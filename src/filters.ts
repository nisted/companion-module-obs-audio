/**
 * OBS's built-in audio filters and their settings, from obs-studio's
 * plugins/obs-filters (checked 1 Nov 2026). Kind ids here are unversioned
 * ('noise_suppress_filter'); the real kind (e.g. 'noise_suppress_filter_v2')
 * is looked up from OBS on connect.
 */

export interface FilterParam {
	key: string
	label: string
	type: 'number' | 'choice' | 'text'
	min?: number
	max?: number
	step?: number
	unit?: string
	default: number | string
	choices?: { id: string; label: string }[]
}

export interface FilterKind {
	kind: string
	label: string
	defaultName: string
	params: FilterParam[]
}

const detector: FilterParam = {
	key: 'detector',
	label: 'Detector',
	type: 'choice',
	default: 'RMS',
	choices: [
		{ id: 'RMS', label: 'RMS' },
		{ id: 'peak', label: 'Peak' },
	],
}

export const FILTER_KINDS: FilterKind[] = [
	{
		kind: 'noise_suppress_filter',
		label: 'Noise suppression',
		defaultName: 'Noise Suppression',
		params: [
			{
				key: 'method',
				label: 'Method',
				type: 'choice',
				default: 'rnnoise',
				choices: [
					{ id: 'speex', label: 'Speex' },
					{ id: 'rnnoise', label: 'RNNoise' },
					{ id: 'nvafx_denoiser', label: 'NVIDIA noise removal' },
				],
			},
			{ key: 'suppress_level', label: 'Suppression (Speex)', type: 'number', min: -60, max: 0, step: 1, unit: 'dB', default: -30 },
		],
	},
	{
		kind: 'noise_gate_filter',
		label: 'Noise gate',
		defaultName: 'Noise Gate',
		params: [
			{ key: 'open_threshold', label: 'Open threshold', type: 'number', min: -96, max: 0, step: 0.1, unit: 'dB', default: -26 },
			{ key: 'close_threshold', label: 'Close threshold', type: 'number', min: -96, max: 0, step: 0.1, unit: 'dB', default: -32 },
			{ key: 'attack_time', label: 'Attack', type: 'number', min: 0, max: 10000, step: 1, unit: 'ms', default: 25 },
			{ key: 'hold_time', label: 'Hold', type: 'number', min: 0, max: 10000, step: 1, unit: 'ms', default: 200 },
			{ key: 'release_time', label: 'Release', type: 'number', min: 0, max: 10000, step: 1, unit: 'ms', default: 150 },
		],
	},
	{
		kind: 'expander_filter',
		label: 'Expander',
		defaultName: 'Expander',
		params: [
			{
				key: 'presets',
				label: 'Preset',
				type: 'choice',
				default: 'expander',
				choices: [
					{ id: 'expander', label: 'Expander' },
					{ id: 'gate', label: 'Gate' },
				],
			},
			{ key: 'ratio', label: 'Ratio', type: 'number', min: 1, max: 20, step: 0.1, unit: ':1', default: 2 },
			{ key: 'threshold', label: 'Threshold', type: 'number', min: -60, max: 0, step: 0.1, unit: 'dB', default: -40 },
			{ key: 'attack_time', label: 'Attack', type: 'number', min: 1, max: 100, step: 1, unit: 'ms', default: 10 },
			{ key: 'release_time', label: 'Release', type: 'number', min: 1, max: 1000, step: 1, unit: 'ms', default: 50 },
			{ key: 'output_gain', label: 'Output gain', type: 'number', min: -32, max: 32, step: 0.1, unit: 'dB', default: 0 },
			detector,
		],
	},
	{
		kind: 'basic_eq_filter',
		label: '3-band EQ',
		defaultName: '3-Band Equalizer',
		params: [
			{ key: 'low', label: 'Low', type: 'number', min: -20, max: 20, step: 0.1, unit: 'dB', default: 0 },
			{ key: 'mid', label: 'Mid', type: 'number', min: -20, max: 20, step: 0.1, unit: 'dB', default: 0 },
			{ key: 'high', label: 'High', type: 'number', min: -20, max: 20, step: 0.1, unit: 'dB', default: 0 },
		],
	},
	{
		kind: 'compressor_filter',
		label: 'Compressor',
		defaultName: 'Compressor',
		params: [
			{ key: 'ratio', label: 'Ratio', type: 'number', min: 1, max: 32, step: 0.5, unit: ':1', default: 10 },
			{ key: 'threshold', label: 'Threshold', type: 'number', min: -60, max: 0, step: 0.1, unit: 'dB', default: -18 },
			{ key: 'attack_time', label: 'Attack', type: 'number', min: 1, max: 500, step: 1, unit: 'ms', default: 6 },
			{ key: 'release_time', label: 'Release', type: 'number', min: 1, max: 1000, step: 1, unit: 'ms', default: 60 },
			{ key: 'output_gain', label: 'Output gain', type: 'number', min: -32, max: 32, step: 0.1, unit: 'dB', default: 0 },
			{ key: 'sidechain_source', label: 'Sidechain source', type: 'text', default: 'none' },
		],
	},
	{
		kind: 'upward_compressor_filter',
		label: 'Upward compressor',
		defaultName: 'Upward Compressor',
		params: [
			{ key: 'ratio', label: 'Ratio', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5 },
			{ key: 'threshold', label: 'Threshold', type: 'number', min: -60, max: 0, step: 0.1, unit: 'dB', default: -20 },
			{ key: 'attack_time', label: 'Attack', type: 'number', min: 1, max: 100, step: 1, unit: 'ms', default: 10 },
			{ key: 'release_time', label: 'Release', type: 'number', min: 1, max: 1000, step: 1, unit: 'ms', default: 50 },
			{ key: 'output_gain', label: 'Output gain', type: 'number', min: -32, max: 32, step: 0.1, unit: 'dB', default: 0 },
			{ key: 'knee_width', label: 'Knee width', type: 'number', min: 0, max: 20, step: 0.1, unit: 'dB', default: 10 },
			detector,
		],
	},
	{
		kind: 'limiter_filter',
		label: 'Limiter',
		defaultName: 'Limiter',
		params: [
			{ key: 'threshold', label: 'Threshold', type: 'number', min: -60, max: 0, step: 0.1, unit: 'dB', default: -6 },
			{ key: 'release_time', label: 'Release', type: 'number', min: 1, max: 1000, step: 1, unit: 'ms', default: 60 },
		],
	},
	{
		kind: 'gain_filter',
		label: 'Gain',
		defaultName: 'Gain',
		params: [{ key: 'db', label: 'Gain', type: 'number', min: -30, max: 30, step: 0.1, unit: 'dB', default: 0 }],
	},
]

export function unversioned(kind: string): string {
	return kind.replace(/_v\d+$/, '')
}

export function filterKind(kind: string): FilterKind | undefined {
	const k = unversioned(kind)
	return FILTER_KINDS.find((f) => f.kind === k)
}

/** Every known setting, for action dropdowns: id 'kind:key' */
export const ALL_FILTER_PARAMS = FILTER_KINDS.flatMap((f) =>
	f.params.map((p) => ({ id: `${f.kind}:${p.key}`, label: `${f.label}: ${p.label}`, kind: f, param: p })),
)

export function slug(text: string): string {
	return (
		text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '_')
			.replace(/^_+|_+$/g, '') || 'x'
	)
}
