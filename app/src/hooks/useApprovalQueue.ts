/**
 * useApprovalQueue — FIFO state for the daemon's `approval_required` events.
 *
 * Shape:
 *   - State-only. Submission is left to the caller because the daemon
 *     `request` fn lives on the screen's own daemon hook, so we can't fold it
 *     in here without a generic.
 *   - `handleDaemonEvent` is the callback the screen wires into the
 *     daemon hook's `onEvent`. It translates `approval_required` →
 *     enqueue and `approval_received` → drop, defending against the
 *     "daemon broadcasts to every attached client" case where multiple
 *     surfaces see the same id.
 *   - `headRef` mirrors `head` synchronously so a `decideApproval`
 *     callback on the screen can read the head WITHOUT relying on a
 *     stale closure — keeps the submit-side off the setState updater
 *     so React's concurrent / StrictMode contract isn't broken.
 *   - `popMatching(approvalId)` lets the caller drop a specific entry
 *     after it has dispatched the submission. The match-by-id guard
 *     defends against the race where a new approval arrives between
 *     the user's click and the updater running.
 *
 * Dedupe-by-id on enqueue: the daemon emits `approval_required` once
 * per pending approval, but if the long-lived WS reconnects mid-prompt
 * the event log can replay the same id. Without the dedupe the user
 * sees duplicate prompts.
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react';

import type { SessionEvent } from '@/lib/local-daemon-binding';
import { snapshotApprovalToPending, type SnapshotPendingApproval } from '@/lib/daemon-snapshot';

import type { PendingApproval } from '@/components/daemon/ApprovalPrompt';

/**
 * What action a daemon event should drive on the approval queue.
 * Extracted as a pure function so the event-shape parsing has a
 * trivially-testable surface; the hook just dispatches the action
 * to its state.
 */
export type ApprovalQueueAction =
  | { kind: 'enqueue'; approval: PendingApproval }
  | { kind: 'drop'; approvalId: string }
  | { kind: 'noop' };

export function classifyApprovalEvent(event: SessionEvent): ApprovalQueueAction {
  if (event.type === 'approval_required') {
    const payload = event.payload as
      | {
          approvalId?: unknown;
          kind?: unknown;
          title?: unknown;
          summary?: unknown;
          options?: unknown;
        }
      | undefined;
    if (!payload || typeof payload.approvalId !== 'string') return { kind: 'noop' };
    return {
      kind: 'enqueue',
      approval: {
        approvalId: payload.approvalId,
        sessionId: event.sessionId,
        runId: event.runId,
        kind: typeof payload.kind === 'string' ? payload.kind : 'tool_execution',
        title: typeof payload.title === 'string' ? payload.title : 'Approval required',
        summary: typeof payload.summary === 'string' ? payload.summary : '',
        options:
          Array.isArray(payload.options) && payload.options.every((o) => typeof o === 'string')
            ? (payload.options as string[])
            : ['approve', 'deny'],
        receivedAt: Date.now(),
      },
    };
  }
  if (event.type === 'approval_received') {
    const payload = event.payload as { approvalId?: unknown } | undefined;
    if (payload && typeof payload.approvalId === 'string') {
      return { kind: 'drop', approvalId: payload.approvalId };
    }
  }
  return { kind: 'noop' };
}

/**
 * Reconcile the queue with a session's authoritative approval state from a
 * `get_session_snapshot`. The snapshot is the source of truth for `sessionId` at
 * attach time: keep other sessions' entries, ensure the snapshot's approval is
 * present (if any), and drop a now-stale approval for this session — the case a
 * reattaching client hits when it missed the `approval_received` while
 * disconnected, where append-only hydration would leave a resolved prompt
 * showing (or wedge a new approval behind it). Order-preserving and ref-stable
 * when nothing changed (so it never forces a spurious render). Mirrors the TUI's
 * snapshot path, which closes the pane when the snapshot has no approval.
 */
