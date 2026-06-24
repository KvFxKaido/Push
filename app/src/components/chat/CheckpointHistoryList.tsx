import { useState } from 'react';
import { Check, History, Loader2, RotateCcw, Trash2, X } from 'lucide-react';
import { HUB_MATERIAL_PILL_BUTTON_CLASS, HUB_PANEL_SURFACE_CLASS } from './hub-styles';
import { formatCheckpointAge } from '@/lib/checkpoint/checkpoint-format';
import type { CheckpointRecord } from '@/lib/checkpoint/checkpoint-store';

export interface CheckpointHistoryListProps {
  checkpoints: CheckpointRecord[];
  loading: boolean;
  error: string | null;
  /** The checkpoint currently being restored, or null. */
  restoringId: string | null;
  /** Whether restore can run (false with no sandbox to restore into). */
  canRestore: boolean;
  onRestore: (checkpointId: string) => void;
  /** The checkpoint currently being deleted, or null. */
  droppingId: string | null;
  /** Whether a clear (lane or all-lanes) purge is in flight. */
  clearing: boolean;
  /** Delete one checkpoint from the lane (#1103). */
  onDrop: (checkpointId: string) => void;
  /** Purge the lane's checkpoints, or every lane's (`allLanes`). */
  onClear: (allLanes: boolean) => void;
  /** Current time for relative ages — injected for deterministic tests. */
  nowMs: number;
}

/**
 * Presentational checkpoint history — the on-device git log surfaced as a
 * restorable list, with delete (per-checkpoint) and clear (lane / all-lanes)
 * purge actions (the #1103 security mitigation). Destructive actions use an
 * inline two-step confirm (no blocking `window.confirm`). Pure aside from that
 * local confirm/arm state; the self-gating `CheckpointHistory` container supplies
 * the data + handlers and gates it to the native shell behind the flag.
 */
export function CheckpointHistoryList({
  checkpoints,
  loading,
  error,
  restoringId,
  canRestore,
  onRestore,
  droppingId,
  clearing,
  onDrop,
  onClear,
  nowMs,
}: CheckpointHistoryListProps) {
  // Inline confirm-arming: which destructive action is awaiting a second tap.
  const [confirmDropId, setConfirmDropId] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState<null | 'lane' | 'all'>(null);

  const restoringAny = restoringId !== null;
  const droppingAny = droppingId !== null;
  // Block other mutations while any purge/restore is in flight.
  const busy = restoringAny || droppingAny || clearing;

  const confirmDrop = (checkpointId: string) => {
    setConfirmDropId(null);
    onDrop(checkpointId);
  };
  const confirmDoClear = (allLanes: boolean) => {
    setConfirmClear(null);
    onClear(allLanes);
  };

  return (
    <div className={`${HUB_PANEL_SURFACE_CLASS} px-3 py-2.5`}>
      <div className="mb-2 flex items-center justify-between gap-2 text-push-xs font-medium text-push-fg-dim">
        <span className="flex items-center gap-1.5">
          <History className="h-3.5 w-3.5" />
          <span>Checkpoints</span>
        </span>
        {!canRestore && checkpoints.length > 0 ? (
          <span className="text-push-fg-dim/70">Start the workspace to restore</span>
        ) : null}
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
            const dropping = droppingId === checkpoint.checkpointId;
            const confirming = confirmDropId === checkpoint.checkpointId;
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
                    {confirming ? (
                      <span className="text-push-rose">Delete this checkpoint?</span>
                    ) : (
                      <>
                        {formatCheckpointAge(nowMs, checkpoint.timestampMs)}
                        {index === 0 ? ' · latest' : ''}
                      </>
                    )}
                  </span>
                </div>
                {confirming ? (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      aria-label="Confirm delete checkpoint"
                      onClick={() => confirmDrop(checkpoint.checkpointId)}
                      disabled={busy}
                      className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} gap-1 px-2.5 text-push-rose disabled:opacity-50`}
                    >
                      <Check className="h-3 w-3" />
                      <span>Delete</span>
                    </button>
                    <button
                      type="button"
                      aria-label="Cancel delete"
                      onClick={() => setConfirmDropId(null)}
                      className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} px-2 text-push-fg-dim`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ) : (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => onRestore(checkpoint.checkpointId)}
                      disabled={busy || !canRestore}
                      className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} gap-1.5 px-3 text-push-fg-secondary disabled:opacity-50`}
                    >
                      {restoring ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <RotateCcw className="h-3 w-3" />
                      )}
                      <span>{restoring ? 'Restoring…' : 'Restore'}</span>
                    </button>
                    <button
                      type="button"
                      aria-label="Delete checkpoint"
                      onClick={() => {
                        setConfirmClear(null);
                        setConfirmDropId(checkpoint.checkpointId);
                      }}
                      disabled={busy}
                      className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} px-2 text-push-fg-dim hover:text-push-rose disabled:opacity-50`}
                    >
                      {dropping ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Trash2 className="h-3 w-3" />
                      )}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* Purge controls — the on-demand security mitigation. Only meaningful when
          something is stored; clear-all spans every lane, clear-branch just this one. */}
      {!loading && checkpoints.length > 0 ? (
        <div className="mt-2.5 border-t border-push-edge/60 pt-2">
          {confirmClear ? (
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-push-xs text-push-rose">
                {confirmClear === 'all'
                  ? 'Delete ALL on-device checkpoints?'
                  : "Delete this branch's checkpoints?"}
              </span>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => confirmDoClear(confirmClear === 'all')}
                  disabled={busy}
                  className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} gap-1 px-2.5 text-push-rose disabled:opacity-50`}
                >
                  {clearing ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Check className="h-3 w-3" />
                  )}
                  <span>{confirmClear === 'all' ? 'Clear all' : 'Clear branch'}</span>
                </button>
                <button
                  type="button"
                  aria-label="Cancel clear"
                  onClick={() => setConfirmClear(null)}
                  className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} px-2 text-push-fg-dim`}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-end gap-1.5">
              <button
                type="button"
                onClick={() => {
                  setConfirmDropId(null);
                  setConfirmClear('lane');
                }}
                disabled={busy}
                className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} gap-1.5 px-2.5 text-push-fg-dim disabled:opacity-50`}
              >
                <Trash2 className="h-3 w-3" />
                <span>Clear branch</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmDropId(null);
                  setConfirmClear('all');
                }}
                disabled={busy}
                className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} gap-1.5 px-2.5 text-push-rose disabled:opacity-50`}
              >
                <Trash2 className="h-3 w-3" />
                <span>Clear all</span>
              </button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
