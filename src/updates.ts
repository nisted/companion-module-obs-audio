/**
 * Checks GitHub for the latest OBS Audio module and the latest OBS Studio,
 * so the page and Companion can say when an update is out.
 */

export const MODULE_REPO = 'nisted/companion-module-obs-audio'
export const OBS_REPO = 'obsproject/obs-studio'
export const MODULE_DOWNLOAD = `https://github.com/${MODULE_REPO}/releases/latest`
export const OBS_DOWNLOAD = 'https://obsproject.com/download'

export interface VersionInfo {
	moduleVersion: string
	moduleLatest: string | null
	moduleUpdate: boolean
	obsVersion: string | null
	obsLatest: string | null
	obsUpdate: boolean
	checkedAt: string | null
	error: string | null
	moduleDownload: string
	obsDownload: string
}

/** Compare '1.2.3' style versions (a leading 'v' and anything after '-' or '+' ignored). -1, 0 or 1. */
export function compareVersions(a: string, b: string): number {
	const parts = (v: string) =>
		v
			.trim()
			.replace(/^v/i, '')
			.split(/[-+]/)[0]
			.split('.')
			.map((n) => parseInt(n, 10) || 0)
	const x = parts(a)
	const y = parts(b)
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		const d = (x[i] ?? 0) - (y[i] ?? 0)
		if (d) return d > 0 ? 1 : -1
	}
	return 0
}

/** The latest full release's tag on a GitHub repo, or null if it has none */
export async function latestRelease(repo: string, timeoutMs = 10000): Promise<string | null> {
	const ac = new AbortController()
	const timer = setTimeout(() => ac.abort(), timeoutMs)
	try {
		const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
			headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'companion-module-obs-audio' },
			signal: ac.signal,
		})
		if (r.status === 404) return null
		if (!r.ok) throw new Error(`GitHub said ${r.status}`)
		const j = (await r.json()) as { tag_name?: string }
		return j.tag_name ? j.tag_name.replace(/^v/i, '') : null
	} finally {
		clearTimeout(timer)
	}
}

export function newVersionInfo(moduleVersion: string): VersionInfo {
	return {
		moduleVersion,
		moduleLatest: null,
		moduleUpdate: false,
		obsVersion: null,
		obsLatest: null,
		obsUpdate: false,
		checkedAt: null,
		error: null,
		moduleDownload: MODULE_DOWNLOAD,
		obsDownload: OBS_DOWNLOAD,
	}
}

export function recompute(v: VersionInfo): void {
	v.moduleUpdate = !!v.moduleLatest && compareVersions(v.moduleLatest, v.moduleVersion) > 0
	v.obsUpdate = !!v.obsLatest && !!v.obsVersion && compareVersions(v.obsLatest, v.obsVersion) > 0
}
