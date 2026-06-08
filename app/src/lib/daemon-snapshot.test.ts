import { describe, expect, it } from 'vitest';
import {
  parseSessionSnapshot,
  snapshotApprovalToPending,
  type SnapshotPendingApproval,
} from './daemon-snapshot';

// A representative get_session_snapshot payload (subset the web consumes), shaped
// like cli/pushd.ts#handleGetSessionSnapshot produces.
function snapshotPayload(overrides: Record<string, unknown> = {}) {
  return {
    host: { hostname: 'box', daemonVersion: '1', protocolVersion: '2' },
    repo: { rootPath: '/x', branch: 'feat/foo' },
    session: {
      sessionId: 'sess_1',
      state: 'running',
      activeRunId: 'run_9',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    },
    activeRun: { runId: 'run_9', type: 'assistant_turn', cancellable: true },
    pendingApproval: null,
    transcript: { lastSeq: 4, recentEvents: [] },
    ...overrides,
  };
}

describe('parseSessionSnapshot', () => {
  it('parses the consumed fields from a full packet', () => {
    expect(parseSessionSnapshot(snapshotPayload())).toEqual({
      session: {
        sessionId: 'sess_1',
        state: 'running',
        activeRunId: 'run_9',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
      },
      branch: 'feat/foo',
      pendingApproval: null,
    });
  });

  it('treats an unknown state as idle and missing fields as null', () => {
    const parsed = parseSessionSnapshot({
      session: { sessionId: 'sess_2', state: 'wat' },
    });
    expect(parsed).toEqual({
      session: {
        sessionId: 'sess_2',
        state: 'idle',
        activeRunId: null,
        provider: null,
        model: null,
      },
      branch: null,
      pendingApproval: null,
    });
  });

  it('parses a pending approval block', () => {
    const parsed = parseSessionSnapshot(
      snapshotPayload({
        pendingApproval: {
          approvalId: 'apr_1',
          runId: 'run_9',
          kind: 'sandbox_exec',
          title: 'Run command',
          summary: 'rm -rf /tmp/x',
        },
      }),
    );
    expect(parsed?.pendingApproval).toEqual({
      approvalId: 'apr_1',
      runId: 'run_9',
      kind: 'sandbox_exec',
      title: 'Run command',
      summary: 'rm -rf /tmp/x',
    });
  });

  it('drops a pending approval with no approvalId (unusable)', () => {
    const parsed = parseSessionSnapshot(
      snapshotPayload({ pendingApproval: { runId: 'run_9', title: 'x' } }),
    );
    expect(parsed?.pendingApproval).toBeNull();
  });

  it('returns null for a packet missing the session block', () => {
    expect(parseSessionSnapshot({ repo: { branch: 'x' } })).toBeNull();
    expect(parseSessionSnapshot(null)).toBeNull();
    expect(parseSessionSnapshot('nope')).toBeNull();
  });
});

describe('snapshotApprovalToPending', () => {
  const approval: SnapshotPendingApproval = {
    approvalId: 'apr_1',
    runId: 'run_9',
    kind: 'sandbox_exec',
    title: 'Run command',
    summary: 'echo hi',
  };

  it('maps to a PendingApproval with the snapshot session id', () => {
    expect(snapshotApprovalToPending(approval, 'sess_1', 1000)).toEqual({
      approvalId: 'apr_1',
      sessionId: 'sess_1',
      runId: 'run_9',
      kind: 'sandbox_exec',
      title: 'Run command',
      summary: 'echo hi',
      options: ['approve', 'deny'],
      receivedAt: 1000,
    });
  });

  it('defaults kind/title/summary when the daemon omitted them', () => {
    const mapped = snapshotApprovalToPending(
      { approvalId: 'apr_2', runId: null, kind: null, title: null, summary: null },
      'sess_1',
      1000,
    );
    expect(mapped).toMatchObject({
      approvalId: 'apr_2',
      kind: 'tool_execution',
      title: 'Approval required',
      summary: '',
      options: ['approve', 'deny'],
    });
    // runId is omitted (optional) rather than set to null.
    expect(mapped && 'runId' in mapped).toBe(false);
  });

  it('returns null when there is no pending approval', () => {
    expect(snapshotApprovalToPending(null, 'sess_1')).toBeNull();
  });
});
