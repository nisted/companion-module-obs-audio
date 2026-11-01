import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dbToPosition, positionToDb, type LawSettings } from '../src/law.js'
import { Rider, type MeterSample } from '../src/rider.js'
import { INPUT_DEFAULTS, type InputRecord, type InputSettings, loadStore, newStore, applyImport } from '../src/settings.js'
import { PickupManager } from '../src/pickup.js'
import { GestureReader, type Gesture } from '../src/gesture.js'
import { Engine } from '../src/engine.js'
import { WebServer } from '../src/web.js'
import { FakeObs } from './fake-obs.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const mul = (db: number) => Math.pow(10, db / 20)

test('fader law round trips and puts unity at three quarters', () => {
	const law: LawSettings = { kind: 'desk', topDb: 10, bottomDb: -60 }
	assert.equal(positionToDb(0, law), null)
	assert.equal(positionToDb(0.75, law), 0)
	assert.equal(positionToDb(1, law), 10)
	for (const db of [-90, -60, -33.3, -12, -6, -1, 0, 3, 10]) {
		const back = positionToDb(dbToPosition(db, law), law)!
		assert.ok(Math.abs(back - db) < 0.01, `${db} -> ${back}`)
	}
	const lin: LawSettings = { kind: 'linear', topDb: 10, bottomDb: -60 }
	assert.ok(Math.abs(positionToDb(0.5, lin)! - -25) < 1e-9)
})

/** A rider wired to a pretend input, driven with synthetic meter readings */
function rig(over: Partial<InputSettings> = {}) {
	const set: InputSettings = { ...INPUT_DEFAULTS, riderOn: true, measureWindowMs: 500, rideRateDbPerS: 4, captureMode: 'instant', ...over }
	const rec: InputRecord = { overrides: {}, sections: {}, target: null, refGain: null }
	const st = { fader: 0 as number | null, trim: 0, raw: -20 as number | null, muted: false, t: 1000, offCalled: false }
	const r = new Rider({
		settings: () => set,
		record: () => rec,
		saveRecord: () => {},
		setGain: (db) => {
			if (set.controlMode === 'trim') st.trim = db
			else st.fader = db
		},
		riderOff: () => {
			st.offCalled = true
			set.riderOn = false
		},
		log: () => {},
		changed: () => {},
	})
	const step = (ms: number) => {
		for (let i = 0; i < ms / 50; i++) {
			st.t += 50
			const x = st.raw === null ? 0 : mul(st.raw + st.trim)
			const sample: MeterSample = {
				t: st.t,
				mag: [x * (st.muted ? 0 : st.fader === null ? 0 : mul(st.fader)), x * (st.muted ? 0 : st.fader === null ? 0 : mul(st.fader))],
				prePeak: [x * 2, x * 2],
				faderDb: st.fader,
				trimDb: st.trim,
				muted: st.muted,
			}
			r.onMeter(sample)
		}
	}
	return { r, set, rec, st, step }
}

test('rider captures a target and rides the fader back, within the limits', () => {
	const { r, set, rec, st, step } = rig()
	step(1000)
	r.captureTarget()
	assert.ok(Math.abs(rec.target! - -20) < 0.6, `target ${rec.target}`)
	assert.equal(rec.refGain, 0)
	st.raw = -28 // source drops 8 dB
	step(6000)
	assert.ok(Math.abs(st.fader! - 6) < 0.05, `fader stopped at max boost: ${st.fader}`)
	assert.equal(r.state, 'limit')
	set.maxBoostDb = 12
	step(6000)
	assert.ok(st.fader! > 7.4 && st.fader! < 8.6, `fader back near +8: ${st.fader}`)
	assert.equal(r.state, 'holding')
})

test('rider stays put inside the band', () => {
	const { r, rec, st, step } = rig({ bandDb: 3 })
	step(1000)
	r.captureTarget()
	st.raw = -22
	step(4000)
	assert.equal(st.fader, 0)
	assert.equal(r.state, 'holding')
	assert.ok(rec.target !== null)
})

test('ride back "just inside the band" stops sooner than "to the target"', () => {
	const a = rig({ rideBack: 'band', bandDb: 3 })
	a.step(1000)
	a.r.captureTarget()
	a.st.raw = -28
	a.step(8000)
	assert.ok(a.st.fader! > 4.4 && a.st.fader! < 5.6, `band mode fader ${a.st.fader}`)
})

test('rider freezes when quiet or muted, and drifts back if set to', () => {
	const { r, set, st, step } = rig()
	step(1000)
	r.captureTarget()
	st.raw = -28
	step(1000)
	const moved = st.fader!
	st.raw = null
	step(3000)
	assert.equal(r.state, 'frozen')
	assert.equal(st.fader, moved)
	st.raw = -28
	st.muted = true
	step(2000)
	assert.equal(r.state, 'frozen')
	assert.equal(st.fader, moved)
	st.muted = false
	set.quietMode = 'drift'
	set.quietDriftAfterMs = 1000
	set.driftRateDbPerS = 10
	st.raw = null
	step(3000)
	assert.ok(Math.abs(st.fader!) < 0.05, `drifted back to the set point: ${st.fader}`)
})

