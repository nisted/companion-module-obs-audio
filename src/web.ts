/**
 * The module's own web server: the fader and meter page, a live feed
 * (Server-Sent Events, which OBS's browser docks handle well) and a small
 * command API. Optional PIN: sent as ?pin= on every request.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { Engine, MonitorType } from './engine.js'
import { PAGE_HTML } from './page.js'
import { parseDb } from './law.js'
import type { ImportPart, InputSettings, PageSettings, Section, SectionMode } from './settings.js'
import { Engine as EngineClass } from './engine.js'

export interface WebOptions {
	port: number
	bind: string
	pin: string
}

const MAX_BODY = 4 * 1024 * 1024

export class WebServer {
	#server: Server | null = null
	#clients = new Set<ServerResponse>()
	#engine: Engine
	#opts: WebOptions
	#meterTimer: NodeJS.Timeout | null = null
	#onState = () => this.#broadcast('state', this.#engine.snapshot())
	#onStatus = this.#onState
	#log: (level: 'info' | 'warn' | 'error', msg: string) => void

	constructor(engine: Engine, opts: WebOptions, log: (level: 'info' | 'warn' | 'error', msg: string) => void) {
		this.#engine = engine
		this.#opts = opts
		this.#log = log
	}

	start(): void {
		const server = createServer((req, res) => void this.#handle(req, res))
		server.on('error', (e) => this.#log('error', `Web page server: ${e.message}`))
		server.listen(this.#opts.port, this.#opts.bind || '0.0.0.0', () => {
			this.#log('info', `Fader page on port ${this.#opts.port}`)
		})
		this.#server = server
		this.#engine.on('state', this.#onState)
		this.#engine.on('status', this.#onStatus)
		this.#restartMeters()
	}

	/** The port actually listened on (useful when 0 was asked for) */
	get port(): number {
		const a = this.#server?.address()
		return a && typeof a === 'object' ? a.port : 0
	}

	#restartMeters(): void {
		if (this.#meterTimer) clearInterval(this.#meterTimer)
		const hz = Math.max(1, Math.min(30, this.#engine.store.page.meterRateHz || 20))
		this.#meterTimer = setInterval(() => {
			if (this.#clients.size) this.#broadcast('meters', this.#engine.meterFrame())
		}, 1000 / hz)
	}

	stop(): void {
		if (this.#meterTimer) clearInterval(this.#meterTimer)
		this.#meterTimer = null
		this.#engine.off('state', this.#onState)
		this.#engine.off('status', this.#onStatus)
		for (const c of this.#clients) c.end()
		this.#clients.clear()
		this.#server?.close()
		this.#server = null
	}

	#pinOk(url: URL): boolean {
		if (!this.#opts.pin) return true
		const a = Buffer.from(url.searchParams.get('pin') ?? '')
		const b = Buffer.from(this.#opts.pin)
		return a.length === b.length && timingSafeEqual(a, b)
	}

	#broadcast(event: string, data: unknown): void {
		const text = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
		for (const c of this.#clients) c.write(text)
	}

	async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? '/', 'http://x')
		try {
			if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
				res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
				res.end(PAGE_HTML)
				return
			}
			if (!this.#pinOk(url)) {
				res.writeHead(401, { 'Content-Type': 'application/json' })
				res.end(JSON.stringify({ error: 'pin' }))
				return
			}
			if (req.method === 'GET' && url.pathname === '/events') {
				res.writeHead(200, {
					'Content-Type': 'text/event-stream',
					'Cache-Control': 'no-store',
					Connection: 'keep-alive',
					'X-Accel-Buffering': 'no',
				})
				res.write(`event: meta\ndata: ${JSON.stringify(EngineClass.meta)}\n\n`)
				res.write(`event: state\ndata: ${JSON.stringify(this.#engine.snapshot())}\n\n`)
				this.#clients.add(res)
				const ping = setInterval(() => res.write(': ping\n\n'), 15000)
				req.on('close', () => {
					clearInterval(ping)
					this.#clients.delete(res)
				})
				return
			}
			if (req.method === 'GET' && url.pathname === '/export') {
				res.writeHead(200, {
					'Content-Type': 'application/json',
					'Content-Disposition': `attachment; filename="obs-audio-settings-${new Date().toISOString().slice(0, 10)}.json"`,
				})
				res.end(this.#engine.exportJson())
				return
			}
			if (req.method === 'POST' && url.pathname === '/cmd') {
				const body = await readBody(req)
				const result = await this.#command(JSON.parse(body) as Record<string, unknown>)
				res.writeHead(200, { 'Content-Type': 'application/json' })
				res.end(JSON.stringify({ ok: true, message: result ?? '' }))
				return
			}
			res.writeHead(404)
			res.end()
		} catch (e) {
			res.writeHead(400, { 'Content-Type': 'application/json' })
			res.end(JSON.stringify({ ok: false, error: (e as Error).message }))
		}
	}

	async #command(c: Record<string, unknown>): Promise<string | void> {
		const e = this.#engine
		const cmd = String(c.cmd ?? '')
		const input = () => {
			const inp = e.inputs.get(String(c.input ?? ''))
			if (!inp) throw new Error(`No input "${String(c.input)}"`)
			return inp
		}
		switch (cmd) {
			case 'volume': {
				const db = c.db === null ? null : Number(c.db)
				if (db !== null && Number.isNaN(db)) throw new Error('Bad level')
				const inp = input()
				e.setVolume(inp, db)
				e.recordable('volume', { input: inp.name, mode: 'set', db: db === null ? '-inf' : db.toFixed(1), fade: '0' }, `vol:${inp.name}`)
				return
			}
			case 'pfl':
				return void (await e.monitoring.setPfl(input(), !!c.value))
			case 'solo':
				return void (await e.monitoring.setSolo(input(), !!c.value))
			case 'notice':
				return (await e.noticeAction(String(c.id), String(c.action))) ?? undefined
			case 'backupSwitch': {
				const inp = input()
				if (c.to === 'main') e.backups.switchToMain(inp)
				else e.backups.switchToBackup(inp, 'it was switched by hand')
				return
			}
			case 'recordStart':
				return void (await e.recorder.start())
			case 'recordStop':
				return void (await e.recorder.stop())
			case 'recordPause':
				return void (await e.recorder.pause(!!c.value))
			case 'recordPlan':
				e.recorder.setPlan(c.nextStart ? String(c.nextStart) : null, !!c.autoStart)
				return
			case 'recordFolder':
				return void (await e.recorder.setDirectory(String(c.value ?? '')))
			case 'recordFormat':
				return void (await e.recorder.setFilenameFormat(String(c.value ?? '')))
			case 'touch':
				e.touch(input(), !!c.value)
				return
			case 'mute': {
				const inp = input()
				e.recordable('mute', { input: inp.name, mode: c.value ? 'on' : 'off' }, `mute:${inp.name}`)
				return void (await e.setMute(inp, !!c.value))
			}
			case 'balance': {
				const inp = input()
				e.recordable('balance', { input: inp.name, mode: 'set', value: String(Math.round((Number(c.value) - 0.5) * 200)) }, `bal:${inp.name}`)
				return void (await e.setBalance(inp, Number(c.value)))
			}
			case 'sync': {
				const inp = input()
				e.recordable('sync', { input: inp.name, mode: 'set', value: String(Number(c.value)) }, `sync:${inp.name}`)
				return void (await e.setSync(inp, Number(c.value)))
			}
			case 'monitor':
				return void (await e.setMonitor(input(), String(c.value) as MonitorType))
			case 'track': {
				const inp = input()
				e.recordable('tracks', { input: inp.name, tracks: String(c.track), mode: c.value ? 'on' : 'off' }, `tracks:${inp.name}:${String(c.track)}`)
				return void (await e.setTracks(inp, { [String(c.track)]: !!c.value }))
			}
			case 'trim': {
				const inp = input()
				e.setTrim(inp, Number(c.value))
				e.recordable('trim', { input: inp.name, mode: 'set', db: String(Number(c.value)) }, `trim:${inp.name}`)
				return
			}
			case 'filterAdd':
				return void (await e.addFilter(input(), String(c.kind), String(c.name ?? '')))
			case 'filterRemove':
				return void (await e.removeFilter(input(), String(c.filter)))
			case 'filterEnable': {
				const inp = input()
				e.recordable('filter_enable', { input: inp.name, filter: String(c.filter), mode: c.value ? 'on' : 'off' }, `fon:${inp.name}:${String(c.filter)}`)
				return void (await e.setFilterEnabled(inp, String(c.filter), !!c.value))
			}
			case 'filterSet': {
				const inp = input()
				const f = inp.filters.find((x) => x.name === String(c.filter))
				if (f) e.recordable('filter_set', { input: inp.name, param: `${f.kind}:${String(c.key)}`, filter: f.name, mode: 'set', value: String(c.value) }, `f:${inp.name}:${f.name}:${String(c.key)}`)
				return void (await e.setFilterSetting(inp, String(c.filter), String(c.key), c.value))
			}
			case 'rider':
				e.setInputSetting(input().name, 'riderOn', !!c.value)
				return
			case 'capture':
				e.captureTarget(input())
				return
			case 'calibrate': {
				const w = c.level
				e.calibrate(input(), w === 'module' ? 'module' : w === 'input' || w === undefined ? 'input' : Number(w))
				return
			}
			case 'setTarget': {
				const db = parseDb(c.value)
				e.setTarget(input(), db === undefined ? null : db)
				return
			}
			case 'inputSetting':
				e.setInputSetting(input().name, String(c.key) as keyof InputSettings, c.value ?? undefined)
				return
			case 'defaultSetting':
				e.setDefaultSetting(String(c.key) as keyof InputSettings, c.value)
				return
			case 'page':
				e.setPage(String(c.key) as keyof PageSettings, c.value)
				if (c.key === 'meterRateHz') this.#restartMeters()
				return
			case 'gestures':
				e.setGestures(num(c.doubleTapMs), num(c.holdMs), num(c.moduleCalibrateDb))
				return
			case 'sections':
				e.setSections((c.sections as Section[]) ?? [])
				return
			case 'inputSection':
				e.setInputSection(String(c.input), String(c.section), (c.mode as SectionMode | null) ?? null)
				return
			case 'order':
				e.setOrder((c.order as string[]) ?? [], (c.hidden as string[]) ?? [])
				return
			case 'import':
				return e.importJson(String(c.data ?? ''), ((c.parts as ImportPart[]) ?? []).filter((p) => typeof p === 'string'))
			case 'restoreAutosave':
				return e.restoreAutosave()
			default:
				throw new Error(`Unknown command "${cmd}"`)
		}
	}
}

function num(v: unknown): number | undefined {
	if (v === undefined || v === null || v === '') return undefined
	const n = Number(v)
	return Number.isNaN(n) ? undefined : n
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let size = 0
		const chunks: Buffer[] = []
		req.on('data', (c: Buffer) => {
			size += c.length
			if (size > MAX_BODY) {
				reject(new Error('Too big'))
				req.destroy()
				return
			}
			chunks.push(c)
		})
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
		req.on('error', reject)
	})
}
