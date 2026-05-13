/**
 * useApprovalQueue — FIFO state for the daemon's `approval_required`
 * events. Phase 2.i extraction from the LocalPcChatScreen / RelayChatScreen
 * clones; both screens kept identical copies of this state machinery.
 *
 * Shape:
 *   - State-only. Submission is left to the caller because the daemon
 *     `request` fn lives on the screen's own daemon hook
 *     (`useLocalDaemon` / `useRelayDaemon`) — they have different
 *     return shapes, so we can't fold them in here without a generic.
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
import { useCallback, useEffect, useRef, useState } from 'react';

import type { SessionEvent } from '@/lib/local-daemon-binding';

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

export interface ApprovalQueueHandle {
  /** Wire this into the daemon hook's `onEvent` callback. */
  handleDaemonEvent: (event: SessionEvent) => void;
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
}

export function useApprovalQueue(): ApprovalQueueHandle {
  const [queue, setQueue] = useState<PendingApproval[]>([]);
  const headRef = useRef<PendingApproval[]>([]);
  useEffect(() => {
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

  const handleDaemonEvent = useCallback(
    (event: SessionEvent) => {
      const action = classifyApprovalEvent(event);
      if (action.kind === 'enqueue') enqueue(action.approval);
      else if (action.kind === 'drop') drop(action.approvalId);
    },
    [enqueue, drop],
  );

  return {
    handleDaemonEvent,
    head: queue[0] ?? null,
    queuedBehind: Math.max(0, queue.length - 1),
    headRef,
    popMatching,
  };
}