test('moving the fader by hand: new target, pause, or rider off', () => {
	const a = rig()
	a.step(1000)
	a.r.captureTarget()
	const t0 = a.rec.target!
	a.r.manualMove(0, -5)
	assert.ok(Math.abs(a.rec.target! - (t0 - 5)) < 1e-9)
	assert.equal(a.rec.refGain, -5)

	const b = rig({ grab: 'pause', grabPauseMs: 2000 })
	b.step(1000)
	b.r.captureTarget()
	b.st.raw = -30
	b.r.manualMove(0, 0)
	b.step(1500)
	assert.equal(b.st.fader, 0)
	b.step(3000)
	assert.ok(b.st.fader! > 0)

	const c = rig({ grab: 'off' })
	c.step(500)
	c.r.captureTarget()
	c.r.manualMove(0, 3)
	assert.ok(c.st.offCalled)
})

test('calibrate sets the fader for a level, and the target with it', () => {
	const { r, rec, st, step } = rig({ calibrateMove: 'jump', riderOn: false })
	st.raw = -26
	step(1000)
	r.calibrate(-18)
	assert.ok(Math.abs(st.fader! - 8) < 0.6, `fader ${st.fader}`)
	assert.equal(rec.target, -18)
})

test('trim mode measures before the fader, so the fader is left alone', () => {
	const { r, rec, st, step } = rig({ controlMode: 'trim' })
	st.fader = -10
	step(1000)
	r.captureTarget()
	assert.ok(Math.abs(rec.target! - -20) < 0.6, `target is pre-fader: ${rec.target}`)
	st.raw = -26
	step(5000)
	assert.equal(st.fader, -10)
	assert.ok(st.trim > 5.4 && st.trim < 6.6, `trim ${st.trim}`)
})

test('pickup: waits, catches after the dwell, releases on an outside move', async () => {
	let desk = 64
	let sent: number | undefined
	const p = new PickupManager(
		() => desk,
		() => {},
	)
	const s = { band: 3, dwellMs: 100, releaseBand: 6, releaseMs: 0 }
	assert.equal(p.handle('a', 20, s, (x) => (sent = x)), false)
	assert.equal(p.ledState('a', 20).led, 'below')
	assert.equal(p.handle('a', 63, s, (x) => (sent = x)), false)
	assert.equal(p.ledState('a', 63).led, 'catch')
	await sleep(150)
	assert.equal(sent, 63)
	desk = 63
	assert.equal(p.handle('a', 90, s, (x) => (sent = x)), true) // latched: follows anything
	desk = 90
	desk = 30 // someone moved OBS
	p.tick()
	assert.equal(p.ledState('a', 90).led, 'above')
	p.destroy()
})

test('gestures: press, double tap, hold', async () => {
	const got: Gesture[] = []
	const g = new GestureReader(
		() => ({ doubleTapMs: 120, holdMs: 200 }),
		(_k, x) => got.push(x),
	)
	g.down('a')
	g.up('a')
	await sleep(160)
	g.down('a')
	g.up('a')
	g.down('a')
	g.up('a')
	await sleep(160)
	g.down('a')
	await sleep(260)
	g.up('a')
	await sleep(160)
	assert.deepEqual(got, ['press', 'double', 'hold'])
	g.destroy()
})

test('store: unknown or bad values are dropped, import picks parts', () => {
	const s = loadStore(JSON.stringify({ defaults: { bandDb: 'x', rideRateDbPerS: 5 }, page: { layout: 'rows' }, inputs: { Mic: { overrides: { measure: 'peak', nonsense: 1 }, target: -20 } } }))
	assert.equal(s.defaults.bandDb, INPUT_DEFAULTS.bandDb)
	assert.equal(s.defaults.rideRateDbPerS, 5)
	assert.equal(s.page.layout, 'rows')
	assert.deepEqual(s.inputs.Mic.overrides, { measure: 'peak' })
	const t = newStore()
	applyImport(t, s, ['input:Mic'])
	assert.equal(t.inputs.Mic.target, -20)
	assert.equal(t.page.layout, 'strips')
})

