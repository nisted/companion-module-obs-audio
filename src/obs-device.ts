/**
 * OBS Studio as a core Device (see core/src/device.ts): talks obs-websocket
 * through ObsClient and turns OBS's inputs, filters, monitoring types,
 * recording tracks and recording into the core's generic terms.
 *
 * Input ids are OBS input names (OBS has no other stable key we can use
 * across sessions); a rename in OBS is reported to the core as a rename.
 * The trim is a Gain filter on the input (named in the input's
 * `trimFilterName` setting), added the first time the trim is used.
 */

import { ObsClient, ObsRequestError } from './obs.js'
import { FILTER_KINDS, filterKind, unversioned } from './obs-filters.js'
import type { Db } from '../core/src/law.js'
import { mulToDb } from '../core/src/law.js'
import type { BlockInfo, Device, DeviceHost, DeviceInfo, DeviceInputState, DeviceRecording, InputCaps } from '../core/src/device.js'
import type { EngineOptions } from '../core/src/engine.js'
import { MODULE_VERSION } from './version.js'

export const MODULE_REPO = 'nisted/companion-module-obs-audio'

export const OBS_MONITOR_TYPES = [
	{ id: 'none', label: 'Off' },
	{ id: 'monitor', label: 'Monitor only' },
	{ id: 'both', label: 'Monitor and output' },
]
const MONITOR_TO_OBS: Record<string, string> = {
	none: 'OBS_MONITORING_TYPE_NONE',
	monitor: 'OBS_MONITORING_TYPE_MONITOR_ONLY',
	both: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT',
}
export function monitorFromObs(t: unknown): string {
	if (t === 'OBS_MONITORING_TYPE_MONITOR_ONLY') return 'monitor'
	if (t === 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT') return 'both'
	return 'none'
}

export const OBS_TRACKS = ['1', '2', '3', '4', '5', '6']

export const OBS_FADER_MAX_DB = 26
export const OBS_TRIM_RANGE = 30
export const TRIM_FILTER_DEFAULT = 'Auto gain trim'

/** Every OBS audio input can do all of this */
export const OBS_CAPS: InputCaps = {
	fader: { minDb: -100, maxDb: OBS_FADER_MAX_DB },
	trim: { minDb: -OBS_TRIM_RANGE, maxDb: OBS_TRIM_RANGE, label: 'Trim' },
	mute: true,
	balance: true,
	delay: { unit: 'ms', min: -950, max: 20000, step: 1, label: 'Sync offset' },
	// PFL = "monitor and output": monitor-only would cut the input from the output
	monitor: { choices: OBS_MONITOR_TYPES, off: 'none', pfl: 'both' },
	routing: { label: 'Recording tracks', targets: OBS_TRACKS.map((t) => ({ id: t, label: t })) },
	processing: { kinds: FILTER_KINDS.map((k) => k.kind), addable: true },
	preMeter: true,
}

export const OBS_INFO: DeviceInfo = {
	label: 'OBS',
	software: { label: 'OBS Studio', repo: 'obsproject/obs-studio', download: 'https://obsproject.com/download' },
	processing: FILTER_KINDS,
	inputFields: {
		trimFilterName: {
			label: 'Trim filter name',
			type: 'text',
			group: 'autolevel',
			default: TRIM_FILTER_DEFAULT,
			resetsAutoLevel: true,
			help: "The name of the Gain filter used as trim. If the input hasn't got one, I'll add it.",
		},
	},
	tips: [
		"PFL uses OBS's monitoring, so set the monitoring device in OBS first: Settings → Audio → Advanced.",
		"The PRE meter is peaks only: that's all OBS gives.",
		'Trim is a Gain filter I add to the input in OBS. The OBS fader stays yours.',
	],
}

/** How OBS Audio sets up the core engine */
export function obsEngineOptions(): EngineOptions {
	return {
		appId: 'obs-audio',
		appName: 'OBS Audio',
		moduleVersion: MODULE_VERSION,
		routingLabel: 'Tracks',
		updates: {
			moduleRepo: MODULE_REPO,
			deviceRepo: OBS_INFO.software.repo,
			moduleDownload: `https://github.com/${MODULE_REPO}/releases`,
			deviceDownload: OBS_INFO.software.download,
			userAgent: 'companion-module-obs-audio',
		},
	}
}

interface ObsFilter {
	filterName: string
	filterKind: string
	filterEnabled: boolean
	filterSettings: Record<string, unknown>
}

export interface ObsDeviceOptions {
	host: string
	port: number
	password: string
}

export class ObsDevice implements Device {
	readonly info = OBS_INFO
	readonly client: ObsClient
	#host: DeviceHost | null = null
	#kindMap = new Map<string, string>()
	#filterDefaults = new Map<string, Record<string, unknown>>()
	/** Last known state per input id (= OBS input name) */
	#inputs = new Map<string, DeviceInputState>()
	readonly recording: DeviceRecording

	constructor(readonly opts: ObsDeviceOptions) {
		this.client = new ObsClient(opts)
		this.recording = {
			status: async () => {
				const st = await this.client.call<{ outputActive: boolean; outputPaused: boolean; outputTimecode: string }>('GetRecordStatus')
				return { active: !!st.outputActive, paused: !!st.outputPaused, timecode: st.outputTimecode ?? '' }
			},
			details: async () => {
				const out: { directory?: string; fileName?: string } = {}
				try {
					out.directory = (await this.client.call<{ recordDirectory: string }>('GetRecordDirectory')).recordDirectory ?? ''
				} catch {
					/* not essential */
				}
				try {
					const f = await this.client.call<{ parameterValue: string | null; defaultParameterValue: string | null }>('GetProfileParameter', {
						parameterCategory: 'Output',
						parameterName: 'FilenameFormatting',
					})
					out.fileName = f.parameterValue ?? f.defaultParameterValue ?? ''
				} catch {
					/* not essential */
				}
				return out
			},
			start: () => this.#do('StartRecord'),
			stop: () => this.#do('StopRecord'),
			pause: (on) => this.#do(on ? 'PauseRecord' : 'ResumeRecord'),
			setFolder: (dir) => this.#do('SetRecordDirectory', { recordDirectory: dir }),
			/** OBS's file name format, e.g. 'Conference %CCYY-%MM-%DD %hh-%mm-%ss' */
			setFileName: (format) => this.#do('SetProfileParameter', { parameterCategory: 'Output', parameterName: 'FilenameFormatting', parameterValue: format }),
		}
	}

	get connected(): boolean {
		return this.client.connected
	}

	get lastError(): string {
		return this.client.lastError
	}

	start(host: DeviceHost): void {
		this.#host = host
		this.client.on('connected', () => {
			host.connected()
			void this.#readVersion()
		})
		this.client.on('disconnected', (reason: string, was: boolean) => host.disconnected(reason, was))
		this.client.on('event', (type: string, data: Record<string, unknown>) => this.#onEvent(type, data))
		this.client.start()
	}

	stop(): void {
		this.client.stop()
		this.client.removeAllListeners()
	}

	async #do(req: string, data?: Record<string, unknown>): Promise<void> {
		await this.client.call(req, data)
	}

	async #readVersion(): Promise<void> {
		try {
			const v = await this.client.call<{ obsVersion: string }>('GetVersion')
			if (v.obsVersion) this.#host?.version(v.obsVersion)
		} catch {
			/* not essential */
		}
	}

	#trimName(id: string): string {
		const v = this.#host?.setting(id, 'trimFilterName')
		return typeof v === 'string' && v ? v : TRIM_FILTER_DEFAULT
	}

	// ---- reading OBS -----------------------------------------------------------

	async refresh(): Promise<void> {
		const host = this.#host
		if (!host || !this.client.connected) return
		try {
			const kinds = await this.client.call<{ sourceFilterKinds: string[] }>('GetSourceFilterKindList')
			this.#kindMap.clear()
			for (const k of kinds.sourceFilterKinds ?? []) {
				const u = unversioned(k)
				const have = this.#kindMap.get(u)
				if (!have || k > have) this.#kindMap.set(u, k)
			}
		} catch (e) {
			host.log('debug', `Filter kinds: ${(e as Error).message}`)
		}
		try {
			const list = await this.client.call<{ inputs: { inputName: string; inputKind: string }[] }>('GetInputList')
			const out: DeviceInputState[] = []
			for (const i of list.inputs ?? []) {
				const s = await this.#loadInput(i.inputName, i.inputKind)
				if (s) out.push(s)
			}
			this.#inputs = new Map(out.map((s) => [s.id, s]))
			host.inputs(out)
		} catch (e) {
			host.log('warn', `Couldn't read OBS inputs: ${(e as Error).message}`)
		}
	}

	/** Read one input's audio state. Undefined if it has no audio. */
	async #loadInput(name: string, kind: string): Promise<DeviceInputState | undefined> {
		let vol: { inputVolumeMul: number }
		try {
			vol = await this.client.call('GetInputVolume', { inputName: name })
		} catch {
			return undefined
		}
		const safe = async <T>(req: string, data: Record<string, unknown>): Promise<T | undefined> => {
			try {
				return await this.client.call<T>(req, data)
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
		const s: DeviceInputState = {
			id: name,
			name,
			kind,
			channels: this.#inputs.get(name)?.channels ?? 2,
			caps: OBS_CAPS,
			volumeDb: mulToDb(vol.inputVolumeMul),
			trimDb: 0,
			hasTrim: false,
			muted: mute?.inputMuted ?? false,
			balance: bal?.inputAudioBalance ?? 0.5,
			delay: sync?.inputAudioSyncOffset ?? 0,
			monitor: monitorFromObs(mon?.monitorType),
			routing: tracks?.inputAudioTracks ?? {},
			mixOption: '',
			blocks: [],
		}
		s.blocks = await this.#loadFilters(name)
		this.#applyTrim(s)
		return s
	}

	async #filterDefaultsFor(kind: string): Promise<Record<string, unknown>> {
		let d = this.#filterDefaults.get(kind)
		if (d) return d
		d = {}
		try {
			const r = await this.client.call<{ defaultFilterSettings: Record<string, unknown> }>('GetSourceFilterDefaultSettings', { filterKind: kind })
			d = r.defaultFilterSettings ?? {}
		} catch {
			/* use the table's defaults */
		}
		const known = filterKind(kind)
		for (const p of known?.params ?? []) if (d[p.key] === undefined) d[p.key] = p.default
		this.#filterDefaults.set(kind, d)
		return d
	}

	async #loadFilters(name: string): Promise<BlockInfo[]> {
		try {
			const r = await this.client.call<{ filters: ObsFilter[] }>('GetSourceFilterList', { sourceName: name })
			const out: BlockInfo[] = []
			for (const f of r.filters ?? []) {
				const defaults = await this.#filterDefaultsFor(f.filterKind)
				out.push({ id: f.filterName, name: f.filterName, kind: unversioned(f.filterKind), enabled: f.filterEnabled, settings: { ...defaults, ...(f.filterSettings ?? {}) } })
			}
			return out
		} catch (e) {
			this.#host?.log('debug', `Filters of ${name}: ${(e as Error).message}`)
			return this.#inputs.get(name)?.blocks ?? []
		}
	}

	/** Work out the trim from the input's filters (the Gain filter named in its settings) */
	#applyTrim(s: DeviceInputState): void {
		const tn = this.#trimName(s.id)
		let trim: BlockInfo | undefined
		for (const b of s.blocks) {
			b.isTrim = b.name === tn && b.kind === 'gain_filter'
			if (b.isTrim) trim = b
		}
		s.hasTrim = !!trim
		s.trimDb = trim && trim.enabled ? Number(trim.settings.db ?? 0) || 0 : 0
	}

	/** Report the input's blocks and trim after a change to them */
	#blocksChanged(s: DeviceInputState, structure: boolean): void {
		this.#applyTrim(s)
		this.#host?.inputChanged(s.id, { blocks: s.blocks, trimDb: s.trimDb, hasTrim: s.hasTrim }, structure)
	}

	settingChanged(id: string, key: string): void {
		if (key !== 'trimFilterName') return
		const s = this.#inputs.get(id)
		if (s) this.#blocksChanged(s, true)
	}

	// ---- OBS events -------------------------------------------------------------

	#onEvent(type: string, d: Record<string, unknown>): void {
		const host = this.#host
		if (!host) return
		const name = String(d.inputName ?? d.sourceName ?? '')
		const s = this.#inputs.get(name)
		const patch = (p: Partial<DeviceInputState>) => {
			if (!s) return
			Object.assign(s, p)
			host.inputChanged(name, p)
		}
		switch (type) {
			case 'InputVolumeMeters': {
				const list = (d.inputs as { inputName: string; inputLevelsMul: number[][] }[]) ?? []
				host.meters(
					list.map((m) => {
						const ch = m.inputLevelsMul ?? []
						const st = this.#inputs.get(m.inputName)
						if (st && ch.length) st.channels = ch.length
						return { id: m.inputName, postMag: ch.map((c) => c[0] ?? 0), postPeak: ch.map((c) => c[1] ?? 0), prePeak: ch.map((c) => c[2] ?? 0) }
					}),
				)
				return
			}
			case 'InputCreated':
				void this.#loadInput(name, String(d.inputKind ?? '')).then((ns) => {
					if (!ns) return
					this.#inputs.set(name, ns)
					host.inputAdded(ns)
				})
				return
			case 'InputRemoved':
				this.#inputs.delete(name)
				host.inputRemoved(name)
				return
			case 'InputNameChanged': {
				const oldName = String(d.oldInputName ?? '')
				const newName = String(d.inputName ?? '')
				const o = this.#inputs.get(oldName)
				if (!o) return
				this.#inputs.delete(oldName)
				o.id = newName
				o.name = newName
				this.#inputs.set(newName, o)
				host.inputRenamed(oldName, newName, newName)
				return
			}
			case 'InputVolumeChanged':
				return patch({ volumeDb: mulToDb(Number(d.inputVolumeMul)) })
			case 'InputMuteStateChanged':
				return patch({ muted: !!d.inputMuted })
			case 'InputAudioBalanceChanged':
				return patch({ balance: Number(d.inputAudioBalance) })
			case 'InputAudioSyncOffsetChanged':
				return patch({ delay: Number(d.inputAudioSyncOffset) })
			case 'InputAudioTracksChanged':
				return patch({ routing: { ...((d.inputAudioTracks as Record<string, boolean>) ?? {}) } })
			case 'InputAudioMonitorTypeChanged':
				return patch({ monitor: monitorFromObs(d.monitorType) })
			case 'RecordStateChanged': {
				const st = String(d.outputState ?? '')
				host.record({
					active: !!d.outputActive,
					paused: st === 'OBS_WEBSOCKET_OUTPUT_PAUSED',
					lastFile: typeof d.outputPath === 'string' && d.outputPath ? d.outputPath : undefined,
					edge: st === 'OBS_WEBSOCKET_OUTPUT_STOPPED' || st === 'OBS_WEBSOCKET_OUTPUT_STARTED',
				})
				return
			}
			case 'SourceFilterSettingsChanged': {
				const f = s?.blocks.find((x) => x.id === d.filterName)
				if (s && f) {
					s.blocks = s.blocks.map((b) => (b === f ? { ...b, settings: { ...b.settings, ...((d.filterSettings as Record<string, unknown>) ?? {}) } } : b))
					this.#blocksChanged(s, false)
				}
				return
			}
			case 'SourceFilterEnableStateChanged': {
				const f = s?.blocks.find((x) => x.id === d.filterName)
				if (s && f) {
					s.blocks = s.blocks.map((b) => (b === f ? { ...b, enabled: !!d.filterEnabled } : b))
					this.#blocksChanged(s, false)
				}
				return
			}
			case 'SourceFilterCreated':
			case 'SourceFilterRemoved':
			case 'SourceFilterNameChanged':
			case 'SourceFilterListReindexed':
				if (s) {
					void this.#loadFilters(name).then((blocks) => {
						s.blocks = blocks
						this.#blocksChanged(s, true)
					})
				}
				return
			case 'ExitStarted':
				host.log('info', 'OBS is closing')
				return
			default:
				return
		}
	}

	// ---- setters ----------------------------------------------------------------

	async #call(req: string, data: Record<string, unknown>): Promise<void> {
		try {
			await this.client.call(req, data)
		} catch (e) {
			throw e instanceof ObsRequestError ? e : new Error(`${req}: ${(e as Error).message}`)
		}
	}

	setVolume(id: string, db: Db): Promise<void> {
		return this.#call('SetInputVolume', db === null ? { inputName: id, inputVolumeMul: 0 } : { inputName: id, inputVolumeDb: db })
	}

	async setTrim(id: string, db: number): Promise<void> {
		const s = this.#inputs.get(id)
		const filterName = this.#trimName(id)
		if (!s?.blocks.some((f) => f.id === filterName)) {
			await this.#createFilter(id, 'gain_filter', filterName, { db })
		} else {
			await this.#call('SetSourceFilterSettings', { sourceName: id, filterName, filterSettings: { db } })
		}
	}

	setMute(id: string, muted: boolean): Promise<void> {
		return this.#call('SetInputMute', { inputName: id, inputMuted: muted })
	}

	setBalance(id: string, balance: number): Promise<void> {
		return this.#call('SetInputAudioBalance', { inputName: id, inputAudioBalance: balance })
	}

	setDelay(id: string, ms: number): Promise<void> {
		return this.#call('SetInputAudioSyncOffset', { inputName: id, inputAudioSyncOffset: Math.round(ms) })
	}

	setMonitor(id: string, value: string): Promise<void> {
		const t = MONITOR_TO_OBS[value]
		if (!t) return Promise.reject(new Error(`"${value}" isn't an OBS monitoring type`))
		return this.#call('SetInputAudioMonitorType', { inputName: id, monitorType: t })
	}

	setRouting(id: string, changes: Record<string, boolean>): Promise<void> {
		return this.#call('SetInputAudioTracks', { inputName: id, inputAudioTracks: changes })
	}

	async #createFilter(id: string, kind: string, name: string, settings: Record<string, unknown>): Promise<void> {
		const real = this.#kindMap.get(kind) ?? kind
		await this.#call('CreateSourceFilter', { sourceName: id, filterName: name, filterKind: real, filterSettings: settings })
		const defaults = await this.#filterDefaultsFor(real)
		const s = this.#inputs.get(id)
		if (s && !s.blocks.some((f) => f.id === name)) {
			s.blocks = [...s.blocks, { id: name, name, kind, enabled: true, settings: { ...defaults, ...settings } }]
			this.#blocksChanged(s, true)
		}
	}

	async addBlock(id: string, kind: string, name: string): Promise<string> {
		await this.#createFilter(id, kind, name, {})
		return name
	}

	async removeBlock(id: string, blockId: string): Promise<void> {
		await this.#call('RemoveSourceFilter', { sourceName: id, filterName: blockId })
		const s = this.#inputs.get(id)
		if (s) {
			s.blocks = s.blocks.filter((b) => b.id !== blockId)
			this.#blocksChanged(s, true)
		}
	}

	setBlockEnabled(id: string, blockId: string, on: boolean): Promise<void> {
		return this.#call('SetSourceFilterEnabled', { sourceName: id, filterName: blockId, filterEnabled: on })
	}

	setBlockParam(id: string, blockId: string, key: string, value: unknown): Promise<void> {
		return this.#call('SetSourceFilterSettings', { sourceName: id, filterName: blockId, filterSettings: { [key]: value } })
	}
}
