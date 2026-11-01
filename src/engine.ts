/**
 * The module's core, separate from Companion: the OBS link, every input's
 * audio state, meters, the riders, CLOR pickup, gestures and the store.
 * main.ts turns this into Companion actions/feedbacks/variables; web.ts
 * serves the page from it.
 */

import { EventEmitter } from 'node:events'
import { ObsClient, ObsRequestError } from './obs.js'
import { type Db, clamp, dbToPosition, mulToDb, MIN_DB, type LawSettings } from './law.js'
import { FILTER_KINDS, filterKind, unversioned } from './filters.js'
import { Rider, type RiderState } from './rider.js'
import { PickupManager } from './pickup.js'
import { GestureReader, type Gesture } from './gesture.js'
import { latestRelease, newVersionInfo, recompute, MODULE_REPO, OBS_REPO, type VersionInfo } from './updates.js'
import { MODULE_VERSION } from './version.js'
import {
	type Store,
	type InputSettings,
	type ImportPart,
	type SectionMode,
	type Section,
	type PageSettings,
	newStore,
	loadStore,
	inputRecord,
	effectiveSettings,
	coerceSetting,
	sanitizeInputOverrides,
	applyImport,
	INPUT_DEFAULTS,
	INPUT_FIELDS,
	PAGE_DEFAULTS,
	CONTROLS,
	GESTURE_DEFAULTS,
} from './settings.js'

