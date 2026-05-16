/**
 * daemon-cancel-pending-approvals.test.ts — pins the two-sided
 * cancel-on-abort contract for paired-daemon approvals.
 *
 * Closes the last item on the Hermes #6 follow-up scoreboard (the
 * "approval-pending abort" gap deferred from #576 as a behavior
 * question). The product decision: parent-round abort should
 * (a) fire session-scoped `cancel_run` to the daemon so it resolves
 * the pending approval as denied and aborts the active run, AND
 * (b) pop the entry from the local approval queue synchronously
 * because `cancel_run` does NOT emit `approval_received` and
 * therefore the queue can't auto-clean (Codex P2 / Copilot finding
 * on the initial #579 attempt).
 */
import { describe, expect, it, vi } from 'vitest';

import { cancelPendingApprovals } from './daemon-cancel-pending-approvals';
import type { PendingApproval } from '@/components/daemon/ApprovalPrompt';

function makeApproval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    approvalId: overrides.approvalId ?? 'appr-1',
    sessionId: overrides.sessionId ?? 'sess-1',
    runId: overrides.runId ?? 'run-1',
    kind: overrides.kind ?? 'tool_execution',
    title: overrides.title ?? 'Approve sandbox_write_file',
    summary: overrides.summary ?? '',
    options: overrides.options ?? ['approve', 'deny'],
    receivedAt: overrides.receivedAt ?? 0,
  };
}

describe('cancelPendingApprovals', () => {
  it('fires one session-scoped cancel_run per pending approval (no runId)', () => {
    // The envelope must NOT carry `runId`. The daemon's
    // `handleCancelRun` rejects with `NO_ACTIVE_RUN` when
    // `payload.runId` is supplied but doesn't match
    // `entry.activeRunId`, and for delegations `entry.activeRunId`
    // is the parent run while `approval.runId` is the child run.
    // Omitting `runId` makes the cancel session-scoped: the
    // daemon aborts the active run AND resolves the pending
    // approval as denied. Codex P1 + Copilot review on the
    // initial #579 attempt caught the runId mismatch.
    const request = vi.fn().mockResolvedValue({ ok: true });
    const popMatching = vi.fn();
    const pending = [
      makeApproval({ approvalId: 'a1', sessionId: 'sess-1', runId: 'run-1' }),
      makeApproval({ approvalId: 'a2', sessionId: 'sess-1', runId: 'run-2' }),
    ];

    cancelPendingApprovals(pending, request, popMatching);

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(1, {
      type: 'cancel_run',
      sessionId: 'sess-1',
      payload: { sessionId: 'sess-1' },
      timeoutMs: 5_000,
    });
    expect(request).toHaveBeenNthCalledWith(2, {
      type: 'cancel_run',
      sessionId: 'sess-1',
      payload: { sessionId: 'sess-1' },
      timeoutMs: 5_000,
    });
  });

  it('pops each pending approval from the local queue (cancel_run does not emit approval_received)', () => {
    // The daemon's `cancel_run` handler resolves
    // `entry.pendingApproval` locally and returns a response but
    // does NOT broadcast `approval_received` — that event is only
    // emitted from `submit_approval`. Without an explicit local
    // pop the `ApprovalPrompt` would keep rendering even after a
    // successful daemon cancel. Codex P2 + Copilot review on the
    // initial #579 attempt caught this.
    const request = vi.fn().mockResolvedValue({ ok: true });
    const popMatching = vi.fn();
    const pending = [
      makeApproval({ approvalId: 'a1' }),
      makeApproval({ approvalId: 'a2' }),
      makeApproval({ approvalId: 'a3' }),
    ];

    cancelPendingApprovals(pending, request, popMatching);

    expect(popMatching).toHaveBeenCalledTimes(3);
    expect(popMatching).toHaveBeenNthCalledWith(1, 'a1');
    expect(popMatching).toHaveBeenNthCalledWith(2, 'a2');
    expect(popMatching).toHaveBeenNthCalledWith(3, 'a3');
  });

  it('uses the per-approval sessionId (handles multi-session queues)', () => {
    // Most queues carry approvals from a single session, but the
    // PendingApproval shape supports cross-session in principle
    // (the daemon may route delegations through different child
    // sessions). Pin that we use each approval's own sessionId,
    // not a single shared one.
    const request = vi.fn().mockResolvedValue({ ok: true });
    const popMatching = vi.fn();
    const pending = [makeApproval({ sessionId: 'sess-a' }), makeApproval({ sessionId: 'sess-b' })];

    cancelPendingApprovals(pending, request, popMatching);

    expect(request).toHaveBeenNthCalledWith(1, expect.objectContaining({ sessionId: 'sess-a' }));
    expect(request).toHaveBeenNthCalledWith(2, expect.objectContaining({ sessionId: 'sess-b' }));
  });

  it('no-ops on an empty queue', () => {
    const request = vi.fn().mockResolvedValue({ ok: true });
    const popMatching = vi.fn();
    cancelPendingApprovals([], request, popMatching);
    expect(request).not.toHaveBeenCalled();
    expect(popMatching).not.toHaveBeenCalled();
  });

  it('pops the local queue even when the daemon request fails (user intent is source of truth)', async () => {
    // Realistic shape: the daemon binding has been torn down by
    // the time abort fires, and `request` rejects. The local pop
    // must still happen — the user clicked Stop, the prompt
    // should disappear regardless of whether the daemon
    // acknowledged the cancel.
    const request = vi.fn().mockRejectedValue(new Error('binding closed'));
    const popMatching = vi.fn();
    const pending = [makeApproval({ approvalId: 'a1' })];

    expect(() => cancelPendingApprovals(pending, request, popMatching)).not.toThrow();
    // Pop is synchronous, so it lands immediately.
    expect(popMatching).toHaveBeenCalledTimes(1);
    expect(popMatching).toHaveBeenCalledWith('a1');
    // Let the catch handler run so the test exits cleanly.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not wait on request promises before returning (fire-and-forget)', () => {
    // A pending approval whose request resolves only after a long
    // delay should not block the caller. The helper returns
    // synchronously by design.
    const resolvers: Array<(value: { ok: true }) => void> = [];
    const request = vi.fn().mockImplementation(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const popMatching = vi.fn();
    const pending = [makeApproval()];

    const start = Date.now();
    cancelPendingApprovals(pending, request, popMatching);
    const elapsed = Date.now() - start;

    // Synchronous return — nowhere near the 5s default timeout.
    expect(elapsed).toBeLessThan(50);
    expect(request).toHaveBeenCalledTimes(1);
    // Local pop happens before return, not after the daemon ack.
    expect(popMatching).toHaveBeenCalledTimes(1);
    // Resolve to clean up the dangling promise.
    for (const resolve of resolvers) resolve({ ok: true });
  });
});
