import {
	InstanceBase,
	InstanceStatus,
	type CompanionActionDefinitions,
	type CompanionFeedbackDefinitions,
	type CompanionOptionValues,
	type CompanionPresetDefinitions,
	type CompanionPresetSection,
	type CompanionStaticUpgradeScript,
	type CompanionVariableDefinitions,
	type CompanionVariableValues,
	type DropdownChoice,
	type CompanionInputFieldTextInput,
	type InstanceTypes,
	type JsonObject,
	type SomeCompanionConfigField,
} from '@companion-module/base'
import { networkInterfaces } from 'node:os'
import { spawn } from 'node:child_process'
import { Engine, type InputInfo, type MonitorType } from './engine.js'
import { WebServer } from './web.js'
import { type Db, dbToPosition, fmtDb, parseDb, parseNumber, positionToDb, clamp, MIN_DB } from './law.js'
import { ALL_FILTER_PARAMS, FILTER_KINDS, filterKind, slug } from './filters.js'
import { INPUT_FIELDS, INPUT_SETTING_KEYS, PAGE_DEFAULTS, type InputSettings, type PageSettings } from './settings.js'
import { RIDER_STATES, type RiderState } from './rider.js'
import { DEFAULT_BAND, DEFAULT_DWELL_MS, DEFAULT_FLASH_MS, DEFAULT_RELEASE_BAND, DEFAULT_RELEASE_MS, NEVER_RELEASE_BAND } from './pickup.js'
import { parseColour, rgb, scaleColour } from './colour.js'

/**
 * The connection's saved config. Configs saved by older versions may be missing some of these
 * (the grid fields, the store, the ticks), so every read allows for that.
 */
interface Config extends JsonObject {
	host: string
	port: string | number
	password: string
	webPort: string | number
	webBind: string
	pin: string
	varRateHz: string | number
	updateHours: string | number
	gridBand: string | number
	gridDwellMs: string | number
	gridReleaseBand: string | number
	gridReleaseMs: string | number
	/** The module's own settings, saved here by the module (not edited by hand) */
	store: string
	autosave: string
}

interface ObsAudioTypes extends InstanceTypes {
	config: Config
	secrets: undefined
}

interface Resolved {
	host: string
	port: number
	password: string
	webPort: number
	bind: string
	pin: string
	varRateHz: number
	updateHours: number
	grid: { band: number; dwellMs: number; releaseBand: number; releaseMs: number }
}

/** The connection fields that hold settings (and can be handed over to the 'Connection: set settings' action) */
const CONN_FIELDS = [
	'host',
	'port',
	'password',
	'webPort',
	'webBind',
	'pin',
	'varRateHz',
	'updateHours',
	'gridBand',
	'gridDwellMs',
	'gridReleaseBand',
	'gridReleaseMs',
] as const
type ConnField = (typeof CONN_FIELDS)[number]

const CONN_LABELS: Record<ConnField, string> = {
	host: 'OBS address',
	port: 'OBS WebSocket port (default 4455)',
	password: 'OBS WebSocket password',
	webPort: 'Fader page port (default 8890, 0 = off)',
	webBind: 'Fader page available on',
	pin: 'Fader page PIN (blank = none)',
	varRateHz: 'Meter variables: updates per second (default 5)',
	updateHours: 'Check for module and OBS updates every (hours, default 12, 0 = never)',
	gridBand: `Catch band (± fader steps of 127, default ${DEFAULT_BAND})`,
	gridDwellMs: `Dwell time (ms, default ${DEFAULT_DWELL_MS})`,
	gridReleaseBand: `Release band (± fader steps, default ${DEFAULT_RELEASE_BAND}, ${NEVER_RELEASE_BAND} = never)`,
	gridReleaseMs: `Release time (ms, default ${DEFAULT_RELEASE_MS})`,
}

const PAGE_SETTING_CHOICES = (Object.keys(PAGE_DEFAULTS) as (keyof PageSettings)[]).map((k) => ({ id: k, label: k }))

/** Open a web address in this computer's default browser */
function openInBrowser(url: string, warn: (m: string) => void): void {
	try {
		const [cmd, args] =
			process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]]
		const child = spawn(cmd, args as string[], { detached: true, stdio: 'ignore', windowsHide: true })
		child.on('error', (e) => warn(`Couldn't open a browser: ${e.message}`))
		child.unref()
	} catch (e) {
		warn(`Couldn't open a browser: ${(e as Error).message}`)
	}
}

/** The page's network setting: 'all', 'local', or an address */
function bindAddress(v: string): string {
	const t = v.trim().toLowerCase()
	if (t === '' || t === 'all' || t === '0.0.0.0') return '0.0.0.0'
	if (t === 'local' || t === 'localhost') return '127.0.0.1'
	return v.trim()
}

/** This computer's IPv4 network addresses */
function localAddresses(): { name: string; address: string }[] {
	const out: { name: string; address: string }[] = []
	for (const [name, list] of Object.entries(networkInterfaces())) {
		for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address })
	}
	return out
}

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

export const UpgradeScripts: CompanionStaticUpgradeScript<Config>[] = []

export default class ObsAudioInstance extends InstanceBase<ObsAudioTypes> {
	config!: Config
	engine!: Engine
	web: WebServer | null = null
	#varTimer: NodeJS.Timeout | null = null
	#lastSaved = ''
	#structureTimer: NodeJS.Timeout | null = null

	#resolved: Resolved | null = null
	#recordingActions = false
	/** Connection fields we've already moaned about having a variable in them */
	#varWarned = new Set<string>()

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
		this.engine.on('status', () => this.#status())
		this.engine.on('recordable', (actionId: string, options: CompanionOptionValues, key: string) => {
			if (this.#recordingActions) this.recordAction({ actionId, options }, key)
		})
		this.updateStatus(InstanceStatus.Connecting)
		await this.#apply()
		this.#structureChanged()
	}

	/**
	 * A connection field's value, trimmed. Connection fields can't take variables any more,
	 * so one that still has "$(" in it is treated as blank (its default), with a warning in the log.
	 */
	#field(id: ConnField): string {
		const v = String(this.config[id] ?? '').trim()
		if (!v.includes('$(')) return v
		const key = `${id}=${v}`
		if (!this.#varWarned.has(key)) {
			this.#varWarned.add(key)
			this.log(
				'warn',
				`"${CONN_LABELS[id]}" on the connection page has a variable in it (${v}). Connection fields can't take variables any more, so I'm using the default for now. ` +
					`Want a variable to drive it? Tick "Can be set by the action" next to it, then use the "Connection: set settings" action (a trigger on "variable changed" does the job nicely).`,
			)
		}
		return ''
	}