test('end to end against a pretend OBS: inputs, rider, trim, web page, import', async () => {
	const obs = new FakeObs('secret')
	obs.addInput('Mic', -24)
	obs.addInput('Music', -12)
	obs.addInput('Camera', null, false)
	const logs: string[] = []
	let saved = ''
	const engine = new Engine(
		{
			log: (l, m) => logs.push(`${l}: ${m}`),
			save: (s) => (saved = s),
			structureChanged: () => {},
			stateChanged: () => {},
		},
		undefined,
		'',
	)
	engine.connect('127.0.0.1', obs.port, 'secret')
	for (let i = 0; i < 50 && engine.visible().length < 2; i++) await sleep(50)
	assert.deepEqual(
		engine.visible().map((i) => i.name),
		['Mic', 'Music'],
	)

	// rider on Mic, fader mode
	engine.setDefaultSetting('measureWindowMs', 500)
	engine.setDefaultSetting('rideRateDbPerS', 10)
	engine.setDefaultSetting('captureMode', 'instant')
	const mic = engine.resolve('Mic')!
	await sleep(800)
	engine.setInputSetting('Mic', 'riderOn', true)
	engine.captureTarget(mic)
	const target = engine.store.inputs.Mic.target!
	assert.ok(Math.abs(target - -24) < 1, `target ${target}`)
	obs.input('Mic').signalDb = -30
	await sleep(2500)
	const micDb = 20 * Math.log10(obs.input('Mic').volMul)
	assert.ok(micDb > 4.8 && micDb < 6.6, `OBS Mic fader ridden up ~6 dB: ${micDb}`)

	// trim mode on Music: the Gain filter is added and ridden; the fader isn't touched
	engine.setInputSetting('Music', 'controlMode', 'trim')
	engine.setInputSetting('Music', 'riderOn', true)
	await sleep(700)
	engine.captureTarget(engine.resolve('Music')!)
	obs.input('Music').signalDb = -18
	await sleep(2500)
	const trim = obs.input('Music').filters.find((f) => f.filterName === 'Auto gain trim')
	assert.ok(trim, 'trim filter created')
	assert.ok(Number(trim!.filterSettings.db) > 4.8 && Number(trim!.filterSettings.db) < 6.6, `trim ${trim!.filterSettings.db}`)
	assert.equal(obs.input('Music').volMul, 1)

	// web page with a PIN
	const web = new WebServer(engine, { port: 0, bind: '127.0.0.1', pin: '1234' }, () => {})
	web.start()
	await sleep(100)
	const base = `http://127.0.0.1:${web.port}`
	const page = await (await fetch(base + '/')).text()
	assert.ok(page.includes('OBS AUDIO'))
	assert.equal((await fetch(base + '/events')).status, 401)
	const post = (c: object) => fetch(base + '/cmd?pin=1234', { method: 'POST', body: JSON.stringify(c) }).then((r) => r.json() as Promise<{ ok: boolean; message?: string }>)
	assert.equal((await post({ cmd: 'mute', input: 'Music', value: true })).ok, true)
	await sleep(100)
	assert.equal(obs.input('Music').muted, true)
	assert.equal((await post({ cmd: 'filterAdd', input: 'Mic', kind: 'compressor_filter' })).ok, true)
	assert.equal((await post({ cmd: 'filterAdd', input: 'Mic', kind: 'noise_suppress_filter' })).ok, true)
	await sleep(100)
	assert.deepEqual(
		obs.input('Mic').filters.map((f) => [f.filterName, f.filterKind]),
		[
			['Compressor', 'compressor_filter'],
			['Noise Suppression', 'noise_suppress_filter_v2'],
		],
	)
	assert.equal((await post({ cmd: 'filterSet', input: 'Mic', filter: 'Compressor', key: 'ratio', value: 4 })).ok, true)
	await sleep(100)
	assert.equal(obs.input('Mic').filters[0].filterSettings.ratio, 4)
	assert.equal((await post({ cmd: 'track', input: 'Mic', track: '3', value: true })).ok, true)
	await sleep(100)
	assert.equal(obs.input('Mic').tracks['3'], true)

	// the live feed starts with the state
	const ac = new AbortController()
	const res = await fetch(base + '/events?pin=1234', { signal: ac.signal })
	const reader = res.body!.getReader()
	let text = ''
	while (!text.includes('event: state')) text += new TextDecoder().decode((await reader.read()).value)
	ac.abort()
	assert.ok(text.includes('"name":"Mic"'))

	// export, change, import just the defaults back, roll back
	const exported = await (await fetch(base + '/export?pin=1234')).text()
	engine.setDefaultSetting('bandDb', 9)
	const r = await post({ cmd: 'import', data: exported, parts: ['defaults'] })
	assert.equal(r.ok, true)
	assert.equal(engine.store.defaults.bandDb, INPUT_DEFAULTS.bandDb)
	assert.equal((await post({ cmd: 'restoreAutosave' })).ok, true)
	assert.equal(engine.store.defaults.bandDb, 9)

	// rename in OBS keeps the settings
	obs.input('Mic').name = 'Presenter'
	obs.event('InputNameChanged', { oldInputName: 'Mic', inputName: 'Presenter' })
	await sleep(100)
	assert.ok(engine.store.inputs.Presenter?.target !== undefined)
	assert.equal(engine.resolve('1')!.name, 'Presenter')

	engine.flushSave(true)
	assert.ok(saved.includes('Presenter'))
	web.stop()
	engine.destroy()
	obs.close()
	assert.ok(!logs.some((l) => l.startsWith('error')), logs.join('\n'))
})
