import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation } from '@/types';

// Same fake-React harness pattern as useQueuedFollowUps.test.ts: tests run
// under environment: 'node', so React's hook machinery is stubbed. useEffect
// here is a no-op — the timer + visibility lifecycle isn't exercised; we
// test flushDirty's logic directly, which is where the retry semantics live.
type Cell = { value: unknown };
const reactState = vi.hoisted(() => ({
  cells: [] as Cell[],
  index: 0,
  refs: [] as { current: unknown }[],
  refIndex: 0,
}));

vi.mock('react', () => ({
  useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
  useEffect: () => {
    /* no-op: timer/visibility wiring isn't under test */
  },
  useRef: <T>(initial: T) => {
    const i = reactState.refIndex++;
    if (!reactState.refs[i]) reactState.refs[i] = { current: initial };
    return reactState.refs[i] as { current: T };
  },
}));

const saveSpy = vi.hoisted(() => vi.fn());
const deleteSpy = vi.hoisted(() => vi.fn());

vi.mock('@/lib/conversation-store', () => ({
  saveConversation: saveSpy,
  deleteConversation: deleteSpy,
}));

const { useConversationPersistence } = await import('./useConversationPersistence');

beforeEach(() => {
  reactState.cells = [];
  reactState.index = 0;
  reactState.refs = [];
  reactState.refIndex = 0;
  saveSpy.mockReset();
  deleteSpy.mockReset();
});

function makeConversation(id: string): Conversation {
  return {
    id,
    title: `Chat ${id}`,
    messages: [],
    createdAt: 1,
    lastMessageAt: 1,
  };
}

interface HarnessOptions {
  conversationsLoaded?: boolean;
  conversations?: Record<string, Conversation>;
}

// Prefixed `use` so react-hooks/rules-of-hooks treats this as a custom hook.
// Not a real React hook — runs under the fake-React mocks above.
function useHarness(options: HarnessOptions = {}) {
  const conversations = options.conversations ?? {};
  const conversationsRef = { current: conversations } as React.MutableRefObject<
    Record<string, Conversation>
  >;
  const hook = useConversationPersistence({
    conversationsLoaded: options.conversationsLoaded ?? true,
    conversationsRef,
  });
  return { hook, conversationsRef };
}

