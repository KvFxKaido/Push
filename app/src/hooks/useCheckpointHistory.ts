import { useCallback, useEffect, useRef, useState } from 'react';
import { resolveCheckpointStore } from '@/lib/checkpoint/resolve-store';
import type {
  CheckpointClearResult,
  CheckpointDropInput,
  CheckpointDropResult,
  CheckpointRecord,
  CheckpointRestoreInput,
  CheckpointRestoreResult,
  CheckpointScope,
} from '@/lib/checkpoint/checkpoint-store';

type ListFn = (scope: CheckpointScope) => Promise<CheckpointRecord[]>;
type RestoreFn = (input: CheckpointRestoreInput) => Promise<CheckpointRestoreResult>;
type DropFn = (input: CheckpointDropInput) => Promise<CheckpointDropResult>;
type ClearFn = (
  scope: CheckpointScope,
  options?: { allLanes?: boolean },
) => Promise<CheckpointClearResult>;

const defaultList: ListFn = (scope) => resolveCheckpointStore().list(scope);
const defaultRestore: RestoreFn = (input) => resolveCheckpointStore().restore(input);
const defaultDrop: DropFn = (input) => resolveCheckpointStore().drop(input);
const defaultClear: ClearFn = (scope, options) => resolveCheckpointStore().clear(scope, options);

export interface UseCheckpointHistoryArgs {
  sandboxId: string | null;
  repoFullName: string | null;
  branch: string | null | undefined;
  /** Gate the work (e.g. native shell + flag). Default true. */
  enabled?: boolean;
  /** Injectable for tests. */
  list?: ListFn;
  restoreCheckpoint?: RestoreFn;
  dropCheckpoint?: DropFn;
  clearCheckpoints?: ClearFn;
}

export interface CheckpointHistoryState {
  checkpoints: CheckpointRecord[];
  loading: boolean;
  error: string | null;
  /** The checkpoint currently being restored, or null. */
  restoringId: string | null;
  /**
   * Whether restore can run — false when there's no sandbox to restore INTO (an
   * idle/hibernated workspace can still list history). Call sites disable the
   * restore control rather than letting it no-op silently (Codex P2).
   */
  canRestore: boolean;
  refresh: () => void;
  restore: (checkpointId: string) => Promise<void>;
  /** The checkpoint currently being deleted, or null. */
  droppingId: string | null;
  /** Whether a clear-all/clear-lane purge is in flight. */
  clearing: boolean;
  /** Delete one checkpoint from the lane (security mitigation, #1103). */
  drop: (checkpointId: string) => Promise<void>;
  /** Purge the lane's checkpoints, or every lane's (`allLanes`). */
  clear: (allLanes?: boolean) => Promise<void>;
}

interface LoadedData {
  /** The lane key this data answered, so a stale resolve can't be shown. */
  scope: string;
  checkpoints: CheckpointRecord[];
  error: string | null;
}

const EMPTY_DATA: LoadedData = { scope: '', checkpoints: [], error: null };

/** Map a non-restored result to a user-facing message. Exported for tests. */
export function restoreError(
  result: Exclude<CheckpointRestoreResult, { status: 'restored' }>,
): string {
  if (result.status === 'skipped-dirty') return 'Restore skipped — the workspace has changes.';
  if (result.status === 'unsupported') return 'Restore is not available here.';
  return result.reason || 'Restore failed.';
}

/** Map a failed drop/clear to a user-facing message. Exported for tests. */
export function purgeError(
  result: { status: 'failed'; reason: string } | { status: 'unsupported' },
): string {
  if (result.status === 'unsupported') return 'Clearing checkpoints is not available here.';
  return result.reason || 'Could not clear checkpoints.';
}

/**
 * Loads the checkpoint history for the active lane (repo + branch) and exposes a
 * per-checkpoint restore. Thin glue over the active CheckpointStore; the
 * self-gating `CheckpointHistory` container decides whether to mount it.
 *
 * `loading`/`checkpoints`/`error` are DERIVED from a single scope-keyed data
 * state, so the effect only ever setStates inside its async callbacks (never
 * synchronously — which would risk cascading renders).
 */
