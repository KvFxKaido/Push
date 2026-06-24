import { useState } from 'react';
import { isNativeCheckpointsEnabled } from '@/lib/checkpoint/checkpoint-store';
import { isNativePlatform } from '@/lib/platform';
import { useCheckpointHistory } from '@/hooks/useCheckpointHistory';
import { CheckpointHistoryList } from './CheckpointHistoryList';

export interface CheckpointHistoryProps {
  sandboxId: string | null;
  repoFullName: string | null | undefined;
  branch: string | null | undefined;
  /**
   * Whether the host surface (hub sheet) is open. Gating the hook's work on this
   * makes the history re-fetch each time the sheet reopens — the sheet stays
   * mounted, so without this checkpoints captured between opens stay invisible
   * (Codex P2).
   */
  open: boolean;
}

/**
 * Self-gating checkpoint-history surface: renders the on-device checkpoint list
 * ONLY on the native shell with `VITE_NATIVE_CHECKPOINTS` enabled, and nothing
 * otherwise. The gate lives here so call sites mount it unconditionally
 * (`<CheckpointHistory … />`) with zero effect on web.
 */
export function CheckpointHistory({
  sandboxId,
  repoFullName,
  branch,
  open,
}: CheckpointHistoryProps) {
  const active = isNativePlatform() && isNativeCheckpointsEnabled();
  // Snapshot "now" once at mount (relative ages are computed against it) — keeps
  // render pure. The sheet is transient, so a per-open snapshot is fine.
  const [nowMs] = useState(() => Date.now());
  // Hook runs unconditionally (rules of hooks); `enabled` gates its work so it's
  // inert on web AND re-fetches on each reopen (the scope key cycles with `open`).
  const history = useCheckpointHistory({
    sandboxId,
    repoFullName: repoFullName ?? null,
    branch,
    enabled: active && open,
  });

  if (!active) return null;

  return (
    <CheckpointHistoryList
      checkpoints={history.checkpoints}
      loading={history.loading}
      error={history.error}
      restoringId={history.restoringId}
      canRestore={history.canRestore}
      onRestore={history.restore}
      droppingId={history.droppingId}
      clearing={history.clearing}
      onDrop={history.drop}
      onClear={history.clear}
      nowMs={nowMs}
    />
  );
}
