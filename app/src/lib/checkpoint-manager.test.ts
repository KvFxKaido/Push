import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunCheckpoint } from '@/types';

const mockClearCheckpoint = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
const mockLoadCheckpoint = vi
  .fn<(chatId: string) => Promise<RunCheckpoint | null>>()
  .mockResolvedValue(null);
const mockSaveCheckpoint = vi
  .fn<(checkpoint: RunCheckpoint) => Promise<void>>()
  .mockResolvedValue(undefined);
const mockClearCheckpointV1 = vi
  .fn<(chatId: string) => Promise<void>>()
  .mockResolvedValue(undefined);

vi.mock('./checkpoint-store', () => ({
  clearCheckpoint: (...args: unknown[]) => mockClearCheckpoint(...(args as [string])),
  loadCheckpoint: (...args: unknown[]) => mockLoadCheckpoint(...(args as [string])),
  saveCheckpoint: (...args: unknown[]) => mockSaveCheckpoint(...(args as [RunCheckpoint])),
  clearCheckpointV1: (...args: unknown[]) => mockClearCheckpointV1(...(args as [string])),
}));

let fakeLocalStorage: Record<string, string> = {};
let fakeSessionStorage: Record<string, string> = {};
const RUN_BROWSER_TAB_ID_KEY = 'run_browser_tab_id';
const RUN_RELOAD_MARKER_KEY = 'run_tab_reload_marker';

vi.mock('./safe-storage', () => ({
  safeStorageGet: (key: string, area: 'local' | 'session' = 'local') =>
    (area === 'session' ? fakeSessionStorage : fakeLocalStorage)[key] ?? null,
  safeStorageRemove: (key: string, area: 'local' | 'session' = 'local') => {
    const target = area === 'session' ? fakeSessionStorage : fakeLocalStorage;
    delete target[key];
    return true;
  },
  safeStorageSet: (key: string, value: string, area: 'local' | 'session' = 'local') => {
    const target = area === 'session' ? fakeSessionStorage : fakeLocalStorage;
    target[key] = value;
    return true;
  },
}));

const {
  acquireRunTabLock,
  __resetRunTabLockStateForTesting,
  buildCheckpointReconciliationMessage,
  buildRunCheckpoint,
  checkpointRequiresLiveSandboxStatus,
  detectInterruptedRun,
  heartbeatRunTabLock,
  releaseRunTabLock,
  saveRunCheckpoint,
} = await import('./checkpoint-manager');

function makeCheckpoint(overrides: Partial<RunCheckpoint> = {}): RunCheckpoint {
  return {
    chatId: 'chat-1',
    round: 2,
    phase: 'streaming_llm',
    baseMessageCount: 1,
    deltaMessages: [{ role: 'assistant', content: 'partial response' }],
    accumulated: 'partial response',
    thinkingAccumulated: '',
    coderDelegationActive: false,
    lastCoderState: null,
    savedAt: Date.now() - 1_000,
    provider: 'openrouter',
    model: 'claude-sonnet-4.6:nitro',
    sandboxSessionId: 'sandbox-1',
    activeBranch: 'feature/checkpoint-manager',
    repoId: 'owner/repo',
    workspaceSessionId: 'workspace-1',
    ...overrides,
  };
}