export function useCheckpointHistory({
  sandboxId,
  repoFullName,
  branch,
  enabled = true,
  list = defaultList,
  restoreCheckpoint = defaultRestore,
  dropCheckpoint = defaultDrop,
  clearCheckpoints = defaultClear,
}: UseCheckpointHistoryArgs): CheckpointHistoryState {
  const [data, setData] = useState<LoadedData>(EMPTY_DATA);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [droppingId, setDroppingId] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [nonce, setNonce] = useState(0);

  const listRef = useRef(list);
  const restoreRef = useRef(restoreCheckpoint);
  const dropRef = useRef(dropCheckpoint);
  const clearRef = useRef(clearCheckpoints);
  useEffect(() => {
    listRef.current = list;
    restoreRef.current = restoreCheckpoint;
    dropRef.current = dropCheckpoint;
    clearRef.current = clearCheckpoints;
  });

  const trimmedBranch = branch?.trim() || null;
  const ready = enabled && Boolean(repoFullName) && Boolean(trimmedBranch);
  // Identity of the current load (lane + refresh nonce); the resolved data
  // carries the scope it answered so a late/stale resolve is ignored.
  const scopeKey =
    ready && repoFullName && trimmedBranch ? [repoFullName, trimmedBranch, nonce].join('|') : '';

  useEffect(() => {
    if (!scopeKey || !repoFullName || !trimmedBranch) return;
    let cancelled = false;
    listRef
      .current({ repoFullName, branch: trimmedBranch })
      .then((records) => {
        if (!cancelled) setData({ scope: scopeKey, checkpoints: records, error: null });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setData({
            scope: scopeKey,
            checkpoints: [],
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [scopeKey, repoFullName, trimmedBranch]);

  const resolved = data.scope === scopeKey;
  const checkpoints = ready && resolved ? data.checkpoints : [];
  const error = ready && resolved ? data.error : null;
  const loading = ready && !resolved;

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const restore = useCallback(
    async (checkpointId: string) => {
      if (!sandboxId || !repoFullName || !trimmedBranch) return;
      setRestoringId(checkpointId);
      try {
        const result = await restoreRef.current({
          sandboxId,
          repoFullName,
          branch: trimmedBranch,
          checkpointId,
        });
        if (result.status !== 'restored') {
          // Surface restore failures by overwriting the current lane's data error.
          setData((current) => ({ ...current, error: restoreError(result) }));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setData((current) => ({ ...current, error: message }));
      } finally {
        setRestoringId(null);
      }
    },
    [sandboxId, repoFullName, trimmedBranch],
  );

  const drop = useCallback(
    async (checkpointId: string) => {
      if (!repoFullName || !trimmedBranch) return;
      setDroppingId(checkpointId);
      try {
        const result = await dropRef.current({ repoFullName, branch: trimmedBranch, checkpointId });
        // 'dropped' and 'not-found' both mean the entry is gone — re-list either way.
        if (result.status === 'dropped' || result.status === 'not-found') {
          refresh();
        } else {
          setData((current) => ({ ...current, error: purgeError(result) }));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setData((current) => ({ ...current, error: message }));
      } finally {
        setDroppingId(null);
      }
    },
    [repoFullName, trimmedBranch, refresh],
  );

  const clear = useCallback(
    async (allLanes?: boolean) => {
      if (!repoFullName || !trimmedBranch) return;
      setClearing(true);
      try {
        const result = await clearRef.current(
          { repoFullName, branch: trimmedBranch },
          { allLanes },
        );
        if (result.status === 'cleared' || result.status === 'noop') {
          refresh();
        } else {
          setData((current) => ({ ...current, error: purgeError(result) }));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setData((current) => ({ ...current, error: message }));
      } finally {
        setClearing(false);
      }
    },
    [repoFullName, trimmedBranch, refresh],
  );

  return {
    checkpoints,
    loading,
    error,
    restoringId,
    canRestore: Boolean(sandboxId),
    refresh,
    restore,
    droppingId,
    clearing,
    drop,
    clear,
  };
}
