import { useState, useCallback, useMemo } from 'react';
import { safeStorageGet, safeStorageSet } from '@/lib/safe-storage';

export interface PinnedArtifact {
  id: string;
  content: string;
  sourceMessageId: string;
  pinnedAt: number;
  label?: string;
}

function storageKey(repoFullName: string | null): string {
  return `push-pinned:${repoFullName || 'sandbox'}`;
}

function readArtifacts(repoFullName: string | null): PinnedArtifact[] {
  const raw = safeStorageGet(storageKey(repoFullName));
  if (!raw) return [];
  try { return JSON.parse(raw) as PinnedArtifact[]; }
  catch { return []; }
}

export function usePinnedArtifacts(repoFullName: string | null) {
  // Version counter triggers useMemo recompute after mutations.
  // repoFullName in the deps handles repo switches automatically.
  const [version, setVersion] = useState(0);
  const artifacts = useMemo(() => readArtifacts(repoFullName), [repoFullName, version]);

  const persist = useCallback((next: PinnedArtifact[]) => {
    safeStorageSet(storageKey(repoFullName), JSON.stringify(next));
    setVersion(v => v + 1);
  }, [repoFullName]);

  const pin = useCallback((content: string, sourceMessageId: string) => {
    const current = readArtifacts(repoFullName);
    const artifact: PinnedArtifact = {
      id: `pin_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      content,
      sourceMessageId,
      pinnedAt: Date.now(),
    };
    persist([artifact, ...current]);
  }, [repoFullName, persist]);

  const unpin = useCallback((id: string) => {
    persist(readArtifacts(repoFullName).filter(a => a.id !== id));
  }, [repoFullName, persist]);

  const updateLabel = useCallback((id: string, label: string) => {
    persist(readArtifacts(repoFullName).map(a => a.id === id ? { ...a, label } : a));
  }, [repoFullName, persist]);

  return { artifacts, pin, unpin, updateLabel, hasArtifacts: artifacts.length > 0 };
}
