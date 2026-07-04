/**
 * useDaemonRunState — tracks the daemon's live foreground run, whether this
 * client *reattached to* it or *started* it, so the relay surface can show a
 * busy indicator + a remote Stop.
 *
 * When a phone attaches to a session the TUI is mid-turn on, the web's own
 * `isStreaming` is false (it didn't start the turn), so nothing signals "busy"
 * and there's no way to cancel it. The `get_session_snapshot` packet carries the
 * live run state; this hook hydrates it into a `reattachedRun` the
 * `DaemonChatBody` renders as "Running…" + a Stop that fires a session-scoped
 * `cancel_run`. Mirrors the TUI's snapshot path (`hydrateDaemonSnapshot` sets
 * the run state + remembers the run id so Ctrl+C can cancel a reattached run).
 *
 * The same field also covers a run *this* client just started by dispatching
 * `send_user_message` to the daemon instead of generating locally (see
 * `useDaemonMessageDispatch`): the daemon runs the turn server-side either
 * way, so watching it is identical regardless of who dispatched it —
 * `startRun` is the entry point for that case, `hydrateSnapshotRunState` for
 * the reattach case. `useRemoteTurnProjection` doesn't care which populated it.
 *
 * Scope: the **foreground** run only (`state: running` with an `activeRunId`).
 * A session that's "running" purely from background delegation/task-graph work
 * (`activeRunId` null) is intentionally not surfaced here — its terminal signal
 * is `task_graph.*`, not `run_complete`, so tracking it without that wiring
 * would risk a stale indicator. State-only, like `useApprovalQueue`; the
 * submit/cancel lives on the screen that owns the daemon `request` fn.
 */
import { useCallback, useState } from 'react';

import type { SessionEvent } from '@/lib/local-daemon-binding';
import type { DaemonSessionSnapshot } from '@/lib/daemon-snapshot';

export interface ReattachedRun {
  /** The daemon's foreground run id, for display/observability. */
  runId: string;
  /** Session the run belongs to — the cancel target. */
  sessionId: string;
}

/**
 * The foreground run a snapshot says is live, or null. Non-null only when the
 * session is running AND has a top-level `activeRunId` (see scope note above).
 * Pure + exported for testing.
 */
export function reattachedRunFromSnapshot(
  snapshot: DaemonSessionSnapshot | null,
): ReattachedRun | null {
  if (!snapshot) return null;
  const { state, activeRunId, sessionId } = snapshot.session;
  if (state !== 'running' || !activeRunId) return null;
  return { runId: activeRunId, sessionId };
}

function sameRun(a: ReattachedRun | null, b: ReattachedRun | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.runId === b.runId && a.sessionId === b.sessionId;
}

export interface DaemonRunStateHandle {
  /** The reattached foreground run, or null when none / not running. */
  reattachedRun: ReattachedRun | null;
  /** Wire into the daemon hook's `onEvent`: a `run_complete` clears the run. */
  handleDaemonEvent: (event: SessionEvent) => void;
  /** Prime the run from a `get_session_snapshot` on attach. */
  hydrateSnapshotRunState: (snapshot: DaemonSessionSnapshot | null) => void;
  /** Track a run this client just started via `send_user_message` (the
   *  `runId` from its ack), so it renders the same "Running…" + Stop UI a
   *  reattached run gets. */
  startRun: (runId: string, sessionId: string) => void;
  /** Clear it (the local user took over the turn, or hit Stop). Idempotent. */
  clear: () => void;
}

export function useDaemonRunState(): DaemonRunStateHandle {
  const [reattachedRun, setReattachedRun] = useState<ReattachedRun | null>(null);

  const handleDaemonEvent = useCallback((event: SessionEvent) => {
    // The foreground run finished on the daemon — drop the indicator. There's
    // one foreground run per session, so any run_complete clears it.
    if (event.type === 'run_complete') {
      setReattachedRun((prev) => (prev ? null : prev));
    }
  }, []);

  const hydrateSnapshotRunState = useCallback((snapshot: DaemonSessionSnapshot | null) => {
    const next = reattachedRunFromSnapshot(snapshot);
    setReattachedRun((prev) => (sameRun(prev, next) ? prev : next));
  }, []);

  const startRun = useCallback((runId: string, sessionId: string) => {
    setReattachedRun((prev) => (sameRun(prev, { runId, sessionId }) ? prev : { runId, sessionId }));
  }, []);

  const clear = useCallback(() => {
    setReattachedRun((prev) => (prev ? null : prev));
  }, []);

  return { reattachedRun, handleDaemonEvent, hydrateSnapshotRunState, startRun, clear };
}
