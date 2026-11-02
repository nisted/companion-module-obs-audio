/**
 * Everything the module remembers: module-wide settings, the page-wide
 * defaults each input starts from, per-input overrides and per-input state.
 * It's saved into the connection's config, so it survives restarts, travels
 * with a Companion export and with Companion Sync.
 */

import type { LawKind } from './law.js'

export type ControlMode = 'fader' | 'trim'
export type Measure = 'rms' | 'peak'
export type StereoMode = 'max' | 'avg'
export type CaptureMode = 'average' | 'instant'
export type RideBack = 'target' | 'band'
export type QuietMode = 'freeze' | 'drift'
export type MoveMode = 'glide' | 'jump'
export type GrabMode = 'retarget' | 'pause' | 'off'
export type SectionMode = 'hidden' | 'open' | 'collapsible'

/** Per-input settings. The defaults hold every one; inputs override some. */
export interface InputSettings {
	riderOn: boolean
	controlMode: ControlMode
	trimFilterName: string
	measure: Measure
	measureWindowMs: number
	stereo: StereoMode
	captureMode: CaptureMode
	captureWindowMs: number
	bandDb: number
	rideBack: RideBack
	rideRateDbPerS: number
	settleDb: number
	maxBoostDb: number
	maxCutDb: number
	floorDb: number
	ceilingDb: number
	quietMode: QuietMode
	quietThresholdDb: number
	quietDriftAfterMs: number
	driftRateDbPerS: number
	calibrateDb: number
	calibrateSetsTarget: boolean
	calibrateMove: MoveMode
	calibrateRateDbPerS: number
	grab: GrabMode
	grabPauseMs: number
	backupOf: string
	backupAuto: boolean
	backupDeadDb: number
	backupDeviationDb: number
	backupDetectMs: number
	backupFadeMs: number
	backupRecoverMs: number
	backupSnoozeMs: number
}

export const INPUT_DEFAULTS: InputSettings = {
	riderOn: false,
	controlMode: 'fader',
	trimFilterName: 'Auto gain trim',
	measure: 'rms',
	measureWindowMs: 2000,
	stereo: 'max',
	captureMode: 'average',
	captureWindowMs: 3000,
	bandDb: 3,
	rideBack: 'target',
	rideRateDbPerS: 2,
	settleDb: 0.5,
	maxBoostDb: 6,
	maxCutDb: 10,
	floorDb: -40,
	ceilingDb: 10,
	quietMode: 'freeze',
	quietThresholdDb: -50,
	quietDriftAfterMs: 10000,
	driftRateDbPerS: 1,
	calibrateDb: -18,
	calibrateSetsTarget: true,
	calibrateMove: 'glide',
	calibrateRateDbPerS: 6,
	grab: 'retarget',
	grabPauseMs: 3000,
	backupOf: '',
	backupAuto: false,
	backupDeadDb: -60,
	backupDeviationDb: 12,
	backupDetectMs: 1500,
	backupFadeMs: 500,
	backupRecoverMs: 5000,
	backupSnoozeMs: 300000,
}

interface FieldInfo {
	label: string
	type: 'bool' | 'number' | 'choice' | 'text' | 'input'
	min?: number
	max?: number
	step?: number
	unit?: string
	choices?: { id: string; label: string }[]
	/** Tooltip: what it does, in plain words */
	help: string
	/** Which group it's shown in on the page */
	group: 'rider' | 'capture' | 'limits' | 'quiet' | 'calibrate' | 'backup'
}