export type MonitorType = 'none' | 'monitor' | 'both'
const MONITOR_TO_OBS: Record<MonitorType, string> = {
	none: 'OBS_MONITORING_TYPE_NONE',
	monitor: 'OBS_MONITORING_TYPE_MONITOR_ONLY',
	both: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT',
}
function monitorFromObs(t: unknown): MonitorType {
	if (t === 'OBS_MONITORING_TYPE_MONITOR_ONLY') return 'monitor'
	if (t === 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT') return 'both'
	return 'none'
}

export interface FilterInfo {
	name: string
	kind: string
	enabled: boolean
	settings: Record<string, unknown>
}

export interface InputInfo {
	name: string
	kind: string
	volumeDb: Db
	muted: boolean
	balance: number
	syncMs: number
	monitor: MonitorType
	tracks: Record<string, boolean>
	filters: FilterInfo[]
	/** Gain of the trim filter (named in this input's settings), 0 if there isn't one */
	trimDb: number
	hasTrim: boolean
	channels: number
	/** Latest meters, dB per channel */
	postPeak: Db[]
	postMag: Db[]
	prePeak: Db[]
	rider: Rider
}

export interface EngineHost {
	log(level: 'debug' | 'info' | 'warn' | 'error', msg: string): void
	/** Persist the store (and autosave) */
	save(store: string, autosave: string): void
	/** Inputs, filters or names changed: redo variable definitions, presets */
	structureChanged(): void
	/** Something feedbacks or variables show changed */
	stateChanged(): void
}

interface Coalesce {
	busy: boolean
	next: (() => Promise<unknown>) | null
}

const ECHO_MS = 1500

export class Engine extends EventEmitter {
	readonly host: EngineHost
	store: Store
	autosave: string
	obs: ObsClient | null = null
	inputs = new Map<string, InputInfo>()
	/** OBS's own order of audio inputs */
	#obsOrder: string[] = []
	#kindMap = new Map<string, string>()
	#filterDefaults = new Map<string, Record<string, unknown>>()
	#sentVolume = new Map<string, { db: Db; at: number }[]>()
	#sentTrim = new Map<string, { db: number; at: number }[]>()
	#coalesce = new Map<string, Coalesce>()
	#fades = new Map<string, NodeJS.Timeout>()
	#saveTimer: NodeJS.Timeout | null = null
	#stateTimer: NodeJS.Timeout | null = null
	#tick: NodeJS.Timeout
	readonly pickup: PickupManager
	readonly gestures: GestureReader
	versions: VersionInfo = newVersionInfo(MODULE_VERSION)
	#updateTimer: NodeJS.Timeout | null = null

	constructor(host: EngineHost, storeJson: unknown, autosave: string) {
		super()
		this.host = host
		this.store = storeJson ? loadStore(storeJson) : newStore()
		this.autosave = autosave || ''
		this.pickup = new PickupManager(
			(name) => {
				const inp = this.inputs.get(name)
				return inp ? dbToPosition(inp.volumeDb, this.law) * 127 : undefined
			},
			() => this.#stateChanged(),
		)
		this.gestures = new GestureReader(
			() => this.store.gestures,
			(name, g) => this.#gesture(name, g),
		)
		this.#tick = setInterval(() => this.pickup.tick(), 125)
	}

	get law(): LawSettings {
		return { kind: this.store.page.law, topDb: this.store.page.faderTopDb, bottomDb: this.store.page.faderBottomDb }
	}

	get connected(): boolean {
		return this.obs?.connected ?? false
	}

	destroy(): void {
		clearInterval(this.#tick)
		if (this.#updateTimer) clearInterval(this.#updateTimer)
		for (const t of this.#fades.values()) clearInterval(t)
		this.#fades.clear()
		this.pickup.destroy()
		this.gestures.destroy()
		this.obs?.stop()
		this.obs = null
		this.flushSave()
	}

	connect(host: string, port: number, password: string): void {
		this.obs?.stop()
		const obs = new ObsClient({ host, port, password })
		this.obs = obs
		obs.on('connected', () => {
			this.host.log('info', `Connected to OBS at ${host}:${port}`)
			void this.refreshAll()
			void this.#readObsVersion()
		})
		obs.on('disconnected', (reason: string, was: boolean) => {
			if (was) this.host.log('warn', `Disconnected from OBS: ${reason}`)
			this.#stateChanged()
			this.emit('status')
		})
		obs.on('event', (type: string, data: Record<string, unknown>) => this.#onEvent(type, data))
		obs.start()
	}

	// ---- update checks --------------------------------------------------------

	async #readObsVersion(): Promise<void> {
		try {
			const v = await this.obs!.call<{ obsVersion: string }>('GetVersion')
			this.versions.obsVersion = v.obsVersion ?? null
			recompute(this.versions)
			this.#stateChanged()
		} catch {
			/* not essential */
		}
	}

	/** Check for updates now and every `hours` (0 = never) */
	setUpdateChecks(hours: number): void {
		if (this.#updateTimer) clearInterval(this.#updateTimer)
		this.#updateTimer = null
		if (!(hours > 0)) return
		void this.checkUpdates()
		this.#updateTimer = setInterval(() => void this.checkUpdates(), hours * 3600 * 1000)
	}

	async checkUpdates(): Promise<void> {
		const v = this.versions
		try {
			const [mod, obs] = await Promise.all([latestRelease(MODULE_REPO), latestRelease(OBS_REPO)])
			v.moduleLatest = mod
			v.obsLatest = obs
			v.error = null
		} catch (e) {
			v.error = `Couldn't check for updates: ${(e as Error).message}`
			this.host.log('debug', v.error)
		}
		v.checkedAt = new Date().toISOString()
		recompute(v)
		if (v.moduleUpdate) this.host.log('info', `OBS Audio ${v.moduleLatest} is out (this is ${v.moduleVersion})`)
		if (v.obsUpdate) this.host.log('info', `OBS ${v.obsLatest} is out (this is ${v.obsVersion})`)
		this.#stateChanged()
	}

	// ---- inputs and order ---------------------------------------------------

	/** Inputs in display order, hidden ones included */
	ordered(): InputInfo[] {
		const names: string[] = []
		for (const n of this.store.order) if (this.inputs.has(n) && !names.includes(n)) names.push(n)
		for (const n of this.#obsOrder) if (this.inputs.has(n) && !names.includes(n)) names.push(n)
		return names.map((n) => this.inputs.get(n)!)
	}

	visible(): InputInfo[] {
		const hidden = new Set(this.store.hidden)
		return this.ordered().filter((i) => !hidden.has(i.name))
	}

	/** An input from text: its number in the visible list, or its name */
	resolve(text: string): InputInfo | undefined {
		const t = text.trim()
		if (t === '') return undefined
		if (/^\d+$/.test(t)) return this.visible()[Number(t) - 1]
		return this.inputs.get(t) ?? [...this.inputs.values()].find((i) => i.name.toLowerCase() === t.toLowerCase())
	}

	/** Which input a Grid fader drives: the override if given, else by position in the list */
	gridInput(fader: number, override: string): InputInfo | undefined {
		if (override.trim()) return this.resolve(override)
		return this.visible()[fader - 1]
	}

	settings(name: string): InputSettings {
		return effectiveSettings(this.store, name)
	}

	// ---- refresh from OBS ---------------------------------------------------

	async refreshAll(): Promise<void> {
		const obs = this.obs
		if (!obs?.connected) return
		try {
			const kinds = await obs.call<{ sourceFilterKinds: string[] }>('GetSourceFilterKindList')
			this.#kindMap.clear()
			for (const k of kinds.sourceFilterKinds ?? []) {
				const u = unversioned(k)
				const have = this.#kindMap.get(u)
				if (!have || k > have) this.#kindMap.set(u, k)
			}
		} catch (e) {
			this.host.log('debug', `Filter kinds: ${(e as Error).message}`)
		}
		try {
			const list = await obs.call<{ inputs: { inputName: string; inputKind: string }[] }>('GetInputList')
			const seen = new Set<string>()
			const order: string[] = []
			for (const i of list.inputs ?? []) {
				if (await this.#loadInput(i.inputName, i.inputKind)) {
					seen.add(i.inputName)
					order.push(i.inputName)
				}
			}
			for (const name of [...this.inputs.keys()]) if (!seen.has(name)) this.#dropInput(name)
			this.#obsOrder = order
		} catch (e) {
			this.host.log('warn', `Couldn't read OBS inputs: ${(e as Error).message}`)
		}
		this.host.structureChanged()
		this.#stateChanged()
		this.emit('status')
	}

	/** Read one input's audio state. False if it has no audio. */
	async #loadInput(name: string, kind: string): Promise<boolean> {
		const obs = this.obs!
		let vol: { inputVolumeMul: number }
		try {
			vol = await obs.call('GetInputVolume', { inputName: name })
		} catch {
			return false
		}
		let inp = this.inputs.get(name)
		if (!inp) {
			inp = this.#newInput(name, kind)
			this.inputs.set(name, inp)
		}
		inp.kind = kind
		inp.volumeDb = mulToDb(vol.inputVolumeMul)
		const safe = async <T>(req: string, data: Record<string, unknown>): Promise<T | undefined> => {
			try {
				return await obs.call<T>(req, data)
			} catch {
				return undefined
			}
		}
		const [mute, bal, sync, mon, tracks] = await Promise.all([
			safe<{ inputMuted: boolean }>('GetInputMute', { inputName: name }),
			safe<{ inputAudioBalance: number }>('GetInputAudioBalance', { inputName: name }),
			safe<{ inputAudioSyncOffset: number }>('GetInputAudioSyncOffset', { inputName: name }),
			safe<{ monitorType: string }>('GetInputAudioMonitorType', { inputName: name }),
			safe<{ inputAudioTracks: Record<string, boolean> }>('GetInputAudioTracks', { inputName: name }),
		])
		inp.muted = mute?.inputMuted ?? false
		inp.balance = bal?.inputAudioBalance ?? 0.5
		inp.syncMs = sync?.inputAudioSyncOffset ?? 0
		inp.monitor = monitorFromObs(mon?.monitorType)
		inp.tracks = tracks?.inputAudioTracks ?? {}
		await this.#loadFilters(name)
		return true
	}

	async #filterDefaultsFor(kind: string): Promise<Record<string, unknown>> {
		let d = this.#filterDefaults.get(kind)
		if (d) return d
		d = {}
		try {
			const r = await this.obs!.call<{ defaultFilterSettings: Record<string, unknown> }>('GetSourceFilterDefaultSettings', {
				filterKind: kind,
			})
			d = r.defaultFilterSettings ?? {}
		} catch {
			/* use the table's defaults */
		}
		const known = filterKind(kind)
		for (const p of known?.params ?? []) if (d[p.key] === undefined) d[p.key] = p.default
		this.#filterDefaults.set(kind, d)
		return d
	}

	async #loadFilters(name: string): Promise<void> {
		const inp = this.inputs.get(name)
		if (!inp || !this.obs?.connected) return
		try {
			const r = await this.obs.call<{
				filters: { filterName: string; filterKind: string; filterEnabled: boolean; filterSettings: Record<string, unknown> }[]
			}>('GetSourceFilterList', { sourceName: name })
			const out: FilterInfo[] = []
			for (const f of r.filters ?? []) {
				const defaults = await this.#filterDefaultsFor(f.filterKind)
				out.push({
					name: f.filterName,
					kind: unversioned(f.filterKind),
					enabled: f.filterEnabled,
					settings: { ...defaults, ...(f.filterSettings ?? {}) },
				})
			}
			inp.filters = out
			this.#updateTrim(inp)
		} catch (e) {
			this.host.log('debug', `Filters of ${name}: ${(e as Error).message}`)
		}
	}

	#updateTrim(inp: InputInfo): void {
		const set = this.settings(inp.name)
		const f = inp.filters.find((x) => x.name === set.trimFilterName && x.kind === 'gain_filter')
		inp.hasTrim = !!f
		inp.trimDb = f && f.enabled ? Number(f.settings.db ?? 0) || 0 : 0
	}

	#newInput(name: string, kind: string): InputInfo {
		const inp: InputInfo = {
			name,
			kind,
			volumeDb: 0,
			muted: false,
			balance: 0.5,
			syncMs: 0,
			monitor: 'none',
			tracks: {},
			filters: [],
			trimDb: 0,
			hasTrim: false,
			channels: 2,
			postPeak: [],
			postMag: [],
			prePeak: [],
			rider: undefined as unknown as Rider,
		}
		inp.rider = new Rider({
			settings: () => this.settings(inp.name),
			record: () => inputRecord(this.store, inp.name),
			saveRecord: () => this.#dirty(),
			setGain: (db) => {
				const set = this.settings(inp.name)
				if (set.controlMode === 'trim') void this.#sendTrim(inp, db)
				else void this.#sendVolume(inp, db)
			},
			riderOff: () => this.setInputSetting(inp.name, 'riderOn', false),
			log: (level, msg) => this.host.log(level, `${inp.name}: ${msg}`),
			changed: () => this.#stateChanged(),
		})
		return inp
	}

	#dropInput(name: string): void {
		this.inputs.delete(name)
		this.pickup.forget(name)
		const t = this.#fades.get(name)
		if (t) clearInterval(t)
		this.#fades.delete(name)
	}

	// ---- OBS events ---------------------------------------------------------

	#onEvent(type: string, d: Record<string, unknown>): void {
		const name = String(d.inputName ?? d.sourceName ?? '')
		const inp = this.inputs.get(name)
		switch (type) {
			case 'InputVolumeMeters':
				this.#onMeters(d.inputs as { inputName: string; inputLevelsMul: number[][] }[])
				return
			case 'InputCreated':
				void this.#loadInput(name, String(d.inputKind ?? '')).then((ok) => {
					if (ok && !this.#obsOrder.includes(name)) this.#obsOrder.push(name)
					this.host.structureChanged()
					this.#stateChanged()
				})
				return
			case 'InputRemoved':
				this.#dropInput(name)
				this.#obsOrder = this.#obsOrder.filter((n) => n !== name)
				this.host.structureChanged()
				this.#stateChanged()
				return
			case 'InputNameChanged': {
				const oldName = String(d.oldInputName ?? '')
				const newName = String(d.inputName ?? '')
				this.#rename(oldName, newName)
				return
			}
			case 'InputVolumeChanged':
				if (inp) this.#onVolume(inp, mulToDb(Number(d.inputVolumeMul)))
				return
			case 'InputMuteStateChanged':
				if (inp) inp.muted = !!d.inputMuted
				break
			case 'InputAudioBalanceChanged':
				if (inp) inp.balance = Number(d.inputAudioBalance)
				break
			case 'InputAudioSyncOffsetChanged':
				if (inp) inp.syncMs = Number(d.inputAudioSyncOffset)
				break
			case 'InputAudioTracksChanged':
				if (inp) inp.tracks = (d.inputAudioTracks as Record<string, boolean>) ?? {}
				break
			case 'InputAudioMonitorTypeChanged':
				if (inp) inp.monitor = monitorFromObs(d.monitorType)
				break
			case 'SourceFilterSettingsChanged': {
				const f = inp?.filters.find((x) => x.name === d.filterName)
				if (inp && f) {
					const before = inp.trimDb
					Object.assign(f.settings, (d.filterSettings as Record<string, unknown>) ?? {})
					this.#updateTrim(inp)
					if (f.name === this.settings(inp.name).trimFilterName) this.#onTrimEcho(inp, before)
				}
				break
			}
			case 'SourceFilterEnableStateChanged': {
				const f = inp?.filters.find((x) => x.name === d.filterName)
				if (inp && f) {
					f.enabled = !!d.filterEnabled
					this.#updateTrim(inp)
				}
				break
			}
			case 'SourceFilterCreated':
			case 'SourceFilterRemoved':
			case 'SourceFilterNameChanged':
			case 'SourceFilterListReindexed':
				if (inp) {
					void this.#loadFilters(name).then(() => {
						this.host.structureChanged()
						this.#stateChanged()
					})
				}
				return
			case 'ExitStarted':
				this.host.log('info', 'OBS is closing')
				return
			default:
				return
		}
		this.#stateChanged()
	}

	#rename(oldName: string, newName: string): void {
		const inp = this.inputs.get(oldName)
		if (!inp) return
		this.inputs.delete(oldName)
		inp.name = newName
		this.inputs.set(newName, inp)
		this.#obsOrder = this.#obsOrder.map((n) => (n === oldName ? newName : n))
		this.store.order = this.store.order.map((n) => (n === oldName ? newName : n))
		this.store.hidden = this.store.hidden.map((n) => (n === oldName ? newName : n))
		if (this.store.inputs[oldName]) {
			this.store.inputs[newName] = this.store.inputs[oldName]
			delete this.store.inputs[oldName]
		}
		this.pickup.forget(oldName)
		this.#dirty()
		this.host.structureChanged()
		this.#stateChanged()
	}

	#isOurs<T extends number | null>(list: { db: T; at: number }[] | undefined, db: T, tol: number): boolean {
		const now = Date.now()
		return (list ?? []).some((s) => now - s.at <= ECHO_MS && (s.db === db || (s.db !== null && db !== null && Math.abs((s.db as number) - (db as number)) <= tol)))
	}

	#onVolume(inp: InputInfo, db: Db): void {
		const old = inp.volumeDb
		inp.volumeDb = db
		if (!this.#isOurs(this.#sentVolume.get(inp.name), db, 0.05)) {
			// moved somewhere else (OBS mixer, another module)
			const fade = this.#fades.get(inp.name)
			if (fade) {
				clearInterval(fade)
				this.#fades.delete(inp.name)
			}
			if (this.settings(inp.name).controlMode === 'fader') inp.rider.manualMove(old, db)
		}
		this.#stateChanged()
	}

	#onTrimEcho(inp: InputInfo, before: number): void {
		if (this.#isOurs(this.#sentTrim.get(inp.name), inp.trimDb, 0.05)) return
		if (this.settings(inp.name).controlMode === 'trim') inp.rider.manualMove(before, inp.trimDb)
	}

	#onMeters(list: { inputName: string; inputLevelsMul: number[][] }[]): void {
		const t = Date.now()
		for (const m of list ?? []) {
			const inp = this.inputs.get(m.inputName)
			if (!inp) continue
			const ch = m.inputLevelsMul ?? []
			inp.channels = ch.length || inp.channels
			inp.postMag = ch.map((c) => mulToDb(c[0]))
			inp.postPeak = ch.map((c) => mulToDb(c[1]))
			inp.prePeak = ch.map((c) => mulToDb(c[2]))
			inp.rider.onMeter({
				t,
				mag: ch.map((c) => c[0] ?? 0),
				prePeak: ch.map((c) => c[2] ?? 0),
				faderDb: inp.volumeDb,
				trimDb: inp.trimDb,
				muted: inp.muted,
			})
		}
		this.emit('meters')
	}

	// ---- sending to OBS -----------------------------------------------------

	/** Send requests for one thing one at a time, always ending on the latest */
	#coalesced(key: string, job: () => Promise<unknown>): Promise<void> {
		let c = this.#coalesce.get(key)
		if (!c) {
			c = { busy: false, next: null }
			this.#coalesce.set(key, c)
		}
		c.next = job
		if (c.busy) return Promise.resolve()
		const run = async (): Promise<void> => {
			const cc = c!
			while (cc.next) {
				const j = cc.next
				cc.next = null
				cc.busy = true
				try {
					await j()
				} catch (e) {
					this.host.log('warn', (e as Error).message)
				}
			}
			cc.busy = false
		}
		return run()
	}

	#remember<T>(map: Map<string, { db: T; at: number }[]>, name: string, db: T): void {
		const now = Date.now()
		const list = (map.get(name) ?? []).filter((s) => now - s.at <= ECHO_MS)
		list.push({ db, at: now })
		map.set(name, list)
	}

	#sendVolume(inp: InputInfo, db: Db): Promise<void> {
		const v: Db = db === null || db <= MIN_DB ? null : clamp(db, MIN_DB, 26)
		inp.volumeDb = v
		this.#remember(this.#sentVolume, inp.name, v)
		this.#stateChanged()
		return this.#coalesced(`vol:${inp.name}`, () =>
			this.obs!.call('SetInputVolume', v === null ? { inputName: inp.name, inputVolumeMul: 0 } : { inputName: inp.name, inputVolumeDb: v }),
		)
	}

	async #sendTrim(inp: InputInfo, db: number): Promise<void> {
		const v = clamp(db, -30, 30)
		const set = this.settings(inp.name)
		inp.trimDb = v
		this.#remember(this.#sentTrim, inp.name, v)
		this.#stateChanged()
		const filterName = set.trimFilterName
		await this.#coalesced(`trim:${inp.name}`, async () => {
			if (!inp.filters.some((f) => f.name === filterName)) {
				await this.#createFilter(inp, 'gain_filter', filterName, { db: v })
			} else {
				await this.obs!.call('SetSourceFilterSettings', {
					sourceName: inp.name,
					filterName,
					filterSettings: { db: v },
				})
			}
		})
	}

	async #createFilter(inp: InputInfo, kind: string, name: string, settings: Record<string, unknown>): Promise<void> {
		const real = this.#kindMap.get(kind) ?? kind
		await this.obs!.call('CreateSourceFilter', { sourceName: inp.name, filterName: name, filterKind: real, filterSettings: settings })
		const defaults = await this.#filterDefaultsFor(real)
		if (!inp.filters.some((f) => f.name === name)) {
			inp.filters.push({ name, kind, enabled: true, settings: { ...defaults, ...settings } })
		}
		this.#updateTrim(inp)
		this.host.structureChanged()
	}

	#call(req: string, data: Record<string, unknown>): Promise<void> {
		if (!this.obs?.connected) {
			this.host.log('warn', 'Not connected to OBS')
			return Promise.resolve()
		}
		return this.obs.call(req, data).then(
			() => undefined,
			(e: Error) => this.host.log('warn', e instanceof ObsRequestError ? e.message : `${req}: ${e.message}`),
		)
	}

	// ---- operations (from actions and the web page) --------------------------

	/** A hand move of the fader (web page, Grid, Companion button) */
	setVolume(inp: InputInfo, db: Db, fadeMs = 0): void {
		const old = inp.volumeDb
		const existing = this.#fades.get(inp.name)
		if (existing) {
			clearInterval(existing)
			this.#fades.delete(inp.name)
		}
		if (this.settings(inp.name).controlMode === 'fader') inp.rider.manualMove(old, db)
		if (fadeMs <= 0 || old === null || db === null) {
			void this.#sendVolume(inp, db)
			return
		}
		const start = Date.now()
		const from = old
		const to = db
		const timer = setInterval(() => {
			const f = Math.min(1, (Date.now() - start) / fadeMs)
			void this.#sendVolume(inp, from + (to - from) * f)
			if (f >= 1) {
				clearInterval(timer)
				this.#fades.delete(inp.name)
			}
		}, 50)
		this.#fades.set(inp.name, timer)
	}

	setTrim(inp: InputInfo, db: number): void {
		if (this.settings(inp.name).controlMode === 'trim') inp.rider.manualMove(inp.trimDb, db)
		void this.#sendTrim(inp, db)
	}

	touch(inp: InputInfo, on: boolean): void {
		inp.rider.touch(on)
	}

	setMute(inp: InputInfo, muted: boolean): Promise<void> {
		inp.muted = muted
		this.#stateChanged()
		return this.#call('SetInputMute', { inputName: inp.name, inputMuted: muted })
	}

	setBalance(inp: InputInfo, balance: number): Promise<void> {
		inp.balance = clamp(balance, 0, 1)
		this.#stateChanged()
		return this.#call('SetInputAudioBalance', { inputName: inp.name, inputAudioBalance: inp.balance })
	}

	setSync(inp: InputInfo, ms: number): Promise<void> {
		inp.syncMs = Math.round(clamp(ms, -950, 20000))
		this.#stateChanged()
		return this.#call('SetInputAudioSyncOffset', { inputName: inp.name, inputAudioSyncOffset: inp.syncMs })
	}

	setMonitor(inp: InputInfo, m: MonitorType): Promise<void> {
		inp.monitor = m
		this.#stateChanged()
		return this.#call('SetInputAudioMonitorType', { inputName: inp.name, monitorType: MONITOR_TO_OBS[m] })
	}

	setTracks(inp: InputInfo, changes: Record<string, boolean>): Promise<void> {
		inp.tracks = { ...inp.tracks, ...changes }
		this.#stateChanged()
		return this.#call('SetInputAudioTracks', { inputName: inp.name, inputAudioTracks: changes })
	}

	async addFilter(inp: InputInfo, kind: string, name: string): Promise<void> {
		const k = FILTER_KINDS.find((f) => f.kind === kind)
		if (!k) return
		let n = name.trim() || k.defaultName
		if (!name.trim()) {
			let i = 2
			while (inp.filters.some((f) => f.name === n)) n = `${k.defaultName} ${i++}`
		}
		try {
			await this.#createFilter(inp, kind, n, {})
		} catch (e) {
			this.host.log('warn', `Couldn't add ${k.label} to ${inp.name}: ${(e as Error).message}`)
		}
		this.#stateChanged()
	}

	async removeFilter(inp: InputInfo, filter: string): Promise<void> {
		await this.#call('RemoveSourceFilter', { sourceName: inp.name, filterName: filter })
		inp.filters = inp.filters.filter((f) => f.name !== filter)
		this.#updateTrim(inp)
		this.host.structureChanged()
		this.#stateChanged()
	}

	setFilterEnabled(inp: InputInfo, filter: string, on: boolean): Promise<void> {
		const f = inp.filters.find((x) => x.name === filter)
		if (f) f.enabled = on
		this.#updateTrim(inp)
		this.#stateChanged()
		return this.#call('SetSourceFilterEnabled', { sourceName: inp.name, filterName: filter, filterEnabled: on })
	}

	setFilterSetting(inp: InputInfo, filter: string, key: string, value: unknown): Promise<void> {
		const f = inp.filters.find((x) => x.name === filter)
		if (f) f.settings[key] = value
		this.#stateChanged()
		return this.#coalesced(`f:${inp.name}:${filter}:${key}`, () =>
			this.obs!.call('SetSourceFilterSettings', { sourceName: inp.name, filterName: filter, filterSettings: { [key]: value } }),
		)
	}

	// ---- auto gain ------------------------------------------------------------

	captureTarget(inp: InputInfo): void {
		inp.rider.captureTarget()
	}

	calibrate(inp: InputInfo, which: 'input' | 'module' | number): void {
		const level = which === 'input' ? this.settings(inp.name).calibrateDb : which === 'module' ? this.store.moduleCalibrateDb : which
		inp.rider.calibrate(level)
	}

	setTarget(inp: InputInfo, db: number | null): void {
		const rec = inputRecord(this.store, inp.name)
		rec.target = db
		rec.refGain = db === null ? null : (inp.rider.gain ?? null)
		this.#dirty()
		this.#stateChanged()
	}

	buttonDown(inp: InputInfo): void {
		this.gestures.down(inp.name)
	}

	buttonUp(inp: InputInfo): void {
		this.gestures.up(inp.name)
	}

	#gesture(name: string, g: Gesture): void {
		const inp = this.inputs.get(name)
		if (!inp) return
		if (g === 'press') this.captureTarget(inp)
		else if (g === 'double') this.calibrate(inp, 'input')
		else this.calibrate(inp, 'module')
	}

	// ---- settings -------------------------------------------------------------

	/** Set one input's setting; value undefined = back to the page-wide default */
	setInputSetting(name: string, key: keyof InputSettings, value: unknown): void {
		const rec = inputRecord(this.store, name)
		const before = this.settings(name)
		if (value === undefined || value === null) delete rec.overrides[key]
		else {
			const v = coerceSetting(key, value)
			if (v === undefined) {
				this.host.log('warn', `"${String(value)}" isn't a valid ${INPUT_FIELDS[key].label}`)
				return
			}
			;(rec.overrides as Record<string, unknown>)[key] = v
		}
		this.#settingChanged(name, before)
		this.#dirty()
		this.#stateChanged()
	}

	setDefaultSetting(key: keyof InputSettings, value: unknown): void {
		const v = coerceSetting(key, value)
		if (v === undefined) return
		const before = new Map([...this.inputs.keys()].map((n) => [n, this.settings(n)]))
		;(this.store.defaults as unknown as Record<string, unknown>)[key] = v
		for (const [n, b] of before) this.#settingChanged(n, b)
		this.#dirty()
		this.#stateChanged()
	}

	#settingChanged(name: string, before: InputSettings): void {
		const inp = this.inputs.get(name)
		if (!inp) return
		const after = this.settings(name)
		if (before.controlMode !== after.controlMode || before.trimFilterName !== after.trimFilterName) {
			// the measuring point changed: the old target doesn't apply
			const rec = inputRecord(this.store, name)
			rec.target = null
			rec.refGain = null
			inp.rider.reset()
			this.#updateTrim(inp)
		}
		if (before.measure !== after.measure || before.stereo !== after.stereo) inp.rider.reset()
	}

	setPage(key: keyof PageSettings, value: unknown): void {
		const base = PAGE_DEFAULTS[key]
		let v: unknown = value
		if (typeof base === 'number') v = Number(value)
		if (typeof base === 'boolean') v = value === true || value === 'true' || value === 1 || value === '1' || value === 'on'
		if (typeof base === 'number' && Number.isNaN(v)) return
		if (typeof v !== typeof base) return
		;(this.store.page as unknown as Record<string, unknown>)[key] = v
		this.#dirty()
		this.#stateChanged()
	}

	setGestures(doubleTapMs?: number, holdMs?: number, moduleCalibrateDb?: number): void {
		if (doubleTapMs !== undefined && doubleTapMs > 0) this.store.gestures.doubleTapMs = doubleTapMs
		if (holdMs !== undefined && holdMs > 0) this.store.gestures.holdMs = holdMs
		if (moduleCalibrateDb !== undefined && !Number.isNaN(moduleCalibrateDb)) this.store.moduleCalibrateDb = moduleCalibrateDb
		this.#dirty()
		this.#stateChanged()
	}

	setSections(sections: Section[]): void {
		this.store = loadStore({ ...this.store, sections })
		this.#dirty()
		this.#stateChanged()
	}

	setInputSection(name: string, section: string, mode: SectionMode | null): void {
		const rec = inputRecord(this.store, name)
		if (mode === null) delete rec.sections[section]
		else rec.sections[section] = mode
		this.#dirty()
		this.#stateChanged()
	}

	setOrder(order: string[], hidden: string[]): void {
		this.store.order = order.filter((x) => typeof x === 'string')
		this.store.hidden = hidden.filter((x) => typeof x === 'string')
		this.#dirty()
		this.host.structureChanged()
		this.#stateChanged()
	}

	// ---- export / import ----------------------------------------------------

	exportJson(): string {
		return JSON.stringify({ app: 'companion-module-obs-audio', exported: new Date().toISOString(), store: this.store }, null, 1)
	}

	/** Apply parts of an exported file. The current settings go to the autosave first. */
	importJson(text: string, parts: ImportPart[]): string {
		let incoming: Store
		try {
			const parsed = JSON.parse(text) as { store?: unknown }
			incoming = loadStore(parsed.store ?? parsed)
		} catch {
			throw new Error("That file isn't a settings export from this module.")
		}
		this.autosave = this.exportJson()
		applyImport(this.store, incoming, parts)
		this.#afterBulkChange()
		return `Imported ${parts.length} part${parts.length === 1 ? '' : 's'}. The previous settings are in the autosave.`
	}

	restoreAutosave(): string {
		if (!this.autosave) throw new Error('There is no autosave yet.')
		const current = this.exportJson()
		const parsed = JSON.parse(this.autosave) as { store?: unknown }
		this.store = loadStore(parsed.store ?? parsed)
		this.autosave = current
		this.#afterBulkChange()
		return 'Settings rolled back to the autosave (the ones just replaced are now the autosave).'
	}

	#afterBulkChange(): void {
		for (const inp of this.inputs.values()) {
			inp.rider.reset()
			this.#updateTrim(inp)
		}
		this.flushSave(true)
		this.host.structureChanged()
		this.#stateChanged()
	}

	// ---- persistence and change notices --------------------------------------

	#dirty(): void {
		if (this.#saveTimer) return
		this.#saveTimer = setTimeout(() => {
			this.#saveTimer = null
			this.host.save(JSON.stringify(this.store), this.autosave)
		}, 1000)
	}

	flushSave(force = false): void {
		if (this.#saveTimer) {
			clearTimeout(this.#saveTimer)
			this.#saveTimer = null
			this.host.save(JSON.stringify(this.store), this.autosave)
		} else if (force) {
			this.host.save(JSON.stringify(this.store), this.autosave)
		}
	}

	#stateChanged(): void {
		if (this.#stateTimer) return
		this.#stateTimer = setTimeout(() => {
			this.#stateTimer = null
			this.host.stateChanged()
			this.emit('state')
		}, 50)
	}

	// ---- snapshots for the web page -------------------------------------------

	snapshot(): Record<string, unknown> {
		const hidden = new Set(this.store.hidden)
		return {
			connected: this.connected,
			versions: this.versions,
			store: {
				defaults: this.store.defaults,
				page: this.store.page,
				gestures: this.store.gestures,
				moduleCalibrateDb: this.store.moduleCalibrateDb,
				sections: this.store.sections,
				order: this.store.order,
				hidden: this.store.hidden,
			},
			autosave: !!this.autosave,
			inputs: this.ordered().map((i) => {
				const rec = this.store.inputs[i.name]
				return {
					name: i.name,
					hidden: hidden.has(i.name),
					volumeDb: i.volumeDb,
					muted: i.muted,
					balance: i.balance,
					syncMs: i.syncMs,
					monitor: i.monitor,
					tracks: i.tracks,
					channels: i.channels,
					filters: i.filters,
					trimDb: i.trimDb,
					hasTrim: i.hasTrim,
					overrides: rec?.overrides ?? {},
					sections: rec?.sections ?? {},
					target: rec?.target ?? null,
					refGain: rec?.refGain ?? null,
					settings: this.settings(i.name),
					rider: i.rider.state,
				}
			}),
		}
	}

	/** Compact meter frame: name -> [postPeak[], prePeak[], riderLevel, riderState] */
	meterFrame(): Record<string, [(number | null)[], (number | null)[], number | null, RiderState]> {
		const r = (d: Db) => (d === null ? null : Math.round(d * 10) / 10)
		const out: Record<string, [(number | null)[], (number | null)[], number | null, RiderState]> = {}
		for (const i of this.inputs.values()) out[i.name] = [i.postPeak.map(r), i.prePeak.map(r), r(i.rider.level), i.rider.state]
		return out
	}

	static readonly meta = {
		inputFields: INPUT_FIELDS,
		inputDefaults: INPUT_DEFAULTS,
		pageDefaults: PAGE_DEFAULTS,
		gestureDefaults: GESTURE_DEFAULTS,
		controls: CONTROLS,
		filterKinds: FILTER_KINDS,
	}
}

export { sanitizeInputOverrides }
