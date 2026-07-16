/**
 * restart-policy.ts — pushd session restart-policy predicates.
 *
 * Extracted from cli/pushd.ts (Pushd Decomposition Plan, Phase 1). Pure
 * predicates over persisted session state and run markers; no daemon runtime
 * state.
 *
 * Each session can have a restart policy that controls crash recovery:
 *   'on-failure' (default) — recover runs that were interrupted by daemon crash
 *   'always'               — always recover (same as on-failure for now; future: timer-based restarts)
 *   'never'                — never auto-recover; user must manually re-send
 */
export type RestartPolicy = 'on-failure' | 'always' | 'never';

export const DEFAULT_RESTART_POLICY: RestartPolicy = 'on-failure';
// Exported (unlike the original file-private Set) because pushd.ts's
// start_session handler validates payload.restartPolicy against it directly.
export const VALID_RESTART_POLICIES = new Set<string>(['on-failure', 'always', 'never']);

export function getRestartPolicy(
  state: { restartPolicy?: string | null } | null | undefined,
): RestartPolicy {
  const policy = state?.restartPolicy || DEFAULT_RESTART_POLICY;
  return VALID_RESTART_POLICIES.has(policy) ? (policy as RestartPolicy) : DEFAULT_RESTART_POLICY;
}

export function shouldRecover(policy: RestartPolicy, marker: { startedAt?: unknown }): boolean {
  if (policy === 'never') return false;
  // 'on-failure' and 'always' both recover interrupted runs
  // Guard: reject missing/non-finite startedAt and stale markers (>1 hour)
  const startedAt = Number(marker.startedAt);
  if (!Number.isFinite(startedAt)) return false;
  const age = Date.now() - startedAt;
  const ONE_HOUR = 60 * 60 * 1000;
  if (age < 0 || age > ONE_HOUR) return false;
  return true;
}