/** Labels, ranges, choices and tooltips for each input setting: used by actions and the web page */
export const INPUT_FIELDS: Record<keyof InputSettings, FieldInfo> = {
	riderOn: { label: 'Rider on', type: 'bool', group: 'rider', help: 'Keeps this input near its target level by moving the fader (or trim) for you. Like having an op ride it, minus the tea breaks.' },
	controlMode: {
		label: 'Auto gain moves',
		type: 'choice',
		group: 'rider',
		choices: [
			{ id: 'fader', label: 'OBS fader' },
			{ id: 'trim', label: 'Trim (Gain filter)' },
		],
		help: 'What auto gain gets its hands on. OBS fader: rides the fader and measures after it. Trim: adds a Gain filter before the fader and rides that, so the fader stays yours.',
	},
	trimFilterName: { label: 'Trim filter name', type: 'text', group: 'rider', help: 'The name of the Gain filter used as trim. If the input hasn\'t got one, I\'ll add it.' },
	measure: {
		label: 'Rider listens to',
		type: 'choice',
		group: 'rider',
		choices: [
			{ id: 'rms', label: 'Average level' },
			{ id: 'peak', label: 'Peaks' },
		],
		help: 'Average level follows loudness the way your ears do and shrugs off single loud moments. Peaks reacts to every transient, so it moves more often.',
	},
	measureWindowMs: { label: 'Listening window', type: 'number', group: 'rider', min: 100, max: 30000, step: 100, unit: 'ms', help: 'How much recent audio the rider averages before it makes its mind up. Longer = calmer, but slower to react.' },
	stereo: {
		label: 'Stereo',
		type: 'choice',
		group: 'rider',
		choices: [
			{ id: 'max', label: 'Louder side' },
			{ id: 'avg', label: 'Both sides averaged' },
		],
		help: 'For stereo inputs: follow the louder side (keeps the image, moves both together) or the average of both.',
	},
	bandDb: { label: 'Leave alone within ±', type: 'number', group: 'rider', min: 0, max: 30, step: 0.5, unit: 'dB', help: 'How far the level can wander from the target before the rider steps in. Inside this band, nothing moves.' },
	rideBack: {
		label: 'When it rides, go back',
		type: 'choice',
		group: 'rider',
		choices: [
			{ id: 'target', label: 'All the way to the target' },
			{ id: 'band', label: 'Just inside the band' },
		],
		help: 'All the way: rides until the level is back on the target. Just inside: stops as soon as it\'s back in the band (smaller, fewer moves).',
	},
	rideRateDbPerS: { label: 'Riding speed', type: 'number', group: 'rider', min: 0.1, max: 60, step: 0.1, unit: 'dB/s', help: 'How fast the rider moves the fader. Slow is gentle and harder to hear; fast catches big changes sooner.' },
	settleDb: { label: 'Close enough within', type: 'number', group: 'rider', min: 0.1, max: 10, step: 0.1, unit: 'dB', help: 'How close to the target counts as close enough, so it can stop moving.' },
	grab: {
		label: 'If you move the fader',
		type: 'choice',
		group: 'rider',
		choices: [
			{ id: 'retarget', label: 'Where you leave it is the new target' },
			{ id: 'pause', label: 'Rider pauses, same target' },
			{ id: 'off', label: 'Rider switches off' },
		],
		help: 'What happens when you (or anyone else) move the fader while the rider is on.',
	},
	grabPauseMs: { label: 'Pause after an outside move', type: 'number', group: 'rider', min: 0, max: 60000, step: 100, unit: 'ms', help: 'With "Rider pauses": how long it waits after someone else moves the fader before it starts riding again.' },
	captureMode: {
		label: '"This level please" takes',
		type: 'choice',
		group: 'capture',
		choices: [
			{ id: 'average', label: 'An average over a few seconds' },
			{ id: 'instant', label: 'The level right now' },
		],
		help: 'How the target is captured when you press "This level please" (or calibrate). An average won\'t be thrown by one loud or quiet moment.',
	},
	captureWindowMs: { label: 'Averaging time', type: 'number', group: 'capture', min: 100, max: 30000, step: 100, unit: 'ms', help: 'How long it listens for when capturing an average.' },
	maxBoostDb: { label: 'Never boost more than', type: 'number', group: 'limits', min: 0, max: 60, step: 0.5, unit: 'dB', help: 'The most the rider will push up from where the target was set. Stops it chasing a dead mic all the way to full gain.' },
	maxCutDb: { label: 'Never cut more than', type: 'number', group: 'limits', min: 0, max: 100, step: 0.5, unit: 'dB', help: 'The most the rider will pull down from where the target was set.' },
	floorDb: { label: 'Never below', type: 'number', group: 'limits', min: -100, max: 26, step: 0.5, unit: 'dB', help: 'The lowest fader (or trim) setting the rider is ever allowed, full stop.' },
	ceilingDb: { label: 'Never above', type: 'number', group: 'limits', min: -100, max: 26, step: 0.5, unit: 'dB', help: 'The highest fader (or trim) setting the rider is ever allowed, full stop.' },
	quietMode: {
		label: 'When the input goes quiet',
		type: 'choice',
		group: 'quiet',
		choices: [
			{ id: 'freeze', label: 'Hold still' },
			{ id: 'drift', label: 'Hold, then drift back to the set point' },
		],
		help: 'In pauses (nobody talking) the rider holds still rather than cranking up into silence. Drift back slowly returns it to where the target was set if the quiet goes on.',
	},
	quietThresholdDb: { label: 'Quiet means below', type: 'number', group: 'quiet', min: -100, max: 0, step: 1, unit: 'dB', help: 'Below this incoming level (peak, before trim and fader), the input counts as quiet.' },
	quietDriftAfterMs: { label: 'Drift back after', type: 'number', group: 'quiet', min: 0, max: 600000, step: 500, unit: 'ms', help: 'With "Hold, then drift back": how long it has to stay quiet before drifting.' },
	driftRateDbPerS: { label: 'Drift speed', type: 'number', group: 'quiet', min: 0.1, max: 60, step: 0.1, unit: 'dB/s', help: 'How fast it drifts back. Gently does it.' },
	calibrateDb: { label: 'Calibrate this input to', type: 'number', group: 'calibrate', min: -60, max: 10, step: 0.5, unit: 'dB', help: 'The level a double tap (or the "Cal" button) brings this input to.' },
	calibrateSetsTarget: { label: 'Calibrate also sets the target', type: 'bool', group: 'calibrate', help: 'After calibrating, the rider holds that level (until you next press "This level please").' },
	calibrateMove: {
		label: 'Calibrate moves by',
		type: 'choice',
		group: 'calibrate',
		choices: [
			{ id: 'glide', label: 'Gliding there' },
			{ id: 'jump', label: 'Jumping there' },
		],
		help: 'Glide moves the fader smoothly; jump gets it there straight away.',
	},
	calibrateRateDbPerS: { label: 'Calibrate glide speed', type: 'number', group: 'calibrate', min: 0.1, max: 100, step: 0.5, unit: 'dB/s', help: 'How fast a calibrate glides.' },
	backupOf: { label: 'This is the backup for', type: 'input', group: 'backup', help: 'Make this input the backup feed for another input (the main). Its fader normally sits down; on a switch, it takes over.' },
	backupAuto: { label: 'Switch to backup automatically', type: 'bool', group: 'backup', help: 'If the main drops out, or goes very high or low while this backup looks healthy, I crossfade to this backup and tell you what happened. I never switch back by myself.' },
	backupDeadDb: { label: 'Main counts as dropped below', type: 'number', group: 'backup', min: -100, max: 0, step: 1, unit: 'dB', help: 'If the main\'s incoming level stays below this while the backup is above it, the main counts as dropped.' },
	backupDeviationDb: { label: 'Or differs from backup by more than', type: 'number', group: 'backup', min: 1, max: 60, step: 1, unit: 'dB', help: 'Main and backup normally sit at a steady difference. If the main strays this far from that (very high or very low), something\'s up.' },
	backupDetectMs: { label: 'For at least', type: 'number', group: 'backup', min: 100, max: 60000, step: 100, unit: 'ms', help: 'How long the main has to look wrong before switching, so one little glitch doesn\'t set it off.' },
	backupFadeMs: { label: 'Crossfade time', type: 'number', group: 'backup', min: 0, max: 10000, step: 50, unit: 'ms', help: 'How long the crossfade between main and backup takes (no clicks, please).' },
	backupRecoverMs: { label: 'Main counts as back after', type: 'number', group: 'backup', min: 500, max: 600000, step: 500, unit: 'ms', help: 'How long the main has to look healthy again before I ask whether you want it back.' },
	backupSnoozeMs: { label: 'Snooze asks again after', type: 'number', group: 'backup', min: 10000, max: 3600000, step: 10000, unit: 'ms', help: 'When you snooze the "main is back" question, how long before I ask again.' },
}

