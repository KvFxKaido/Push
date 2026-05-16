/**
 * daemon-cancel-pending-approvals.ts — Fire `cancel_run` to the daemon
 * for every pending approval prompt, so a parent-round abort doesn't
 * leave the daemon's Coder agent paused waiting on a prompt the user
 * has already cancelled.
 *
 * Why this exists: in a paired-daemon session (local-pc / relay), the
 * delegated Coder agent runs on the daemon side. When it hits a tool
 * needing approval, the daemon emits `approval_required` which
 * `useApprovalQueue` enqueues; the ApprovalPrompt renders in the
 * paired client. If the user hits Stop on the parent round at that
 * moment, the web round loop sets `abortRef.current = true` and
 * breaks — but nothing on the abort path tells the daemon to stop
 * waiting on the approval. The Coder agent stays paused, the local
 * prompt persists, and a confused click would actually execute the
 * tool the user tried to cancel.
 *
 * The daemon's `cancel_run` handler (`cli/pushd.ts:1634-1638`)
 * already resolves a session's pending approval as `deny` and aborts
 * the active run, then emits `approval_received` which the
 * `useApprovalQueue` `approval_received` branch consumes to drop the
 * entry from the local queue. So firing `cancel_run` is the single
 * load-bearing call — local cleanup follows the daemon's
 * acknowledgement.
 *
 * Behavior is fire-and-forget per approval:
 *
 *   - The daemon dispatcher tolerates `cancel_run` for a session
 *     that no longer has an active run (`NO_ACTIVE_RUN` ack) — that
 *     race is benign for our purposes.
 *   - A transport failure (binding torn down, WS closed) is
 *     swallowed via `.catch(() => {})`. The daemon's WS-close
 *     cleanup also resolves pending approvals as denied at session
 *     teardown, so a failed dispatch at worst delays cleanup until
 *     the daemon's own path fires.
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
 * Fire `cancel_run` for each pending approval. Returns immediately —
 * the requests fire-and-forget. Errors are swallowed; see file-level
 * doc for the rationale.
 */
export function cancelPendingApprovals(
  pending: readonly PendingApproval[],
  request: DaemonRequestFn,
): void {
  for (const approval of pending) {
    void request({
      type: 'cancel_run',
      sessionId: approval.sessionId,
      payload: { sessionId: approval.sessionId, runId: approval.runId },
      timeoutMs: 5_000,
    }).catch(() => {
      // Intentional swallow — see file-level doc.
    });
  }
}
