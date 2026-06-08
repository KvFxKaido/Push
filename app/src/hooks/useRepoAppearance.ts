import { useCallback, useEffect, useState } from 'react';
import { safeStorageGet } from '@/lib/safe-storage';
import { getSetting, SETTINGS_KEYS, setSetting, subscribeSetting } from '@/lib/settings-store';
import {
  coerceRepoAppearance,
  DEFAULT_REPO_APPEARANCE,
  type RepoAppearance,
} from '@/lib/repo-appearance';

const LEGACY_KEY = 'push:repo-appearance:v1';

type RepoAppearanceMap = Record<string, RepoAppearance>;

function coerceMap(raw: unknown): RepoAppearanceMap {
  if (!raw || typeof raw !== 'object') return {};
  const next: RepoAppearanceMap = {};
  for (const [repoFullName, value] of Object.entries(raw as Record<string, unknown>)) {
    const appearance = coerceRepoAppearance(value);
    if (appearance) next[repoFullName] = appearance;
  }
  return next;
}

function legacyMap(): RepoAppearanceMap | undefined {
  const raw = safeStorageGet(LEGACY_KEY);
  if (!raw) return undefined;
  try {
    return coerceMap(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function readMap(): RepoAppearanceMap {
  const stored = getSetting(SETTINGS_KEYS.appearanceByRepo);
  if (stored !== undefined) return coerceMap(stored);
  return legacyMap() ?? {};
}

export function useRepoAppearance() {
  const [appearancesByRepo, setAppearancesByRepo] = useState<RepoAppearanceMap>(readMap);

  // Re-derive when a server reconcile or another hook instance writes the map.
  useEffect(
    () => subscribeSetting(SETTINGS_KEYS.appearanceByRepo, () => setAppearancesByRepo(readMap())),
    [],
  );

  // Write-through. `setSetting` notifies synchronously, so the subscription above
  // refreshes local state — no separate setState needed.
  const persist = useCallback((next: RepoAppearanceMap) => {
    setSetting(SETTINGS_KEYS.appearanceByRepo, next);
  }, []);

  const setRepoAppearance = useCallback((repoFullName: string, appearance: RepoAppearance) => {
    if (!repoFullName) return;
    const normalized = coerceRepoAppearance(appearance) ?? DEFAULT_REPO_APPEARANCE;
    setSetting(SETTINGS_KEYS.appearanceByRepo, { ...readMap(), [repoFullName]: normalized });
  }, []);

  const clearRepoAppearance = useCallback((repoFullName: string) => {
    if (!repoFullName) return;
    const current = readMap();
    if (!current[repoFullName]) return;
    const next = { ...current };
    delete next[repoFullName];
    setSetting(SETTINGS_KEYS.appearanceByRepo, next);
  }, []);

  const getRepoAppearance = useCallback(
    (repoFullName?: string | null): RepoAppearance | null => {
      if (!repoFullName) return null;
      return appearancesByRepo[repoFullName] ?? null;
    },
    [appearancesByRepo],
  );

  const resolveRepoAppearance = useCallback(
    (repoFullName?: string | null): RepoAppearance => {
      return getRepoAppearance(repoFullName) ?? DEFAULT_REPO_APPEARANCE;
    },
    [getRepoAppearance],
  );

  return {
    appearancesByRepo,
    getRepoAppearance,
    resolveRepoAppearance,
    setRepoAppearance,
    clearRepoAppearance,
    resetRepoAppearances: () => persist({}),
  };
}
