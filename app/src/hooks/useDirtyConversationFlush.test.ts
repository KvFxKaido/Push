import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation } from '@/types';

// Minimal `document` stub for the visibility/listener wiring. The repo
// runs the web tests under environment: 'node' (no jsdom installed), so
// the hook's effects would otherwise crash on first mount. Keeps the
// surface tight: only what useDirtyConversationFlush touches.
type Listener = (event: Event) => void;
const documentListeners = vi.hoisted(() => new Map<string, Set<Listener>>());
const documentVisibility = vi.hoisted(() => ({ state: 'visible' as 'visible' | 'hidden' }));

if (typeof globalThis.document === 'undefined') {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      addEventListener: (type: string, fn: Listener) => {
        if (!documentListeners.has(type)) documentListeners.set(type, new Set());
        documentListeners.get(type)?.add(fn);
      },
      removeEventListener: (type: string, fn: Listener) => {
        documentListeners.get(type)?.delete(fn);
      },
      dispatchEvent: (event: Event) => {
        documentListeners.get(event.type)?.forEach((fn) => fn(event));
        return true;
      },
      get visibilityState() {
        return documentVisibility.state;
      },
    },
  });
}

const { mockSaveConversation, mockDeleteConversation } = vi.hoisted(() => ({
  mockSaveConversation: vi.fn(),
  mockDeleteConversation: vi.fn(),
}));

vi.mock('@/lib/conversation-store', () => ({
  saveConversation: (conv: Conversation) => mockSaveConversation(conv),
  deleteConversation: (id: string) => mockDeleteConversation(id),
}));

// Hand-rolled React stubs matching the pattern in useQueuedFollowUps.test.ts.
// Tests run under environment: 'node', so we don't have a real renderer —
// the stubs exist purely to let the hook's body execute and expose flushDirty
// for direct assertion. useEffect runs eagerly so the periodic + visibility
// listeners are wired up the same way they would be in a real mount.
type EffectRecord = {
  cleanup: void | (() => void);
  deps: unknown[] | undefined;
};

const reactState = vi.hoisted(() => ({
  cells: [] as { value: unknown }[],
  index: 0,
  refs: [] as { current: unknown }[],
  refIndex: 0,
  effects: [] as EffectRecord[],
  effectIndex: 0,
}));

vi.mock('react', () => ({
  useState: <T>(initial: T | (() => T)) => {
    const i = reactState.index++;
    if (!reactState.cells[i]) {
      const seed = typeof initial === 'function' ? (initial as () => T)() : initial;
      reactState.cells[i] = { value: seed };
    }
    const cell = reactState.cells[i];
    const setter = (v: T | ((prev: T) => T)) => {
      cell.value = typeof v === 'function' ? (v as (prev: T) => T)(cell.value as T) : v;
    };
    return [cell.value as T, setter];
  },
  useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
  useRef: <T>(initial: T) => {
    const i = reactState.refIndex++;
    if (!reactState.refs[i]) reactState.refs[i] = { current: initial };
    return reactState.refs[i] as { current: T };
  },
  useEffect: (fn: () => void | (() => void), deps?: unknown[]) => {
    const i = reactState.effectIndex++;
    const prev = reactState.effects[i];
    // Cheap dep-equality check matching React's reference semantics.
    const depsChanged =
      !prev ||
      !deps ||
      !prev.deps ||
      deps.length !== prev.deps.length ||
      deps.some((d, idx) => !Object.is(d, prev.deps?.[idx]));
    if (depsChanged) {
      if (prev?.cleanup) prev.cleanup();
      const cleanup = fn();
      reactState.effects[i] = { cleanup, deps };
    }
  },
}));

const { useDirtyConversationFlush } = await import('./useDirtyConversationFlush');

function resetReactState() {
  for (const e of reactState.effects) {
    if (e?.cleanup) e.cleanup();
  }
  reactState.cells = [];
  reactState.index = 0;
  reactState.refs = [];
  reactState.refIndex = 0;
  reactState.effects = [];
  reactState.effectIndex = 0;
}

function rerender() {
  reactState.index = 0;
  reactState.refIndex = 0;
  reactState.effectIndex = 0;
}

function makeConversation(id: string): Conversation {
  return {
    id,
    title: `Chat ${id}`,
    messages: [],
    createdAt: 1,
    lastMessageAt: 1,
  };
}

