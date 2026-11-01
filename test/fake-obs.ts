/**
 * A pretend OBS for tests: speaks obs-websocket v5, has audio inputs with a
 * synthetic signal, applies gain filters and the fader, and sends meters at
 * 20 Hz like the real thing.
 */
import { createHash } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'

interface FakeFilter {
	filterName: string
	filterKind: string
	filterEnabled: boolean
	filterSettings: Record<string, unknown>
}

export interface FakeInput {
	name: string
	kind: string
	volMul: number
	muted: boolean
	balance: number
	sync: number
	monitor: string
	tracks: Record<string, boolean>
	filters: FakeFilter[]
	/** Incoming signal level, dB (RMS); peak is +6 */
	signalDb: number | null
	audio: boolean
}

export class FakeObs {
	wss: WebSocketServer
	clients = new Set<WebSocket>()
	inputs: FakeInput[] = []
	requests: { type: string; data: Record<string, unknown> }[] = []
	password: string
	#timer: NodeJS.Timeout
	port = 0

	constructor(password = '') {
		this.password = password
		this.wss = new WebSocketServer({ port: 0 })
		this.port = (this.wss.address() as { port: number }).port
		this.wss.on('connection', (ws) => this.#onConn(ws))
		this.#timer = setInterval(() => this.#meters(), 50)
	}

	close(): void {
		clearInterval(this.#timer)
		for (const c of this.clients) c.terminate()
		this.wss.close()
	}

	addInput(name: string, signalDb: number | null, audio = true): FakeInput {
		const i: FakeInput = {
			name,
			kind: 'wasapi_input_capture',
			volMul: 1,
			muted: false,
			balance: 0.5,
			sync: 0,
			monitor: 'OBS_MONITORING_TYPE_NONE',
			tracks: { '1': true, '2': false, '3': false, '4': false, '5': false, '6': false },
			filters: [],
			signalDb,
			audio,
		}
		this.inputs.push(i)
		return i
	}

	input(name: string): FakeInput {
		const i = this.inputs.find((x) => x.name === name)
		if (!i) throw new Error('no input')
		return i
	}

	#send(ws: WebSocket, op: number, d: unknown): void {
		ws.send(JSON.stringify({ op, d }))
	}

	event(type: string, data: Record<string, unknown>, sub = 8): void {
		for (const c of this.clients) if ((c as unknown as { subs: number }).subs & sub) this.#send(c, 5, { eventType: type, eventIntent: sub, eventData: data })
	}

	#onConn(ws: WebSocket): void {
		const salt = 'salty'
		const challenge = 'chally'
		this.#send(ws, 0, {
			obsWebSocketVersion: '5.5.0',
			rpcVersion: 1,
			...(this.password ? { authentication: { salt, challenge } } : {}),
		})
		ws.on('message', (raw) => {
			const msg = JSON.parse(String(raw))
			if (msg.op === 1) {
				if (this.password) {
					const secret = createHash('sha256').update(this.password + salt).digest('base64')
					const want = createHash('sha256').update(secret + challenge).digest('base64')
					if (msg.d.authentication !== want) return ws.close(4009, 'Authentication failed')
				}
				;(ws as unknown as { subs: number }).subs = msg.d.eventSubscriptions
				this.clients.add(ws)
				this.#send(ws, 2, { negotiatedRpcVersion: 1 })
				return
			}
			if (msg.op === 6) {
				const { requestType, requestId, requestData } = msg.d
				this.requests.push({ type: requestType, data: requestData ?? {} })
				try {
					const responseData = this.#request(requestType, requestData ?? {})
					this.#send(ws, 7, { requestType, requestId, requestStatus: { result: true, code: 100 }, responseData })
				} catch (e) {
					this.#send(ws, 7, { requestType, requestId, requestStatus: { result: false, code: 600, comment: (e as Error).message } })
				}
			}
		})
		ws.on('close', () => this.clients.delete(ws))
	}

	#audioInput(name: unknown): FakeInput {
		const i = this.inputs.find((x) => x.name === name)
		if (!i) throw new Error('No source was found')
		if (!i.audio) throw new Error('The specified input does not support audio')
		return i
	}

	#request(type: string, d: Record<string, unknown>): unknown {
		switch (type) {
			case 'GetVersion':
				return { obsVersion: '31.0.2', obsWebSocketVersion: '5.5.0', rpcVersion: 1 }
			case 'GetSourceFilterKindList':
				return {
					sourceFilterKinds: ['noise_suppress_filter_v2', 'noise_gate_filter', 'gain_filter', 'compressor_filter', 'limiter_filter', 'expander_filter', 'upward_compressor_filter', 'basic_eq_filter', 'color_filter_v2'],
				}
			case 'GetInputList':
				return { inputs: this.inputs.map((i) => ({ inputName: i.name, inputKind: i.kind, unversionedInputKind: i.kind })) }
			case 'GetInputVolume': {
				const i = this.#audioInput(d.inputName)
				return { inputVolumeMul: i.volMul, inputVolumeDb: i.volMul > 0 ? 20 * Math.log10(i.volMul) : -100 }
			}
			case 'SetInputVolume': {
				const i = this.#audioInput(d.inputName)
				i.volMul = d.inputVolumeMul !== undefined ? Number(d.inputVolumeMul) : Math.pow(10, Number(d.inputVolumeDb) / 20)
				this.event('InputVolumeChanged', { inputName: i.name, inputVolumeMul: i.volMul, inputVolumeDb: i.volMul > 0 ? 20 * Math.log10(i.volMul) : -100 })
				return {}
			}
			case 'GetInputMute':
				return { inputMuted: this.#audioInput(d.inputName).muted }
			case 'SetInputMute': {
				const i = this.#audioInput(d.inputName)
				i.muted = !!d.inputMuted
				this.event('InputMuteStateChanged', { inputName: i.name, inputMuted: i.muted })
				return {}
			}
			case 'GetInputAudioBalance':
				return { inputAudioBalance: this.#audioInput(d.inputName).balance }
			case 'SetInputAudioBalance': {
				const i = this.#audioInput(d.inputName)
				i.balance = Number(d.inputAudioBalance)
				this.event('InputAudioBalanceChanged', { inputName: i.name, inputAudioBalance: i.balance })
				return {}
			}
			case 'GetInputAudioSyncOffset':
				return { inputAudioSyncOffset: this.#audioInput(d.inputName).sync }
			case 'SetInputAudioSyncOffset': {
				const i = this.#audioInput(d.inputName)
				i.sync = Number(d.inputAudioSyncOffset)
				this.event('InputAudioSyncOffsetChanged', { inputName: i.name, inputAudioSyncOffset: i.sync })
				return {}
			}
			case 'GetInputAudioMonitorType':
				return { monitorType: this.#audioInput(d.inputName).monitor }
			case 'SetInputAudioMonitorType': {
				const i = this.#audioInput(d.inputName)
				i.monitor = String(d.monitorType)
				this.event('InputAudioMonitorTypeChanged', { inputName: i.name, monitorType: i.monitor })
				return {}
			}
			case 'GetInputAudioTracks':
				return { inputAudioTracks: this.#audioInput(d.inputName).tracks }
			case 'SetInputAudioTracks': {
				const i = this.#audioInput(d.inputName)
				Object.assign(i.tracks, d.inputAudioTracks)
				this.event('InputAudioTracksChanged', { inputName: i.name, inputAudioTracks: i.tracks })
				return {}
			}
			case 'GetSourceFilterList':
				return { filters: this.#audioInput(d.sourceName).filters.map((f, idx) => ({ ...f, filterIndex: idx })) }
			case 'GetSourceFilterDefaultSettings':
				return { defaultFilterSettings: d.filterKind === 'gain_filter' ? { db: 0 } : {} }
			case 'CreateSourceFilter': {
				const i = this.#audioInput(d.sourceName)
				if (i.filters.some((f) => f.filterName === d.filterName)) throw new Error('A filter already exists by that name')
				const known = ['noise_suppress_filter_v2', 'noise_gate_filter', 'gain_filter', 'compressor_filter', 'limiter_filter', 'expander_filter', 'upward_compressor_filter', 'basic_eq_filter']
				if (!known.includes(String(d.filterKind))) throw new Error('Your specified filter kind is not supported by OBS')
				i.filters.push({ filterName: String(d.filterName), filterKind: String(d.filterKind), filterEnabled: true, filterSettings: (d.filterSettings as Record<string, unknown>) ?? {} })
				this.event('SourceFilterCreated', { sourceName: i.name, filterName: d.filterName, filterKind: d.filterKind, filterSettings: d.filterSettings ?? {} }, 32)
				return {}
			}
			case 'RemoveSourceFilter': {
				const i = this.#audioInput(d.sourceName)
				i.filters = i.filters.filter((f) => f.filterName !== d.filterName)
				this.event('SourceFilterRemoved', { sourceName: i.name, filterName: d.filterName }, 32)
				return {}
			}
			case 'SetSourceFilterSettings': {
				const i = this.#audioInput(d.sourceName)
				const f = i.filters.find((x) => x.filterName === d.filterName)
				if (!f) throw new Error('No filter was found')
				Object.assign(f.filterSettings, d.filterSettings)
				this.event('SourceFilterSettingsChanged', { sourceName: i.name, filterName: f.filterName, filterSettings: f.filterSettings }, 32)
				return {}
			}
			case 'SetSourceFilterEnabled': {
				const i = this.#audioInput(d.sourceName)
				const f = i.filters.find((x) => x.filterName === d.filterName)
				if (!f) throw new Error('No filter was found')
				f.filterEnabled = !!d.filterEnabled
				this.event('SourceFilterEnableStateChanged', { sourceName: i.name, filterName: f.filterName, filterEnabled: f.filterEnabled }, 32)
				return {}
			}
			default:
				throw new Error(`Unhandled request ${type}`)
		}
	}

	#meters(): void {
		const inputs = this.inputs
			.filter((i) => i.audio)
			.map((i) => {
				let gain = 0
				for (const f of i.filters) if (f.filterEnabled && f.filterKind === 'gain_filter') gain += Number(f.filterSettings.db ?? 0)
				const sig = i.signalDb === null ? 0 : Math.pow(10, (i.signalDb + gain + (Math.random() - 0.5)) / 20)
				const pk = sig * 2
				const vol = i.muted ? 0 : i.volMul
				const ch = [sig * vol, pk * vol, pk]
				return { inputName: i.name, inputUuid: i.name, inputLevelsMul: [ch, ch] }
			})
		this.event('InputVolumeMeters', { inputs }, 1 << 16)
	}
}
