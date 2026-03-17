import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunCheckpoint } from '@/types';

const mockClearCheckpoint = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
const mockLoadCheckpoint = vi.fn<(chatId: string) => Promise<RunCheckpoint | null>>().mockResolvedValue(null);
const mockSaveCheckpoint = vi
  .fn<(checkpoint: RunCheckpoint) => Promise<void>>()
  .mockResolvedValue(undefined);

vi.mock('./checkpoint-store', () => ({
  clearCheckpoint: (...args: unknown[]) => mockClearCheckpoint(...(args as [string])),
  loadCheckpoint: (...args: unknown[]) => mockLoadCheckpoint(...(args as [string])),
  saveCheckpoint: (...args: unknown[]) => mockSaveCheckpoint(...(args as [RunCheckpoint])),
}));

let fakeStorage: Record<string, string> = {};

vi.mock('./safe-storage', () => ({
  safeStorageGet: (key: string) => fakeStorage[key] ?? null,
  safeStorageRemove: (key: string) => {
    delete fakeStorage[key];
    return true;
  },
  safeStorageSet: (key: string, value: string) => {
    fakeStorage[key] = value;
    return true;
  },
}));

const {
  acquireRunTabLock,
  buildCheckpointReconciliationMessage,
  buildRunCheckpoint,
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
  fakeStorage = {};
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
    mockLoadCheckpoint.mockResolvedValue(
      makeCheckpoint({ savedAt: Date.now() - 26 * 60 * 1_000 }),
    );

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

  it('acquires, heartbeats, and releases a tab lock', () => {
    const tabId = acquireRunTabLock('chat-1');

    expect(tabId).toBeTruthy();
    expect(acquireRunTabLock('chat-1')).toBeNull();

    const key = 'run_active_chat-1';
    const beforeHeartbeat = JSON.parse(fakeStorage[key]).heartbeat as number;

    vi.advanceTimersByTime(15_000);
    heartbeatRunTabLock('chat-1', tabId);

    const afterHeartbeat = JSON.parse(fakeStorage[key]).heartbeat as number;
    expect(afterHeartbeat).toBeGreaterThan(beforeHeartbeat);

    releaseRunTabLock('chat-1', tabId);
    expect(fakeStorage[key]).toBeUndefined();
  });

  it('takes over stale tab locks', () => {
    fakeStorage['run_active_chat-1'] = JSON.stringify({
      tabId: 'old-lock',
      heartbeat: Date.now() - 61_000,
    });

    const tabId = acquireRunTabLock('chat-1');

    expect(tabId).toBeTruthy();
    expect(tabId).not.toBe('old-lock');
  });
});
