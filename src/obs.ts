/**
 * A small obs-websocket v5 client on Node's built-in WebSocket, so the module
 * needs no outside packages. Reconnects by itself.
 */

import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'

const OP_HELLO = 0
const OP_IDENTIFY = 1
const OP_IDENTIFIED = 2
const OP_EVENT = 5
const OP_REQUEST = 6
const OP_RESPONSE = 7

/** General | Inputs | Filters | Outputs | InputVolumeMeters */
export const EVENT_SUBS = 1 | 8 | 32 | 64 | (1 << 16)

/** Why a connection to OBS failed or dropped, in plain words */
export function explainClose(code: number, reason: string, host: string, port: number, everConnected: boolean): string {
	if (code === 4009) {
		return `OBS says the password is wrong. In OBS: Tools → WebSocket Server Settings → Show Connect Info, copy the Server Password into this connection, or untick Enable Authentication there and leave the password blank.`
	}
	if (code === 4010) return 'OBS is running an older WebSocket version this module can\'t talk to (needs obs-websocket 5, built into OBS 28 and later).'
	if (code === 1006 && !everConnected) {
		return `Can't reach OBS at ${host}:${port}. Is OBS running, and is its WebSocket server on? In OBS: Tools → WebSocket Server Settings → tick Enable WebSocket server (it's off by default) and check the port (normally 4455).`
	}
	if (code === 1006) return `Lost the connection to OBS at ${host}:${port} (OBS closed, or the network dropped). Trying again.`
	return `Disconnected from OBS${reason ? `: ${reason}` : ` (code ${code})`}. Trying again.`
}

export class ObsRequestError extends Error {
	constructor(
		readonly requestType: string,
		readonly code: number,
		comment: string,
	) {
		super(`${requestType} failed (${code})${comment ? `: ${comment}` : ''}`)
	}
}

export interface ObsOptions {
	host: string
	port: number
	password: string
	reconnectMs?: number
	requestTimeoutMs?: number
}

type Pending = { resolve: (d: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

/**
 * Events: 'connected', 'disconnected' (reason), 'error' (Error),
 * 'event' (eventType, eventData)
 */
export class ObsClient extends EventEmitter {
	#ws: WebSocket | null = null
	#opts: ObsOptions
	#pending = new Map<string, Pending>()
	#identified = false
	#everConnected = false
	#stopped = true
	/** The last reason the connection failed, in plain words, or '' */
	lastError = ''
	#retry: NodeJS.Timeout | null = null

	constructor(opts: ObsOptions) {
		super()
		this.#opts = opts
	}

	get connected(): boolean {
		return this.#identified
	}

	start(): void {
		this.#stopped = false
		this.#open()
	}

	stop(): void {
		this.#stopped = true
		if (this.#retry) clearTimeout(this.#retry)
		this.#retry = null
		this.#close('stopped')
	}

	#open(): void {
		if (this.#stopped) return
		const { host, port } = this.#opts
		let ws: WebSocket
		try {
			ws = new WebSocket(`ws://${host}:${port}`, 'obswebsocket.json')
		} catch (e) {
			this.emit('error', e as Error)
			this.#scheduleRetry()
			return
		}
		this.#ws = ws
		ws.onmessage = (ev) => this.#onMessage(String(ev.data))
		ws.onerror = () => {
			/* the close that follows does the work */
		}
		ws.onclose = (ev) => {
			if (this.#ws !== ws) return
			this.#ws = null
			const was = this.#identified
			this.#identified = false
			this.#failPending(new Error('Disconnected from OBS'))
			this.lastError = explainClose(ev.code, ev.reason, this.#opts.host, this.#opts.port, this.#everConnected)
			this.emit('disconnected', this.lastError, was)
			this.#scheduleRetry()
		}
	}

	#close(reason: string): void {
		const ws = this.#ws
		this.#ws = null
		this.#identified = false
		this.#failPending(new Error(reason))
		if (ws) {
			try {
				ws.close()
			} catch {
				/* already closed */
			}
		}
	}

	#scheduleRetry(): void {
		if (this.#stopped || this.#retry) return
		this.#retry = setTimeout(() => {
			this.#retry = null
			this.#open()
		}, this.#opts.reconnectMs ?? 3000)
	}

	#failPending(err: Error): void {
		for (const p of this.#pending.values()) {
			clearTimeout(p.timer)
			p.reject(err)
		}
		this.#pending.clear()
	}

	#send(op: number, d: unknown): void {
		this.#ws?.send(JSON.stringify({ op, d }))
	}

	#onMessage(text: string): void {
		let msg: { op: number; d: Record<string, unknown> }
		try {
			msg = JSON.parse(text)
		} catch {
			return
		}
		const d = msg.d ?? {}
		switch (msg.op) {
			case OP_HELLO: {
				const ident: Record<string, unknown> = { rpcVersion: 1, eventSubscriptions: EVENT_SUBS }
				const auth = d.authentication as { challenge: string; salt: string } | undefined
				if (auth) {
					const secret = createHash('sha256')
						.update(this.#opts.password + auth.salt)
						.digest('base64')
					ident.authentication = createHash('sha256')
						.update(secret + auth.challenge)
						.digest('base64')
				}
				this.#send(OP_IDENTIFY, ident)
				break
			}
			case OP_IDENTIFIED:
				this.#identified = true
				this.#everConnected = true
				this.lastError = ''
				this.emit('connected')
				break
			case OP_EVENT:
				this.emit('event', d.eventType as string, (d.eventData ?? {}) as Record<string, unknown>)
				break
			case OP_RESPONSE: {
				const id = d.requestId as string
				const p = this.#pending.get(id)
				if (!p) return
				this.#pending.delete(id)
				clearTimeout(p.timer)
				const status = d.requestStatus as { result: boolean; code: number; comment?: string }
				if (status?.result) p.resolve(d.responseData ?? {})
				else p.reject(new ObsRequestError(String(d.requestType), status?.code ?? 0, status?.comment ?? ''))
				break
			}
		}
	}

	call<T = Record<string, unknown>>(requestType: string, requestData?: Record<string, unknown>): Promise<T> {
		if (!this.#identified || !this.#ws) return Promise.reject(new Error('Not connected to OBS'))
		const requestId = randomUUID()
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(requestId)
				reject(new Error(`${requestType} timed out`))
			}, this.#opts.requestTimeoutMs ?? 5000)
			this.#pending.set(requestId, { resolve: resolve as (d: unknown) => void, reject, timer })
			this.#send(OP_REQUEST, { requestType, requestId, requestData })
		})
	}
}