	/** Work out the connection settings and apply any that changed */
	async #apply(): Promise<void> {
		const f = (id: ConnField) => this.#field(id)
		const r: Resolved = {
			host: f('host') || '127.0.0.1',
			port: parseNumber(f('port'), 4455, 1, 65535),
			password: f('password'),
			webPort: parseNumber(f('webPort'), 8890, 0, 65535),
			bind: bindAddress(f('webBind')),
			pin: f('pin'),
			varRateHz: parseNumber(f('varRateHz'), 5, 1, 20),
			updateHours: parseNumber(f('updateHours'), 12, 0, 720),
			grid: {
				band: parseNumber(f('gridBand'), DEFAULT_BAND, 0, 64),
				dwellMs: parseNumber(f('gridDwellMs'), DEFAULT_DWELL_MS, 0, 10000),
				releaseBand: parseNumber(f('gridReleaseBand'), DEFAULT_RELEASE_BAND, 0, NEVER_RELEASE_BAND),
				releaseMs: parseNumber(f('gridReleaseMs'), DEFAULT_RELEASE_MS, 0, 60000),
			},
		}
		const old = this.#resolved
		this.#resolved = r
		if (!old || old.host !== r.host || old.port !== r.port || old.password !== r.password) {
			this.updateStatus(InstanceStatus.Connecting)
			this.engine.connect(r.host, Math.round(r.port), r.password)
		}
		if (!old || old.webPort !== r.webPort || old.bind !== r.bind || old.pin !== r.pin) {
			this.web?.stop()
			this.web = null
			if (r.webPort > 0) {
				this.web = new WebServer(this.engine, { port: Math.round(r.webPort), bind: r.bind, pin: r.pin }, (level, msg) => this.log(level, msg))
				this.web.start()
			}
			this.setVariableValues(this.#urlVariables())
		}
		if (!old || old.varRateHz !== r.varRateHz) this.#restartVarTimer()
		if (!old || old.updateHours !== r.updateHours) this.engine.setUpdateChecks(r.updateHours)
		if (!old || JSON.stringify(old.grid) !== JSON.stringify(r.grid)) {
			this.setVariableValues(this.#urlVariables())
		}
	}

	#status(): void {
		if (this.engine.connected) this.updateStatus(InstanceStatus.Ok)
		else this.updateStatus(InstanceStatus.ConnectionFailure, this.engine.obs?.lastError || 'Waiting for OBS')
	}

	#restartVarTimer(): void {
		if (this.#varTimer) clearInterval(this.#varTimer)
		const hz = clamp(this.#resolved?.varRateHz ?? 5, 1, 20)
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
		await this.#apply()
		if (config.store !== old.store) this.saveConfig(this.config)
	}

	override handleStartStopRecordActions(isRecording: boolean): void {
		this.#recordingActions = isRecording
	}

	#saveStore(store: string, autosave: string): void {
		if (store === this.#lastSaved && autosave === this.config.autosave) return
		this.#lastSaved = store
		this.config = { ...this.config, store, autosave }
		this.saveConfig(this.config)
	}

	/** The fader page's addresses on this computer */
	#pageUrls(): string[] {
		const r = this.#resolved
		if (!r || r.webPort <= 0) return []
		const port = Math.round(r.webPort)
		if (r.bind === '127.0.0.1') return [`http://127.0.0.1:${port}/`]
		if (r.bind !== '0.0.0.0') return [`http://${r.bind}:${port}/`]
		return [...localAddresses().map((a) => `http://${a.address}:${port}/`), `http://127.0.0.1:${port}/`]
	}