export function reconcileApprovalQueue(
  prev: PendingApproval[],
  desired: PendingApproval | null,
  sessionId: string,
): PendingApproval[] {
  // Drop this session's stale approvals (anything not matching the snapshot);
  // leave other sessions untouched.
  const filtered = prev.filter(
    (p) => p.sessionId !== sessionId || (desired !== null && p.approvalId === desired.approvalId),
  );
  const hasDesired = desired !== null && filtered.some((p) => p.approvalId === desired.approvalId);
  const next = desired !== null && !hasDesired ? [...filtered, desired] : filtered;
  if (next.length === prev.length && next.every((p, i) => p === prev[i])) return prev;
  return next;
}

export interface ApprovalQueueHandle {
  /** Wire this into the daemon hook's `onEvent` callback. */
  handleDaemonEvent: (event: SessionEvent) => void;
  /**
   * Reconcile the queue with a `get_session_snapshot` for `sessionId`. Installs
   * an approval the session was blocked on before this client attached (the
   * `approval_required` event it missed), and drops a now-stale one the snapshot
   * says is gone. No-op when nothing changed. See `reconcileApprovalQueue`.
   */
  hydrateSnapshotApproval: (approval: SnapshotPendingApproval | null, sessionId: string) => void;
  /** Head of the queue, null when empty. The ApprovalPrompt renders this. */
  head: PendingApproval | null;
  /** Count behind the head — surfaced as the "N more waiting" counter. */
  queuedBehind: number;
  /** Synchronous mirror of the queue so decision callbacks read a fresh head. */
  headRef: React.MutableRefObject<PendingApproval[]>;
  /**
   * Drop the entry with this id IF AND ONLY IF it's still the head.
   * The match-by-id guard defends against the race where a new
   * approval arrives between the user's click and this updater
   * running.
   */
  popMatching: (approvalId: string) => void;
  /**
   * Drop every queued approval. Used when the bound session is no longer valid
   * (target change / attach failure) so a prompt from the old session can't
   * linger — and be approved — on the new one. Idempotent / ref-stable.
   */
  clear: () => void;
}

export function useApprovalQueue(): ApprovalQueueHandle {
  const [queue, setQueue] = useState<PendingApproval[]>([]);
  // Mirror the queue into a ref via `useLayoutEffect`, not the
  // standard `useEffect`. Layout effects run synchronously after
  // commit but BEFORE the browser paints — meaning the user can't
  // see the rendered prompt and click on it before the ref has
  // been updated. With `useEffect`, the ref update is scheduled in
  // a later task: a click landing between commit/paint and the
  // effect would dispatch against a stale head. PR #533 Copilot.
  const headRef = useRef<PendingApproval[]>([]);
  useLayoutEffect(() => {
    headRef.current = queue;
  }, [queue]);

  const enqueue = useCallback((approval: PendingApproval) => {
    setQueue((prev) =>
      prev.some((p) => p.approvalId === approval.approvalId) ? prev : [...prev, approval],
    );
  }, []);

  const drop = useCallback((approvalId: string) => {
    setQueue((prev) => prev.filter((p) => p.approvalId !== approvalId));
  }, []);

  const popMatching = useCallback((approvalId: string) => {
    setQueue((prev) => (prev[0]?.approvalId === approvalId ? prev.slice(1) : prev));
  }, []);

  const clear = useCallback(() => {
    setQueue((prev) => (prev.length === 0 ? prev : []));
  }, []);

  const handleDaemonEvent = useCallback(
    (event: SessionEvent) => {
      const action = classifyApprovalEvent(event);
      if (action.kind === 'enqueue') enqueue(action.approval);
      else if (action.kind === 'drop') drop(action.approvalId);
    },
    [enqueue, drop],
  );

  const hydrateSnapshotApproval = useCallback(
    (approval: SnapshotPendingApproval | null, sessionId: string) => {
      const desired = snapshotApprovalToPending(approval, sessionId);
      setQueue((prev) => reconcileApprovalQueue(prev, desired, sessionId));
    },
    [],
  );

  return {
    handleDaemonEvent,
    hydrateSnapshotApproval,
    head: queue[0] ?? null,
    queuedBehind: Math.max(0, queue.length - 1),
    headRef,
    popMatching,
    clear,
  };
}
