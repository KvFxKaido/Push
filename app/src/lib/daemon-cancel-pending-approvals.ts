/**
 * daemon-cancel-pending-approvals.ts — Two-sided cleanup for pending
 * daemon approvals when the user aborts the parent round.
 *
 * Why this exists: in a paired-daemon session (local-pc / relay), a
 * delegated Coder agent runs on the daemon side. When it hits a tool
 * needing approval, the daemon emits `approval_required` which
 * `useApprovalQueue` enqueues; the ApprovalPrompt renders in the
 * paired client. If the user hits Stop on the parent round at that
 * moment, the web round loop sets `abortRef.current = true` and
 * breaks — but nothing on the abort path tells the daemon to stop
 * waiting, and nothing clears the local queue. The Coder agent stays
 * paused, the local prompt persists, and a confused click would
 * actually execute the tool the user tried to cancel.
 *
 * The cleanup needs BOTH sides addressed and neither side knows about
 * the other:
 *
 *   - **Daemon side:** fire `cancel_run` with `sessionId` only (no
 *     `runId`). The daemon's `handleCancelRun` at `cli/pushd.ts:1619-
 *     1638` rejects with `NO_ACTIVE_RUN` when a provided `runId`
 *     doesn't match `entry.activeRunId`, and for delegations
 *     `entry.activeRunId` is the parent run while
 *     `approval.runId` is the child run emitted by `buildApprovalFn`.
 *     Omitting `runId` makes the cancel session-scoped: the daemon
 *     aborts the active run AND resolves the pending approval as
 *     denied (line 1633-1638). Codex P1 + Copilot review caught the
 *     runId mismatch on the initial #579 attempt.
 *
 *   - **Local side:** `cancel_run` does NOT emit `approval_received`
 *     — that broadcast only fires from `submit_approval`
 *     (`cli/pushd.ts:1536`). So the local `useApprovalQueue` won't
 *     auto-drop the entry the way the original design assumed. The
 *     caller must pop the matched approval from the local queue
 *     itself. Codex P2 + Copilot review caught this on #579.
 *
 * Behavior is fire-and-forget for the daemon request and synchronous
 * for the local pop:
 *
 *   - The daemon dispatcher tolerates `cancel_run` for a session
 *     that no longer has an active run (`NO_ACTIVE_RUN` ack) — that
 *     race is benign.
 *   - A transport failure (binding torn down, WS closed) is
 *     swallowed via `.catch(() => {})`. The daemon's WS-close
 *     cleanup also resolves pending approvals as denied at session
 *     teardown, so a failed dispatch at worst delays the daemon-side
 *     cleanup until that path fires.
 *   - The local pop happens regardless of the daemon's response —
 *     the user's intent is the source of truth for the UI.
 */

import type { PendingApproval } from '@/components/daemon/ApprovalPrompt';
import type { RequestOptions, SessionResponse } from '@/lib/local-daemon-binding';

/**
 * Daemon request fn shape, matching the `request` prop threaded into
 * `DaemonChatBody` and the `LocalDaemonBinding` interface. Generic
 * payload type because callers vary; this helper doesn't care.
 */
export type DaemonRequestFn = <T = unknown>(opts: RequestOptions) => Promise<SessionResponse<T>>;

/**
 * Local-queue pop callback. Matches `useApprovalQueue`'s
 * `popMatching` signature — drops the entry with the given
 * approvalId from the FIFO if present, no-ops otherwise.
 */
export type PopMatchingFn = (approvalId: string) => void;

/**
 * For each pending approval: fire session-scoped `cancel_run` to the
 * daemon and pop the entry from the local queue. Returns immediately
 * — daemon requests are fire-and-forget; local pops are synchronous
 * and unconditional on the daemon's response.
 */
export function cancelPendingApprovals(
  pending: readonly PendingApproval[],
  request: DaemonRequestFn,
  popMatching: PopMatchingFn,
): void {
  for (const approval of pending) {
    // Session-scoped — omit `runId` because the daemon rejects
    // child-run ids against `entry.activeRunId` (parent for
    // delegations). See file-level doc.
    void request({
      type: 'cancel_run',
      sessionId: approval.sessionId,
      payload: { sessionId: approval.sessionId },
      timeoutMs: 5_000,
    }).catch(() => {
      // Intentional swallow — see file-level doc.
    });
    // Local pop is unconditional. `cancel_run` does NOT emit
    // `approval_received`, so without this the ApprovalPrompt
    // would keep rendering even after a successful daemon cancel.
    popMatching(approval.approvalId);
  }
}