	#urlVariables(): CompanionVariableValues {
		const urls = this.#pageUrls()
		const g = this.#resolved?.grid
		return {
			page_url: urls[0] ?? '',
			page_urls: urls.join(' '),
			grid_catch_band: g?.band ?? DEFAULT_BAND,
			grid_dwell_ms: g?.dwellMs ?? DEFAULT_DWELL_MS,
			grid_release_band: g?.releaseBand ?? DEFAULT_RELEASE_BAND,
			grid_release_ms: g?.releaseMs ?? DEFAULT_RELEASE_MS,
		}
	}

	override getConfigFields(): SomeCompanionConfigField[] {
		const urls = this.#pageUrls()
		const obsState = this.engine?.connected ? 'Connected to OBS. All good.' : `Not connected to OBS. ${this.engine?.obs?.lastError || ''}`
		const nets = localAddresses()
		return [
			{
				type: 'static-text',
				id: 'info',
				label: 'Status',
				width: 12,
				value:
					`${obsState}<br>` +
					(urls.length ? `Fader page: ${urls.map((u) => `<a href="${u}" target="_blank">${u}</a>`).join(' · ')} (works as an OBS custom browser dock too: Docks → Custom Browser Docks).` : 'Fader page: off for now.') +
					'<br>Setting up OBS: go to Tools → WebSocket Server Settings and tick <b>Enable WebSocket server</b> (it starts off). OBS also switches on a password: copy it from <b>Show Connect Info</b> into the password below, or untick <b>Enable Authentication</b> and leave the password blank.',
			},
			{
				type: 'textinput',
				id: 'host',
				label: 'OBS address',
				width: 6,
				default: '127.0.0.1',
				tooltip: 'Where OBS lives. 127.0.0.1 if it\'s on this computer, otherwise its IP address, e.g. 192.168.1.20.',
			},
			{
				type: 'textinput',
				id: 'port',
				label: 'OBS WebSocket port (default 4455)',
				width: 3,
				default: '4455',
				tooltip: "OBS's WebSocket port. You'll find it in OBS: Tools → WebSocket Server Settings → Server Port. It's 4455 unless someone's changed it.",
			},
			{
				type: 'textinput',
				id: 'password',
				label: 'OBS WebSocket password',
				width: 6,
				default: '',
				tooltip:
					"OBS makes up its own password and has authentication on out of the box. Copy it from OBS: Tools → WebSocket Server Settings → Show Connect Info. Or untick Enable Authentication there and leave this blank (but then anything on the network can drive OBS).",
			},
			{
				type: 'textinput',
				id: 'webPort',
				label: 'Fader page port (default 8890, 0 = off)',
				width: 3,
				default: '8890',
				tooltip: 'The port the fader and meter page lives on. Open http://<this computer>:<port>/ in any browser on the network. 0 switches the page off.',
			},
			{
				type: 'dropdown',
				id: 'webBind',
				label: 'Fader page available on',
				width: 6,
				default: 'all',
				allowCustom: true,
				tooltip:
					"Which of this computer's network connections the page answers on, like Companion's own \"network interface\" setting. All = any of them. This computer only = just a browser on this computer. Or pick one connection. It doesn't decide who's allowed in, mind: that's what the PIN is for. You can also type an address.",
				choices: [
					{ id: 'all', label: 'All network connections' },
					{ id: 'local', label: 'This computer only (127.0.0.1)' },
					...nets.map((n) => ({ id: n.address, label: `${n.name}: ${n.address}` })),
				],
			},
			{
				type: 'textinput',
				id: 'pin',
				label: 'Fader page PIN (blank = none)',
				width: 3,
				default: '',
				tooltip: 'Set one and the page asks for it before showing anything or letting anyone change things.',
			},
			{
				type: 'textinput',
				id: 'varRateHz',
				label: 'Meter variables: updates per second (default 5)',
				width: 3,
				default: '5',
				tooltip: 'How often the meter level variables update (1 to 20). Higher looks smoother on buttons, but keeps everything busier.',
			},
			{
				type: 'textinput',
				id: 'updateHours',
				label: 'Check for module and OBS updates every (hours, default 12, 0 = never)',
				width: 6,
				default: '12',
				tooltip: 'How often I peek at GitHub for a newer OBS Audio module and OBS. Needs internet. 0 = never.',
			},
			{
				type: 'static-text',
				id: 'gridInfo',
				label: 'Grid fader pickup (this connection)',
				width: 12,
				value: "These are what 'Fader: from a value (Intech Grid fader), with pickup' uses whenever its own pickup fields are left blank. Each OBS Audio connection (e.g. main and backup OBS) gets its own set.",
			},
			{
				type: 'textinput',
				id: 'gridBand',
				label: `Catch band (± fader steps of 127, default ${DEFAULT_BAND})`,
				width: 3,
				default: String(DEFAULT_BAND),
				tooltip: "How close the Grid fader has to get to OBS's level before it takes over.",
			},
			{
				type: 'textinput',
				id: 'gridDwellMs',
				label: `Dwell time (ms, default ${DEFAULT_DWELL_MS})`,
				width: 3,
				default: String(DEFAULT_DWELL_MS),
				tooltip: 'How long the Grid fader has to sit inside the catch band before it takes over. Stops a quick swipe past grabbing it.',
			},
			{
				type: 'textinput',
				id: 'gridReleaseBand',
				label: `Release band (± fader steps, default ${DEFAULT_RELEASE_BAND}, ${NEVER_RELEASE_BAND} = never)`,
				width: 3,
				default: String(DEFAULT_RELEASE_BAND),
				tooltip: 'Once latched, only a move on the OBS side bigger than this makes the Grid fader let go.',
			},
			{
				type: 'textinput',
				id: 'gridReleaseMs',
				label: `Release time (ms, default ${DEFAULT_RELEASE_MS})`,
				width: 3,
				default: String(DEFAULT_RELEASE_MS),
				tooltip: 'How long a move on the OBS side has to stay outside the release band before the Grid fader lets go.',
			},
			{
				type: 'static-text',
				id: 'bundle',
				label: "Psst. This one's got mates. 🍹",
				width: 12,
				value:
					'OBS Audio is part of a little crew of Companion modules: some brand new, some old favourites given a good tweak. ' +
					"Want to know who else is in the crew, or grab the freshest version of each one? It's all here: " +
					'<a href="https://github.com/nisted/companion-modules" target="_blank">github.com/nisted/companion-modules</a>',
			},
		]
	}

	// ---- helpers ----------------------------------------------------------------

	/** An option's value as text. Companion has already filled in any variables or expression. */
	#text(options: CompanionOptionValues, id: string): string {
		const v = options[id]
		return (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)).trim()
	}

	#input(options: CompanionOptionValues): InputInfo | undefined {
		const t = this.#text(options, 'input')
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
		const { structure, presets } = this.#presets()
		this.setPresetDefinitions(structure, presets)
	}

	#stateChanged(): void {
		this.checkAllFeedbacks()
		this.setVariableValues(this.#stateVariables())
	}

	// ---- variables ----------------------------------------------------------------

	#variableDefs(): CompanionVariableDefinitions {
		const defs: { variableId: string; name: string }[] = [
			{ variableId: 'connected', name: 'Connected to OBS' },
			{ variableId: 'inputs', name: 'Number of inputs shown' },
			{ variableId: 'module_version', name: 'OBS Audio module: this version' },
			{ variableId: 'module_latest', name: 'OBS Audio module: latest version' },
			{ variableId: 'module_update', name: 'OBS Audio module: update available' },
			{ variableId: 'obs_version', name: 'OBS: this version' },
			{ variableId: 'obs_latest', name: 'OBS: latest version' },
			{ variableId: 'obs_update', name: 'OBS: update available' },
			{ variableId: 'obs_error', name: 'Why OBS is not connected (blank when connected)' },
			{ variableId: 'page_url', name: 'Fader page address' },
			{ variableId: 'grid_catch_band', name: 'Grid fader pickup: catch band (this connection)' },
			{ variableId: 'grid_dwell_ms', name: 'Grid fader pickup: dwell time ms (this connection)' },
			{ variableId: 'grid_release_band', name: 'Grid fader pickup: release band (this connection)' },
			{ variableId: 'grid_release_ms', name: 'Grid fader pickup: release time ms (this connection)' },
			{ variableId: 'page_urls', name: 'Fader page addresses (all network connections)' },
			{ variableId: 'rec_state', name: 'Recording: recording / paused / stopped' },
			{ variableId: 'rec_time', name: 'Recording: time so far' },
			{ variableId: 'rec_next', name: 'Recording: next planned start (HH:MM)' },
			{ variableId: 'rec_countdown', name: 'Recording: countdown to the next start' },
			{ variableId: 'rec_auto', name: 'Recording: next start is automatic' },
			{ variableId: 'rec_folder', name: 'Recording: folder' },
			{ variableId: 'rec_files', name: 'Recording: files in the folder' },
			{ variableId: 'solo', name: 'Input being soloed' },
			{ variableId: 'notices', name: 'Pop-ups waiting' },
			{ variableId: 'notice', name: 'Latest pop-up' },
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
				{ variableId: `${p}pfl`, name: `${lab}: PFL on` },
				{ variableId: `${p}backup_for`, name: `${lab}: is the backup for` },
				{ variableId: `${p}on_backup`, name: `${lab}: switched to this backup` },
			)
			for (const f of inp.filters) {
				const k = filterKind(f.kind)
				const fp = `${p}f_${slug(f.name)}_`
				defs.push({ variableId: `${fp}on`, name: `${lab}: ${f.name} on` })
				for (const prm of k?.params ?? []) defs.push({ variableId: `${fp}${prm.key}`, name: `${lab}: ${f.name} ${prm.label}` })
			}
		})
		return Object.fromEntries(defs.map((d) => [d.variableId, { name: d.name }]))
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
			obs_error: this.engine.connected ? '' : (this.engine.obs?.lastError ?? ''),
			...this.#urlVariables(),
			...this.#recordVariables(),
			solo: this.engine.monitoring.solo ?? '',
			notices: this.engine.notices.list.length,
			notice: this.engine.notices.list.at(-1)?.title ?? '',
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
			v[`${p}pfl`] = this.engine.monitoring.pflShown(inp)
			v[`${p}backup_for`] = this.engine.backups.mainOf(inp)?.name ?? ''
			v[`${p}on_backup`] = this.engine.backups.onBackup(inp.name)
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

	#recordVariables(): CompanionVariableValues {
		const r = this.engine.recorder.state
		const plan = this.engine.store.record
		const cd = this.engine.recorder.countdown()
		const fmt = (s: number) => {
			const a = Math.abs(s)
			const hh = Math.floor(a / 3600)
			const mm = Math.floor((a % 3600) / 60)
			const ss = a % 60
			return `${s < 0 ? '-' : ''}${hh ? `${hh}:` : ''}${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
		}
		return {
			rec_state: r.active ? (r.paused ? 'paused' : 'recording') : 'stopped',
			rec_time: r.timecode ? r.timecode.split('.')[0] : '',
			rec_next: plan.nextStart ? new Date(plan.nextStart).toTimeString().slice(0, 5) : '',
			rec_countdown: cd === null ? '' : fmt(cd),
			rec_auto: !!plan.nextStart && plan.autoStart,
			rec_folder: r.directory,
			rec_files: r.fileCount ?? '',
		}
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
		Object.assign(v, this.#recordVariables())
		this.setVariableValues(v)
		this.checkFeedbacks('level_above', 'pickup_led', 'recording')
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
				callback: async ({ options }) => {
					const inp = this.#input(options)
					if (!inp) return
					if (options.edge === 'up') e.buttonUp(inp)
					else e.buttonDown(inp)
				},
			},
			ag_capture: {
				name: 'Auto gain: this level please',
				description: 'Capture the current level as the rider target',
				options: [inputOption],
				callback: async ({ options }) => {
					const inp = this.#input(options)
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
						disableAutoExpression: true,
						choices: [
							{ id: 'input', label: "The input's own calibrate level" },
							{ id: 'module', label: 'The module calibrate level' },
							{ id: 'custom', label: 'A level given here' },
						],
					},
					{ type: 'textinput', label: 'Level (dB)', id: 'level', default: '-18', useVariables: true, isVisibleExpression: "$(options:to) == 'custom'" },
				],
				callback: async ({ options }) => {
					const inp = this.#input(options)
					if (!inp) return
					if (options.to === 'custom') {
						const db = parseNumber(this.#text(options, 'level'), NaN, -100, 26)
						if (Number.isNaN(db)) return this.log('warn', 'Calibrate: the level isn\'t a number')
						e.calibrate(inp, db)
					} else e.calibrate(inp, options.to === 'module' ? 'module' : 'input')
				},
			},
			ag_rider: {
				name: 'Auto gain: rider on / off',
				options: [inputOption, { type: 'dropdown', label: 'Rider', id: 'mode', default: 'toggle', choices: onOffToggle }],
				callback: async ({ options }) => {
					const inp = this.#input(options)
					if (inp) e.setInputSetting(inp.name, 'riderOn', flip(options.mode, e.settings(inp.name).riderOn))
				},
			},
			ag_target: {
				name: 'Auto gain: set the rider target',
				options: [
					inputOption,
					{ type: 'dropdown', label: 'Mode', id: 'mode', default: 'set', disableAutoExpression: true, choices: modeChoices([{ id: 'clear', label: 'Clear the target' }]) },
					{ type: 'textinput', label: 'dB', id: 'db', default: '-18', useVariables: true, isVisibleExpression: "$(options:mode) != 'clear'" },
				],
				callback: async ({ options }) => {
					const inp = this.#input(options)
					if (!inp) return
					if (options.mode === 'clear') return e.setTarget(inp, null)
					const n = parseNumber(this.#text(options, 'db'), NaN, -100, 26)
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
						disableAutoExpression: true,
						choices: [
							{ id: 'input', label: 'One input' },
							{ id: 'default', label: 'The defaults (every input that has not changed it)' },
						],
					},
					{ ...inputOption, isVisibleExpression: "$(options:scope) == 'input'" },
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
				callback: async ({ options }) => {
					const key = String(options.key) as keyof InputSettings
					const value = this.#text(options, 'value')
					if (options.scope === 'default') return e.setDefaultSetting(key, value)
					const inp = this.#input(options)
					if (inp) e.setInputSetting(inp.name, key, value.toLowerCase() === 'default' ? undefined : value)
				},
			},
			volume: {
				name: 'Fader: set level',
				options: [
					inputOption,
					{ type: 'dropdown', label: 'Mode', id: 'mode', default: 'set', disableAutoExpression: true, choices: modeChoices() },
					{ type: 'textinput', label: 'dB (or -inf)', id: 'db', default: '0', useVariables: true },
					{ type: 'textinput', label: 'Fade time (ms, 0 = instant)', id: 'fade', default: '0', useVariables: true, isVisibleExpression: "$(options:mode) == 'set'" },
				],
				callback: async ({ options }) => {
					const inp = this.#input(options)
					if (!inp) return
					const db = parseDb(this.#text(options, 'db'))
					if (db === undefined) return this.log('warn', 'Fader: the level isn\'t a number')
					if (options.mode === 'adjust') {
						if (inp.volumeDb === null || db === null) return
						e.setVolume(inp, clamp(inp.volumeDb + db, MIN_DB, 26))
					} else e.setVolume(inp, db === null ? null : clamp(db, MIN_DB, 26), parseNumber(this.#text(options, 'fade'), 0, 0, 600000))
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
						disableAutoExpression: true,
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
						disableAutoExpression: true,
						tooltip:
							"Don't change OBS until the fader sits within the catch band of the OBS level for the dwell time, then stay latched until OBS is moved elsewhere. Show the state with the 'Grid fader pickup LED' feedback.",
						isVisibleExpression: "$(options:valueType) != 'db'",
					},
					{ type: 'textinput', label: 'Catch band (blank = this connection\'s setting)', id: 'band', default: '', useVariables: true, isVisibleExpression: "$(options:valueType) != 'db' && $(options:pickup)" },
					{ type: 'textinput', label: 'Dwell time ms (blank = this connection\'s setting)', id: 'dwell', default: '', useVariables: true, isVisibleExpression: "$(options:valueType) != 'db' && $(options:pickup)" },
					{
						type: 'textinput',
						label: 'Release band (blank = this connection\'s setting)',
						id: 'releaseBand',
						default: '',
						useVariables: true,
						tooltip: `Once latched, only an OBS-side move bigger than this lets go. ${NEVER_RELEASE_BAND} = never. Leave blank to use the connection's setting.`,
						isVisibleExpression: "$(options:valueType) != 'db' && $(options:pickup)",
					},
					{ type: 'textinput', label: 'Release time ms (blank = this connection\'s setting)', id: 'releaseMs', default: '', useVariables: true, isVisibleExpression: "$(options:valueType) != 'db' && $(options:pickup)" },
				],
				callback: async ({ options }) => {
					const fader = parseNumber(this.#text(options, 'fader'), 1, 1, 999)
					const inp = e.gridInput(Math.round(fader), this.#text(options, 'input'))
					if (!inp) return
					const raw = this.#text(options, 'value')
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
					const g = this.#resolved?.grid ?? { band: DEFAULT_BAND, dwellMs: DEFAULT_DWELL_MS, releaseBand: DEFAULT_RELEASE_BAND, releaseMs: DEFAULT_RELEASE_MS }
					const settings = {
						band: parseNumber(this.#text(options, 'band'), g.band, 0, 64),
						dwellMs: parseNumber(this.#text(options, 'dwell'), g.dwellMs, 0, 10000),
						releaseBand: parseNumber(this.#text(options, 'releaseBand'), g.releaseBand, 0, NEVER_RELEASE_BAND),
						releaseMs: parseNumber(this.#text(options, 'releaseMs'), g.releaseMs, 0, 60000),
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
				callback: async ({ options }) => {
					const inp = this.#input(options)
					if (!inp) return
					const n = parseNumber(this.#text(options, 'db'), NaN, -60, 60)
					if (Number.isNaN(n)) return
					e.setTrim(inp, clamp(options.mode === 'adjust' ? inp.trimDb + n : n, -30, 30))
				},
			},
			mute: {
				name: 'Input: mute',
				options: [inputOption, { type: 'dropdown', label: 'Mute', id: 'mode', default: 'toggle', choices: onOffToggle }],
				callback: async ({ options }) => {
					const inp = this.#input(options)
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
				callback: async ({ options }) => {
					const inp = this.#input(options)
					if (!inp) return
					const n = parseNumber(this.#text(options, 'value'), NaN, -200, 200)
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
				callback: async ({ options }) => {
					const inp = this.#input(options)
					if (!inp) return
					const n = parseNumber(this.#text(options, 'value'), NaN)
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
						disableAutoExpression: true,
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
						isVisibleExpression: "$(options:value) == 'toggle'",
					},
				],
				callback: async ({ options }) => {
					const inp = this.#input(options)
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
				callback: async ({ options }) => {
					const inp = this.#input(options)
					if (!inp) return
					const list = (this.#text(options, 'tracks'))
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
				callback: async ({ options }) => {
					const inp = this.#input(options)
					if (inp) await e.addFilter(inp, String(options.kind), this.#text(options, 'name'))
				},
			},
			filter_remove: {
				name: 'Processing: remove a filter',
				options: [inputOption, { type: 'textinput', label: 'Filter name', id: 'filter', default: '', useVariables: true }],
				callback: async ({ options }) => {
					const inp = this.#input(options)
					if (inp) await e.removeFilter(inp, this.#text(options, 'filter'))
				},
			},
			filter_enable: {
				name: 'Processing: filter on / off',
				options: [
					inputOption,
					{ type: 'textinput', label: 'Filter name', id: 'filter', default: 'Compressor', useVariables: true },
					{ type: 'dropdown', label: 'Filter', id: 'mode', default: 'toggle', choices: onOffToggle },
				],
				callback: async ({ options }) => {
					const inp = this.#input(options)
					if (!inp) return
					const name = this.#text(options, 'filter')
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
				callback: async ({ options }) => {
					const inp = this.#input(options)
					if (!inp) return
					const p = ALL_FILTER_PARAMS.find((x) => x.id === options.param)
					if (!p) return
					const name = this.#text(options, 'filter')
					const f = name ? inp.filters.find((x) => x.name === name) : inp.filters.find((x) => x.kind === p.kind.kind)
					if (!f) return this.log('warn', `${inp.name} has no ${name || p.kind.label} filter`)
					const raw = this.#text(options, 'value')
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
			pfl: {
				name: 'Input: PFL (listen on OBS monitoring)',
				description: "Uses OBS's monitoring (the headphone button in OBS's mixer). Never changes the stream or recording.",
				options: [inputOption, { type: 'dropdown', label: 'PFL', id: 'mode', default: 'toggle', choices: onOffToggle }],
				callback: async ({ options }) => {
					const inp = this.#input(options)
					if (inp) await e.monitoring.setPfl(inp, flip(options.mode, e.monitoring.pflShown(inp)))
				},
			},
			solo: {
				name: 'Input: solo (hear only this input on monitoring)',
				description:
					'While soloed you hear only this input on monitoring; ending the solo puts every PFL back as it was. Never changes the stream or recording. For press-and-hold, put "On" in the press actions and "Off" in the release actions.',
				options: [
					inputOption,
					{
						type: 'dropdown',
						label: 'Solo',
						id: 'mode',
						default: 'toggle',
						choices: [
							{ id: 'toggle', label: 'Toggle (latching)' },
							{ id: 'on', label: 'On (e.g. on press)' },
							{ id: 'off', label: 'Off (e.g. on release)' },
						],
					},
				],
				callback: async ({ options }) => {
					const inp = this.#input(options)
					if (inp) await e.monitoring.setSolo(inp, flip(options.mode, e.monitoring.solo === inp.name))
				},
			},
			backup_switch: {
				name: 'Backup: switch between main and backup',
				description: 'The input given is the backup feed (its "This is the backup for" setting names the main).',
				options: [
					{ ...inputOption, label: 'Backup input (name or number)' },
					{
						type: 'dropdown',
						label: 'Switch to',
						id: 'to',
						default: 'toggle',
						choices: [
							{ id: 'toggle', label: 'Toggle' },
							{ id: 'backup', label: 'The backup' },
							{ id: 'main', label: 'The main' },
						],
					},
				],
				callback: async ({ options }) => {
					const inp = this.#input(options)
					if (!inp) return
					if (!e.backups.mainOf(inp)) return this.log('warn', `${inp.name} isn't set as a backup for another input`)
					const toBackup = options.to === 'backup' || (options.to === 'toggle' && !e.backups.onBackup(inp.name))
					if (toBackup) e.backups.switchToBackup(inp, 'it was switched by hand')
					else e.backups.switchToMain(inp)
				},
			},
			rider_all: {
				name: 'Auto gain: every rider on / off',
				options: [
					{
						type: 'dropdown',
						label: 'Riders',
						id: 'mode',
						default: 'off',
						choices: [
							{ id: 'on', label: 'All on' },
							{ id: 'off', label: 'All off' },
						],
					},
				],
				callback: ({ options }) => {
					for (const inp of e.visible()) e.setInputSetting(inp.name, 'riderOn', options.mode === 'on')
				},
			},
			record: {
				name: 'Recording: start / stop / pause',
				description: 'Stopping from a button happens straight away (the fader page asks twice first).',
				options: [
					{
						type: 'dropdown',
						label: 'Recording',
						id: 'mode',
						default: 'start',
						choices: [
							{ id: 'start', label: 'Start' },
							{ id: 'stop', label: 'Stop' },
							{ id: 'toggle', label: 'Toggle start / stop' },
							{ id: 'pause', label: 'Pause' },
							{ id: 'resume', label: 'Resume' },
						],
					},
				],
				callback: async ({ options }) => {
					const r = e.recorder
					try {
						if (options.mode === 'start' || (options.mode === 'toggle' && !r.state.active)) await r.start()
						else if (options.mode === 'stop' || options.mode === 'toggle') await r.stop()
						else await r.pause(options.mode === 'pause')
					} catch (err) {
						this.log('warn', `Recording: ${(err as Error).message}`)
					}
				},
			},
			record_plan: {
				name: 'Recording: plan the next start',
				options: [
					{ type: 'textinput', label: 'Time (HH:MM, today or tomorrow if already past; blank = clear the plan)', id: 'time', default: '', useVariables: true },
					{ type: 'checkbox', label: 'Start recording automatically at that time', id: 'auto', default: false },
				],
				callback: async ({ options }) => {
					const t = this.#text(options, 'time')
					if (!t) return e.recorder.setPlan(null, false)
					const m = /^(\d{1,2}):(\d{2})$/.exec(t)
					if (!m) return this.log('warn', `Recording plan: "${t}" isn't a time like 14:30`)
					const d = new Date()
					d.setHours(Number(m[1]), Number(m[2]), 0, 0)
					if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1)
					e.recorder.setPlan(d.toISOString(), options.auto === true)
				},
			},
			record_folder: {
				name: 'Recording: set the folder',
				options: [{ type: 'textinput', label: 'Folder (on the OBS computer)', id: 'dir', default: '', useVariables: true }],
				callback: async ({ options }) => {
					try {
						await e.recorder.setDirectory(this.#text(options, 'dir'))
					} catch (err) {
						this.log('warn', `Recording folder: ${(err as Error).message}`)
					}
				},
			},
			record_name: {
				name: 'Recording: set the file name',
				description: "OBS's file name format. A prefix followed by OBS's date codes, e.g. Conference %CCYY-%MM-%DD %hh-%mm-%ss",
				options: [
					{ type: 'textinput', label: 'Prefix', id: 'prefix', default: '', useVariables: true },
					{ type: 'textinput', label: 'Then (OBS date codes)', id: 'rest', default: '%CCYY-%MM-%DD %hh-%mm-%ss', useVariables: true },
				],
				callback: async ({ options }) => {
					const prefix = this.#text(options, 'prefix')
					const rest = this.#text(options, 'rest')
					try {
						await e.recorder.setFilenameFormat(prefix ? `${prefix} ${rest}` : rest)
					} catch (err) {
						this.log('warn', `Recording file name: ${(err as Error).message}`)
					}
				},
			},
			page_setting: {
				name: 'Fader page: change a setting',
				description: 'Any fader page setting (colours, layout, meters, PFL mode...). The same settings as on the page.',
				options: [
					{ type: 'dropdown', label: 'Setting', id: 'key', default: 'layout', choices: PAGE_SETTING_CHOICES },
					{ type: 'textinput', label: 'Value', id: 'value', default: '', useVariables: true, tooltip: 'A number, true/false, a colour like #7a2fe0, or a choice (e.g. strips, rows, additive, exclusive).' },
				],
				callback: async ({ options }) => {
					e.setPage(String(options.key) as keyof PageSettings, this.#text(options, 'value'))
				},
			},
			notices_dismiss: {
				name: 'Fader page: dismiss all pop-ups',
				options: [],
				callback: () => {
					for (const n of [...e.notices.list]) void e.noticeAction(n.id, 'dismiss')
				},
			},
			open_page: {
				name: 'Fader page: open it on this computer',
				description: 'Opens the fader page in the default web browser of the computer Companion runs on.',
				options: [],
				callback: () => {
					const url = this.#pageUrls().find((u) => u.includes('127.0.0.1')) ?? this.#pageUrls()[0]
					if (!url) return this.log('warn', 'The fader page is off (its port is 0)')
					openInBrowser(url, (m) => this.log('warn', m))
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
		const inputFor = (o: CompanionOptionValues) => e.resolve(this.#text(o, 'input'))
		return {
			rider_status: {
				type: 'advanced',
				name: 'Auto gain: rider status colours',
				affectedProperties: ['bgcolor'],
				description: 'Background colour for what the rider is doing on an input',
				options: [inputOption, ...RIDER_STATES.map((s) => colourOpt(`c_${s.id}`, s.label, STATUS_COLOURS[s.id]))],
				callback: (fb) => {
					const inp = inputFor(fb.options)
					if (!inp) return {}
					const c = parseColour(this.#text(fb.options, `c_${inp.rider.state}`), undefined)
					return c === undefined ? {} : { bgcolor: c }
				},
			},
			pfl_on: {
				type: 'boolean',
				name: 'Input: PFL is on',
				defaultStyle: { bgcolor: rgb(0, 120, 60), color: rgb(255, 255, 255) },
				options: [inputOption],
				callback: (fb) => {
					const inp = inputFor(fb.options)
					return !!inp && e.monitoring.pflShown(inp)
				},
			},
			solo_on: {
				type: 'boolean',
				name: 'Input: soloed',
				defaultStyle: { bgcolor: rgb(200, 150, 0), color: rgb(0, 0, 0) },
				options: [inputOption],
				callback: (fb) => inputFor(fb.options)?.name === e.monitoring.solo,
			},
			on_backup: {
				type: 'boolean',
				name: 'Backup: switched to the backup',
				defaultStyle: { bgcolor: rgb(200, 100, 0), color: rgb(255, 255, 255) },
				options: [{ ...inputOption, label: 'Backup input (name or number)' }],
				callback: (fb) => {
					const inp = inputFor(fb.options)
					return !!inp && e.backups.onBackup(inp.name)
				},
			},
			recording: {
				type: 'boolean',
				name: 'Recording: is',
				defaultStyle: { bgcolor: rgb(200, 0, 0), color: rgb(255, 255, 255) },
				options: [
					{
						type: 'dropdown',
						label: 'State',
						id: 'state',
						default: 'active',
						choices: [
							{ id: 'active', label: 'Recording (or paused)' },
							{ id: 'paused', label: 'Paused' },
							{ id: 'stopped', label: 'Stopped' },
							{ id: 'due', label: 'Due to start (a start time is planned)' },
						],
					},
				],
				callback: (fb) => {
					const r = e.recorder.state
					if (fb.options.state === 'paused') return r.active && r.paused
					if (fb.options.state === 'stopped') return !r.active
					if (fb.options.state === 'due') return !r.active && !!e.store.record.nextStart
					return r.active
				},
			},
			notice_active: {
				type: 'boolean',
				name: 'Fader page: a pop-up is waiting',
				defaultStyle: { bgcolor: rgb(200, 100, 0), color: rgb(255, 255, 255) },
				options: [],
				callback: () => e.notices.list.length > 0,
			},
			connected: {
				type: 'boolean',
				name: 'Connected to OBS',
				defaultStyle: { bgcolor: rgb(0, 120, 60), color: rgb(255, 255, 255) },
				options: [],
				callback: () => e.connected,
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
				callback: (fb) => {
					const inp = inputFor(fb.options)
					return !!inp && e.settings(inp.name).riderOn
				},
			},
			muted: {
				type: 'boolean',
				name: 'Input: muted',
				defaultStyle: { bgcolor: rgb(200, 0, 0), color: rgb(255, 255, 255) },
				options: [inputOption],
				callback: (fb) => !!inputFor(fb.options)?.muted,
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
				callback: (fb) => {
					const inp = inputFor(fb.options)
					if (!inp) return false
					return fb.options.value === 'any' ? inp.monitor !== 'none' : inp.monitor === fb.options.value
				},
			},
			track_on: {
				type: 'boolean',
				name: 'Recording track on',
				defaultStyle: { bgcolor: rgb(85, 0, 170), color: rgb(255, 255, 255) },
				options: [inputOption, { type: 'textinput', label: 'Track (1-6)', id: 'track', default: '1', useVariables: true }],
				callback: (fb) => {
					const inp = inputFor(fb.options)
					return !!inp?.tracks[this.#text(fb.options, 'track')]
				},
			},
			filter_on: {
				type: 'boolean',
				name: 'Processing: filter is on',
				defaultStyle: { bgcolor: rgb(0, 120, 60), color: rgb(255, 255, 255) },
				options: [inputOption, { type: 'textinput', label: 'Filter name', id: 'filter', default: 'Compressor', useVariables: true }],
				callback: (fb) => {
					const inp = inputFor(fb.options)
					const name = this.#text(fb.options, 'filter')
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
				callback: (fb) => {
					const inp = inputFor(fb.options)
					if (!inp) return false
					const th = parseNumber(this.#text(fb.options, 'db'), 0)
					const max = (a: Db[]) => a.reduce<Db>((m, x) => (x !== null && (m === null || x > m) ? x : m), null)
					const v = fb.options.meter === 'rms' ? max(inp.postMag) : fb.options.meter === 'pre' ? max(inp.prePeak) : fb.options.meter === 'level' ? inp.rider.level : max(inp.postPeak)
					return v !== null && v >= th
				},
			},
			pickup_led: {
				type: 'advanced',
				name: 'Grid fader pickup LED',
				affectedProperties: ['bgcolor'],
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
				callback: (fb) => {
					const o = fb.options
					const fader = parseNumber(this.#text(o, 'fader'), 1, 1, 999)
					const inp = e.gridInput(Math.round(fader), this.#text(o, 'input'))
					if (!inp) return {}
					const raw = this.#text(o, 'value')
					const n = Number(raw)
					const { led, position } = e.pickup.ledState(inp.name, raw === '' || Number.isNaN(n) ? undefined : n)
					const flashMs = parseNumber(this.#text(o, 'flashMs'), DEFAULT_FLASH_MS, 50, 5000)
					const off = Math.floor(Date.now() / flashMs) % 2 === 1
					const col = (id: string, def: number) => parseColour(this.#text(o, id), def) ?? def
					switch (led) {
						case 'below':
							return { bgcolor: o.belowFlash && off ? BLACK : col('belowColour', rgb(255, 0, 0)) }
						case 'above':
							return { bgcolor: o.aboveFlash && off ? BLACK : col('aboveColour', rgb(255, 0, 0)) }
						case 'catch':
							return { bgcolor: col('catchColour', rgb(0, 255, 0)) }
						default:
							return { bgcolor: scaleColour(col('trackingColour', rgb(255, 255, 255)), position / 127) }
					}
				},
			},
		}
	}

	// ---- presets ------------------------------------------------------------------

	#presets(): { structure: CompanionPresetSection<ObsAudioTypes>[]; presets: CompanionPresetDefinitions<ObsAudioTypes> } {
		const presets: CompanionPresetDefinitions<ObsAudioTypes> = {}
		const structure: CompanionPresetSection<ObsAudioTypes>[] = []
		const white = rgb(255, 255, 255)
		const purple = rgb(85, 0, 170)
		const L = this.label
		/** Start a new section of presets; button() adds to the latest one */
		const section = (id: string, name: string) => {
			structure.push({ id, name, definitions: [] })
		}
		const button = (
			id: string,
			name: string,
			text: string,
			down: { actionId: string; options: CompanionOptionValues }[],
			feedbacks: { feedbackId: string; options: CompanionOptionValues; style?: { bgcolor?: number; color?: number } }[] = [],
			up: { actionId: string; options: CompanionOptionValues }[] = [],
		) => {
			presets[id] = {
				type: 'simple',
				name,
				style: { text, size: 'auto', color: white, bgcolor: BLACK },
				steps: [{ down, up }],
				feedbacks,
			}
			;(structure[structure.length - 1].definitions as string[]).push(id)
		}

		// overall
		section('overall', 'OBS Audio')
		button('open_page', 'Open the fader page (on this computer)', 'FADER\\nPAGE', [{ actionId: 'open_page', options: {} }])
		button('page_url', 'Fader page address', '$(' + L + ':page_url)', [], [])
		button('connected', 'OBS connection', 'OBS', [], [{ feedbackId: 'connected', options: {}, style: { bgcolor: rgb(0, 120, 60) } }])
		button('update', 'Update available', 'UPDATE', [{ actionId: 'open_page', options: {} }], [{ feedbackId: 'update_available', options: { which: 'either' }, style: { bgcolor: purple } }])
		button('riders_on', 'All riders on', 'ALL\\nRIDERS\\nON', [{ actionId: 'rider_all', options: { mode: 'on' } }])
		button('riders_off', 'All riders off', 'ALL\\nRIDERS\\nOFF', [{ actionId: 'rider_all', options: { mode: 'off' } }])
		button('record', 'Record start / stop', 'REC\\n$(' + L + ':rec_time)', [{ actionId: 'record', options: { mode: 'toggle' } }], [
			{ feedbackId: 'recording', options: { state: 'active' }, style: { bgcolor: rgb(200, 0, 0) } },
			{ feedbackId: 'recording', options: { state: 'paused' }, style: { bgcolor: rgb(150, 100, 0) } },
		])
		button('record_next', 'Next recording start and countdown', 'NEXT REC\\n$(' + L + ':rec_next)\\n$(' + L + ':rec_countdown)', [], [
			{ feedbackId: 'recording', options: { state: 'due' }, style: { bgcolor: purple } },
		])
		button('notices', 'Pop-ups waiting (press to dismiss all)', 'POP-UPS\\n$(' + L + ':notices)', [{ actionId: 'notices_dismiss', options: {} }], [
			{ feedbackId: 'notice_active', options: {}, style: { bgcolor: rgb(200, 100, 0) } },
		])

		this.engine.visible().forEach((inp, idx) => {
			const n = idx + 1
			const i = String(n)
			section(`input_${n}`, `Input ${n}: ${inp.name}`)
			const name = `$(${L}:in${n}_name)`
			button(
				`ag_${n}`,
				'Auto gain button: press = this level, double tap = calibrate, hold = calibrate to module level',
				`${name}\\nAG $(${L}:in${n}_target)`,
				[{ actionId: 'ag_button', options: { input: i, edge: 'down' } }],
				[{ feedbackId: 'rider_status', options: { input: i, ...Object.fromEntries(RIDER_STATES.map((st) => [`c_${st.id}`, STATUS_COLOURS[st.id]])) } }],
				[{ actionId: 'ag_button', options: { input: i, edge: 'up' } }],
			)
			button(`rider_${n}`, 'Rider on / off', `${name}\\nRIDER`, [{ actionId: 'ag_rider', options: { input: i, mode: 'toggle' } }], [
				{ feedbackId: 'rider_on', options: { input: i }, style: { bgcolor: purple, color: white } },
			])
			button(`status_${n}`, 'Rider status and target', `${name}\\n$(${L}:in${n}_rider)\\n$(${L}:in${n}_target)`, [], [
				{ feedbackId: 'rider_status', options: { input: i, ...Object.fromEntries(RIDER_STATES.map((st) => [`c_${st.id}`, STATUS_COLOURS[st.id]])) } },
			])
			button(`capture_${n}`, 'This level please', `${name}\\nTHIS\\nLEVEL`, [{ actionId: 'ag_capture', options: { input: i } }])
			button(`cal_${n}`, "Calibrate to the input's level", `${name}\\nCAL\\n$(${L}:in${n}_cal)`, [{ actionId: 'ag_calibrate', options: { input: i, to: 'input' } }])
			button(`calm_${n}`, 'Calibrate to the module level', `${name}\\nCAL\\nMODULE`, [{ actionId: 'ag_calibrate', options: { input: i, to: 'module' } }])
			button(`mute_${n}`, 'Mute', `${name}\\nMUTE`, [{ actionId: 'mute', options: { input: i, mode: 'toggle' } }], [
				{ feedbackId: 'muted', options: { input: i }, style: { bgcolor: rgb(200, 0, 0), color: white } },
			])
			button(`pfl_${n}`, 'PFL', `${name}\\nPFL`, [{ actionId: 'pfl', options: { input: i, mode: 'toggle' } }], [
				{ feedbackId: 'pfl_on', options: { input: i }, style: { bgcolor: rgb(0, 120, 60), color: white } },
			])
			button(
				`solo_${n}`,
				'Solo (hold)',
				`${name}\\nSOLO`,
				[{ actionId: 'solo', options: { input: i, mode: 'on' } }],
				[{ feedbackId: 'solo_on', options: { input: i }, style: { bgcolor: rgb(200, 150, 0), color: BLACK } }],
				[{ actionId: 'solo', options: { input: i, mode: 'off' } }],
			)
			button(`solol_${n}`, 'Solo (latching)', `${name}\\nSOLO\\nLATCH`, [{ actionId: 'solo', options: { input: i, mode: 'toggle' } }], [
				{ feedbackId: 'solo_on', options: { input: i }, style: { bgcolor: rgb(200, 150, 0), color: BLACK } },
			])
			button(`level_${n}`, 'Level readout', `${name}\\n$(${L}:in${n}_vol) dB\\n$(${L}:in${n}_peak)`, [], [
				{ feedbackId: 'level_above', options: { input: i, meter: 'peak', db: '-18' }, style: { bgcolor: rgb(0, 100, 0) } },
				{ feedbackId: 'level_above', options: { input: i, meter: 'peak', db: '-6' }, style: { bgcolor: rgb(150, 120, 0) } },
				{ feedbackId: 'level_above', options: { input: i, meter: 'peak', db: '-1' }, style: { bgcolor: rgb(200, 0, 0) } },
			])
			for (const [id, label, mode, db] of [
				['up1', '+1 dB', 'adjust', '1'],
				['dn1', '-1 dB', 'adjust', '-1'],
				['up3', '+3 dB', 'adjust', '3'],
				['dn3', '-3 dB', 'adjust', '-3'],
				['unity', '0 dB', 'set', '0'],
			]) {
				button(`fader_${id}_${n}`, `Fader ${label}`, `${name}\\nFADER\\n${label}`, [{ actionId: 'volume', options: { input: i, mode, db, fade: '0' } }])
			}
			button(`trim_up_${n}`, 'Trim +1 dB', `${name}\\nTRIM\\n+1 dB`, [{ actionId: 'trim', options: { input: i, mode: 'adjust', db: '1' } }])
			button(`trim_dn_${n}`, 'Trim -1 dB', `${name}\\nTRIM\\n-1 dB`, [{ actionId: 'trim', options: { input: i, mode: 'adjust', db: '-1' } }])
			for (let t = 1; t <= 6; t++) {
				button(`track_${n}_${t}`, `Track ${t}`, `${name}\\nTRK ${t}`, [{ actionId: 'tracks', options: { input: i, tracks: String(t), mode: 'toggle' } }], [
					{ feedbackId: 'track_on', options: { input: i, track: String(t) }, style: { bgcolor: purple, color: white } },
				])
			}
			for (const f of inp.filters) {
				if (f.name === this.engine.settings(inp.name).trimFilterName) continue
				button(`filter_${n}_${slug(f.name)}`, `${f.name} on / off`, `${name}\\n${f.name.toUpperCase()}`, [
					{ actionId: 'filter_enable', options: { input: i, filter: f.name, mode: 'toggle' } },
				], [{ feedbackId: 'filter_on', options: { input: i, filter: f.name }, style: { bgcolor: rgb(0, 120, 60), color: white } }])
			}
			if (this.engine.backups.mainOf(inp)) {
				button(`backup_${n}`, 'Switch between main and this backup', `${name}\\nBACKUP`, [{ actionId: 'backup_switch', options: { input: i, to: 'toggle' } }], [
					{ feedbackId: 'on_backup', options: { input: i }, style: { bgcolor: rgb(200, 100, 0), color: white } },
				])
			}
		})
		return { structure, presets }
	}
}
