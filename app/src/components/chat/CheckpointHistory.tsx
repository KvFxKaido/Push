import { useState } from 'react';
import { isNativeCheckpointsEnabled } from '@/lib/checkpoint/checkpoint-store';
import { isNativePlatform } from '@/lib/platform';
import { useCheckpointHistory } from '@/hooks/useCheckpointHistory';
import { CheckpointHistoryList } from './CheckpointHistoryList';

export interface CheckpointHistoryProps {
  sandboxId: string | null;
  repoFullName: string | null | undefined;
  branch: string | null | undefined;
}

/**
 * Self-gating checkpoint-history surface: renders the on-device checkpoint list
 * ONLY on the native shell with `VITE_NATIVE_CHECKPOINTS` enabled, and nothing
 * otherwise. The gate lives here so call sites mount it unconditionally
 * (`<CheckpointHistory … />`) with zero effect on web.
 */
export function CheckpointHistory({ sandboxId, repoFullName, branch }: CheckpointHistoryProps) {
  const active = isNativePlatform() && isNativeCheckpointsEnabled();
  // Snapshot "now" once at mount (relative ages are computed against it) — keeps
  // render pure. The sheet is transient, so a per-open snapshot is fine.
  const [nowMs] = useState(() => Date.now());
  // Hook runs unconditionally (rules of hooks); `enabled` gates its work so it's
  // inert on web.
  const history = useCheckpointHistory({
    sandboxId,
    repoFullName: repoFullName ?? null,
    branch,
    enabled: active,
  });

  if (!active) return null;

  return (
    <CheckpointHistoryList
      checkpoints={history.checkpoints}
      loading={history.loading}
      error={history.error}
      restoringId={history.restoringId}
      onRestore={history.restore}
      nowMs={nowMs}
    />
  );
}
