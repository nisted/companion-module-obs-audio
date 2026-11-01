// Turns web/page.html into src/page.ts so the page ships inside the module.
import { readFileSync, writeFileSync } from 'node:fs'
const html = readFileSync(new URL('../web/page.html', import.meta.url), 'utf8')
writeFileSync(
	new URL('../src/page.ts', import.meta.url),
	`// Generated from web/page.html by scripts/embed-page.mjs. Edit the HTML, not this.\nexport const PAGE_HTML = ${JSON.stringify(html)}\n`,
)