export const INPUT_SETTING_KEYS = Object.keys(INPUT_DEFAULTS) as (keyof InputSettings)[]

/** Controls that can be placed in strip sections */
export const CONTROLS: { id: string; label: string }[] = [
	{ id: 'mute', label: 'Mute' },
	{ id: 'monitor', label: 'Monitoring' },
	{ id: 'balance', label: 'Balance' },
	{ id: 'sync', label: 'Sync offset' },
	{ id: 'trim', label: 'Trim' },
	{ id: 'noise_suppress_filter', label: 'Noise suppression' },
	{ id: 'noise_gate_filter', label: 'Noise gate' },
	{ id: 'expander_filter', label: 'Expander' },
	{ id: 'basic_eq_filter', label: '3-band EQ' },
	{ id: 'compressor_filter', label: 'Compressor' },
	{ id: 'upward_compressor_filter', label: 'Upward compressor' },
	{ id: 'limiter_filter', label: 'Limiter' },
	{ id: 'gain_filter', label: 'Gain filters (other)' },
	{ id: 'backup', label: 'Backup feed' },
	{ id: 'tracks', label: 'Recording tracks' },
]

export interface Section {
	id: string
	name: string
	controls: string[]
	mode: SectionMode
}

export const STARTER_SECTIONS: Section[] = [
	{ id: 'input', name: 'Input', controls: ['trim', 'balance', 'sync', 'backup'], mode: 'collapsible' },
	{
		id: 'processing',
		name: 'Processing',
		controls: [
			'noise_suppress_filter',
			'noise_gate_filter',
			'expander_filter',
			'basic_eq_filter',
			'compressor_filter',
			'upward_compressor_filter',
			'limiter_filter',
		],
		mode: 'collapsible',
	},
	{ id: 'tracks', name: 'Tracks', controls: ['tracks'], mode: 'collapsible' },
]

