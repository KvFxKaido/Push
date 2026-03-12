import { useCallback, useState } from 'react';
import { safeStorageGet, safeStorageSet } from '@/lib/safe-storage';
import {
  coerceRepoAppearance,
  DEFAULT_REPO_APPEARANCE,
  type RepoAppearance,
} from '@/lib/repo-appearance';

const REPO_APPEARANCE_STORAGE_KEY = 'push:repo-appearance:v1';

type RepoAppearanceMap = Record<string, RepoAppearance>;

function loadRepoAppearances(): RepoAppearanceMap {
  const raw = safeStorageGet(REPO_APPEARANCE_STORAGE_KEY);
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const next: RepoAppearanceMap = {};
    for (const [repoFullName, value] of Object.entries(parsed)) {
      const appearance = coerceRepoAppearance(value);
      if (appearance) {
        next[repoFullName] = appearance;
      }
    }
    return next;
  } catch {
    return {};
  }
}

export function useRepoAppearance() {
  const [appearancesByRepo, setAppearancesByRepo] = useState<RepoAppearanceMap>(loadRepoAppearances);

  const persist = useCallback((next: RepoAppearanceMap) => {
    safeStorageSet(REPO_APPEARANCE_STORAGE_KEY, JSON.stringify(next));
    setAppearancesByRepo(next);
  }, []);

  const setRepoAppearance = useCallback((repoFullName: string, appearance: RepoAppearance) => {
    if (!repoFullName) return;
    const normalized = coerceRepoAppearance(appearance) ?? DEFAULT_REPO_APPEARANCE;
    setAppearancesByRepo((prev) => {
      const next = { ...prev, [repoFullName]: normalized };
      safeStorageSet(REPO_APPEARANCE_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const clearRepoAppearance = useCallback((repoFullName: string) => {
    if (!repoFullName) return;
    setAppearancesByRepo((prev) => {
      if (!prev[repoFullName]) return prev;
      const next = { ...prev };
      delete next[repoFullName];
      safeStorageSet(REPO_APPEARANCE_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const getRepoAppearance = useCallback((repoFullName?: string | null): RepoAppearance | null => {
    if (!repoFullName) return null;
    return appearancesByRepo[repoFullName] ?? null;
  }, [appearancesByRepo]);

  const resolveRepoAppearance = useCallback((repoFullName?: string | null): RepoAppearance => {
    return getRepoAppearance(repoFullName) ?? DEFAULT_REPO_APPEARANCE;
  }, [getRepoAppearance]);

  return {
    appearancesByRepo,
    getRepoAppearance,
    resolveRepoAppearance,
    setRepoAppearance,
    clearRepoAppearance,
    resetRepoAppearances: () => persist({}),
  };
}
