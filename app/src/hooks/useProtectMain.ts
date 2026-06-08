import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { safeStorageGet } from '@/lib/safe-storage';
import { getSetting, SETTINGS_KEYS, setSetting, subscribeSetting } from '@/lib/settings-store';

export type RepoOverride = 'inherit' | 'always' | 'never';

type RepoOverrideMap = Record<string, 'always' | 'never'>;

// Pre-unification localStorage keys, read once as a fallback so existing
// protection prefs survive the first load and migrate into the doc on write.
const LEGACY_GLOBAL_KEY = 'protect_main_default';
function legacyRepoKey(repoFullName: string): string {
  return `protect_main_${repoFullName}`;
}

function resolveOverrideMap(raw: unknown): RepoOverrideMap {
  if (!raw || typeof raw !== 'object') return {};
  const out: RepoOverrideMap = {};
  for (const [repo, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === 'always' || value === 'never') out[repo] = value;
  }
  return out;
}

function resolveGlobalDefault(raw: unknown): boolean {
  if (typeof raw === 'boolean') return raw;
  return safeStorageGet(LEGACY_GLOBAL_KEY) === 'true';
}

function resolveRepoOverride(repoFullName: string | undefined, rawMap: unknown): RepoOverride {
  if (!repoFullName) return 'inherit';
  const fromDoc = resolveOverrideMap(rawMap)[repoFullName];
  if (fromDoc) return fromDoc;
  const legacy = safeStorageGet(legacyRepoKey(repoFullName));
  if (legacy === 'always' || legacy === 'never') return legacy;
  return 'inherit';
}

/**
 * Standalone (non-hook) getter for use in library code that can't call hooks.
 * Returns true if main branch protection is active for the given repo. Reads the
 * unified settings cache, falling back to the pre-migration localStorage values.
 */
export function getIsMainProtected(repoFullName?: string): boolean {
  const override = resolveRepoOverride(repoFullName, getSetting(SETTINGS_KEYS.protectMainByRepo));
  if (override === 'always') return true;
  if (override === 'never') return false;
  return resolveGlobalDefault(getSetting(SETTINGS_KEYS.protectMainDefault));
}

export function useProtectMain(repoFullName?: string) {
  // Subscribe to the raw doc values; derive booleans/overrides in memos so the
  // external-store snapshots stay referentially stable and a `repoFullName`
  // change re-derives without a setState-in-effect.
  const rawGlobal = useSyncExternalStore(
    (cb) => subscribeSetting(SETTINGS_KEYS.protectMainDefault, cb),
    () => getSetting(SETTINGS_KEYS.protectMainDefault),
    () => undefined,
  );
  const rawMap = useSyncExternalStore(
    (cb) => subscribeSetting(SETTINGS_KEYS.protectMainByRepo, cb),
    () => getSetting(SETTINGS_KEYS.protectMainByRepo),
    () => undefined,
  );

  const globalDefault = useMemo(() => resolveGlobalDefault(rawGlobal), [rawGlobal]);
  const repoOverride = useMemo(
    () => resolveRepoOverride(repoFullName, rawMap),
    [repoFullName, rawMap],
  );

  const setGlobalDefault = useCallback((value: boolean) => {
    setSetting(SETTINGS_KEYS.protectMainDefault, value);
  }, []);

  const setRepoOverride = useCallback(
    (value: RepoOverride) => {
      // No repo in context: an override has nothing to scope to, so it's a no-op.
      if (!repoFullName) return;
      const next = { ...resolveOverrideMap(rawMap) };
      if (value === 'inherit') delete next[repoFullName];
      else next[repoFullName] = value;
      setSetting(SETTINGS_KEYS.protectMainByRepo, next);
    },
    [repoFullName, rawMap],
  );

  const isProtected =
    repoOverride === 'always' ? true : repoOverride === 'never' ? false : globalDefault;

  return {
    isProtected,
    globalDefault,
    setGlobalDefault,
    repoOverride,
    setRepoOverride,
  };
}