export interface PageSettings {
	layout: 'strips' | 'rows'
	law: LawKind
	faderTopDb: number
	faderBottomDb: number
	meterFloorDb: number
	meterTopDb: number
	showPre: boolean
	showPost: boolean
	peakHoldMs: number
	peakFallDbPerS: number
	greenToDb: number
	yellowToDb: number
	greenColour: string
	yellowColour: string
	redColour: string
	bandColour: string
	ridingColour: string
	targetColour: string
	meterRateHz: number
	fineRatio: number
	doubleTapUnity: boolean
	accentColour: string
	pflMode: 'additive' | 'exclusive'
	soloLatch: boolean
	tooltips: boolean
	tipsOnOpen: boolean
	recordLeadMin: number
	recordSnoozeMin: number
}

export const PAGE_DEFAULTS: PageSettings = {
	layout: 'strips',
	law: 'desk',
	faderTopDb: 10,
	faderBottomDb: -60,
	meterFloorDb: -60,
	meterTopDb: 0,
	showPre: true,
	showPost: true,
	peakHoldMs: 2000,
	peakFallDbPerS: 20,
	greenToDb: -18,
	yellowToDb: -6,
	greenColour: '#4fe07a',
	yellowColour: '#ffd84a',
	redColour: '#ff5a4a',
	bandColour: '#7a2fe0',
	ridingColour: '#5cd8f5',
	targetColour: '#ffffff',
	meterRateHz: 20,
	fineRatio: 0.2,
	doubleTapUnity: true,
	accentColour: '#7a2fe0',
	pflMode: 'additive',
	soloLatch: false,
	tooltips: true,
	tipsOnOpen: true,
	recordLeadMin: 10,
	recordSnoozeMin: 5,
}

