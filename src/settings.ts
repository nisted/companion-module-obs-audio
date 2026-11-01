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

/** Per-input auto gain settings. The defaults hold every one; inputs override some. */
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
}

interface FieldInfo {
	label: string
	type: 'bool' | 'number' | 'choice' | 'text'
	min?: number
	max?: number
	step?: number
	unit?: string
	choices?: { id: string; label: string }[]
	help?: string
}

/** Labels, ranges and choices for each input setting: used by actions and the web page */
export const INPUT_FIELDS: Record<keyof InputSettings, FieldInfo> = {
	riderOn: { label: 'Rider on', type: 'bool' },
	controlMode: {
		label: 'Auto gain moves',
		type: 'choice',
		choices: [
			{ id: 'fader', label: 'OBS fader' },
			{ id: 'trim', label: 'Trim (Gain filter)' },
		],
		help: 'Trim: a Gain filter before the fader, so the fader stays yours',
	},
	trimFilterName: { label: 'Trim filter name', type: 'text' },
	measure: {
		label: 'Rider measures',
		type: 'choice',
		choices: [
			{ id: 'rms', label: 'Average (RMS)' },
			{ id: 'peak', label: 'Peak' },
		],
	},
	measureWindowMs: { label: 'Measuring window', type: 'number', min: 100, max: 30000, step: 100, unit: 'ms' },
	stereo: {
		label: 'Stereo',
		type: 'choice',
		choices: [
			{ id: 'max', label: 'Linked, louder side' },
			{ id: 'avg', label: 'Averaged' },
		],
	},
	captureMode: {
		label: '"This level please" captures',
		type: 'choice',
		choices: [
			{ id: 'average', label: 'Average over window' },
			{ id: 'instant', label: 'Instant' },
		],
	},
	captureWindowMs: { label: 'Capture window', type: 'number', min: 100, max: 30000, step: 100, unit: 'ms' },
	bandDb: { label: 'Band (±)', type: 'number', min: 0, max: 30, step: 0.5, unit: 'dB' },
	rideBack: {
		label: 'Ride back',
		type: 'choice',
		choices: [
			{ id: 'target', label: 'To the target' },
			{ id: 'band', label: 'Just inside the band' },
		],
	},
	rideRateDbPerS: { label: 'Ride rate', type: 'number', min: 0.1, max: 60, step: 0.1, unit: 'dB/s' },
	settleDb: { label: 'Settle within', type: 'number', min: 0.1, max: 10, step: 0.1, unit: 'dB', help: 'How close to the target counts as arrived' },
	maxBoostDb: { label: 'Max boost from set point', type: 'number', min: 0, max: 60, step: 0.5, unit: 'dB' },
	maxCutDb: { label: 'Max cut from set point', type: 'number', min: 0, max: 100, step: 0.5, unit: 'dB' },
	floorDb: { label: 'Floor', type: 'number', min: -100, max: 26, step: 0.5, unit: 'dB' },
	ceilingDb: { label: 'Ceiling', type: 'number', min: -100, max: 26, step: 0.5, unit: 'dB' },
	quietMode: {
		label: 'When quiet',
		type: 'choice',
		choices: [
			{ id: 'freeze', label: 'Freeze' },
			{ id: 'drift', label: 'Freeze, then drift back' },
		],
	},
	quietThresholdDb: { label: 'Quiet below', type: 'number', min: -100, max: 0, step: 1, unit: 'dB', help: 'Incoming peak, before trim and fader' },
	quietDriftAfterMs: { label: 'Drift back after', type: 'number', min: 0, max: 600000, step: 500, unit: 'ms' },
	driftRateDbPerS: { label: 'Drift rate', type: 'number', min: 0.1, max: 60, step: 0.1, unit: 'dB/s' },
	calibrateDb: { label: 'Calibrate level', type: 'number', min: -60, max: 10, step: 0.5, unit: 'dB' },
	calibrateSetsTarget: { label: 'Calibrate sets rider target', type: 'bool' },
	calibrateMove: {
		label: 'Calibrate moves',
		type: 'choice',
		choices: [
			{ id: 'glide', label: 'Glide' },
			{ id: 'jump', label: 'Jump' },
		],
	},
	calibrateRateDbPerS: { label: 'Calibrate glide rate', type: 'number', min: 0.1, max: 100, step: 0.5, unit: 'dB/s' },
	grab: {
		label: 'Fader moved while riding',
		type: 'choice',
		choices: [
			{ id: 'retarget', label: 'Where you leave it is the new target' },
			{ id: 'pause', label: 'Rider pauses, same target' },
			{ id: 'off', label: 'Rider switches off' },
		],
	},
	grabPauseMs: { label: 'Pause after an outside move', type: 'number', min: 0, max: 60000, step: 100, unit: 'ms' },
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
	{ id: 'autogain_buttons', label: 'Auto gain: rider, this level, calibrate' },
	{ id: 'autogain_target', label: 'Auto gain: target and status' },
	{ id: 'autogain_settings', label: 'Auto gain: all settings' },
	{ id: 'tracks', label: 'Recording tracks' },
]

export interface Section {
	id: string
	name: string
	controls: string[]
	mode: SectionMode
}

export const STARTER_SECTIONS: Section[] = [
	{ id: 'input', name: 'Input', controls: ['mute', 'monitor', 'balance', 'sync', 'trim'], mode: 'collapsible' },
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
	{
		id: 'autogain',
		name: 'Auto gain',
		controls: ['autogain_buttons', 'autogain_target', 'autogain_settings'],
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
	greenColour: '#2ecc40',
	yellowColour: '#ffd400',
	redColour: '#ff3030',
	bandColour: '#8b5cf6',
	ridingColour: '#00c2ff',
	targetColour: '#ffffff',
	meterRateHz: 20,
	fineRatio: 0.2,
	doubleTapUnity: true,
	accentColour: '#8b5cf6',
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
}

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
