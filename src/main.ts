import {
	InstanceBase,
	InstanceStatus,
	runEntrypoint,
	type CompanionActionContext,
	type CompanionActionDefinitions,
	type CompanionFeedbackDefinitions,
	type CompanionOptionValues,
	type CompanionPresetDefinitions,
	type CompanionVariableDefinition,
	type CompanionVariableValues,
	type DropdownChoice,
	type CompanionInputFieldTextInput,
	type SomeCompanionConfigField,
} from '@companion-module/base'
import { Engine, type InputInfo, type MonitorType } from './engine.js'
import { WebServer } from './web.js'
import { type Db, dbToPosition, fmtDb, parseDb, parseNumber, positionToDb, clamp, MIN_DB } from './law.js'
import { ALL_FILTER_PARAMS, FILTER_KINDS, filterKind, slug } from './filters.js'
import { INPUT_FIELDS, INPUT_SETTING_KEYS, type InputSettings } from './settings.js'
import { RIDER_STATES, type RiderState } from './rider.js'
import { DEFAULT_BAND, DEFAULT_DWELL_MS, DEFAULT_FLASH_MS, DEFAULT_RELEASE_BAND, DEFAULT_RELEASE_MS, NEVER_RELEASE_BAND } from './pickup.js'
import { parseColour, rgb, scaleColour } from './colour.js'

interface Config {
	host: string
	port: number
	password: string
	webPort: number
	webBind: string
	pin: string
	varRateHz: number
	updateHours: number
	/** The module's own settings, saved here by the module (not edited by hand) */
	store?: string
	autosave?: string
}

type Ctx = Pick<CompanionActionContext, 'parseVariablesInString'>

const INPUT_TIP = 'The OBS input name, or its number in the list (1 = first). Can be a variable.'

const inputOption: CompanionInputFieldTextInput = {
	type: 'textinput',
	label: 'Input (name or number)',
	id: 'input',
	default: '1',
	useVariables: true,
	tooltip: INPUT_TIP,
}

const BLACK = rgb(0, 0, 0)

const STATUS_COLOURS: Record<RiderState, string> = {
	off: '',
	holding: '#3b2466',
	riding: '#0077aa',
	frozen: '#555555',
	limit: '#b36b00',
	capturing: '#8b5cf6',
	calibrating: '#8b5cf6',
}

class ObsAudioInstance extends InstanceBase<Config> {
	config!: Config
	engine!: Engine
	web: WebServer | null = null
	#varTimer: NodeJS.Timeout | null = null
	#lastSaved = ''
	#structureTimer: NodeJS.Timeout | null = null

	override async init(config: Config): Promise<void> {
		this.config = config
		this.engine = new Engine(
			{
				log: (level, msg) => this.log(level, msg),
				save: (store, autosave) => this.#saveStore(store, autosave),
				structureChanged: () => this.#structureChanged(),
				stateChanged: () => this.#stateChanged(),
			},
			config.store,
			config.autosave ?? '',
		)
		this.#lastSaved = config.store ?? ''
		this.#start()
	}

	#start(): void {
		const c = this.config
		this.updateStatus(InstanceStatus.Connecting)
		this.engine.connect(c.host || '127.0.0.1', Number(c.port) || 4455, c.password ?? '')
		this.engine.on('status', () => this.#status())
		this.web?.stop()
		if (Number(c.webPort) > 0) {
			this.web = new WebServer(this.engine, { port: Number(c.webPort), bind: c.webBind || '0.0.0.0', pin: c.pin ?? '' }, (level, msg) =>
				this.log(level, msg),
			)
			this.web.start()
		}
		this.#structureChanged()
		this.#restartVarTimer()
		this.engine.setUpdateChecks(Number(this.config.updateHours ?? 12))
	}

