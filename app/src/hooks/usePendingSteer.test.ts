import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingSteerRequest } from './usePendingSteer';

// --- Hand-rolled React harness ---
type Cell = { value: unknown };
const reactState = vi.hoisted(() => ({
  cells: [] as Cell[],
  index: 0,
  refs: [] as { current: unknown }[],
  refIndex: 0,
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
}));

const { usePendingSteer } = await import('./usePendingSteer');

beforeEach(() => {
  reactState.cells = [];
  reactState.index = 0;
  reactState.refs = [];
  reactState.refIndex = 0;
});

function useHarness(mounted = true) {
  const isMountedRef = { current: mounted } as React.MutableRefObject<boolean>;
  const hook = usePendingSteer({ isMountedRef });
  return { hook, isMountedRef };
}

let nextRequestedAt = 1;
function makeSteer(text: string): PendingSteerRequest {
  return { text, requestedAt: nextRequestedAt++ };
}

beforeEach(() => {
  nextRequestedAt = 1;
});

describe('usePendingSteer — enqueuePendingSteer (FIFO append)', () => {
  it('appends a single steer to an empty queue', () => {
    const { hook } = useHarness();
    const steer = makeSteer('first');

    hook.enqueuePendingSteer('chat-1', steer);

    expect(hook.pendingSteersByChatRef.current).toEqual({ 'chat-1': [steer] });
  });

  it('appends two steers in arrival order (FIFO; second does NOT replace first)', () => {
    const { hook } = useHarness();
    const first = makeSteer('first');
    const second = makeSteer('second');

    hook.enqueuePendingSteer('chat-1', first);
    hook.enqueuePendingSteer('chat-1', second);

    expect(hook.pendingSteersByChatRef.current).toEqual({ 'chat-1': [first, second] });
  });

  it('preserves arrival order across many enqueues', () => {
    const { hook } = useHarness();
    const items = ['a', 'b', 'c', 'd'].map(makeSteer);

    for (const s of items) hook.enqueuePendingSteer('chat-1', s);

    expect(hook.pendingSteersByChatRef.current['chat-1']).toEqual(items);
  });

  it('keeps per-chat queues independent', () => {
    const { hook } = useHarness();
    const a = makeSteer('a');
    const b = makeSteer('b');

    hook.enqueuePendingSteer('chat-1', a);
    hook.enqueuePendingSteer('chat-2', b);

    expect(hook.pendingSteersByChatRef.current).toEqual({
      'chat-1': [a],
      'chat-2': [b],
    });
  });
});

describe('usePendingSteer — dequeuePendingSteer (FIFO head)', () => {
  it('returns the single queued steer and removes it', () => {
    const { hook } = useHarness();
    const steer = makeSteer('x');
    hook.enqueuePendingSteer('chat-1', steer);

    const dequeued = hook.dequeuePendingSteer('chat-1');

    expect(dequeued).toEqual(steer);
    expect(hook.pendingSteersByChatRef.current).toEqual({});
  });

  it('returns null for an empty queue without mutating state', () => {
    const { hook } = useHarness();

    const dequeued = hook.dequeuePendingSteer('chat-1');

    expect(dequeued).toBeNull();
    expect(hook.pendingSteersByChatRef.current).toEqual({});
  });

  it('drains two queued steers across two consecutive dequeues, in arrival order', () => {
    const { hook } = useHarness();
    const first = makeSteer('first');
    const second = makeSteer('second');
    hook.enqueuePendingSteer('chat-1', first);
    hook.enqueuePendingSteer('chat-1', second);

    const a = hook.dequeuePendingSteer('chat-1');
    expect(a).toEqual(first);
    expect(hook.pendingSteersByChatRef.current).toEqual({ 'chat-1': [second] });

    const b = hook.dequeuePendingSteer('chat-1');
    expect(b).toEqual(second);
    expect(hook.pendingSteersByChatRef.current).toEqual({});

    const c = hook.dequeuePendingSteer('chat-1');
    expect(c).toBeNull();
  });

  it('dequeues only the target chat queue', () => {
    const { hook } = useHarness();
    const a = makeSteer('a');
    const b = makeSteer('b');
    hook.enqueuePendingSteer('chat-1', a);
    hook.enqueuePendingSteer('chat-2', b);

    const dequeued = hook.dequeuePendingSteer('chat-1');

    expect(dequeued).toEqual(a);
    expect(hook.pendingSteersByChatRef.current).toEqual({ 'chat-2': [b] });
  });

  it('dequeue is head-only; a second drain is needed for the next entry', () => {
    const { hook } = useHarness();
    hook.enqueuePendingSteer('chat-1', makeSteer('a'));
    hook.enqueuePendingSteer('chat-1', makeSteer('b'));

    hook.dequeuePendingSteer('chat-1');

    expect(hook.pendingSteersByChatRef.current['chat-1']).toHaveLength(1);
  });
});

describe('usePendingSteer — clearPendingSteer (whole queue)', () => {
  it('returns true and clears every entry when one or more are queued', () => {
    const { hook } = useHarness();
    hook.enqueuePendingSteer('chat-1', makeSteer('a'));
    hook.enqueuePendingSteer('chat-1', makeSteer('b'));
    hook.enqueuePendingSteer('chat-1', makeSteer('c'));

    const result = hook.clearPendingSteer('chat-1');

    expect(result).toBe(true);
    expect(hook.pendingSteersByChatRef.current).toEqual({});
  });

  it('returns false and leaves state alone when the queue was empty', () => {
    const { hook } = useHarness();

    const result = hook.clearPendingSteer('chat-1');

    expect(result).toBe(false);
    expect(hook.pendingSteersByChatRef.current).toEqual({});
  });

  it('clears only the target chat queue', () => {
    const { hook } = useHarness();
    hook.enqueuePendingSteer('chat-1', makeSteer('a'));
    const b = makeSteer('b');
    hook.enqueuePendingSteer('chat-2', b);

    hook.clearPendingSteer('chat-1');

    expect(hook.pendingSteersByChatRef.current).toEqual({ 'chat-2': [b] });
  });
});

describe('usePendingSteer — mount gating', () => {
  it('updates the ref even when isMountedRef.current is false', () => {
    const { hook } = useHarness(false);
    const steer = makeSteer('x');

    hook.enqueuePendingSteer('chat-1', steer);

    // Ref tracks the latest value so in-flight callbacks (e.g. inside
    // sendMessage) can read the queue even after unmount.
    expect(hook.pendingSteersByChatRef.current).toEqual({ 'chat-1': [steer] });
  });
});
