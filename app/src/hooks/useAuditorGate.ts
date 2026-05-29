import { useCallback, useEffect, useState } from 'react';
import { safeStorageGet, safeStorageRemove, safeStorageSet } from '@/lib/safe-storage';

/**
 * Auditor commit-gate toggle — the web half of the cross-surface setting that
 * the CLI/daemon resolve via `lib/auditor-policy.ts`. Modeled on
 * `useProtectMain` (global default + per-repo override) because the Auditor
 * gate is the other commit-safety gate and users reason about them the same
 * way.
 *
 * Difference from Protect Main: the gate DEFAULTS ON. The Auditor SAFE/UNSAFE
 * review is a documented required gate (ARCHITECTURE.md), so absent any stored
 * preference the gate is active. Disabling is a deliberate opt-out. That makes
 * the persisted vocabulary an explicit `'true'`/`'false'` string (not
 * presence/absence) so we can tell "user turned it off" from "never set".
 */

const GLOBAL_DEFAULT_KEY = 'auditor_gate_default';

export type RepoOverride = 'inherit' | 'always' | 'never';

function repoKey(repoFullName: string): string {
  return `auditor_gate_${repoFullName}`;
}

function loadGlobalDefault(): boolean {
  const raw = safeStorageGet(GLOBAL_DEFAULT_KEY);
  // Default ON: only an explicit 'false' disables it. Any other value
  // (including unset) means enabled.
  return raw !== 'false';
}

function loadRepoOverride(repoFullName?: string): RepoOverride {
  if (!repoFullName) return 'inherit';
  const raw = safeStorageGet(repoKey(repoFullName));
  if (raw === 'always' || raw === 'never') return raw;
  return 'inherit';
}

/**
 * Standalone (non-hook) getter for use in library code that can't call hooks
 * (the `runAuditor` gate at the commit call sites). Returns true when the
 * Auditor commit gate is active for the given repo.
 */
export function getIsAuditorGateEnabled(repoFullName?: string): boolean {
  const override = loadRepoOverride(repoFullName);
  if (override === 'always') return true;
  if (override === 'never') return false;
  return loadGlobalDefault();
}

export function useAuditorGate(repoFullName?: string) {
  const [globalDefault, setGlobalDefaultState] = useState(loadGlobalDefault);
  const [repoOverride, setRepoOverrideState] = useState<RepoOverride>(() =>
    loadRepoOverride(repoFullName),
  );

  useEffect(() => {
    setRepoOverrideState(loadRepoOverride(repoFullName));
  }, [repoFullName]);

  const setGlobalDefault = useCallback((value: boolean) => {
    safeStorageSet(GLOBAL_DEFAULT_KEY, String(value));
    setGlobalDefaultState(value);
  }, []);

  const setRepoOverride = useCallback(
    (value: RepoOverride) => {
      if (repoFullName) {
        if (value === 'inherit') {
          safeStorageRemove(repoKey(repoFullName));
        } else {
          safeStorageSet(repoKey(repoFullName), value);
        }
      }
      setRepoOverrideState(value);
    },
    [repoFullName],
  );

  const isEnabled =
    repoOverride === 'always' ? true : repoOverride === 'never' ? false : globalDefault;

  return {
    isEnabled,
    globalDefault,
    setGlobalDefault,
    repoOverride,
    setRepoOverride,
  };
}