	#status(): void {
		if (this.engine.connected) this.updateStatus(InstanceStatus.Ok)
		else this.updateStatus(InstanceStatus.ConnectionFailure, 'Waiting for OBS')
	}

	#restartVarTimer(): void {
		if (this.#varTimer) clearInterval(this.#varTimer)
		const hz = clamp(Number(this.config.varRateHz) || 5, 1, 20)
		this.#varTimer = setInterval(() => this.#meterVariables(), 1000 / hz)
	}

	override async destroy(): Promise<void> {
		if (this.#varTimer) clearInterval(this.#varTimer)
		if (this.#structureTimer) clearTimeout(this.#structureTimer)
		this.web?.stop()
		this.engine.destroy()
	}

	override async configUpdated(config: Config): Promise<void> {
		const old = this.config
		// the store is the module's own: keep the running copy
		this.config = { ...config, store: old.store, autosave: old.autosave }
		const changed = (['host', 'port', 'password', 'webPort', 'webBind', 'pin'] as const).some((k) => String(old[k] ?? '') !== String(config[k] ?? ''))
		if (changed) {
			this.engine.removeAllListeners('status')
			this.engine.obs?.stop()
			this.#start()
		}
		if (old.varRateHz !== config.varRateHz) this.#restartVarTimer()
		if (old.updateHours !== config.updateHours) this.engine.setUpdateChecks(Number(config.updateHours ?? 12))
		if (config.store !== old.store) this.saveConfig(this.config)
	}

	#saveStore(store: string, autosave: string): void {
		if (store === this.#lastSaved && autosave === this.config.autosave) return
		this.#lastSaved = store
		this.config = { ...this.config, store, autosave }
		this.saveConfig(this.config)
	}

	override getConfigFields(): SomeCompanionConfigField[] {
		return [
			{ type: 'static-text', id: 'info', label: '', width: 12, value: 'OBS: Tools → WebSocket Server Settings. The fader page is at http://<this computer>:<page port>/ (also usable as an OBS custom browser dock).' },
			{ type: 'textinput', id: 'host', label: 'OBS address', width: 6, default: '127.0.0.1' },
			{ type: 'number', id: 'port', label: 'OBS WebSocket port', width: 3, default: 4455, min: 1, max: 65535 },
			{ type: 'textinput', id: 'password', label: 'OBS WebSocket password', width: 6, default: '' },
			{ type: 'number', id: 'webPort', label: 'Fader page port (0 = off)', width: 3, default: 8890, min: 0, max: 65535 },
			{ type: 'textinput', id: 'webBind', label: 'Fader page network address (0.0.0.0 = all)', width: 6, default: '0.0.0.0' },
			{ type: 'textinput', id: 'pin', label: 'Fader page PIN (blank = none)', width: 3, default: '' },
			{ type: 'number', id: 'varRateHz', label: 'Meter variables: updates per second', width: 3, default: 5, min: 1, max: 20 },
			{ type: 'number', id: 'updateHours', label: 'Check for module and OBS updates every (hours, 0 = never)', width: 6, default: 12, min: 0, max: 720 },
		]
	}

	// ---- helpers ----------------------------------------------------------------

	async #text(options: CompanionOptionValues, id: string, ctx: Ctx): Promise<string> {
		return (await ctx.parseVariablesInString(String(options[id] ?? ''))).trim()
	}

	async #input(options: CompanionOptionValues, ctx: Ctx): Promise<InputInfo | undefined> {
		const t = await this.#text(options, 'input', ctx)
		const inp = this.engine.resolve(t)
		if (!inp) this.log('warn', `No OBS audio input "${t}"`)
		return inp
	}

	#structureChanged(): void {
		if (this.#structureTimer) return
		this.#structureTimer = setTimeout(() => {
			this.#structureTimer = null
			this.#definitions()
			this.#stateChanged()
		}, 100)
	}

	#definitions(): void {
		this.setActionDefinitions(this.#actions())
		this.setFeedbackDefinitions(this.#feedbacks())
		this.setVariableDefinitions(this.#variableDefs())
		this.setPresetDefinitions(this.#presets())
	}

	#stateChanged(): void {
		this.checkFeedbacks()
		this.setVariableValues(this.#stateVariables())
	}

	// ---- variables ----------------------------------------------------------------

	#variableDefs(): CompanionVariableDefinition[] {
		const defs: CompanionVariableDefinition[] = [
			{ variableId: 'connected', name: 'Connected to OBS' },
			{ variableId: 'inputs', name: 'Number of inputs shown' },
			{ variableId: 'module_version', name: 'OBS Audio module: this version' },
			{ variableId: 'module_latest', name: 'OBS Audio module: latest version' },
			{ variableId: 'module_update', name: 'OBS Audio module: update available' },
			{ variableId: 'obs_version', name: 'OBS: this version' },
			{ variableId: 'obs_latest', name: 'OBS: latest version' },
			{ variableId: 'obs_update', name: 'OBS: update available' },
		]
		this.engine.visible().forEach((inp, idx) => {
			const n = idx + 1
			const p = `in${n}_`
			const lab = `Input ${n} (${inp.name})`
			defs.push(
				{ variableId: `${p}name`, name: `${lab}: name` },
				{ variableId: `${p}vol`, name: `${lab}: fader dB` },
				{ variableId: `${p}trim`, name: `${lab}: trim dB` },
				{ variableId: `${p}mute`, name: `${lab}: muted` },
				{ variableId: `${p}bal`, name: `${lab}: balance (-100 L to 100 R)` },
				{ variableId: `${p}sync`, name: `${lab}: sync offset ms` },
				{ variableId: `${p}monitor`, name: `${lab}: monitoring` },
				{ variableId: `${p}tracks`, name: `${lab}: recording tracks on` },
				{ variableId: `${p}rider`, name: `${lab}: rider status` },
				{ variableId: `${p}rider_on`, name: `${lab}: rider on` },
				{ variableId: `${p}target`, name: `${lab}: rider target dB` },
				{ variableId: `${p}cal`, name: `${lab}: calibrate level dB` },
				{ variableId: `${p}level`, name: `${lab}: level the rider sees dB` },
				{ variableId: `${p}rms`, name: `${lab}: post-fader average dB` },
				{ variableId: `${p}peak`, name: `${lab}: post-fader peak dB` },
				{ variableId: `${p}pre`, name: `${lab}: pre-fader peak dB` },
			)
			for (const f of inp.filters) {
				const k = filterKind(f.kind)
				const fp = `${p}f_${slug(f.name)}_`
				defs.push({ variableId: `${fp}on`, name: `${lab}: ${f.name} on` })
				for (const prm of k?.params ?? []) defs.push({ variableId: `${fp}${prm.key}`, name: `${lab}: ${f.name} ${prm.label}` })
			}
		})
		return defs
	}

	#stateVariables(): CompanionVariableValues {
		const ver = this.engine.versions
		const v: CompanionVariableValues = {
			connected: this.engine.connected,
			inputs: this.engine.visible().length,
			module_version: ver.moduleVersion,
			module_latest: ver.moduleLatest ?? '',
			module_update: ver.moduleUpdate,
			obs_version: ver.obsVersion ?? '',
			obs_latest: ver.obsLatest ?? '',
			obs_update: ver.obsUpdate,
		}
		this.engine.visible().forEach((inp, idx) => {
			const p = `in${idx + 1}_`
			const set = this.engine.settings(inp.name)
			const rec = this.engine.store.inputs[inp.name]
			v[`${p}name`] = inp.name
			v[`${p}vol`] = fmtDb(inp.volumeDb)
			v[`${p}trim`] = inp.trimDb.toFixed(1)
			v[`${p}mute`] = inp.muted
			v[`${p}bal`] = Math.round((inp.balance - 0.5) * 200)
			v[`${p}sync`] = inp.syncMs
			v[`${p}monitor`] = inp.monitor
			v[`${p}tracks`] = Object.entries(inp.tracks)
				.filter(([, on]) => on)
				.map(([t]) => t)
				.join(',')
			v[`${p}rider`] = inp.rider.state
			v[`${p}rider_on`] = set.riderOn
			v[`${p}target`] = rec?.target === null || rec?.target === undefined ? '' : rec.target.toFixed(1)
			v[`${p}cal`] = set.calibrateDb
			for (const f of inp.filters) {
				const k = filterKind(f.kind)
				const fp = `${p}f_${slug(f.name)}_`
				v[`${fp}on`] = f.enabled
				for (const prm of k?.params ?? []) {
					const val = f.settings[prm.key]
					v[`${fp}${prm.key}`] = typeof val === 'number' ? Math.round(val * 100) / 100 : String(val ?? '')
				}
			}
		})
		return v
	}

	#meterVariables(): void {
		const v: CompanionVariableValues = {}
		const max = (a: Db[]) => a.reduce<Db>((m, x) => (x !== null && (m === null || x > m) ? x : m), null)
		this.engine.visible().forEach((inp, idx) => {
			const p = `in${idx + 1}_`
			v[`${p}level`] = fmtDb(inp.rider.level)
			v[`${p}rms`] = fmtDb(max(inp.postMag))
			v[`${p}peak`] = fmtDb(max(inp.postPeak))
			v[`${p}pre`] = fmtDb(max(inp.prePeak))
		})
		this.setVariableValues(v)
		this.checkFeedbacks('level_above', 'pickup_led')
	}

	// ---- actions ------------------------------------------------------------------

	#actions(): CompanionActionDefinitions {
		const e = this.engine
		const modeChoices = (extra: DropdownChoice[] = []): DropdownChoice[] => [
			{ id: 'set', label: 'Set to' },
			{ id: 'adjust', label: 'Adjust by' },
			...extra,
		]
		const onOffToggle: DropdownChoice[] = [
			{ id: 'toggle', label: 'Toggle' },
			{ id: 'on', label: 'On' },
			{ id: 'off', label: 'Off' },
		]
		const flip = (mode: unknown, current: boolean) => (mode === 'on' ? true : mode === 'off' ? false : !current)
		const settingChoices = INPUT_SETTING_KEYS.map((k) => ({ id: k, label: INPUT_FIELDS[k].label }))

		return {
			ag_button: {
				name: 'Auto gain: the input button (press / double tap / hold)',
				description:
					'Put "pressed" in the button\'s press actions and "released" in its release actions. Press = this level please, double tap = calibrate to the input\'s level, hold = calibrate to the module level.',
				options: [
					inputOption,
					{
						type: 'dropdown',
						label: 'Button',
						id: 'edge',
						default: 'down',
						choices: [
							{ id: 'down', label: 'Pressed' },
							{ id: 'up', label: 'Released' },
						],
					},
				],
				callback: async ({ options }, ctx) => {
					const inp = await this.#input(options, ctx)
					if (!inp) return
					if (options.edge === 'up') e.buttonUp(inp)
					else e.buttonDown(inp)
				},
			},
			ag_capture: {
				name: 'Auto gain: this level please',
				description: 'Capture the current level as the rider target',
				options: [inputOption],
				callback: async ({ options }, ctx) => {
					const inp = await this.#input(options, ctx)
					if (inp) e.captureTarget(inp)
				},
			},
			ag_calibrate: {
				name: 'Auto gain: calibrate',
				options: [
					inputOption,
					{
						type: 'dropdown',
						label: 'To',
						id: 'to',
						default: 'input',
						choices: [
							{ id: 'input', label: "The input's own calibrate level" },
							{ id: 'module', label: 'The module calibrate level' },
							{ id: 'custom', label: 'A level given here' },
						],
					},
					{ type: 'textinput', label: 'Level (dB)', id: 'level', default: '-18', useVariables: true, isVisible: (o) => o.to === 'custom' },
				],
				callback: async ({ options }, ctx) => {
					const inp = await this.#input(options, ctx)
					if (!inp) return
					if (options.to === 'custom') {
						const db = parseNumber(await this.#text(options, 'level', ctx), NaN, -100, 26)
						if (Number.isNaN(db)) return this.log('warn', 'Calibrate: the level isn\'t a number')
						e.calibrate(inp, db)
					} else e.calibrate(inp, options.to === 'module' ? 'module' : 'input')
				},
			},
			ag_rider: {
				name: 'Auto gain: rider on / off',
				options: [inputOption, { type: 'dropdown', label: 'Rider', id: 'mode', default: 'toggle', choices: onOffToggle }],
				callback: async ({ options }, ctx) => {
					const inp = await this.#input(options, ctx)
					if (inp) e.setInputSetting(inp.name, 'riderOn', flip(options.mode, e.settings(inp.name).riderOn))
				},
			},
			ag_target: {
				name: 'Auto gain: set the rider target',
				options: [
					inputOption,
					{ type: 'dropdown', label: 'Mode', id: 'mode', default: 'set', choices: modeChoices([{ id: 'clear', label: 'Clear the target' }]) },
					{ type: 'textinput', label: 'dB', id: 'db', default: '-18', useVariables: true, isVisible: (o) => o.mode !== 'clear' },
				],
				callback: async ({ options }, ctx) => {
					const inp = await this.#input(options, ctx)
					if (!inp) return
					if (options.mode === 'clear') return e.setTarget(inp, null)
					const n = parseNumber(await this.#text(options, 'db', ctx), NaN, -100, 26)
					if (Number.isNaN(n)) return
					const cur = e.store.inputs[inp.name]?.target ?? null
					if (options.mode === 'adjust') {
						if (cur === null) return this.log('warn', `${inp.name} has no target to adjust`)
						e.setTarget(inp, cur + n)
					} else e.setTarget(inp, n)
				},
			},
			ag_setting: {
				name: 'Auto gain: change a setting',
				description: 'Any auto gain setting, for one input or the page-wide defaults',
				options: [
					{
						type: 'dropdown',
						label: 'For',
						id: 'scope',
						default: 'input',
						choices: [
							{ id: 'input', label: 'One input' },
							{ id: 'default', label: 'The defaults (every input that has not changed it)' },
						],
					},
					{ ...inputOption, isVisible: (o) => o.scope === 'input' },
					{ type: 'dropdown', label: 'Setting', id: 'key', default: 'bandDb', choices: settingChoices },
					{
						type: 'textinput',
						label: 'Value',
						id: 'value',
						default: '',
						useVariables: true,
						tooltip: 'A number, on/off, or a choice (e.g. fader, trim, rms, peak). For one input, "default" goes back to the page-wide default.',
					},
				],
				callback: async ({ options }, ctx) => {
					const key = String(options.key) as keyof InputSettings
					const value = await this.#text(options, 'value', ctx)
					if (options.scope === 'default') return e.setDefaultSetting(key, value)
					const inp = await this.#input(options, ctx)
					if (inp) e.setInputSetting(inp.name, key, value.toLowerCase() === 'default' ? undefined : value)
				},
			},
			volume: {
				name: 'Fader: set level',
				options: [
					inputOption,
					{ type: 'dropdown', label: 'Mode', id: 'mode', default: 'set', choices: modeChoices() },
					{ type: 'textinput', label: 'dB (or -inf)', id: 'db', default: '0', useVariables: true },
					{ type: 'textinput', label: 'Fade time (ms, 0 = instant)', id: 'fade', default: '0', useVariables: true, isVisible: (o) => o.mode === 'set' },
				],
				callback: async ({ options }, ctx) => {
					const inp = await this.#input(options, ctx)
					if (!inp) return
					const db = parseDb(await this.#text(options, 'db', ctx))
					if (db === undefined) return this.log('warn', 'Fader: the level isn\'t a number')
					if (options.mode === 'adjust') {
						if (inp.volumeDb === null || db === null) return
						e.setVolume(inp, clamp(inp.volumeDb + db, MIN_DB, 26))
					} else e.setVolume(inp, db === null ? null : clamp(db, MIN_DB, 26), parseNumber(await this.#text(options, 'fade', ctx), 0, 0, 600000))
				},
			},
			volume_grid: {
				name: 'Fader: from a value (Intech Grid fader), with pickup',
				description:
					'Sets an input\'s fader from a number or variable, e.g. a Grid fader\'s 0-127. Fader N drives the Nth input in the list unless an input is given.',
				options: [
					{ type: 'textinput', label: 'Fader number', id: 'fader', default: '1', useVariables: true, tooltip: 'Which input in the list it drives (1 = first). Can be a variable, for banking.' },
					{ type: 'textinput', label: 'Input (blank = by fader number)', id: 'input', default: '', useVariables: true, tooltip: INPUT_TIP },
					{ type: 'textinput', label: 'Value', id: 'value', default: '', useVariables: true },
					{
						type: 'dropdown',
						label: 'Value is',
						id: 'valueType',
						default: 'position',
						choices: [
							{ id: 'position', label: 'Fader position 0-127 (e.g. Grid fader)' },
							{ id: 'db', label: 'Level in dB (-inf, or -100 to +26)' },
						],
					},
					{
						type: 'checkbox',
						label: 'Pickup mode',
						id: 'pickup',
						default: true,
						tooltip:
							"Don't change OBS until the fader sits within the catch band of the OBS level for the dwell time, then stay latched until OBS is moved elsewhere. Show the state with the 'Grid fader pickup LED' feedback.",
						isVisible: (o) => o.valueType !== 'db',
					},
					{ type: 'textinput', label: 'Catch band (± fader steps, of 127)', id: 'band', default: String(DEFAULT_BAND), useVariables: true, isVisible: (o) => o.valueType !== 'db' && o.pickup === true },
					{ type: 'textinput', label: 'Dwell time (ms)', id: 'dwell', default: String(DEFAULT_DWELL_MS), useVariables: true, isVisible: (o) => o.valueType !== 'db' && o.pickup === true },
					{
						type: 'textinput',
						label: 'Release band (± fader steps, of 127)',
						id: 'releaseBand',
						default: String(DEFAULT_RELEASE_BAND),
						useVariables: true,
						tooltip: `Once latched, only an OBS-side move bigger than this lets go. ${NEVER_RELEASE_BAND} = never.`,
						isVisible: (o) => o.valueType !== 'db' && o.pickup === true,
					},
					{ type: 'textinput', label: 'Release time (ms)', id: 'releaseMs', default: String(DEFAULT_RELEASE_MS), useVariables: true, isVisible: (o) => o.valueType !== 'db' && o.pickup === true },
				],
				callback: async ({ options }, ctx) => {
					const fader = parseNumber(await this.#text(options, 'fader', ctx), 1, 1, 999)
					const inp = e.gridInput(Math.round(fader), await this.#text(options, 'input', ctx))
					if (!inp) return
					const raw = await this.#text(options, 'value', ctx)
					if (options.valueType === 'db') {
						const db = parseDb(raw)
						if (db !== undefined) e.setVolume(inp, db === null ? null : clamp(db, MIN_DB, 26))
						return
					}
					const n = Number(raw)
					if (raw === '' || Number.isNaN(n)) return
					const incoming = clamp(n, 0, 127)
					const send = (pos: number) => e.setVolume(inp, positionToDb(pos / 127, e.law))
					if (options.pickup !== true) return send(incoming)
					const settings = {
						band: parseNumber(await this.#text(options, 'band', ctx), DEFAULT_BAND, 0, 64),
						dwellMs: parseNumber(await this.#text(options, 'dwell', ctx), DEFAULT_DWELL_MS, 0, 10000),
						releaseBand: parseNumber(await this.#text(options, 'releaseBand', ctx), DEFAULT_RELEASE_BAND, 0, NEVER_RELEASE_BAND),
						releaseMs: parseNumber(await this.#text(options, 'releaseMs', ctx), DEFAULT_RELEASE_MS, 0, 60000),
					}
					if (e.pickup.handle(inp.name, incoming, settings, send)) send(incoming)
				},
			},
			trim: {
				name: 'Trim: set level',
				description: "The input's trim (a Gain filter, added if it isn't there)",
				options: [
					inputOption,
					{ type: 'dropdown', label: 'Mode', id: 'mode', default: 'set', choices: modeChoices() },
					{ type: 'textinput', label: 'dB (-30 to +30)', id: 'db', default: '0', useVariables: true },
				],
				callback: async ({ options }, ctx) => {
					const inp = await this.#input(options, ctx)
					if (!inp) return
					const n = parseNumber(await this.#text(options, 'db', ctx), NaN, -60, 60)
					if (Number.isNaN(n)) return
					e.setTrim(inp, clamp(options.mode === 'adjust' ? inp.trimDb + n : n, -30, 30))
				},
			},
			mute: {
				name: 'Input: mute',
				options: [inputOption, { type: 'dropdown', label: 'Mute', id: 'mode', default: 'toggle', choices: onOffToggle }],
				callback: async ({ options }, ctx) => {
					const inp = await this.#input(options, ctx)
					if (inp) await e.setMute(inp, flip(options.mode, inp.muted))
				},
			},
			balance: {
				name: 'Input: balance',
				options: [
					inputOption,
					{ type: 'dropdown', label: 'Mode', id: 'mode', default: 'set', choices: modeChoices() },
					{ type: 'textinput', label: 'Balance (-100 = left, 0 = centre, 100 = right)', id: 'value', default: '0', useVariables: true },
				],
				callback: async ({ options }, ctx) => {
					const inp = await this.#input(options, ctx)
					if (!inp) return
					const n = parseNumber(await this.#text(options, 'value', ctx), NaN, -200, 200)
					if (Number.isNaN(n)) return
					const cur = (inp.balance - 0.5) * 200
					await e.setBalance(inp, (clamp(options.mode === 'adjust' ? cur + n : n, -100, 100) + 100) / 200)
				},
			},
			sync: {
				name: 'Input: sync offset',
				options: [
					inputOption,
					{ type: 'dropdown', label: 'Mode', id: 'mode', default: 'set', choices: modeChoices() },
					{ type: 'textinput', label: 'Milliseconds', id: 'value', default: '0', useVariables: true },
				],
				callback: async ({ options }, ctx) => {
					const inp = await this.#input(options, ctx)
					if (!inp) return
					const n = parseNumber(await this.#text(options, 'value', ctx), NaN)
					if (Number.isNaN(n)) return
					await e.setSync(inp, options.mode === 'adjust' ? inp.syncMs + n : n)
				},
			},
			monitor: {
				name: 'Input: monitoring',
				options: [
					inputOption,
					{
						type: 'dropdown',
						label: 'Monitoring',
						id: 'value',
						default: 'toggle',
						choices: [
							{ id: 'toggle', label: 'Toggle (off / the type below)' },
							{ id: 'none', label: 'Off' },
							{ id: 'monitor', label: 'Monitor only' },
							{ id: 'both', label: 'Monitor and output' },
						],
					},
					{
						type: 'dropdown',
						label: 'Toggle to',
						id: 'toggleTo',
						default: 'both',
						choices: [
							{ id: 'monitor', label: 'Monitor only' },
							{ id: 'both', label: 'Monitor and output' },
						],
						isVisible: (o) => o.value === 'toggle',
					},
				],
				callback: async ({ options }, ctx) => {
					const inp = await this.#input(options, ctx)
					if (!inp) return
					const v = options.value === 'toggle' ? (inp.monitor === 'none' ? (options.toggleTo as MonitorType) : 'none') : (options.value as MonitorType)
					await e.setMonitor(inp, v)
				},
			},
			tracks: {
				name: 'Recording tracks',
				options: [
					inputOption,
					{ type: 'textinput', label: 'Tracks (e.g. 1 or 1,3,5)', id: 'tracks', default: '1', useVariables: true },
					{ type: 'dropdown', label: 'Set', id: 'mode', default: 'toggle', choices: onOffToggle },
				],
				callback: async ({ options }, ctx) => {
					const inp = await this.#input(options, ctx)
					if (!inp) return
					const list = (await this.#text(options, 'tracks', ctx))
						.split(/[,\s]+/)
						.map((t) => parseInt(t, 10))
						.filter((t) => t >= 1 && t <= 6)
					const changes: Record<string, boolean> = {}
					for (const t of list) changes[String(t)] = flip(options.mode, !!inp.tracks[String(t)])
					if (list.length) await e.setTracks(inp, changes)
				},
			},
			filter_add: {
				name: 'Processing: add a filter',
				options: [
					inputOption,
					{ type: 'dropdown', label: 'Filter', id: 'kind', default: 'compressor_filter', choices: FILTER_KINDS.map((k) => ({ id: k.kind, label: k.label })) },
					{ type: 'textinput', label: 'Name (blank = standard name)', id: 'name', default: '', useVariables: true },
				],
				callback: async ({ options }, ctx) => {
					const inp = await this.#input(options, ctx)
					if (inp) await e.addFilter(inp, String(options.kind), await this.#text(options, 'name', ctx))
				},
			},
			filter_remove: {
				name: 'Processing: remove a filter',
				options: [inputOption, { type: 'textinput', label: 'Filter name', id: 'filter', default: '', useVariables: true }],
				callback: async ({ options }, ctx) => {
					const inp = await this.#input(options, ctx)
					if (inp) await e.removeFilter(inp, await this.#text(options, 'filter', ctx))
				},
			},
			filter_enable: {
				name: 'Processing: filter on / off',
				options: [
					inputOption,
					{ type: 'textinput', label: 'Filter name', id: 'filter', default: 'Compressor', useVariables: true },
					{ type: 'dropdown', label: 'Filter', id: 'mode', default: 'toggle', choices: onOffToggle },
				],
				callback: async ({ options }, ctx) => {
					const inp = await this.#input(options, ctx)
					if (!inp) return
					const name = await this.#text(options, 'filter', ctx)
					const f = inp.filters.find((x) => x.name === name)
					if (!f) return this.log('warn', `${inp.name} has no filter "${name}"`)
					await e.setFilterEnabled(inp, name, flip(options.mode, f.enabled))
				},
			},
			filter_set: {
				name: 'Processing: change a filter setting',
				options: [
					inputOption,
					{ type: 'dropdown', label: 'Setting', id: 'param', default: ALL_FILTER_PARAMS[0].id, choices: ALL_FILTER_PARAMS.map((p) => ({ id: p.id, label: p.label })) },
					{ type: 'textinput', label: 'Filter name (blank = the first of that kind)', id: 'filter', default: '', useVariables: true },
					{ type: 'dropdown', label: 'Mode', id: 'mode', default: 'set', choices: modeChoices() },
					{ type: 'textinput', label: 'Value', id: 'value', default: '', useVariables: true },
				],
				callback: async ({ options }, ctx) => {
					const inp = await this.#input(options, ctx)
					if (!inp) return
					const p = ALL_FILTER_PARAMS.find((x) => x.id === options.param)
					if (!p) return
					const name = await this.#text(options, 'filter', ctx)
					const f = name ? inp.filters.find((x) => x.name === name) : inp.filters.find((x) => x.kind === p.kind.kind)
					if (!f) return this.log('warn', `${inp.name} has no ${name || p.kind.label} filter`)
					const raw = await this.#text(options, 'value', ctx)
					let value: unknown = raw
					if (p.param.type === 'number') {
						const n = Number(raw)
						if (raw === '' || Number.isNaN(n)) return
						const cur = Number(f.settings[p.param.key] ?? p.param.default)
						value = clamp(options.mode === 'adjust' ? cur + n : n, p.param.min ?? -Infinity, p.param.max ?? Infinity)
					} else if (p.param.type === 'choice') {
						const c = p.param.choices?.find((c) => c.id.toLowerCase() === raw.toLowerCase() || c.label.toLowerCase() === raw.toLowerCase())
						if (!c) return this.log('warn', `"${raw}" isn't a choice for ${p.label}`)
						value = c.id
					}
					await e.setFilterSetting(inp, f.name, p.param.key, value)
				},
			},
			check_updates: {
				name: 'Check for module and OBS updates now',
				options: [],
				callback: async () => {
					await e.checkUpdates()
				},
			},
			refresh: {
				name: 'Re-read everything from OBS',
				options: [],
				callback: async () => {
					await e.refreshAll()
				},
			},
		}
	}

	// ---- feedbacks ----------------------------------------------------------------

	#feedbacks(): CompanionFeedbackDefinitions {
		const e = this.engine
		const colourOpt = (id: string, label: string, def: string, tooltip?: string) =>
			({ type: 'textinput', label, id, default: def, useVariables: true, tooltip: tooltip ?? '#rrggbb, r,g,b or a variable. Blank = leave as is.' }) as const
		const inputFor = async (o: CompanionOptionValues, ctx: Ctx) => e.resolve(await this.#text(o, 'input', ctx))
		return {
			rider_status: {
				type: 'advanced',
				name: 'Auto gain: rider status colours',
				description: 'Background colour for what the rider is doing on an input',
				options: [inputOption, ...RIDER_STATES.map((s) => colourOpt(`c_${s.id}`, s.label, STATUS_COLOURS[s.id]))],
				callback: async (fb, ctx) => {
					const inp = await inputFor(fb.options, ctx)
					if (!inp) return {}
					const c = parseColour(await this.#text(fb.options, `c_${inp.rider.state}`, ctx), undefined)
					return c === undefined ? {} : { bgcolor: c }
				},
			},
			update_available: {
				type: 'boolean',
				name: 'Update available',
				description: 'A newer OBS Audio module or OBS is out (checked on GitHub, see the connection settings)',
				defaultStyle: { bgcolor: rgb(85, 0, 170), color: rgb(255, 255, 255) },
				options: [
					{
						type: 'dropdown',
						label: 'For',
						id: 'which',
						default: 'either',
						choices: [
							{ id: 'either', label: 'Either' },
							{ id: 'module', label: 'This module' },
							{ id: 'obs', label: 'OBS' },
						],
					},
				],
				callback: (fb) => {
					const v = e.versions
					return fb.options.which === 'module' ? v.moduleUpdate : fb.options.which === 'obs' ? v.obsUpdate : v.moduleUpdate || v.obsUpdate
				},
			},
			rider_on: {
				type: 'boolean',
				name: 'Auto gain: rider is on',
				defaultStyle: { bgcolor: rgb(85, 0, 170), color: rgb(255, 255, 255) },
				options: [inputOption],
				callback: async (fb, ctx) => {
					const inp = await inputFor(fb.options, ctx)
					return !!inp && e.settings(inp.name).riderOn
				},
			},
			muted: {
				type: 'boolean',
				name: 'Input: muted',
				defaultStyle: { bgcolor: rgb(200, 0, 0), color: rgb(255, 255, 255) },
				options: [inputOption],
				callback: async (fb, ctx) => !!(await inputFor(fb.options, ctx))?.muted,
			},
			monitor_on: {
				type: 'boolean',
				name: 'Input: monitoring is',
				defaultStyle: { bgcolor: rgb(0, 120, 60), color: rgb(255, 255, 255) },
				options: [
					inputOption,
					{
						type: 'dropdown',
						label: 'Monitoring',
						id: 'value',
						default: 'any',
						choices: [
							{ id: 'any', label: 'On (either type)' },
							{ id: 'monitor', label: 'Monitor only' },
							{ id: 'both', label: 'Monitor and output' },
							{ id: 'none', label: 'Off' },
						],
					},
				],
				callback: async (fb, ctx) => {
					const inp = await inputFor(fb.options, ctx)
					if (!inp) return false
					return fb.options.value === 'any' ? inp.monitor !== 'none' : inp.monitor === fb.options.value
				},
			},
			track_on: {
				type: 'boolean',
				name: 'Recording track on',
				defaultStyle: { bgcolor: rgb(85, 0, 170), color: rgb(255, 255, 255) },
				options: [inputOption, { type: 'textinput', label: 'Track (1-6)', id: 'track', default: '1', useVariables: true }],
				callback: async (fb, ctx) => {
					const inp = await inputFor(fb.options, ctx)
					return !!inp?.tracks[await this.#text(fb.options, 'track', ctx)]
				},
			},
			filter_on: {
				type: 'boolean',
				name: 'Processing: filter is on',
				defaultStyle: { bgcolor: rgb(0, 120, 60), color: rgb(255, 255, 255) },
				options: [inputOption, { type: 'textinput', label: 'Filter name', id: 'filter', default: 'Compressor', useVariables: true }],
				callback: async (fb, ctx) => {
					const inp = await inputFor(fb.options, ctx)
					const name = await this.#text(fb.options, 'filter', ctx)
					return !!inp?.filters.find((f) => f.name === name)?.enabled
				},
			},
			level_above: {
				type: 'boolean',
				name: 'Meter: level at or above',
				defaultStyle: { bgcolor: rgb(200, 0, 0), color: rgb(255, 255, 255) },
				options: [
					inputOption,
					{
						type: 'dropdown',
						label: 'Meter',
						id: 'meter',
						default: 'peak',
						choices: [
							{ id: 'peak', label: 'Post-fader peak' },
							{ id: 'rms', label: 'Post-fader average' },
							{ id: 'pre', label: 'Pre-fader peak' },
							{ id: 'level', label: 'What the rider sees' },
						],
					},
					{ type: 'textinput', label: 'Threshold (dB)', id: 'db', default: '-6', useVariables: true },
				],
				callback: async (fb, ctx) => {
					const inp = await inputFor(fb.options, ctx)
					if (!inp) return false
					const th = parseNumber(await this.#text(fb.options, 'db', ctx), 0)
					const max = (a: Db[]) => a.reduce<Db>((m, x) => (x !== null && (m === null || x > m) ? x : m), null)
					const v = fb.options.meter === 'rms' ? max(inp.postMag) : fb.options.meter === 'pre' ? max(inp.prePeak) : fb.options.meter === 'level' ? inp.rider.level : max(inp.postPeak)
					return v !== null && v >= th
				},
			},
			pickup_led: {
				type: 'advanced',
				name: 'Grid fader pickup LED',
				description: 'Background colour for a Grid fader using pickup. Same as the SQ module extension.',
				options: [
					{ type: 'textinput', label: 'Fader number', id: 'fader', default: '1', useVariables: true },
					{ type: 'textinput', label: 'Input (blank = by fader number)', id: 'input', default: '', useVariables: true, tooltip: INPUT_TIP },
					{ type: 'textinput', label: 'Fader value', id: 'value', default: '', useVariables: true },
					colourOpt('belowColour', 'Below OBS level: colour', '#ff0000'),
					{ type: 'checkbox', label: 'Below OBS level: flash', id: 'belowFlash', default: true },
					colourOpt('aboveColour', 'Above OBS level: colour', '#ff0000'),
					{ type: 'checkbox', label: 'Above OBS level: flash', id: 'aboveFlash', default: false },
					colourOpt('catchColour', 'Catching: colour', '#00ff00'),
					colourOpt('trackingColour', 'Tracking: colour (brightness follows the fader)', '#ffffff'),
					{ type: 'textinput', label: 'Flash speed (ms per on/off)', id: 'flashMs', default: String(DEFAULT_FLASH_MS), useVariables: true },
				],
				callback: async (fb, ctx) => {
					const o = fb.options
					const fader = parseNumber(await this.#text(o, 'fader', ctx), 1, 1, 999)
					const inp = e.gridInput(Math.round(fader), await this.#text(o, 'input', ctx))
					if (!inp) return {}
					const raw = await this.#text(o, 'value', ctx)
					const n = Number(raw)
					const { led, position } = e.pickup.ledState(inp.name, raw === '' || Number.isNaN(n) ? undefined : n)
					const flashMs = parseNumber(await this.#text(o, 'flashMs', ctx), DEFAULT_FLASH_MS, 50, 5000)
					const off = Math.floor(Date.now() / flashMs) % 2 === 1
					const col = async (id: string, def: number) => parseColour(await this.#text(o, id, ctx), def) ?? def
					switch (led) {
						case 'below':
							return { bgcolor: o.belowFlash && off ? BLACK : await col('belowColour', rgb(255, 0, 0)) }
						case 'above':
							return { bgcolor: o.aboveFlash && off ? BLACK : await col('aboveColour', rgb(255, 0, 0)) }
						case 'catch':
							return { bgcolor: await col('catchColour', rgb(0, 255, 0)) }
						default:
							return { bgcolor: scaleColour(await col('trackingColour', rgb(255, 255, 255)), position / 127) }
					}
				},
			},
		}
	}

	// ---- presets ------------------------------------------------------------------

	#presets(): CompanionPresetDefinitions {
		const presets: CompanionPresetDefinitions = {}
		const white = rgb(255, 255, 255)
		this.engine.visible().forEach((inp, idx) => {
			const n = idx + 1
			const category = `Input ${n}: ${inp.name}`
			const name = `$(${this.label}:in${n}_name)`
			presets[`ag_${n}`] = {
				type: 'button',
				category,
				name: 'Auto gain button',
				style: { text: `${name}\\nAG $(${this.label}:in${n}_target)`, size: 'auto', color: white, bgcolor: BLACK },
				steps: [
					{
						down: [{ actionId: 'ag_button', options: { input: String(n), edge: 'down' } }],
						up: [{ actionId: 'ag_button', options: { input: String(n), edge: 'up' } }],
					},
				],
				feedbacks: [
					{
						feedbackId: 'rider_status',
						options: { input: String(n), ...Object.fromEntries(RIDER_STATES.map((s) => [`c_${s.id}`, STATUS_COLOURS[s.id]])) },
					},
				],
			}
			presets[`rider_${n}`] = {
				type: 'button',
				category,
				name: 'Rider on / off',
				style: { text: `${name}\\nRIDER`, size: 'auto', color: white, bgcolor: BLACK },
				steps: [{ down: [{ actionId: 'ag_rider', options: { input: String(n), mode: 'toggle' } }], up: [] }],
				feedbacks: [{ feedbackId: 'rider_on', options: { input: String(n) }, style: { bgcolor: rgb(85, 0, 170), color: white } }],
			}
			presets[`mute_${n}`] = {
				type: 'button',
				category,
				name: 'Mute',
				style: { text: `${name}\\nMUTE`, size: 'auto', color: white, bgcolor: BLACK },
				steps: [{ down: [{ actionId: 'mute', options: { input: String(n), mode: 'toggle' } }], up: [] }],
				feedbacks: [{ feedbackId: 'muted', options: { input: String(n) }, style: { bgcolor: rgb(200, 0, 0), color: white } }],
			}
			presets[`level_${n}`] = {
				type: 'button',
				category,
				name: 'Level readout',
				style: { text: `${name}\\n$(${this.label}:in${n}_vol) dB\\n$(${this.label}:in${n}_peak)`, size: 'auto', color: white, bgcolor: BLACK },
				steps: [{ down: [], up: [] }],
				feedbacks: [
					{ feedbackId: 'level_above', options: { input: String(n), meter: 'peak', db: '-18' }, style: { bgcolor: rgb(0, 100, 0) } },
					{ feedbackId: 'level_above', options: { input: String(n), meter: 'peak', db: '-6' }, style: { bgcolor: rgb(150, 120, 0) } },
					{ feedbackId: 'level_above', options: { input: String(n), meter: 'peak', db: '-1' }, style: { bgcolor: rgb(200, 0, 0) } },
				],
			}
			for (let t = 1; t <= 6; t++) {
				presets[`track_${n}_${t}`] = {
					type: 'button',
					category,
					name: `Track ${t}`,
					style: { text: `${name}\\nTRK ${t}`, size: 'auto', color: white, bgcolor: BLACK },
					steps: [{ down: [{ actionId: 'tracks', options: { input: String(n), tracks: String(t), mode: 'toggle' } }], up: [] }],
					feedbacks: [{ feedbackId: 'track_on', options: { input: String(n), track: String(t) }, style: { bgcolor: rgb(85, 0, 170), color: white } }],
				}
			}
		})
		return presets
	}
}

runEntrypoint(ObsAudioInstance, [])
