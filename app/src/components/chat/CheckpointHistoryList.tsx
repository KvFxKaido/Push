import { History, Loader2, RotateCcw } from 'lucide-react';
import { HUB_MATERIAL_PILL_BUTTON_CLASS, HUB_PANEL_SURFACE_CLASS } from './hub-styles';
import { formatCheckpointAge } from '@/lib/checkpoint/checkpoint-format';
import type { CheckpointRecord } from '@/lib/checkpoint/checkpoint-store';

export interface CheckpointHistoryListProps {
  checkpoints: CheckpointRecord[];
  loading: boolean;
  error: string | null;
  /** The checkpoint currently being restored, or null. */
  restoringId: string | null;
  onRestore: (checkpointId: string) => void;
  /** Current time for relative ages — injected for deterministic tests. */
  nowMs: number;
}

/**
 * Presentational checkpoint history — the on-device git log surfaced as a
 * restorable list. Pure (no store / platform access); the self-gating
 * `CheckpointHistory` container supplies the data and gates it to the native
 * shell behind the flag.
 */
export function CheckpointHistoryList({
  checkpoints,
  loading,
  error,
  restoringId,
  onRestore,
  nowMs,
}: CheckpointHistoryListProps) {
  const restoringAny = restoringId !== null;
  return (
    <div className={`${HUB_PANEL_SURFACE_CLASS} px-3 py-2.5`}>
      <div className="mb-2 flex items-center gap-1.5 text-push-xs font-medium text-push-fg-dim">
        <History className="h-3.5 w-3.5" />
        <span>Checkpoints</span>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-1 text-push-xs text-push-fg-dim">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>Loading…</span>
        </div>
      ) : error ? (
        <p className="py-1 text-push-xs text-push-rose">{error}</p>
      ) : checkpoints.length === 0 ? (
        <p className="py-1 text-push-xs text-push-fg-dim">No checkpoints yet.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {checkpoints.map((checkpoint, index) => {
            const restoring = restoringId === checkpoint.checkpointId;
            return (
              <li
                key={checkpoint.checkpointId}
                className="flex items-center justify-between gap-3 py-0.5"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      index === 0 ? 'bg-push-sky' : 'bg-push-fg-dim/40'
                    }`}
                  />
                  <span className="truncate text-push-xs text-push-fg-secondary">
                    {formatCheckpointAge(nowMs, checkpoint.timestampMs)}
                    {index === 0 ? ' · latest' : ''}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => onRestore(checkpoint.checkpointId)}
                  disabled={restoringAny}
                  className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} shrink-0 gap-1.5 px-3 text-push-fg-secondary`}
                >
                  {restoring ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <RotateCcw className="h-3 w-3" />
                  )}
                  <span>{restoring ? 'Restoring…' : 'Restore'}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
