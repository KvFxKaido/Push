import { useState, useCallback } from 'react';
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

export function usePinnedArtifacts(repoFullName: string | null) {
  const [artifacts, setArtifacts] = useState<PinnedArtifact[]>(() => {
    const raw = safeStorageGet(storageKey(repoFullName));
    if (!raw) return [];
    try {
      return JSON.parse(raw) as PinnedArtifact[];
    } catch {
      return [];
    }
  });

  const persist = useCallback((next: PinnedArtifact[]) => {
    setArtifacts(next);
    safeStorageSet(storageKey(repoFullName), JSON.stringify(next));
  }, [repoFullName]);

  const pin = useCallback((content: string, sourceMessageId: string) => {
    const artifact: PinnedArtifact = {
      id: `pin_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      content,
      sourceMessageId,
      pinnedAt: Date.now(),
    };
    persist([artifact, ...artifacts]);
  }, [artifacts, persist]);

  const unpin = useCallback((id: string) => {
    persist(artifacts.filter(a => a.id !== id));
  }, [artifacts, persist]);

  const updateLabel = useCallback((id: string, label: string) => {
    persist(artifacts.map(a => a.id === id ? { ...a, label } : a));
  }, [artifacts, persist]);

  return { artifacts, pin, unpin, updateLabel, hasArtifacts: artifacts.length > 0 };
}
