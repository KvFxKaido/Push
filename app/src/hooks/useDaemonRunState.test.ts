import { describe, expect, it } from 'vitest';
import type { DaemonSessionSnapshot } from '@/lib/daemon-snapshot';
import { reattachedRunFromSnapshot } from './useDaemonRunState';

function snapshot(
  session: Partial<DaemonSessionSnapshot['session']> &
    Pick<DaemonSessionSnapshot['session'], 'sessionId'>,
): DaemonSessionSnapshot {
  return {
    session: {
      state: 'idle',
      activeRunId: null,
      provider: null,
      model: null,
      ...session,
    },
    branch: null,
    pendingApproval: null,
  };
}

describe('reattachedRunFromSnapshot', () => {
  it('returns the foreground run when running with an activeRunId', () => {
    expect(
      reattachedRunFromSnapshot(
        snapshot({ sessionId: 'sess_1', state: 'running', activeRunId: 'run_9' }),
      ),
    ).toEqual({ runId: 'run_9', sessionId: 'sess_1' });
  });

  it('returns null when the session is idle', () => {
    expect(
      reattachedRunFromSnapshot(snapshot({ sessionId: 'sess_1', activeRunId: 'run_9' })),
    ).toBeNull();
  });

  it('returns null when running but there is no foreground run (background-only)', () => {
    // Running purely from background delegation/graph work — out of scope here.
    expect(
      reattachedRunFromSnapshot(
        snapshot({ sessionId: 'sess_1', state: 'running', activeRunId: null }),
      ),
    ).toBeNull();
  });

  it('returns null for a null snapshot', () => {
    expect(reattachedRunFromSnapshot(null)).toBeNull();
  });
});