interface Harness {
  conversationsRef: { current: Record<string, Conversation> };
  dirty: Set<string>;
  deleted: Set<string>;
  dirtyRef: { current: Set<string> };
  deletedRef: { current: Set<string> };
}

function makeHarness(): Harness {
  const conversationsRef = { current: {} as Record<string, Conversation> };
  const dirty = new Set<string>();
  const deleted = new Set<string>();
  return {
    conversationsRef,
    dirty,
    deleted,
    dirtyRef: { current: dirty },
    deletedRef: { current: deleted },
  };
}

function useMount(h: Harness, conversationsLoaded: boolean) {
  return useDirtyConversationFlush({
    conversationsLoaded,
    conversationsRef: h.conversationsRef,
    dirtyConversationIdsRef: h.dirtyRef,
    deletedConversationIdsRef: h.deletedRef,
  });
}

beforeEach(() => {
  resetReactState();
  mockSaveConversation.mockReset();
  mockDeleteConversation.mockReset();
  mockSaveConversation.mockResolvedValue(undefined);
  mockDeleteConversation.mockResolvedValue(undefined);
});

afterEach(() => {
  resetReactState();
});

describe('useDirtyConversationFlush — flushDirty', () => {
  it('is a no-op when conversations have not loaded yet', async () => {
    const h = makeHarness();
    h.conversationsRef.current['c1'] = makeConversation('c1');
    h.dirty.add('c1');
    const { flushDirty } = useMount(h, false);
    await flushDirty();
    expect(mockSaveConversation).not.toHaveBeenCalled();
    expect(h.dirty.has('c1')).toBe(true);
  });

  it('is a no-op when both sets are empty', async () => {
    const h = makeHarness();
    const { flushDirty } = useMount(h, true);
    await flushDirty();
    expect(mockSaveConversation).not.toHaveBeenCalled();
    expect(mockDeleteConversation).not.toHaveBeenCalled();
  });

  it('saves all dirty conversations and clears the dirty set', async () => {
    const h = makeHarness();
    h.conversationsRef.current['c1'] = makeConversation('c1');
    h.conversationsRef.current['c2'] = makeConversation('c2');
    h.dirty.add('c1');
    h.dirty.add('c2');
    const { flushDirty } = useMount(h, true);
    await flushDirty();
    expect(mockSaveConversation).toHaveBeenCalledTimes(2);
    expect(h.dirty.size).toBe(0);
  });

  it('deletes all deleted conversations and clears the deleted set', async () => {
    const h = makeHarness();
    h.deleted.add('c1');
    h.deleted.add('c2');
    const { flushDirty } = useMount(h, true);
    await flushDirty();
    expect(mockDeleteConversation).toHaveBeenCalledWith('c1');
    expect(mockDeleteConversation).toHaveBeenCalledWith('c2');
    expect(h.deleted.size).toBe(0);
  });

  it('skips dirty IDs whose conversations are missing from the snapshot', async () => {
    const h = makeHarness();
    // No conversation in the snapshot — typical race when the deletion
    // landed before the flush.
    h.dirty.add('ghost');
    const { flushDirty } = useMount(h, true);
    await flushDirty();
    expect(mockSaveConversation).not.toHaveBeenCalled();
    expect(h.dirty.size).toBe(0);
  });

  it('re-adds a failing ID to the dirty set on transient failure', async () => {
    const h = makeHarness();
    h.conversationsRef.current['c1'] = makeConversation('c1');
    h.dirty.add('c1');
    mockSaveConversation.mockRejectedValueOnce(new Error('disk full'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { flushDirty } = useMount(h, true);
    await flushDirty();

    expect(mockSaveConversation).toHaveBeenCalledTimes(1);
    expect(h.dirty.has('c1')).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('drops a conversation after MAX_RETRIES failures', async () => {
    const h = makeHarness();
    h.conversationsRef.current['c1'] = makeConversation('c1');
    h.dirty.add('c1');
    mockSaveConversation.mockRejectedValue(new Error('disk full'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { flushDirty } = useMount(h, true);
    // Attempts 1..3 should keep re-adding the ID. Attempt 4 should drop.
    await flushDirty();
    expect(h.dirty.has('c1')).toBe(true);
    await flushDirty();
    expect(h.dirty.has('c1')).toBe(true);
    await flushDirty();
    expect(h.dirty.has('c1')).toBe(true);
    await flushDirty();
    expect(h.dirty.has('c1')).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('Failed to save conversation c1');
    warnSpy.mockRestore();
  });

  it('drops a deletion after MAX_RETRIES failures', async () => {
    const h = makeHarness();
    h.deleted.add('c1');
    mockDeleteConversation.mockRejectedValue(new Error('disk full'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { flushDirty } = useMount(h, true);
    await flushDirty();
    await flushDirty();
    await flushDirty();
    await flushDirty();
    expect(h.deleted.has('c1')).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('Failed to delete conversation c1');
    warnSpy.mockRestore();
  });

  it('preserves a concurrent dirty mark added during the in-flight save', async () => {
    const h = makeHarness();
    h.conversationsRef.current['c1'] = makeConversation('c1');
    h.conversationsRef.current['c2'] = makeConversation('c2');
    h.dirty.add('c1');
    // Simulate a concurrent dirty-mark landing during the save: when the
    // save resolves, c2 has been added back to the (cleared) set.
    mockSaveConversation.mockImplementationOnce(async () => {
      h.dirty.add('c2');
    });
    const { flushDirty } = useMount(h, true);
    await flushDirty();
    expect(mockSaveConversation).toHaveBeenCalledTimes(1);
    // c1 was the snapshot; c2 was added concurrently and must survive.
    expect(h.dirty.has('c1')).toBe(false);
    expect(h.dirty.has('c2')).toBe(true);
  });

  it('clears the retry counter after a successful save following failures', async () => {
    const h = makeHarness();
    h.conversationsRef.current['c1'] = makeConversation('c1');
    h.dirty.add('c1');
    mockSaveConversation.mockRejectedValueOnce(new Error('once')).mockResolvedValueOnce(undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { flushDirty } = useMount(h, true);
    await flushDirty();
    expect(h.dirty.has('c1')).toBe(true);
    await flushDirty();
    expect(h.dirty.has('c1')).toBe(false);

    // After success, queue another failure cycle and confirm the counter
    // restarts at 0 (i.e., 3 more failures are allowed before dropping).
    mockSaveConversation.mockRejectedValue(new Error('again'));
    h.dirty.add('c1');
    await flushDirty();
    await flushDirty();
    await flushDirty();
    expect(h.dirty.has('c1')).toBe(true);
    await flushDirty();
    expect(h.dirty.has('c1')).toBe(false);
    warnSpy.mockRestore();
  });
});

describe('useDirtyConversationFlush — periodic + visibility wiring', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('drives flushDirty on a 3s interval', async () => {
    const h = makeHarness();
    h.conversationsRef.current['c1'] = makeConversation('c1');
    h.dirty.add('c1');
    useMount(h, true);

    expect(mockSaveConversation).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(mockSaveConversation).toHaveBeenCalledTimes(1);

    h.conversationsRef.current['c2'] = makeConversation('c2');
    h.dirty.add('c2');
    await vi.advanceTimersByTimeAsync(3000);
    expect(mockSaveConversation).toHaveBeenCalledTimes(2);
  });

  it('flushes when the document becomes hidden', async () => {
    const h = makeHarness();
    h.conversationsRef.current['c1'] = makeConversation('c1');
    h.dirty.add('c1');
    useMount(h, true);

    documentVisibility.state = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);

    expect(mockSaveConversation).toHaveBeenCalledTimes(1);
  });

  it('does not flush when the document becomes visible', async () => {
    const h = makeHarness();
    h.conversationsRef.current['c1'] = makeConversation('c1');
    h.dirty.add('c1');
    useMount(h, true);

    documentVisibility.state = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);

    expect(mockSaveConversation).not.toHaveBeenCalled();
  });

  it('rewires the interval when conversationsLoaded flips false → true', async () => {
    const h = makeHarness();
    h.conversationsRef.current['c1'] = makeConversation('c1');
    h.dirty.add('c1');

    useMount(h, false);
    await vi.advanceTimersByTimeAsync(3000);
    // While not loaded, flushDirty short-circuits — nothing saved even
    // though the interval fired.
    expect(mockSaveConversation).not.toHaveBeenCalled();

    rerender();
    useMount(h, true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(mockSaveConversation).toHaveBeenCalledTimes(1);
  });
});
