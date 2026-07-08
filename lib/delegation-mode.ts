/**
 * Delegation-mode vocabulary — the single source of truth for the
 * `inline` / `delegated` turn-shape preference across surfaces.
 *
 * `inline` is the single conversational lead (Agent Runtime Decisions §10):
 * the user's turn runs one agent directly, with no Planner pre-pass and no
 * Orchestrator handoff. `delegated` opts back into the historical org-chart
 * wrapper. Inline has been the web default since 2026-06-11 (the step-1
 * delegation-collapse A/B measured twice with quality tied and the wrapper
 * costing ~78% wall-clock).
 *
 * Consumers today: **web only**, via localStorage
 * (`app/src/lib/delegation-mode-settings.ts`). The CLI adopted the inline
 * default as the first §10 convergence step and later retired its
 * `delegated` opt-in entirely (`RunOptions.delegationMode` /
 * `PUSH_DELEGATION_MODE` are no longer read) — every CLI turn is the lead,
 * unconditionally. This stays in `lib/` as the shared vocabulary in case a
 * surface grows a preference again; the web resolves through
 * `resolveDelegationMode` so the opt-in rule has one home.
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
