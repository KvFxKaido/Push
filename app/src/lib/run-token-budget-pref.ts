/**
 * Client accessor for the user's per-run token budget preference.
 *
 * The budget's parsing/precedence vocabulary is owned once by the shared
 * `lib/run-cost-budget.ts` (so web and CLI agree). This module is the thin web
 * adapter: it reads the raw setting from the unified settings store and runs it
 * through the shared resolver, returning a positive token cap or `null` (off).
 *
 * Read at the client `resolveHarnessSettings` call sites (`chat-send-inline`,
 * `coder-delegation-handler`) so the user's choice is folded into the harness
 * settings the kernel consumes as `harnessTokenBudget` — covering the inline
 * lead, the delegated sub-Coder, and (via the dispatched envelope) the
 * background job.
 */

import { resolveRunTokenBudget } from '@push/lib/run-cost-budget';
import { getSetting, SETTINGS_KEYS } from './settings-store';

/** Preset caps surfaced in the settings UI. `null` is the off/uncapped state. */
export const RUN_TOKEN_BUDGET_PRESETS: ReadonlyArray<{ label: string; value: number | null }> = [
  { label: 'Off', value: null },
  { label: '100K', value: 100_000 },
  { label: '250K', value: 250_000 },
  { label: '500K', value: 500_000 },
];

/**
 * Resolve the user's configured per-run token budget to a positive cap or
 * `null` (uncapped). Parses through the shared resolver so a malformed stored
 * value degrades to off rather than throwing.
 */
export function getRunTokenBudgetPref(): number | null {
  return resolveRunTokenBudget({ explicit: getSetting(SETTINGS_KEYS.runTokenBudget) });
}
