/**
 * Show features on top of the basic OBS link: pop-up notices, PFL and solo
 * (monitoring only), backup feeds with automatic switch-over, and recording
 * with a planned restart.
 */

import { readdir } from 'node:fs/promises'
import type { Db } from './law.js'
import type { InputInfo, MonitorType } from './engine.js'
import type { InputSettings, RecordPlan } from './settings.js'

// ---- what the features need from the engine --------------------------------

export interface FeatureHost {
	inputs: Map<string, InputInfo>
	settings(name: string): InputSettings
	setMonitor(inp: InputInfo, m: MonitorType): Promise<void>
	/** Move a fader as part of an automatic switch (not a hand move) */
	fadeTo(inp: InputInfo, db: Db, ms: number): void
	setInputSetting(name: string, key: keyof InputSettings, value: unknown): void
	call<T = Record<string, unknown>>(req: string, data?: Record<string, unknown>): Promise<T>
	connected(): boolean
	pflMode(): 'additive' | 'exclusive'
	plan(): RecordPlan
	savePlan(): void
	recordLeadMin(): number
	recordSnoozeMin(): number
	log(level: 'info' | 'warn' | 'debug', msg: string): void
	changed(): void
}

// ---- notices (pop-ups on the page, variables in Companion) ------------------

export interface Notice {
	id: string
	kind: 'backup-switched' | 'backup-back' | 'record-due' | 'info'
	input?: string
	title: string
	message: string
	actions: { id: string; label: string }[]
	at: string
}

export class Notices {
	list: Notice[] = []
	#n = 0
	constructor(private readonly changed: () => void) {}

	add(n: Omit<Notice, 'id' | 'at'>): Notice {
		// one of each kind per input at a time
		this.list = this.list.filter((x) => !(x.kind === n.kind && x.input === n.input))
		const full: Notice = { ...n, id: `n${++this.#n}`, at: new Date().toISOString() }
		this.list.push(full)
		this.changed()
		return full
	}

	remove(id: string): void {
		const before = this.list.length
		this.list = this.list.filter((x) => x.id !== id)
		if (this.list.length !== before) this.changed()
	}

	removeKind(kind: Notice['kind'], input?: string): void {
		const before = this.list.length
		this.list = this.list.filter((x) => !(x.kind === kind && (input === undefined || x.input === input)))
		if (this.list.length !== before) this.changed()
	}

	get(id: string): Notice | undefined {
		return this.list.find((x) => x.id === id)
	}
}

// ---- PFL and solo (monitoring only: the stream and recording are never touched) ----

/** PFL on = OBS monitoring "monitor and output" (monitor-only would cut the input from the output) */
export const pflOn = (m: MonitorType) => m !== 'none'

export class Monitoring {
	/** The input being soloed, and everyone's monitoring before it started */
	solo: string | null = null
	#saved = new Map<string, MonitorType>()

	constructor(private readonly host: FeatureHost) {}

	async setPfl(inp: InputInfo, on: boolean): Promise<void> {
		if (this.solo) {
			// while soloed, change what comes back afterwards
			this.#saved.set(inp.name, on ? 'both' : 'none')
			this.host.changed()
			return
		}
		if (on && this.host.pflMode() === 'exclusive') {
			for (const other of this.host.inputs.values()) {
				if (other !== inp && pflOn(other.monitor)) await this.host.setMonitor(other, 'none')
			}
		}
		await this.host.setMonitor(inp, on ? 'both' : 'none')
	}

	async setSolo(inp: InputInfo, on: boolean): Promise<void> {
		if (on) {
			if (this.solo === inp.name) return
			if (!this.solo) {
				this.#saved.clear()
				for (const i of this.host.inputs.values()) this.#saved.set(i.name, i.monitor)
			}
			this.solo = inp.name
			for (const i of this.host.inputs.values()) {
				const want: MonitorType = i === inp ? 'both' : 'none'
				if (i.monitor !== want) await this.host.setMonitor(i, want)
			}
		} else {
			if (this.solo !== inp.name) return
			this.solo = null
			for (const i of this.host.inputs.values()) {
				const back = this.#saved.get(i.name) ?? 'none'
				if (i.monitor !== back) await this.host.setMonitor(i, back)
			}
			this.#saved.clear()
		}
		this.host.changed()
	}

