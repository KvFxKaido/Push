/**
 * useApprovalQueue.test.ts — pure-helper coverage for the daemon
 * approval-event classifier. Mirrors the project's hook-testing
 * convention (test exported pure functions; the React state plumbing
 * is exercised at integration time via the screens that mount the
 * hook). The classifier is the fragile part — it converts the
 * daemon's loosely-typed event payloads into queue actions, so a
 * payload-shape change on the daemon side would surface here.
 */
import { describe, expect, it } from 'vitest';

import type { SessionEvent } from '@/lib/local-daemon-binding';

import { classifyApprovalEvent } from './useApprovalQueue';

function makeEvent(overrides: Partial<SessionEvent> & Pick<SessionEvent, 'type'>): SessionEvent {
  return {
    v: 'push.runtime.v1',
    kind: 'event',
    sessionId: 'sess_test',
    seq: 0,
    ts: 1,
    type: overrides.type,
    payload: overrides.payload ?? {},
    runId: overrides.runId,
  } as SessionEvent;
}

describe('classifyApprovalEvent', () => {
  it('turns a well-formed approval_required event into an enqueue action', () => {
    const action = classifyApprovalEvent(
      makeEvent({
        type: 'approval_required',
        runId: 'run_x',
        payload: {
          approvalId: 'apv_1',
          kind: 'sandbox_exec',
          title: 'Approve sandbox_exec',
          summary: 'rm -rf /tmp/scratch',
          options: ['approve', 'deny'],
        },
      }),
    );
    expect(action.kind).toBe('enqueue');
    if (action.kind !== 'enqueue') throw new Error('unreachable');
    expect(action.approval.approvalId).toBe('apv_1');
    expect(action.approval.sessionId).toBe('sess_test');
    expect(action.approval.runId).toBe('run_x');
    expect(action.approval.kind).toBe('sandbox_exec');
    expect(action.approval.title).toBe('Approve sandbox_exec');
    expect(action.approval.summary).toBe('rm -rf /tmp/scratch');
    expect(action.approval.options).toEqual(['approve', 'deny']);
    expect(typeof action.approval.receivedAt).toBe('number');
  });

  it('defaults missing fields gracefully (mixed-version daemon)', () => {
    // A pre-slice-4 daemon might emit an approval_required with just
    // the id. Don't drop the event — present sensible defaults so the
    // user sees a generic prompt rather than silently missing the
    // approval gate.
    const action = classifyApprovalEvent(
      makeEvent({
        type: 'approval_required',
        payload: { approvalId: 'apv_minimal' },
      }),
    );
    expect(action.kind).toBe('enqueue');
    if (action.kind !== 'enqueue') throw new Error('unreachable');
    expect(action.approval.kind).toBe('tool_execution');
    expect(action.approval.title).toBe('Approval required');
    expect(action.approval.summary).toBe('');
    expect(action.approval.options).toEqual(['approve', 'deny']);
  });

  it('returns noop for approval_required with no approvalId', () => {
    const action = classifyApprovalEvent(
      makeEvent({
        type: 'approval_required',
        payload: { kind: 'sandbox_exec' },
      }),
    );
    expect(action.kind).toBe('noop');
  });

  it('turns approval_received into a drop action keyed by approvalId', () => {
    const action = classifyApprovalEvent(
      makeEvent({
        type: 'approval_received',
        payload: { approvalId: 'apv_done' },
      }),
    );
    expect(action.kind).toBe('drop');
    if (action.kind !== 'drop') throw new Error('unreachable');
    expect(action.approvalId).toBe('apv_done');
  });

  it('returns noop for approval_received without an approvalId', () => {
    const action = classifyApprovalEvent(makeEvent({ type: 'approval_received', payload: {} }));
    expect(action.kind).toBe('noop');
  });

  it('returns noop for unrelated event types (does not poison the queue)', () => {
    const action = classifyApprovalEvent(
      makeEvent({
        type: 'agent_chunk',
        payload: { text: 'hello' },
      }),
    );
    expect(action.kind).toBe('noop');
  });

  it('rejects malformed options arrays and falls back to approve/deny', () => {
    const action = classifyApprovalEvent(
      makeEvent({
        type: 'approval_required',
        payload: {
          approvalId: 'apv_bad_opts',
          options: ['approve', 42, null], // non-string entries — drop the whole array
        },
      }),
    );
    expect(action.kind).toBe('enqueue');
    if (action.kind !== 'enqueue') throw new Error('unreachable');
    expect(action.approval.options).toEqual(['approve', 'deny']);
  });
});
