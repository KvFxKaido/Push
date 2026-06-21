/**
 * Per-run token budget — the single source of truth for the cross-surface
 * "stop the run once it has spent more than N tokens" circuit breaker.
 *
 * Round caps (`max_rounds`) bound a run by *how many times* the model is
 * called; this bounds it by *how much it consumes*. A run that streams huge
 * contexts or pathologically long responses can burn a budget well before it
 * hits the round cap — this gate catches that axis. Modelled on cua's
 * `max_trajectory_budget` callback (halt the trajectory when spend exceeds a
 * ceiling), but denominated in **tokens**, not USD: tokens are the signal both
 * surfaces already capture exactly from `StreamUsage`, whereas dollars need a
 * per-model price table that drifts (see the billing-accuracy disclaimer in
 * `prompt-cost-telemetry.ts`). A USD layer can sit on top later by converting a
 * price into a token ceiling before calling `resolveRunTokenBudget`.
 *
 * The vocabulary (env var, default, parser, precedence, ledger semantics) lives
 * here in `lib/` so both the CLI/daemon and the web/worker resolve and account
 * the budget identically — no per-surface drift. The shared kernel
 * (`lib/coder-agent.ts`) owns the loop integration; both surfaces inherit it.
 * See `cli/tests/run-cost-budget.test.mjs` for the pinned contract.
 *
 * Resolution precedence (highest wins), mirroring `lib/auditor-policy.ts`:
 *   1. env var (operator override — `PUSH_RUN_TOKEN_BUDGET`)
 *   2. explicit per-surface setting (CLI `config.runTokenBudget`, web setting)
 *   3. default (`RUN_TOKEN_BUDGET_DEFAULT` — off)
 *
 * **Fail-closed.** When the budget is *enabled* but a round's provider usage is
 * absent (some adapters never report it), the caller feeds an estimate so the
 * ledger always advances — an unmetered round can't silently run past the cap.
 * The ledger prefers reported usage and falls back to the estimate per round.
 */

import type { StreamUsage } from './provider-contract.js';

/** Env var that sets the per-run token budget across surfaces. */
export const RUN_TOKEN_BUDGET_ENV_VAR = 'PUSH_RUN_TOKEN_BUDGET';

/**
 * Default state when nothing opts in: `null` (off / unlimited). Unlike the
 * Auditor gate, this is not a documented hard invariant — it's an opt-in spend
 * guard — so absence means "no cap", not "the default cap".
 */
export const RUN_TOKEN_BUDGET_DEFAULT: number | null = null;

/**
 * Fraction of the limit at which a run crosses from `ok` into `warn`. The warn
 * verdict is advisory (a structured log + status, run continues); `exceeded`
 * (>= the full limit) is the halt.
 */
export const RUN_TOKEN_BUDGET_WARN_RATIO = 0.9;

/**
 * Parse a loosely-typed budget value into a positive token cap, `null`
 * (explicitly unlimited), or `undefined` (no opinion — fall through to the next
 * precedence tier). Mirrors `parseBooleanSetting`'s three-state contract so an
 * empty/garbage value falls through rather than silently meaning "off".
 *
 *  - finite number > 0          → that cap
 *  - 0 / negative / non-finite  → `null` (an explicit "no cap")
 *  - numeric string (`"50000"`) → parsed the same way
 *  - `undefined` / empty / NaN-ish string → `undefined`
 */
export function parseTokenBudgetSetting(value: unknown): number | null | undefined {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    return value > 0 ? Math.floor(value) : null;
  }
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (['off', 'none', 'unlimited', 'false', '0'].includes(normalized)) return null;
  // Allow thousands separators / underscores a human might type (`50_000`).
  const parsed = Number(normalized.replace(/[_,]/g, ''));
  if (!Number.isFinite(parsed)) return undefined;
  return parsed > 0 ? Math.floor(parsed) : null;
}