	/** The PFL state to show for an input (while soloed, what comes back afterwards) */
	pflShown(inp: InputInfo): boolean {
		if (this.solo) return pflOn(this.#saved.get(inp.name) ?? 'none')
		return pflOn(inp.monitor)
	}
}

// ---- backup feeds ------------------------------------------------------------

interface Pair {
	/** backup input name -> its state */
	state: 'normal' | 'on-backup'
	reason: string
	since: number | undefined
	healthySince: number | undefined
	askedAt: number | undefined
	snoozedUntil: number
	/** smoothed incoming levels and the usual difference between them */
	m: number | null
	b: number | null
	offset: number | null
	mainLevel: Db
	backupLevel: Db
}

const peakOf = (inp: InputInfo): Db => inp.prePeak.reduce<Db>((a, x) => (x !== null && (a === null || x > a) ? x : a), null)

export class Backups {
	pairs = new Map<string, Pair>()
	#lastT = 0

	constructor(
		private readonly host: FeatureHost,
		private readonly notices: Notices,
	) {}

	/** The main input a backup is for, if it exists */
	mainOf(backup: InputInfo): InputInfo | undefined {
		const name = this.host.settings(backup.name).backupOf
		return name && name !== backup.name ? this.host.inputs.get(name) : undefined
	}

	#pair(backupName: string): Pair {
		let p = this.pairs.get(backupName)
		if (!p) {
			p = { state: 'normal', reason: '', since: undefined, healthySince: undefined, askedAt: undefined, snoozedUntil: 0, m: null, b: null, offset: null, mainLevel: 0, backupLevel: null }
			this.pairs.set(backupName, p)
		}
		return p
	}

	/** Called on each meter update */
	check(t: number): void {
		const dt = this.#lastT ? Math.min(1, (t - this.#lastT) / 1000) : 0.05
		this.#lastT = t
		for (const backup of this.host.inputs.values()) {
			const main = this.mainOf(backup)
			if (!main) {
				this.pairs.delete(backup.name)
				continue
			}
			const set = this.host.settings(backup.name)
			const p = this.#pair(backup.name)
			const smooth = (prev: number | null, v: Db) => (v === null ? null : prev === null ? v : prev + (v - prev) * Math.min(1, dt / 0.3))
			p.m = smooth(p.m, peakOf(main))
			p.b = smooth(p.b, peakOf(backup))
			const mainDead = p.m === null || p.m < set.backupDeadDb
			const backupAlive = p.b !== null && p.b >= set.backupDeadDb
			let deviating = false
			if (!mainDead && backupAlive && p.m !== null && p.b !== null) {
				const diff = p.m - p.b
				if (p.offset === null) p.offset = diff
				deviating = Math.abs(diff - p.offset) > set.backupDeviationDb
				if (!deviating && p.state === 'normal') p.offset += (diff - p.offset) * Math.min(1, dt / 10)
			}
			const wrong = backupAlive && (mainDead || deviating)

			if (p.state === 'normal') {
				if (!wrong || !set.backupAuto) {
					p.since = undefined
					continue
				}
				p.since ??= t
				if (t - p.since >= set.backupDetectMs) {
					const why = mainDead ? 'the main dropped out (no signal)' : `the main went ${p.m! - p.b! > (p.offset ?? 0) ? 'much louder' : 'much quieter'} than the backup`
					this.switchToBackup(backup, why)
				}
			} else {
				const healthy = !mainDead && !deviating
				if (!healthy) {
					p.healthySince = undefined
					continue
				}
				p.healthySince ??= t
				if (t - p.healthySince >= set.backupRecoverMs && !p.askedAt && Date.now() >= p.snoozedUntil) {
					p.askedAt = t
					this.notices.add({
						kind: 'backup-back',
						input: backup.name,
						title: `${main.name} is back`,
						message: `${main.name} has looked healthy for ${Math.round(set.backupRecoverMs / 1000)} s. You're still on the backup, ${backup.name}. It won't switch back by itself.`,
						actions: [
							{ id: 'take', label: `Take ${main.name}` },
							{ id: 'snooze', label: 'Snooze' },
							{ id: 'swap', label: 'Swap roles' },
							{ id: 'dismiss', label: 'Dismiss' },
						],
					})
				}
			}
		}
	}

	switchToBackup(backup: InputInfo, why: string): void {
		const main = this.mainOf(backup)
		if (!main) return
		const p = this.#pair(backup.name)
		if (p.state === 'on-backup') return
		const set = this.host.settings(backup.name)
		p.state = 'on-backup'
		p.reason = why
		p.mainLevel = main.volumeDb
		p.backupLevel = backup.volumeDb
		p.healthySince = undefined
		p.askedAt = undefined
		p.since = undefined
		this.host.fadeTo(main, null, set.backupFadeMs)
		this.host.fadeTo(backup, p.mainLevel ?? 0, set.backupFadeMs)
		this.host.log('warn', `Switched ${main.name} to its backup ${backup.name}: ${why}`)
		this.notices.removeKind('backup-back', backup.name)
		this.notices.add({
			kind: 'backup-switched',
			input: backup.name,
			title: `Switched to backup: ${backup.name}`,
			message: `${main.name} → ${backup.name} at ${new Date().toLocaleTimeString()}, because ${why}.`,
			actions: [{ id: 'dismiss', label: 'OK' }],
		})
		this.host.changed()
	}

