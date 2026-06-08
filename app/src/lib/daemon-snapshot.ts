/**
 * daemon-snapshot.ts — the web consumer's view of the daemon's
 * `get_session_snapshot` packet.
 *
 * A client that attaches to a running daemon session over the relay hydrates the
 * transcript via `get_session_messages`, but the *live state* the event stream
 * already passed before attach — whether the session is mid-run, and any
 * approval it's blocked on — is lost. The snapshot carries that current state so
 * a freshly-attached phone renders the same pane the TUI does (the reference
 * consumer is `hydrateDaemonSnapshot` in `cli/tui.ts`).
 *
 * This module is the parse + map layer only: a defensive `parseSessionSnapshot`
 * (the payload crosses the relay from a daemon that may be a different version)
 * and `snapshotApprovalToPending` so a blocked-on-approval session can install
 * into the same `useApprovalQueue` an `approval_required` event would. The
 * producer lives in the daemon (`cli/pushd.ts#handleGetSessionSnapshot`); this is
 * its web counterpart.
 */

import type { PendingApproval } from '@/components/daemon/ApprovalPrompt';

/** The pending-approval block the daemon includes in a snapshot, when blocked. */
export interface SnapshotPendingApproval {
  approvalId: string;
  runId: string | null;
  kind: string | null;
  title: string | null;
  summary: string | null;
}

/** The subset of the snapshot packet the web consumes. */
export interface DaemonSessionSnapshot {
  session: {
    sessionId: string;
    /** `running` when a foreground run or background delegation/graph is live. */
    state: 'running' | 'idle';
    activeRunId: string | null;
    provider: string | null;
    model: string | null;
  };
  /** Feature-branch the daemon cwd is on, when resolvable. */
  branch: string | null;
  /** Set when the session is blocked awaiting a decision; null otherwise. */
  pendingApproval: SnapshotPendingApproval | null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function parsePendingApproval(value: unknown): SnapshotPendingApproval | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  // approvalId is the load-bearing field — without it the client can't submit a
  // decision, so a malformed block is treated as "no pending approval".
  const approvalId = asString(raw.approvalId);
  if (!approvalId) return null;
  return {
    approvalId,
    runId: asString(raw.runId),
    kind: asString(raw.kind),
    title: asString(raw.title),
    summary: asString(raw.summary),
  };
}

/**
 * Defensively parse a `get_session_snapshot` response payload. Returns null when
 * the packet is missing the session block (an older/garbled daemon) so the
 * caller can skip hydration rather than render from junk.
 */
export function parseSessionSnapshot(payload: unknown): DaemonSessionSnapshot | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload as Record<string, unknown>;
  const session = raw.session;
  if (!session || typeof session !== 'object') return null;
  const s = session as Record<string, unknown>;
  const sessionId = asString(s.sessionId);
  if (!sessionId) return null;

  const repo = (raw.repo && typeof raw.repo === 'object' ? raw.repo : {}) as Record<
    string,
    unknown
  >;

  return {
    session: {
      sessionId,
      state: s.state === 'running' ? 'running' : 'idle',
      activeRunId: asString(s.activeRunId),
      provider: asString(s.provider),
      model: asString(s.model),
    },
    branch: asString(repo.branch),
    pendingApproval: parsePendingApproval(raw.pendingApproval),
  };
}

/**
 * Map a snapshot's pending-approval block to the `PendingApproval` the approval
 * queue renders — the snapshot equivalent of `classifyApprovalEvent`'s enqueue
 * shape. `sessionId` comes from the snapshot's session block (the approval block
 * doesn't repeat it); options default to approve/deny (the only set the daemon
 * offers today). `nowMs` is injectable for deterministic tests.
 */
export function snapshotApprovalToPending(
  approval: SnapshotPendingApproval | null,
  sessionId: string,
  nowMs: number = Date.now(),
): PendingApproval | null {
  if (!approval) return null;
  return {
    approvalId: approval.approvalId,
    sessionId,
    ...(approval.runId ? { runId: approval.runId } : {}),
    kind: approval.kind ?? 'tool_execution',
    title: approval.title ?? 'Approval required',
    summary: approval.summary ?? '',
    options: ['approve', 'deny'],
    receivedAt: nowMs,
  };
}
