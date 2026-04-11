import { useState, useCallback, useEffect } from 'react';
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
  try {
    return JSON.parse(raw) as PinnedArtifact[];
  } catch {
    return [];
  }
}

export function usePinnedArtifacts(repoFullName: string | null) {
  const [artifacts, setArtifacts] = useState<PinnedArtifact[]>(() => readArtifacts(repoFullName));

  useEffect(() => {
    setArtifacts(readArtifacts(repoFullName));
  }, [repoFullName]);

  const updateArtifacts = useCallback(
    (updater: (current: PinnedArtifact[]) => PinnedArtifact[]) => {
      setArtifacts((current) => {
        const next = updater(current);
        safeStorageSet(storageKey(repoFullName), JSON.stringify(next));
        return next;
      });
    },
    [repoFullName],
  );

  const pin = useCallback(
    (content: string, sourceMessageId: string) => {
      const artifact: PinnedArtifact = {
        id: `pin_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        content,
        sourceMessageId,
        pinnedAt: Date.now(),
      };
      updateArtifacts((current) => [artifact, ...current]);
    },
    [updateArtifacts],
  );

  const unpin = useCallback(
    (id: string) => {
      updateArtifacts((current) => current.filter((artifact) => artifact.id !== id));
    },
    [updateArtifacts],
  );

  const updateLabel = useCallback(
    (id: string, label: string) => {
      updateArtifacts((current) =>
        current.map((artifact) => (artifact.id === id ? { ...artifact, label } : artifact)),
      );
    },
    [updateArtifacts],
  );

  return { artifacts, pin, unpin, updateLabel, hasArtifacts: artifacts.length > 0 };
}