/**
 * Resolve the effective per-run token budget. Pure — callers pass the raw env
 * value and the raw per-surface setting; precedence + default live here so
 * every surface agrees. Returns a positive cap, or `null` when uncapped.
 */
export function resolveRunTokenBudget(
  opts: { explicit?: unknown; env?: unknown } = {},
): number | null {
  const fromEnv = parseTokenBudgetSetting(opts.env);
  if (fromEnv !== undefined) return fromEnv;
  const fromExplicit = parseTokenBudgetSetting(opts.explicit);
  if (fromExplicit !== undefined) return fromExplicit;
  return RUN_TOKEN_BUDGET_DEFAULT;
}

export type RunBudgetState = 'ok' | 'warn' | 'exceeded';

export interface RunBudgetVerdict {
  state: RunBudgetState;
  usedTokens: number;
  /** The active cap, or `null` when uncapped (verdict is always `ok`). */
  limitTokens: number | null;
  /** `limit - used`, floored at 0; `null` when uncapped. */
  remainingTokens: number | null;
}

export interface RunTokenLedgerSnapshot {
  usedTokens: number;
  /** Rounds counted from real provider usage. */
  reportedRounds: number;
  /** Rounds counted from the fail-closed estimate fallback. */
  estimatedRounds: number;
}

export interface RunTokenLedger {
  /**
   * Account one round. Prefers `usage.totalTokens` when present and positive;
   * otherwise falls back to `estimatedTokens` (the fail-closed path). Returns
   * the source actually used so the caller can log it.
   */
  record(input: {
    usage?: StreamUsage;
    estimatedTokens?: number;
  }): 'reported' | 'estimated' | 'none';
  snapshot(): RunTokenLedgerSnapshot;
  /** Evaluate the running total against `limit` (`null` ⇒ always `ok`). */
  check(limit: number | null): RunBudgetVerdict;
}

function positiveTotal(usage: StreamUsage | undefined): number {
  if (!usage) return 0;
  const total = usage.totalTokens;
  if (typeof total === 'number' && Number.isFinite(total) && total > 0) return total;
  // Some adapters report only the input/output split without a summed total.
  const input = Number.isFinite(usage.inputTokens) ? usage.inputTokens : 0;
  const output = Number.isFinite(usage.outputTokens) ? usage.outputTokens : 0;
  const summed = input + output;
  return summed > 0 ? summed : 0;
}

/**
 * Create a fresh run-scoped token ledger. State is per-run (one per kernel
 * loop), so it lives as a closure rather than module state — concurrent runs
 * (delegation fan-out) each get their own.
 */
export function createRunTokenLedger(): RunTokenLedger {
  let usedTokens = 0;
  let reportedRounds = 0;
  let estimatedRounds = 0;

  return {
    record({ usage, estimatedTokens }) {
      const reported = positiveTotal(usage);
      if (reported > 0) {
        usedTokens += reported;
        reportedRounds += 1;
        return 'reported';
      }
      const estimate =
        typeof estimatedTokens === 'number' &&
        Number.isFinite(estimatedTokens) &&
        estimatedTokens > 0
          ? Math.floor(estimatedTokens)
          : 0;
      if (estimate > 0) {
        usedTokens += estimate;
        estimatedRounds += 1;
        return 'estimated';
      }
      return 'none';
    },
    snapshot() {
      return { usedTokens, reportedRounds, estimatedRounds };
    },
    check(limit) {
      if (limit === null || !Number.isFinite(limit) || limit <= 0) {
        return { state: 'ok', usedTokens, limitTokens: null, remainingTokens: null };
      }
      const remainingTokens = Math.max(0, limit - usedTokens);
      let state: RunBudgetState = 'ok';
      if (usedTokens >= limit) state = 'exceeded';
      else if (usedTokens >= limit * RUN_TOKEN_BUDGET_WARN_RATIO) state = 'warn';
      return { state, usedTokens, limitTokens: limit, remainingTokens };
    },
  };
}
