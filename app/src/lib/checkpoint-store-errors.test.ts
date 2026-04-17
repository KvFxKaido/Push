import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunCheckpoint } from '@/types';

// ---------------------------------------------------------------------------
// This file is isolated from checkpoint-store.test.ts because its specs mock
// `./app-db` with `vi.doMock` + `vi.resetModules`, which would interfere with
// the legacy-localStorage closures in that file's real-IDB tests.
// ---------------------------------------------------------------------------

const fakeStorage: Record<string, string> = {};

vi.mock('./safe-storage', () => ({
  safeStorageGet: (key: string) => fakeStorage[key] ?? null,
  safeStorageSet: (key: string, value: string) => {
    fakeStorage[key] = value;
  },
  safeStorageRemove: (key: string) => {
    delete fakeStorage[key];
  },
}));

function makeCheckpoint(overrides: Partial<RunCheckpoint> = {}): RunCheckpoint {
  return {
    chatId: 'chat-1',
    round: 3,
    phase: 'planner' as RunCheckpoint['phase'],
    baseMessageCount: 5,
    deltaMessages: [{ role: 'assistant', content: 'partial' }],
    accumulated: 'partial',
    thinkingAccumulated: '',
    coderDelegationActive: false,
    lastCoderState: null,
    savedAt: 1_700_000_000,
    provider: 'anthropic' as RunCheckpoint['provider'],
    model: 'claude-opus-4-6',
    sandboxSessionId: 'sb-1',
    activeBranch: 'main',
    repoId: 'octo/push',
    ...overrides,
  };
}

beforeEach(() => {
  for (const key of Object.keys(fakeStorage)) delete fakeStorage[key];
  vi.resetModules();
});

describe('checkpoint-store — IndexedDB failure tolerance', () => {
  it('saveCheckpoint swallows IndexedDB errors (best-effort)', async () => {
    vi.doMock('./app-db', () => ({
      STORE: { checkpoints: 'checkpoints' },
      get: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockRejectedValue(new Error('quota')),
      del: vi.fn().mockResolvedValue(undefined),
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const mod = await import('./checkpoint-store');
    await expect(mod.saveCheckpoint(makeCheckpoint())).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith('[CheckpointStore] IndexedDB write failed');
  });

  it('loadCheckpoint falls back to localStorage when IDB read throws', async () => {
    vi.doMock('./app-db', () => ({
      STORE: { checkpoints: 'checkpoints' },
      get: vi.fn().mockRejectedValue(new Error('db gone')),
      put: vi.fn().mockResolvedValue(undefined),
      del: vi.fn().mockResolvedValue(undefined),
    }));
    fakeStorage[`run_checkpoint_chat-1`] = JSON.stringify(makeCheckpoint({ round: 42 }));

    const mod = await import('./checkpoint-store');
    const loaded = await mod.loadCheckpoint('chat-1');

    expect(loaded?.round).toBe(42);
  });

  it('clearCheckpoint swallows IndexedDB errors', async () => {
    vi.doMock('./app-db', () => ({
      STORE: { checkpoints: 'checkpoints' },
      get: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockResolvedValue(undefined),
      del: vi.fn().mockRejectedValue(new Error('tx failed')),
    }));

    const mod = await import('./checkpoint-store');
    await expect(mod.clearCheckpoint('chat-1')).resolves.toBeUndefined();
  });
});
