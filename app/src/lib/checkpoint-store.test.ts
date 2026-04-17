import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import type { RunCheckpoint } from '@/types';

// ---------------------------------------------------------------------------
// localStorage stub — shared across checkpoint-store and app-db's consumers
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

async function loadFresh() {
  // Wipe every object store in place so app-db's cached dbPromise stays
  // valid across tests (avoids vi.resetModules, which would recapture the
  // vi.mock closure over a different fakeStorage binding).
  const { STORE, clear } = await import('./app-db');
  await Promise.all(Object.values(STORE).map((name) => clear(name)));
  return import('./checkpoint-store');
}

beforeEach(() => {
  for (const key of Object.keys(fakeStorage)) delete fakeStorage[key];
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Round-trip
// ---------------------------------------------------------------------------

describe('checkpoint-store — IndexedDB round-trip', () => {
  it('save → load returns the same checkpoint', async () => {
    const mod = await loadFresh();
    const cp = makeCheckpoint();
    await mod.saveCheckpoint(cp);
    const loaded = await mod.loadCheckpoint('chat-1');
    expect(loaded).toEqual(cp);
  });

  it('loadCheckpoint returns null when nothing is stored', async () => {
    const mod = await loadFresh();
    const loaded = await mod.loadCheckpoint('missing');
    expect(loaded).toBeNull();
  });

  it('saveCheckpoint overwrites an existing record', async () => {
    const mod = await loadFresh();
    await mod.saveCheckpoint(makeCheckpoint({ round: 1 }));
    await mod.saveCheckpoint(makeCheckpoint({ round: 9 }));
    const loaded = await mod.loadCheckpoint('chat-1');
    expect(loaded?.round).toBe(9);
  });

  it('clearCheckpoint removes the record', async () => {
    const mod = await loadFresh();
    await mod.saveCheckpoint(makeCheckpoint());
    await mod.clearCheckpoint('chat-1');
    expect(await mod.loadCheckpoint('chat-1')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Legacy localStorage migration
// ---------------------------------------------------------------------------

describe('checkpoint-store — legacy localStorage fallback', () => {
  it('reads a legacy checkpoint out of localStorage when IndexedDB is empty', async () => {
    const mod = await loadFresh();
    const legacy = makeCheckpoint({ chatId: 'legacy-1', round: 7 });
    fakeStorage[`run_checkpoint_legacy-1`] = JSON.stringify(legacy);

    const loaded = await mod.loadCheckpoint('legacy-1');
    expect(loaded).toEqual(legacy);
  });

  it('migrates legacy entry into IndexedDB and clears localStorage', async () => {
    const mod = await loadFresh();
    const legacy = makeCheckpoint({ chatId: 'legacy-1', round: 7 });
    fakeStorage[`run_checkpoint_legacy-1`] = JSON.stringify(legacy);

    const firstLoad = await mod.loadCheckpoint('legacy-1');
    expect(firstLoad).toEqual(legacy);

    // Poll until the fire-and-forget migration clears the legacy key.
    // Avoids a fixed setTimeout that would be flaky on slow CI runners.
    await vi.waitFor(() => {
      expect(fakeStorage[`run_checkpoint_legacy-1`]).toBeUndefined();
    });
    // The record should now live in IndexedDB — a second load reads it back.
    const secondLoad = await mod.loadCheckpoint('legacy-1');
    expect(secondLoad).toEqual(legacy);
  });

  it('returns null when the legacy payload is malformed JSON', async () => {
    const mod = await loadFresh();
    fakeStorage[`run_checkpoint_broken`] = '{ not json';
    const loaded = await mod.loadCheckpoint('broken');
    expect(loaded).toBeNull();
  });

  it('clearCheckpoint also removes the legacy localStorage entry', async () => {
    const mod = await loadFresh();
    fakeStorage[`run_checkpoint_chat-1`] = JSON.stringify(makeCheckpoint());
    await mod.saveCheckpoint(makeCheckpoint());

    await mod.clearCheckpoint('chat-1');

    expect(fakeStorage[`run_checkpoint_chat-1`]).toBeUndefined();
    expect(await mod.loadCheckpoint('chat-1')).toBeNull();
  });
});
