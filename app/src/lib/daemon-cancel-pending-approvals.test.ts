/**
 * daemon-cancel-pending-approvals.test.ts — pins the cancel-on-abort
 * contract for paired-daemon approvals.
 *
 * Closes the last item on the Hermes #6 follow-up scoreboard (the
 * "approval-pending abort" gap deferred from #576 as a behavior
 * question). The product decision landed on: parent-round abort
 * should fire `cancel_run` for each pending approval so the daemon
 * resolves them as denied and the local queue auto-cleans via the
 * `approval_received` consumer.
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
  it('fires one cancel_run per pending approval with the right envelope shape', () => {
    const request = vi.fn().mockResolvedValue({ ok: true });
    const pending = [
      makeApproval({ approvalId: 'a1', sessionId: 'sess-1', runId: 'run-1' }),
      makeApproval({ approvalId: 'a2', sessionId: 'sess-1', runId: 'run-2' }),
    ];

    cancelPendingApprovals(pending, request);

    expect(request).toHaveBeenCalledTimes(2);
    // Envelope shape: `sessionId` is both top-level (some
    // dispatchers route on it) and in payload (the daemon's
    // handleCancelRun reads from payload — see cli/pushd.ts:1561).
    expect(request).toHaveBeenNthCalledWith(1, {
      type: 'cancel_run',
      sessionId: 'sess-1',
      payload: { sessionId: 'sess-1', runId: 'run-1' },
      timeoutMs: 5_000,
    });
    expect(request).toHaveBeenNthCalledWith(2, {
      type: 'cancel_run',
      sessionId: 'sess-1',
      payload: { sessionId: 'sess-1', runId: 'run-2' },
      timeoutMs: 5_000,
    });
  });

  it('uses the per-approval sessionId (handles multi-session queues)', () => {
    // Most queues carry approvals from a single session, but the
    // PendingApproval shape supports cross-session in principle
    // (the daemon may route delegations through different child
    // sessions). Pin that we use each approval's own sessionId,
    // not a single shared one.
    const request = vi.fn().mockResolvedValue({ ok: true });
    const pending = [
      makeApproval({ sessionId: 'sess-a', runId: 'run-a' }),
      makeApproval({ sessionId: 'sess-b', runId: 'run-b' }),
    ];

    cancelPendingApprovals(pending, request);

    expect(request).toHaveBeenNthCalledWith(1, expect.objectContaining({ sessionId: 'sess-a' }));
    expect(request).toHaveBeenNthCalledWith(2, expect.objectContaining({ sessionId: 'sess-b' }));
  });

  it('no-ops on an empty queue', () => {
    const request = vi.fn().mockResolvedValue({ ok: true });
    cancelPendingApprovals([], request);
    expect(request).not.toHaveBeenCalled();
  });

  it('swallows transport failures so a stale binding cannot poison the abort', async () => {
    // Realistic shape: the daemon binding has already been torn
    // down by the time abort fires, and `request` rejects. The
    // helper must not propagate the rejection — the caller is
    // about to call `abortStream()` and any throw here would skip
    // that and strand the run.
    const request = vi.fn().mockRejectedValue(new Error('binding closed'));
    const pending = [makeApproval()];

    // The helper returns void; any rejection on the inner promise
    // is consumed by the `.catch()` inside the helper. Wait a
    // microtask tick to let that catch run before we assert.
    expect(() => cancelPendingApprovals(pending, request)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not wait on request promises before returning (fire-and-forget)', () => {
    // A pending approval whose request resolves only after a long
    // delay should not block the caller. The helper is synchronous
    // by design.
    const resolvers: Array<(value: { ok: true }) => void> = [];
    const request = vi.fn().mockImplementation(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const pending = [makeApproval()];

    const start = Date.now();
    cancelPendingApprovals(pending, request);
    const elapsed = Date.now() - start;

    // Synchronous return — nowhere near the 5s default timeout.
    expect(elapsed).toBeLessThan(50);
    expect(request).toHaveBeenCalledTimes(1);
    // Resolve to clean up the dangling promise.
    for (const resolve of resolvers) resolve({ ok: true });
  });
});