describe('useConversationPersistence — flushDirty', () => {
  it('skips persistence when conversationsLoaded is false', async () => {
    const { hook } = useHarness({
      conversationsLoaded: false,
      conversations: { a: makeConversation('a') },
    });
    hook.dirtyConversationIdsRef.current.add('a');

    await hook.flushDirty();

    expect(saveSpy).not.toHaveBeenCalled();
    expect(hook.dirtyConversationIdsRef.current.has('a')).toBe(true);
  });

  it('short-circuits when both dirty and deleted sets are empty', async () => {
    const { hook } = useHarness();

    await hook.flushDirty();

    expect(saveSpy).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('saves each dirty conversation and clears the dirty set on success', async () => {
    saveSpy.mockResolvedValue(undefined);
    const a = makeConversation('a');
    const b = makeConversation('b');
    const { hook } = useHarness({ conversations: { a, b } });
    hook.dirtyConversationIdsRef.current.add('a');
    hook.dirtyConversationIdsRef.current.add('b');

    await hook.flushDirty();

    expect(saveSpy).toHaveBeenCalledTimes(2);
    expect(saveSpy).toHaveBeenCalledWith(a);
    expect(saveSpy).toHaveBeenCalledWith(b);
    expect(hook.dirtyConversationIdsRef.current.size).toBe(0);
  });

  it('skips dirty IDs that no longer exist in conversationsRef', async () => {
    saveSpy.mockResolvedValue(undefined);
    const { hook } = useHarness({ conversations: {} });
    hook.dirtyConversationIdsRef.current.add('ghost');

    await hook.flushDirty();

    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('re-queues failed saves and increments the retry counter', async () => {
    saveSpy.mockRejectedValue(new Error('boom'));
    const a = makeConversation('a');
    const { hook } = useHarness({ conversations: { a } });
    hook.dirtyConversationIdsRef.current.add('a');

    await hook.flushDirty();

    expect(hook.dirtyConversationIdsRef.current.has('a')).toBe(true);
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it('drops the update after 3 consecutive save failures', async () => {
    saveSpy.mockRejectedValue(new Error('boom'));
    const a = makeConversation('a');
    const { hook } = useHarness({ conversations: { a } });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    hook.dirtyConversationIdsRef.current.add('a');

    // Three failures: each retries (count: 0→1, 1→2, 2→3).
    await hook.flushDirty();
    await hook.flushDirty();
    await hook.flushDirty();
    expect(hook.dirtyConversationIdsRef.current.has('a')).toBe(true);

    // Fourth failure: count is 3, exceeds MAX_RETRIES, dropped.
    await hook.flushDirty();
    expect(hook.dirtyConversationIdsRef.current.has('a')).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to save conversation a after 3 retries'),
      expect.any(Error),
    );

    warnSpy.mockRestore();
  });

  it('clears the retry counter when a previously failing save succeeds', async () => {
    const a = makeConversation('a');
    const { hook } = useHarness({ conversations: { a } });

    // Sequence: fail, fail, succeed, then four fails. Without the counter
    // reset on success, the fourth post-success fail would land at count=3
    // and get dropped — the assertion would flip false.
    saveSpy
      .mockRejectedValueOnce(new Error('boom'))
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('boom'))
      .mockRejectedValueOnce(new Error('boom'))
      .mockRejectedValueOnce(new Error('boom'))
      .mockRejectedValueOnce(new Error('boom'));

    hook.dirtyConversationIdsRef.current.add('a');
    await hook.flushDirty(); // fail 1: count 0→1
    await hook.flushDirty(); // fail 2: count 1→2
    await hook.flushDirty(); // success: counter cleared, dirty empty

    expect(hook.dirtyConversationIdsRef.current.has('a')).toBe(false);

    // Re-dirty and burn through the retry budget again — proves the counter
    // restarted at 0 rather than 2 (which would drop on the third fail).
    hook.dirtyConversationIdsRef.current.add('a');
    await hook.flushDirty(); // count 0→1
    await hook.flushDirty(); // count 1→2
    await hook.flushDirty(); // count 2→3

    expect(hook.dirtyConversationIdsRef.current.has('a')).toBe(true);
  });

  it('processes deletions and clears the deleted set on success', async () => {
    deleteSpy.mockResolvedValue(undefined);
    const { hook } = useHarness();
    hook.deletedConversationIdsRef.current.add('a');
    hook.deletedConversationIdsRef.current.add('b');

    await hook.flushDirty();

    expect(deleteSpy).toHaveBeenCalledTimes(2);
    expect(deleteSpy).toHaveBeenCalledWith('a');
    expect(deleteSpy).toHaveBeenCalledWith('b');
    expect(hook.deletedConversationIdsRef.current.size).toBe(0);
  });

  it('re-queues failed deletes and drops them after 3 retries', async () => {
    deleteSpy.mockRejectedValue(new Error('delete boom'));
    const { hook } = useHarness();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    hook.deletedConversationIdsRef.current.add('a');

    await hook.flushDirty();
    await hook.flushDirty();
    await hook.flushDirty();
    expect(hook.deletedConversationIdsRef.current.has('a')).toBe(true);

    await hook.flushDirty();
    expect(hook.deletedConversationIdsRef.current.has('a')).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to delete conversation a after 3 retries'),
      expect.any(Error),
    );

    warnSpy.mockRestore();
  });

  it('processes both dirty and deleted sets in the same flush', async () => {
    saveSpy.mockResolvedValue(undefined);
    deleteSpy.mockResolvedValue(undefined);
    const a = makeConversation('a');
    const { hook } = useHarness({ conversations: { a } });
    hook.dirtyConversationIdsRef.current.add('a');
    hook.deletedConversationIdsRef.current.add('b');

    await hook.flushDirty();

    expect(saveSpy).toHaveBeenCalledWith(a);
    expect(deleteSpy).toHaveBeenCalledWith('b');
    expect(hook.dirtyConversationIdsRef.current.size).toBe(0);
    expect(hook.deletedConversationIdsRef.current.size).toBe(0);
  });

  it('preserves IDs added during an in-flight flush', async () => {
    let resolveSave: () => void = () => {};
    saveSpy.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );
    const a = makeConversation('a');
    const { hook } = useHarness({ conversations: { a } });
    hook.dirtyConversationIdsRef.current.add('a');

    const flushPromise = hook.flushDirty();
    // Mid-flight: caller dirties a new ID. The flush has already snapshotted
    // and cleared the set, so this addition must survive into the next flush.
    hook.dirtyConversationIdsRef.current.add('c');

    resolveSave();
    await flushPromise;

    expect(hook.dirtyConversationIdsRef.current.has('a')).toBe(false);
    expect(hook.dirtyConversationIdsRef.current.has('c')).toBe(true);
  });
});
