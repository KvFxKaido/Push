/**
 * Delegation-mode vocabulary — the single source of truth for the
 * `inline` / `delegated` turn-shape preference across surfaces.
 *
 * `inline` is the single conversational lead (Agent Runtime Decisions §10):
 * the user's turn runs one agent directly, with no Planner pre-pass and no
 * Orchestrator handoff. `delegated` opts back into the historical org-chart
 * wrapper. Inline has been the web default since 2026-06-11 (the step-1
 * delegation-collapse A/B measured twice with quality tied and the wrapper
 * costing ~78% wall-clock); the CLI terminal chat adopted the same default
 * as the first §10 convergence step.
 *
 * Surfaces differ only in where the raw preference comes from — web reads
 * localStorage (`app/src/lib/delegation-mode-settings.ts`), the CLI reads
 * `RunOptions.delegationMode` falling back to the `PUSH_DELEGATION_MODE`
 * env var — but both resolve through `resolveDelegationMode` so the opt-in
 * rule cannot drift between them.
 */

export type DelegationMode = 'delegated' | 'inline';

/**
 * Resolve a raw preference string to a mode. Only the exact string
 * `'delegated'` opts back into the wrapper arc; unknown, legacy, or missing
 * values fall to the `inline` default — mirroring the pre-flip rule where
 * only an exact `'inline'` opted in.
 */
export function resolveDelegationMode(raw: string | null | undefined): DelegationMode {
  return raw === 'delegated' ? 'delegated' : 'inline';
}