export interface GestureSettings {
	doubleTapMs: number
	holdMs: number
}

export const GESTURE_DEFAULTS: GestureSettings = { doubleTapMs: 300, holdMs: 800 }

/** What's remembered for each OBS input, keyed by input name */
export interface InputRecord {
	/** Only the settings that differ from the page-wide defaults */
	overrides: Partial<InputSettings>
	/** Per-input overrides of section modes: section id -> mode */
	sections: Record<string, SectionMode>
	/** Rider target, dB at the measuring point (post-fader in fader mode, pre-fader in trim mode) */
	target: number | null
	/** Control gain when the target was set: the relative limits are measured from here */
	refGain: number | null
}

export interface Store {
	version: 1
	defaults: InputSettings
	page: PageSettings
	gestures: GestureSettings
	/** Calibrate level for press-and-hold */
	moduleCalibrateDb: number
	sections: Section[]
	/** Input display order (names); inputs not listed follow in OBS order */
	order: string[]
	hidden: string[]
	inputs: Record<string, InputRecord>
	/** The next planned recording start, if any */
	record: RecordPlan
}

export interface RecordPlan {
	/** ISO time the recording is due to (re)start, or null */
	nextStart: string | null
	/** Start it automatically at that time */
	autoStart: boolean
	/** The "Start recording?" prompt is snoozed until this ISO time */
	snoozedUntil: string | null
	/** The prompt was dismissed for this nextStart */
	dismissed: boolean
}

export const RECORD_DEFAULTS: RecordPlan = { nextStart: null, autoStart: false, snoozedUntil: null, dismissed: false }

export function newStore(): Store {
	return {
		version: 1,
		defaults: { ...INPUT_DEFAULTS },
		page: { ...PAGE_DEFAULTS },
		gestures: { ...GESTURE_DEFAULTS },
		moduleCalibrateDb: -18,
		sections: STARTER_SECTIONS.map((s) => ({ ...s, controls: [...s.controls] })),
		order: [],
		hidden: [],
		inputs: {},
		record: { ...RECORD_DEFAULTS },
	}
}

function obj(x: unknown): Record<string, unknown> {
	return x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {}
}

/** Keep only known keys of the right type, filling the rest from `base` */
function sanitize<T extends object>(raw: unknown, base: T, partial = false): Partial<T> {
	const src = obj(raw)
	const out: Partial<T> = partial ? {} : { ...base }
	for (const key of Object.keys(base) as (keyof T)[]) {
		const v = src[key as string]
		if (v === undefined) continue
		if (typeof v === typeof base[key]) out[key] = v as T[keyof T]
	}
	return out
}

export function sanitizeInputOverrides(raw: unknown): Partial<InputSettings> {
	return sanitize(raw, INPUT_DEFAULTS, true)
}

function sanitizeSection(raw: unknown, i: number): Section | null {
	const s = obj(raw)
	const mode = s.mode === 'hidden' || s.mode === 'open' || s.mode === 'collapsible' ? s.mode : 'collapsible'
	const known = new Set(CONTROLS.map((c) => c.id))
	return {
		id: typeof s.id === 'string' && s.id ? s.id : `section${i + 1}`,
		name: typeof s.name === 'string' ? s.name : `Section ${i + 1}`,
		controls: Array.isArray(s.controls) ? s.controls.filter((c): c is string => typeof c === 'string' && known.has(c)) : [],
		mode,
	}
}

function sanitizeRecord(raw: unknown): InputRecord {
	const r = obj(raw)
	const sections: Record<string, SectionMode> = {}
	for (const [k, v] of Object.entries(obj(r.sections))) {
		if (v === 'hidden' || v === 'open' || v === 'collapsible') sections[k] = v
	}
	return {
		overrides: sanitizeInputOverrides(r.overrides),
		sections,
		target: typeof r.target === 'number' ? r.target : null,
		refGain: typeof r.refGain === 'number' ? r.refGain : null,
	}
}