beforeEach(() => {
  fakeLocalStorage = {};
  fakeSessionStorage = {};
  __resetRunTabLockStateForTesting();
  mockClearCheckpoint.mockReset().mockResolvedValue(undefined);
  mockLoadCheckpoint.mockReset().mockResolvedValue(null);
  mockSaveCheckpoint.mockReset().mockResolvedValue(undefined);
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-17T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('checkpoint-manager', () => {
  it('builds a checkpoint snapshot from api messages and coder state', () => {
    const checkpoint = buildRunCheckpoint({
      chatId: 'chat-1',
      round: 4,
      phase: 'delegating_coder',
      baseMessageCount: 1,
      apiMessages: [
        { role: 'user', content: 'Fix the bug' },
        { role: 'assistant', content: 'Working on it' },
        { role: 'assistant', content: '{"ok":true}' },
      ],
      accumulated: 'Working on it',
      thinkingAccumulated: 'Need to inspect useChat.ts',
      lastCoderState: {
        plan: 'Finish extraction',
        openTasks: ['Write tests'],
        filesTouched: ['app/src/lib/checkpoint-manager.ts'],
        assumptions: ['Checkpoint store stays unchanged'],
        errorsEncountered: [],
      },
      provider: 'openrouter',
      model: 'claude-sonnet-4.6:nitro',
      sandboxSessionId: 'sandbox-1',
      activeBranch: 'feature/checkpoint-manager',
      repoId: 'owner/repo',
      workspaceSessionId: 'workspace-1',
      userAborted: false,
    });

    expect(checkpoint.deltaMessages).toEqual([
      { role: 'assistant', content: 'Working on it' },
      { role: 'assistant', content: '{"ok":true}' },
    ]);
    expect(checkpoint.coderDelegationActive).toBe(true);
    expect(checkpoint.lastCoderState).toContain('Finish extraction');
    expect(checkpoint.workspaceSessionId).toBe('workspace-1');
  });

  it('trims oversized deltas before saving', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const checkpoint = makeCheckpoint({
      deltaMessages: [
        { role: 'assistant', content: `a:${'x'.repeat(20_000)}` },
        { role: 'tool', content: `b:${'y'.repeat(20_000)}` },
        { role: 'assistant', content: `c:${'z'.repeat(20_000)}` },
        { role: 'tool', content: `d:${'q'.repeat(20_000)}` },
      ],
    });

    saveRunCheckpoint(checkpoint);

    expect(mockSaveCheckpoint).toHaveBeenCalledTimes(1);
    const saved = mockSaveCheckpoint.mock.calls[0][0];
    expect(saved.deltaMessages.length).toBeLessThan(checkpoint.deltaMessages.length);
    expect(saved.deltaMessages.at(-1)?.content.startsWith('d:')).toBe(true);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('clears stale checkpoints during interrupted-run detection', async () => {
    mockLoadCheckpoint.mockResolvedValue(makeCheckpoint({ savedAt: Date.now() - 26 * 60 * 1_000 }));

    const result = await detectInterruptedRun(
      'chat-1',
      'sandbox-1',
      'feature/checkpoint-manager',
      'owner/repo',
      'workspace-1',
    );

    expect(result).toBeNull();
    expect(mockClearCheckpoint).toHaveBeenCalledWith('chat-1');
  });

  it('returns matching checkpoints without clearing them', async () => {
    const checkpoint = makeCheckpoint();
    mockLoadCheckpoint.mockResolvedValue(checkpoint);

    const result = await detectInterruptedRun(
      'chat-1',
      'sandbox-1',
      'feature/checkpoint-manager',
      'owner/repo',
      'workspace-1',
    );

    expect(result).toEqual(checkpoint);
    expect(mockClearCheckpoint).not.toHaveBeenCalled();
  });

  it('keeps expiry checkpoints when the old sandbox id no longer exists', async () => {
    const checkpoint = makeCheckpoint({
      reason: 'expiry',
      savedDiff: 'diff --git a/file.ts b/file.ts',
      sandboxSessionId: 'expired-sandbox',
    });
    mockLoadCheckpoint.mockResolvedValue(checkpoint);

    const result = await detectInterruptedRun(
      'chat-1',
      'fresh-sandbox',
      'feature/checkpoint-manager',
      'owner/repo',
      'workspace-1',
    );

    expect(result).toEqual(checkpoint);
    expect(mockClearCheckpoint).not.toHaveBeenCalled();
  });

  it('treats only non-expiry checkpoints as requiring live sandbox status', () => {
    expect(checkpointRequiresLiveSandboxStatus(makeCheckpoint())).toBe(true);
    expect(checkpointRequiresLiveSandboxStatus(makeCheckpoint({ reason: 'expiry' }))).toBe(false);
  });

  it('builds coder-specific reconciliation guidance', () => {
    const content = buildCheckpointReconciliationMessage(
      makeCheckpoint({
        phase: 'delegating_coder',
        round: 7,
        lastCoderState: '{"plan":"Finish the checkpoint extraction"}',
      }),
      {
        head: 'abc1234',
        dirtyFiles: ['app/src/hooks/useChat.ts'],
        diffStat: '1 file changed, 12 insertions(+), 4 deletions(-)',
        changedFiles: ['app/src/hooks/useChat.ts'],
      },
    );

    expect(content).toContain('[SESSION_RESUMED]');
    expect(content).toContain('HEAD: abc1234');
    expect(content).toContain('Last known Coder state');
    expect(content).toContain('Do not repeat work that is already reflected in the sandbox.');
  });

  it('builds expiry reconciliation guidance from the saved diff without live sandbox state', () => {
    const content = buildCheckpointReconciliationMessage(
      makeCheckpoint({
        reason: 'expiry',
        savedDiff: 'diff --git a/app.ts b/app.ts\n+console.log("hi")',
      }),
      {
        head: 'ignored',
        dirtyFiles: ['ignored.ts'],
        diffStat: 'ignored',
        changedFiles: ['ignored.ts'],
      },
    );

    expect(content).toContain('Prior sandbox expired');
    expect(content).toContain('diff --git a/app.ts b/app.ts');
    expect(content).not.toContain('HEAD: ignored');
  });

  it('builds sandbox-loss reconciliation guidance without live sandbox state', () => {
    const content = buildCheckpointReconciliationMessage(
      makeCheckpoint(),
      {
        head: 'ignored',
        dirtyFiles: ['ignored.ts'],
        diffStat: 'ignored',
        changedFiles: ['ignored.ts'],
      },
      { sandboxLost: true },
    );

    expect(content).toContain('Prior sandbox was lost mid-run');
    expect(content).toContain('any uncommitted changes are gone');
    expect(content).not.toContain('HEAD: ignored');
  });

  it('includes the saved diff in sandbox-loss reconciliation when one was captured', () => {
    const content = buildCheckpointReconciliationMessage(
      makeCheckpoint({ savedDiff: 'diff --git a/app.ts b/app.ts\n+console.log("hi")' }),
      { head: 'unknown', dirtyFiles: [], diffStat: '', changedFiles: [] },
      { sandboxLost: true },
    );

    expect(content).toContain('Prior sandbox was lost mid-run');
    expect(content).toContain('Uncommitted changes at the last checkpoint');
    expect(content).toContain('diff --git a/app.ts b/app.ts');
  });

  it('on native recovery, makes re-apply conditional on the tree and keeps the diff as reference', () => {
    const content = buildCheckpointReconciliationMessage(
      makeCheckpoint({ savedDiff: 'diff --git a/app.ts b/app.ts\n+console.log("hi")' }),
      { head: 'unknown', dirtyFiles: [], diffStat: '', changedFiles: [] },
      { sandboxLost: true, localCheckpointRecovery: true },
    );

    expect(content).toContain('[SESSION_RESUMED]');
    expect(content).toContain('on-device checkpoint');
    // The model must inspect the actual tree before deciding.
    expect(content).toContain('git status');
    // The cloud-era UNCONDITIONAL "re-apply these changes" instruction is gone...
    expect(content).not.toContain('Re-apply these changes to continue');
    // ...but the diff is kept as a labeled reference (never dropped → no work loss
    // when there is no on-device checkpoint), gated on a clean clone.
    expect(content).toContain('For reference only');
    expect(content).toContain('diff --git a/app.ts b/app.ts');
    expect(content).toContain('never re-apply changes already in the tree');
  });

  it('on native recovery without a saved diff, still defers to the on-device checkpoint', () => {
    const content = buildCheckpointReconciliationMessage(
      makeCheckpoint(),
      { head: 'unknown', dirtyFiles: [], diffStat: '', changedFiles: [] },
      { sandboxLost: true, localCheckpointRecovery: true },
    );

    expect(content).toContain('on-device checkpoint');
    // No diff was captured → no reference block, and the cloud-era "no diff snapshot
    // → work is gone" framing must NOT appear (the on-device checkpoint holds WIP).
    expect(content).not.toContain('For reference only');
    expect(content).not.toContain('any uncommitted changes are gone');
  });

  it('acquires, heartbeats, and releases a tab lock', () => {
    const tabId = acquireRunTabLock('chat-1');

    expect(tabId).toBeTruthy();
    expect(acquireRunTabLock('chat-1')).toBeNull();

    const key = 'run_active_chat-1';
    const beforeHeartbeat = JSON.parse(fakeLocalStorage[key]).heartbeat as number;

    vi.advanceTimersByTime(15_000);
    heartbeatRunTabLock('chat-1', tabId);

    const afterHeartbeat = JSON.parse(fakeLocalStorage[key]).heartbeat as number;
    expect(afterHeartbeat).toBeGreaterThan(beforeHeartbeat);

    releaseRunTabLock('chat-1', tabId);
    expect(fakeLocalStorage[key]).toBeUndefined();
  });

  it('takes over stale tab locks', () => {
    fakeLocalStorage['run_active_chat-1'] = JSON.stringify({
      tabId: 'old-lock',
      heartbeat: Date.now() - 61_000,
    });

    const tabId = acquireRunTabLock('chat-1');

    expect(tabId).toBeTruthy();
    expect(tabId).not.toBe('old-lock');
  });

  it('reclaims a fresh tab lock after a same-tab reload', async () => {
    const firstLockId = acquireRunTabLock('chat-1');
    expect(firstLockId).toBeTruthy();

    const original = JSON.parse(fakeLocalStorage['run_active_chat-1']) as {
      browserTabId?: string;
      pageInstanceId?: string;
      heartbeat?: number;
    };
    expect(original.browserTabId).toBeTruthy();
    expect(original.pageInstanceId).toBeTruthy();

    fakeLocalStorage['run_active_chat-1'] = JSON.stringify({
      tabId: firstLockId,
      heartbeat: original.heartbeat ?? Date.now(),
      browserTabId: original.browserTabId,
      pageInstanceId: 'previous-page-instance',
    });
    fakeSessionStorage[RUN_RELOAD_MARKER_KEY] = JSON.stringify({
      browserTabId: original.browserTabId,
      pageInstanceId: 'previous-page-instance',
      unloadedAt: Date.now(),
    });

    const reclaimedLockId = acquireRunTabLock('chat-1');

    expect(reclaimedLockId).toBeTruthy();
    expect(reclaimedLockId).not.toBe(firstLockId);

    const reclaimed = JSON.parse(fakeLocalStorage['run_active_chat-1']) as {
      browserTabId?: string;
      pageInstanceId?: string;
    };
    expect(reclaimed.browserTabId).toBe(original.browserTabId);
    expect(reclaimed.pageInstanceId).toBe(original.pageInstanceId);
    expect(fakeSessionStorage[RUN_RELOAD_MARKER_KEY]).toBeUndefined();
  });

  it('does not reclaim a fresh tab lock when another tab only cloned the browser tab id', () => {
    fakeSessionStorage[RUN_BROWSER_TAB_ID_KEY] = 'shared-browser-tab';
    fakeSessionStorage[RUN_RELOAD_MARKER_KEY] = JSON.stringify({
      browserTabId: 'shared-browser-tab',
      pageInstanceId: 'duplicate-page-instance',
      unloadedAt: Date.now(),
    });
    fakeLocalStorage['run_active_chat-1'] = JSON.stringify({
      tabId: 'original-lock',
      heartbeat: Date.now(),
      browserTabId: 'shared-browser-tab',
      pageInstanceId: 'original-page-instance',
    });

    expect(acquireRunTabLock('chat-1')).toBeNull();
  });
});
