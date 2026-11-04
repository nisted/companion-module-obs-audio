// Runs the core's tests and this module's: bundles each with esbuild (so the TypeScript sources run as they are), then node --test.
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

await import('./embed-page.mjs')
const dir = mkdtempSync(join(tmpdir(), 'obs-audio-test-'))
const files = []
for (const [name, entry] of [
	['core.test.mjs', '../core/test/all.test.ts'],
	['core-joining.test.mjs', '../core/test/joining.test.ts'],
	['core-recordings.test.mjs', '../core/test/recordings/recordings.test.ts'],
	['obs-audio.test.mjs', '../test/all.test.ts'],
]) {
	const outfile = join(dir, name)
	await build({
		entryPoints: [new URL(entry, import.meta.url).pathname],
		bundle: true,
		platform: 'node',
		format: 'esm',
		outfile,
		banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
		logLevel: 'warning',
	})
	files.push(outfile)
}
// the recordings tests use UK dates and times
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', env: { ...process.env, TZ: process.env.TZ ?? 'Europe/London' } })
process.exit(r.status ?? 1)