export function loadStore(raw: unknown): Store {
	let parsed: unknown = raw
	if (typeof raw === 'string') {
		try {
			parsed = JSON.parse(raw)
		} catch {
			parsed = {}
		}
	}
	const src = obj(parsed)
	const store = newStore()
	store.defaults = sanitize(src.defaults, INPUT_DEFAULTS) as InputSettings
	store.page = sanitize(src.page, PAGE_DEFAULTS) as PageSettings
	store.gestures = sanitize(src.gestures, GESTURE_DEFAULTS) as GestureSettings
	if (typeof src.moduleCalibrateDb === 'number') store.moduleCalibrateDb = src.moduleCalibrateDb
	if (Array.isArray(src.sections)) {
		store.sections = src.sections.map(sanitizeSection).filter((s): s is Section => s !== null)
	}
	if (Array.isArray(src.order)) store.order = src.order.filter((x): x is string => typeof x === 'string')
	if (Array.isArray(src.hidden)) store.hidden = src.hidden.filter((x): x is string => typeof x === 'string')
	for (const [name, rec] of Object.entries(obj(src.inputs))) store.inputs[name] = sanitizeRecord(rec)
	const r = obj(src.record)
	store.record = {
		nextStart: typeof r.nextStart === 'string' ? r.nextStart : null,
		autoStart: r.autoStart === true,
		snoozedUntil: typeof r.snoozedUntil === 'string' ? r.snoozedUntil : null,
		dismissed: r.dismissed === true,
	}
	return store
}

export function inputRecord(store: Store, name: string): InputRecord {
	let rec = store.inputs[name]
	if (!rec) {
		rec = { overrides: {}, sections: {}, target: null, refGain: null }
		store.inputs[name] = rec
	}
	return rec
}

export function effectiveSettings(store: Store, name: string): InputSettings {
	return { ...store.defaults, ...(store.inputs[name]?.overrides ?? {}) }
}

/** Turn typed text into a value for an input setting; undefined if it doesn't fit */
export function coerceSetting(key: keyof InputSettings, raw: unknown): InputSettings[keyof InputSettings] | undefined {
	const field = INPUT_FIELDS[key]
	if (!field) return undefined
	if (field.type === 'bool') {
		if (typeof raw === 'boolean') return raw
		const t = String(raw).trim().toLowerCase()
		if (['1', 'true', 'on', 'yes'].includes(t)) return true
		if (['0', 'false', 'off', 'no'].includes(t)) return false
		return undefined
	}
	if (field.type === 'number') {
		const n = typeof raw === 'number' ? raw : Number(String(raw).trim())
		if (String(raw).trim() === '' || Number.isNaN(n)) return undefined
		return Math.max(field.min ?? -Infinity, Math.min(field.max ?? Infinity, n))
	}
	if (field.type === 'choice') {
		const t = String(raw).trim()
		const c = field.choices?.find((c) => c.id === t || c.label.toLowerCase() === t.toLowerCase())
		return c?.id as InputSettings[keyof InputSettings] | undefined
	}
	return String(raw)
}

/** Parts of an export that can be picked on import */
export type ImportPart = 'page' | 'sections' | 'defaults' | 'gestures' | 'order' | `input:${string}`

export function applyImport(store: Store, incoming: Store, parts: ImportPart[]): void {
	for (const part of parts) {
		if (part === 'page') store.page = { ...incoming.page }
		else if (part === 'sections') store.sections = incoming.sections.map((s) => ({ ...s, controls: [...s.controls] }))
		else if (part === 'defaults') store.defaults = { ...incoming.defaults }
		else if (part === 'gestures') {
			store.gestures = { ...incoming.gestures }
			store.moduleCalibrateDb = incoming.moduleCalibrateDb
		} else if (part === 'order') {
			store.order = [...incoming.order]
			store.hidden = [...incoming.hidden]
		} else if (part.startsWith('input:')) {
			const name = part.slice(6)
			const rec = incoming.inputs[name]
			if (rec) store.inputs[name] = JSON.parse(JSON.stringify(rec)) as InputRecord
		}
	}
}
