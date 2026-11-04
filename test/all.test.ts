import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CompanionMigrationAction, CompanionMigrationFeedback } from '@companion-module/base'
import { Engine, type EngineHost } from '../core/src/engine.js'
import { WebServer } from '../core/src/web.js'
import { INPUT_DEFAULTS } from '../core/src/settings.js'
import { FakeObs } from './fake-obs.js'
import { explainClose } from '../src/obs.js'
import { OBS_INFO, ObsDevice, obsEngineOptions } from '../src/obs-device.js'
import { upgradeRiderToAutoLevel, renameVariables } from '../src/upgrades.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The engine as OBS Audio's main.ts makes it */
const obsEngine = (host: EngineHost, store: unknown) => new Engine(host, OBS_INFO, obsEngineOptions(), store, '')

test('end to end against a pretend OBS: inputs, auto level, trim, web page, import', async () => {
	const obs = new FakeObs('secret')
	obs.addInput('Mic', -24)
	obs.addInput('Music', -12)
	obs.addInput('Camera', null, false)
	const logs: string[] = []
	let saved = ''
	const engine = obsEngine(
		{
			log: (l, m) => logs.push(`${l}: ${m}`),
			save: (s) => (saved = s),
			structureChanged: () => {},
			stateChanged: () => {},
		},
		undefined,
	)
	engine.useDevice(new ObsDevice({ host: '127.0.0.1', port: obs.port, password: 'secret' }))
	for (let i = 0; i < 50 && engine.visible().length < 2; i++) await sleep(50)
	assert.deepEqual(
		engine.visible().map((i) => i.name),
		['Mic', 'Music'],
	)
	assert.equal(engine.versions.deviceVersion, '31.0.2')

	// auto level on Mic, fader mode
	engine.setDefaultSetting('measureWindowMs', 500)
	engine.setDefaultSetting('rideRateDbPerS', 10)
	engine.setDefaultSetting('captureMode', 'instant')
	const mic = engine.resolve('Mic')!
	await sleep(800)
	engine.setInputSetting('Mic', 'autoLevelOn', true)
	engine.captureTarget(mic)
	const target = engine.store.inputs.Mic.target!
	assert.ok(Math.abs(target - -24) < 1, `target ${target}`)
	obs.input('Mic').signalDb = -30
	await sleep(2500)
	const micDb = 20 * Math.log10(obs.input('Mic').volMul)
	assert.ok(micDb > 4.8 && micDb < 6.6, `OBS Mic fader ridden up ~6 dB: ${micDb}`)

	// trim mode on Music: the Gain filter is added and ridden; the fader isn't touched
	engine.setInputSetting('Music', 'controlMode', 'trim')
	engine.setInputSetting('Music', 'autoLevelOn', true)
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
	assert.ok(page.includes('<title>OBS Audio</title>'))
	assert.equal((await fetch(base + '/events')).status, 401)
	const post = (c: object) => fetch(base + '/cmd?pin=1234', { method: 'POST', body: JSON.stringify(c) }).then((r) => r.json() as Promise<{ ok: boolean; message?: string }>)
	assert.equal((await post({ cmd: 'mute', input: 'Music', value: true })).ok, true)
	await sleep(100)
	assert.equal(obs.input('Music').muted, true)
	assert.equal((await post({ cmd: 'blockAdd', input: 'Mic', kind: 'compressor_filter' })).ok, true)
	assert.equal((await post({ cmd: 'blockAdd', input: 'Mic', kind: 'noise_suppress_filter' })).ok, true)
	await sleep(100)
	assert.deepEqual(
		obs.input('Mic').filters.map((f) => [f.filterName, f.filterKind]),
		[
			['Compressor', 'compressor_filter'],
			['Noise Suppression', 'noise_suppress_filter_v2'],
		],
	)
	assert.equal((await post({ cmd: 'blockSet', input: 'Mic', block: 'Compressor', key: 'ratio', value: 4 })).ok, true)
	await sleep(100)
	assert.equal(obs.input('Mic').filters[0].filterSettings.ratio, 4)
	assert.equal((await post({ cmd: 'routing', input: 'Mic', target: '3', value: true })).ok, true)
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

test('connection errors are explained in plain words', () => {
	assert.match(explainClose(4009, '', 'h', 4455, false), /password is wrong/)
	assert.match(explainClose(1006, '', '10.0.0.5', 4455, false), /Enable WebSocket server/)
	assert.match(explainClose(1006, '', '10.0.0.5', 4455, true), /Lost the connection/)
})

test('PFL, solo, backup switch and recording against a pretend OBS', async () => {
	const obs = new FakeObs()
	obs.addInput('Mic', -24)
	obs.addInput('Mic Backup', -24)
	obs.addInput('Music', -12)
	const logs: string[] = []
	const engine = obsEngine({ log: (l, m) => logs.push(`${l}: ${m}`), save: () => {}, structureChanged: () => {}, stateChanged: () => {} }, undefined)
	engine.useDevice(new ObsDevice({ host: '127.0.0.1', port: obs.port, password: '' }))
	for (let i = 0; i < 50 && engine.visible().length < 3; i++) await sleep(50)
	const mic = engine.resolve('Mic')!
	const music = engine.resolve('Music')!
	const backup = engine.resolve('Mic Backup')!
	const mon = (n: string) => obs.input(n).monitor

	// PFL additive, then exclusive
	await engine.monitoring.setPfl(mic, true)
	await engine.monitoring.setPfl(music, true)
	await sleep(100)
	assert.equal(mon('Mic'), 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT')
	assert.equal(mon('Music'), 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT')
	engine.setPage('pflMode', 'exclusive')
	await engine.monitoring.setPfl(mic, true)
	await sleep(100)
	assert.equal(mon('Music'), 'OBS_MONITORING_TYPE_NONE')
	engine.setPage('pflMode', 'additive')
	await engine.monitoring.setPfl(music, true)
	await sleep(100)

	// solo: only Music on monitoring; on release both PFLs come back
	await engine.monitoring.setSolo(music, true)
	await sleep(100)
	assert.equal(mon('Mic'), 'OBS_MONITORING_TYPE_NONE')
	assert.equal(mon('Music'), 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT')
	assert.equal(engine.monitoring.pflShown(mic), true)
	await engine.monitoring.setSolo(music, false)
	await sleep(100)
	assert.equal(mon('Mic'), 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT')
	assert.equal(mon('Music'), 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT')
	assert.equal(obs.input('Mic').muted, false)

	// backup: main drops out, auto crossfade, never back by itself, then Take
	engine.setInputSetting('Mic Backup', 'backupOf', 'Mic')
	engine.setInputSetting('Mic Backup', 'backupAuto', true)
	engine.setInputSetting('Mic Backup', 'backupDetectMs', 300)
	engine.setInputSetting('Mic Backup', 'backupRecoverMs', 400)
	engine.setInputSetting('Mic Backup', 'backupFadeMs', 100)
	await sleep(600)
	assert.equal(engine.backups.onBackup('Mic Backup'), false)
	obs.input('Mic').signalDb = null
	await sleep(1200)
	assert.equal(engine.backups.onBackup('Mic Backup'), true)
	assert.ok(obs.input('Mic').volMul < 0.01, `main faded out: ${obs.input('Mic').volMul}`)
	assert.ok(Math.abs(obs.input('Mic Backup').volMul - 1) < 0.01, 'backup up at the main level')
	assert.ok(engine.notices.list.some((n) => n.kind === 'backup-switched'))
	obs.input('Mic').signalDb = -24
	await sleep(1500)
	assert.equal(engine.backups.onBackup('Mic Backup'), true, 'stays on backup')
	const back = engine.notices.list.find((n) => n.kind === 'backup-back')
	assert.ok(back, 'asks about the main coming back')
	await engine.noticeAction(back!.id, 'take')
	await sleep(400)
	assert.equal(engine.backups.onBackup('Mic Backup'), false)
	assert.ok(Math.abs(obs.input('Mic').volMul - 1) < 0.01, 'main back up')
	void backup

	// recording: start, stop, plan, reminder, snooze, file name
	await engine.recorder.start()
	await sleep(100)
	assert.equal(engine.recorder.state.active, true)
	await engine.recorder.stop()
	await sleep(100)
	assert.equal(engine.recorder.state.active, false)
	assert.ok(engine.recorder.state.lastFile.endsWith('.mkv'))
	engine.recorder.setPlan(new Date(Date.now() + 5 * 60000).toISOString(), false)
	await sleep(1300)
	const due = engine.notices.list.find((n) => n.kind === 'record-due')
	assert.ok(due, 'reminder shows inside the lead time')
	assert.ok(engine.recorder.countdown()! > 250)
	await engine.noticeAction(due!.id, 'snooze')
	assert.ok(!engine.notices.list.some((n) => n.kind === 'record-due'))
	await engine.recorder.setFileName('Conf %CCYY-%MM-%DD')
	assert.equal(obs.rec.format, 'Conf %CCYY-%MM-%DD')
	engine.recorder.setPlan(new Date(Date.now() - 1000).toISOString(), true)
	await sleep(1300)
	assert.equal(obs.rec.active, true, 'auto start fired')
	assert.equal(engine.store.record.nextStart, null, 'a start clears the plan')

	engine.destroy()
	obs.close()
	assert.ok(!logs.some((l) => l.startsWith('error')), logs.join('\n'))
})

test('upgrade script: rider actions, feedbacks, settings and variables become auto level', () => {
	const ev = (value: unknown, isExpression = false) => ({ value, isExpression }) as never
	const actions: CompanionMigrationAction[] = [
		{ id: 'a1', controlId: 'c1', actionId: 'ag_rider', options: { input: ev('1'), mode: ev('toggle') } },
		{ id: 'a2', controlId: 'c1', actionId: 'rider_all', options: { mode: ev('on') } },
		{ id: 'a3', controlId: 'c2', actionId: 'ag_setting', options: { scope: ev('input'), input: ev('Mic'), key: ev('riderOn'), value: ev('$(OBS_Audio:in2_rider_on)') } },
		{ id: 'a4', controlId: 'c2', actionId: 'ag_setting', options: { scope: ev('input'), input: ev('Mic'), key: ev('bandDb'), value: ev('3') } },
		{ id: 'a5', controlId: 'c3', actionId: 'mute', options: { input: ev('1'), mode: ev('toggle') } },
		{ id: 'a6', controlId: 'c3', actionId: 'volume', options: { input: ev("$(OBS_Audio:in1_rider) == 'riding' ? 1 : 2", true), mode: ev('set') } },
		// options stored without the {value} wrapper (older Companion), just in case
		{ id: 'a7', controlId: 'c4', actionId: 'ag_setting', options: { key: 'riderOn' as never, value: 'on' as never } },
	]
	const feedbacks: CompanionMigrationFeedback[] = [
		{ id: 'f1', controlId: 'c1', feedbackId: 'rider_status', options: { input: ev('1'), c_riding: ev('#0077aa') } },
		{ id: 'f2', controlId: 'c1', feedbackId: 'rider_on', options: { input: ev('2') } },
		{ id: 'f3', controlId: 'c1', feedbackId: 'muted', options: { input: ev('2') } },
	]
	const r = upgradeRiderToAutoLevel({ currentConfig: {} as never }, { config: null, secrets: null, actions, feedbacks })
	assert.equal(r.updatedConfig, null)
	const byId = Object.fromEntries(r.updatedActions.map((a) => [a.id, a]))
	assert.deepEqual(Object.keys(byId).sort(), ['a1', 'a2', 'a3', 'a6', 'a7'])
	assert.equal(byId.a1.actionId, 'ag_auto_level')
	assert.deepEqual(byId.a1.options.mode, { value: 'toggle', isExpression: false })
	assert.equal(byId.a2.actionId, 'auto_level_all')
	assert.equal(byId.a3.actionId, 'ag_setting')
	assert.deepEqual(byId.a3.options.key, { value: 'autoLevelOn', isExpression: false })
	assert.deepEqual(byId.a3.options.value, { value: '$(OBS_Audio:in2_auto_level_on)', isExpression: false })
	assert.deepEqual(byId.a6.options.input, { value: "$(OBS_Audio:in1_auto_level) == 'riding' ? 1 : 2", isExpression: true })
	assert.equal(byId.a7.options.key, 'autoLevelOn')
	assert.deepEqual(r.updatedFeedbacks.map((f) => [f.id, f.feedbackId]), [
		['f1', 'auto_level_status'],
		['f2', 'auto_level_on'],
	])
	assert.deepEqual(r.updatedFeedbacks[0].options.c_riding, { value: '#0077aa', isExpression: false })
	// running it again changes nothing
	const again = upgradeRiderToAutoLevel({ currentConfig: {} as never }, { config: null, secrets: null, actions, feedbacks })
	assert.equal(again.updatedActions.length + again.updatedFeedbacks.length, 0)
	assert.equal(renameVariables('$(x:in12_rider) $(x:in3_rider_on) rider in1_riderx'), '$(x:in12_auto_level) $(x:in3_auto_level_on) rider in1_riderx')
})

test('a 0.1.x settings store (rider) loads into the 0.2 engine, OBS fields kept', () => {
	const old = JSON.stringify({
		version: 1,
		defaults: { ...INPUT_DEFAULTS, riderOn: false, trimFilterName: 'My trim' },
		sections: [{ id: 'input', name: 'Input', controls: ['trim', 'sync', 'compressor_filter'], mode: 'open' }, { id: 'tracks', name: 'Tracks', controls: ['tracks'], mode: 'collapsible' }],
		inputs: { Mic: { overrides: { riderOn: true, controlMode: 'trim' }, sections: {}, target: -20, refGain: 2 } },
	})
	const engine = obsEngine({ log: () => {}, save: () => {}, structureChanged: () => {}, stateChanged: () => {} }, old)
	assert.equal(engine.settings('Mic').autoLevelOn, true)
	assert.equal(engine.settings('Mic').controlMode, 'trim')
	assert.equal(engine.settings('Mic').trimFilterName, 'My trim')
	assert.equal(engine.settings('Other').autoLevelOn, false)
	assert.equal(engine.store.inputs.Mic.target, -20)
	assert.deepEqual(engine.store.sections[0].controls, ['trim', 'delay', 'compressor_filter'])
	assert.deepEqual(engine.store.sections[1].controls, ['routing'])
	assert.equal(engine.store.version, 2)
	assert.ok(!JSON.stringify(engine.store).includes('riderOn'))
	engine.destroy()
})