	switchToMain(backup: InputInfo): void {
		const main = this.mainOf(backup)
		const p = this.pairs.get(backup.name)
		if (!main || !p || p.state !== 'on-backup') return
		const set = this.host.settings(backup.name)
		this.host.fadeTo(main, p.mainLevel ?? 0, set.backupFadeMs)
		this.host.fadeTo(backup, p.backupLevel, set.backupFadeMs)
		p.state = 'normal'
		p.since = undefined
		p.offset = null
		this.notices.removeKind('backup-back', backup.name)
		this.notices.removeKind('backup-switched', backup.name)
		this.host.log('info', `Back on ${main.name} (from backup ${backup.name})`)
		this.host.changed()
	}

	/** The backup becomes the main and the main becomes its backup. Nothing moves. */
	swap(backup: InputInfo): void {
		const main = this.mainOf(backup)
		const p = this.pairs.get(backup.name)
		if (!main || !p) return
		const auto = this.host.settings(backup.name).backupAuto
		this.host.setInputSetting(backup.name, 'backupOf', '')
		this.host.setInputSetting(main.name, 'backupOf', backup.name)
		this.host.setInputSetting(main.name, 'backupAuto', auto)
		this.pairs.delete(backup.name)
		const np = this.#pair(main.name)
		np.state = 'normal'
		np.mainLevel = p.backupLevel
		this.notices.removeKind('backup-back', backup.name)
		this.notices.removeKind('backup-switched', backup.name)
		this.host.log('info', `${backup.name} is now the main, with ${main.name} as its backup`)
		this.host.changed()
	}

	snooze(backup: InputInfo): void {
		const p = this.pairs.get(backup.name)
		if (!p) return
		p.snoozedUntil = Date.now() + this.host.settings(backup.name).backupSnoozeMs
		p.askedAt = undefined
		p.healthySince = undefined
		this.notices.removeKind('backup-back', backup.name)
	}

	onBackup(backupName: string): boolean {
		return this.pairs.get(backupName)?.state === 'on-backup'
	}
}

// ---- recording ---------------------------------------------------------------

const RECORDING_EXT = /\.(mkv|mp4|mov|flv|ts|m3u8|fmp4|hybrid_mp4|webm)$/i

export interface RecordState {
	active: boolean
	paused: boolean
	timecode: string
	lastFile: string
	directory: string
	filenameFormat: string
	fileCount: number | null
}

export class Recorder {
	state: RecordState = { active: false, paused: false, timecode: '', lastFile: '', directory: '', filenameFormat: '', fileCount: null }
	#timer: NodeJS.Timeout
	#promptShownFor = ''

	constructor(
		private readonly host: FeatureHost,
		private readonly notices: Notices,
	) {
		this.#timer = setInterval(() => void this.#tick(), 1000)
	}

	destroy(): void {
		clearInterval(this.#timer)
	}

	async refresh(): Promise<void> {
		try {
			const st = await this.host.call<{ outputActive: boolean; outputPaused: boolean; outputTimecode: string }>('GetRecordStatus')
			this.state.active = !!st.outputActive
			this.state.paused = !!st.outputPaused
			this.state.timecode = st.outputTimecode ?? ''
		} catch {
			/* not essential */
		}
		try {
			const d = await this.host.call<{ recordDirectory: string }>('GetRecordDirectory')
			this.state.directory = d.recordDirectory ?? ''
		} catch {
			/* not essential */
		}
		try {
			const f = await this.host.call<{ parameterValue: string | null; defaultParameterValue: string | null }>('GetProfileParameter', {
				parameterCategory: 'Output',
				parameterName: 'FilenameFormatting',
			})
			this.state.filenameFormat = f.parameterValue ?? f.defaultParameterValue ?? ''
		} catch {
			/* not essential */
		}
		await this.#countFiles()
		this.host.changed()
	}

	async #countFiles(): Promise<void> {
		const dir = this.state.directory
		if (!dir) {
			this.state.fileCount = null
			return
		}
		try {
			const names = await readdir(dir)
			this.state.fileCount = names.filter((n) => RECORDING_EXT.test(n)).length
		} catch {
			this.state.fileCount = null // OBS is on another computer, or the folder can't be read from here
		}
	}

