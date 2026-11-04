// Embeds the core's page (core/web/page.html -> core/src/page.ts) and writes the module version to src/version.ts.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
if (!existsSync(new URL('../core/scripts/embed-page.mjs', import.meta.url))) {
	console.error('The core is missing. Run: git submodule update --init --recursive')
	process.exit(1)
}
await import('../core/scripts/embed-page.mjs')
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
writeFileSync(
	new URL('../src/version.ts', import.meta.url),
	`// Generated from package.json by scripts/embed-page.mjs.\nexport const MODULE_VERSION = ${JSON.stringify(version)}\n`,
)
