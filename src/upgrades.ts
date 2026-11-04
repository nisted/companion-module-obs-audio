/**
 * Upgrade scripts for buttons and triggers made with older versions.
 * Companion runs each script once per connection, in order.
 *
 * 0.2.0: "Rider" became "Auto Level". Action, feedback and setting ids follow:
 *   actions   ag_rider -> ag_auto_level, rider_all -> auto_level_all
 *   feedbacks rider_status -> auto_level_status, rider_on -> auto_level_on
 *   'Auto gain: change a setting' key riderOn -> autoLevelOn
 *   variables in option text: in<N>_rider -> in<N>_auto_level,
 *             in<N>_rider_on -> in<N>_auto_level_on (the old variables still work for now)
 * The settings store inside the config is migrated when it loads (core/src/settings.ts).
 */

import type {
	CompanionMigrationAction,
	CompanionMigrationFeedback,
	CompanionMigrationOptionValues,
	CompanionStaticUpgradeProps,
	CompanionStaticUpgradeResult,
	CompanionStaticUpgradeScript,
	CompanionUpgradeContext,
	JsonObject,
} from '@companion-module/base'

export const ACTION_RENAMES: Record<string, string> = { ag_rider: 'ag_auto_level', rider_all: 'auto_level_all' }
export const FEEDBACK_RENAMES: Record<string, string> = { rider_status: 'auto_level_status', rider_on: 'auto_level_on' }
export const SETTING_RENAMES: Record<string, string> = { riderOn: 'autoLevelOn' }

/** Old variable names in text: in3_rider_on, in3_rider */
const VAR_RE = /\b(in\d+)_rider(_on)?\b/g
export const renameVariables = (text: string): string => text.replace(VAR_RE, (_m, p: string, on?: string) => `${p}_auto_level${on ?? ''}`)

/** Rewrite one option value, whether it's stored plain or as {value, isExpression} */
function mapOption(v: unknown, fn: (x: unknown) => unknown): unknown {
	if (v && typeof v === 'object' && !Array.isArray(v) && 'isExpression' in v && 'value' in v) {
		const w = v as { value: unknown; isExpression: boolean }
		const nv = fn(w.value)
		return nv === w.value ? v : { ...w, value: nv }
	}
	return fn(v)
}

/** Rewrite variable names in every text option. True if anything changed. */
function fixOptions(options: CompanionMigrationOptionValues, extra?: (key: string, v: unknown) => unknown): boolean {
	let changed = false
	for (const [k, v] of Object.entries(options)) {
		const nv = mapOption(v, (x) => {
			let y = extra ? extra(k, x) : x
			if (typeof y === 'string') y = renameVariables(y)
			return y
		})
		if (nv !== v) {
			options[k] = nv as CompanionMigrationOptionValues[string]
			changed = true
		}
	}
	return changed
}

export function upgradeRiderToAutoLevel<TConfig extends JsonObject>(
	_context: CompanionUpgradeContext<TConfig>,
	props: CompanionStaticUpgradeProps<TConfig, undefined>,
): CompanionStaticUpgradeResult<TConfig, undefined> {
	const updatedActions: CompanionMigrationAction[] = []
	const updatedFeedbacks: CompanionMigrationFeedback[] = []
	for (const a of props.actions) {
		let changed = false
		const to = ACTION_RENAMES[a.actionId]
		if (to) {
			a.actionId = to
			changed = true
		}
		const settingKey = a.actionId === 'ag_setting' ? (k: string, x: unknown) => (k === 'key' && typeof x === 'string' ? (SETTING_RENAMES[x] ?? x) : x) : undefined
		if (fixOptions(a.options, settingKey)) changed = true
		if (changed) updatedActions.push(a)
	}
	for (const f of props.feedbacks) {
		let changed = false
		const to = FEEDBACK_RENAMES[f.feedbackId]
		if (to) {
			f.feedbackId = to
			changed = true
		}
		if (fixOptions(f.options)) changed = true
		if (changed) updatedFeedbacks.push(f)
	}
	return { updatedConfig: null, updatedActions, updatedFeedbacks }
}

export function upgradeScripts<TConfig extends JsonObject>(): CompanionStaticUpgradeScript<TConfig>[] {
	return [upgradeRiderToAutoLevel]
}