	onEvent(d: Record<string, unknown>): void {
		const s = String(d.outputState ?? '')
		this.state.active = !!d.outputActive
		this.state.paused = s === 'OBS_WEBSOCKET_OUTPUT_PAUSED'
		if (typeof d.outputPath === 'string' && d.outputPath) this.state.lastFile = d.outputPath
		if (s === 'OBS_WEBSOCKET_OUTPUT_STOPPED' || s === 'OBS_WEBSOCKET_OUTPUT_STARTED') void this.#countFiles().then(() => this.host.changed())
		if (this.state.active) {
			// a start satisfies any plan
			const plan = this.host.plan()
			if (plan.nextStart) {
				plan.nextStart = null
				plan.dismissed = false
				plan.snoozedUntil = null
				this.host.savePlan()
			}
			this.notices.removeKind('record-due')
		}
		this.host.changed()
	}

	start(): Promise<unknown> {
		return this.host.call('StartRecord')
	}

	stop(): Promise<unknown> {
		return this.host.call('StopRecord')
	}

	pause(on: boolean): Promise<unknown> {
		return this.host.call(on ? 'PauseRecord' : 'ResumeRecord')
	}

	/** Plan the next start: ISO time (or null to clear), and whether to start by itself */
	setPlan(nextStart: string | null, autoStart: boolean): void {
		const plan = this.host.plan()
		plan.nextStart = nextStart
		plan.autoStart = autoStart
		plan.snoozedUntil = null
		plan.dismissed = false
		this.#promptShownFor = ''
		this.notices.removeKind('record-due')
		this.host.savePlan()
		this.host.changed()
	}

	snoozePrompt(): void {
		const plan = this.host.plan()
		plan.snoozedUntil = new Date(Date.now() + this.host.recordSnoozeMin() * 60000).toISOString()
		this.#promptShownFor = ''
		this.notices.removeKind('record-due')
		this.host.savePlan()
	}

	dismissPrompt(): void {
		const plan = this.host.plan()
		plan.dismissed = true
		this.notices.removeKind('record-due')
		this.host.savePlan()
	}

	async setDirectory(dir: string): Promise<void> {
		await this.host.call('SetRecordDirectory', { recordDirectory: dir })
		this.state.directory = dir
		await this.#countFiles()
		this.host.changed()
	}

	/** OBS's file name format, e.g. 'Conference %CCYY-%MM-%DD %hh-%mm-%ss' */
	async setFilenameFormat(format: string): Promise<void> {
		await this.host.call('SetProfileParameter', { parameterCategory: 'Output', parameterName: 'FilenameFormatting', parameterValue: format })
		this.state.filenameFormat = format
		this.host.changed()
	}

	/** Seconds until the planned start, or null */
	countdown(): number | null {
		const plan = this.host.plan()
		if (!plan.nextStart) return null
		return Math.round((Date.parse(plan.nextStart) - Date.now()) / 1000)
	}

	async #tick(): Promise<void> {
		if (!this.host.connected()) return
		if (this.state.active) {
			try {
				const st = await this.host.call<{ outputTimecode: string; outputPaused: boolean }>('GetRecordStatus')
				this.state.timecode = st.outputTimecode ?? ''
				this.state.paused = !!st.outputPaused
				this.host.changed()
			} catch {
				/* next time */
			}
			return
		}
		const plan = this.host.plan()
		if (!plan.nextStart) return
		const due = Date.parse(plan.nextStart)
		const now = Date.now()
		if (plan.autoStart) {
			if (now >= due) {
				this.host.log('info', 'Starting the planned recording')
				try {
					await this.start()
				} catch (e) {
					this.host.log('warn', `Couldn't start the planned recording: ${(e as Error).message}`)
				}
			}
			return
		}
		const lead = this.host.recordLeadMin() * 60000
		const snoozed = plan.snoozedUntil && Date.parse(plan.snoozedUntil) > now
		if (now >= due - lead && !plan.dismissed && !snoozed && this.#promptShownFor !== plan.nextStart + (plan.snoozedUntil ?? '')) {
			this.#promptShownFor = plan.nextStart + (plan.snoozedUntil ?? '')
			const at = new Date(due).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
			this.notices.add({
				kind: 'record-due',
				title: 'Start recording?',
				message: now >= due ? `Recording was due to start at ${at}.` : `Recording is due to start at ${at}.`,
				actions: [
					{ id: 'start', label: 'Start recording' },
					{ id: 'snooze', label: `Snooze ${this.host.recordSnoozeMin()} min` },
					{ id: 'newtime', label: 'Set a new time' },
					{ id: 'dismiss', label: 'Dismiss' },
				],
			})
		}
	}
}
