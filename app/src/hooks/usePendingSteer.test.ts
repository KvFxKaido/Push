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

function makeSteer(text: string): PendingSteerRequest {
  return { text, requestedAt: 1 };
}

describe('usePendingSteer — single-slot mutation semantics', () => {
  it('setPendingSteer assigns the slot for the given chat', () => {
    const { hook } = useHarness();
    const steer = makeSteer('first');

    hook.setPendingSteer('chat-1', steer);

    expect(hook.pendingSteersByChatRef.current).toEqual({ 'chat-1': steer });
  });

  it('setPendingSteer overwrites an existing slot with latest-wins semantics', () => {
    const { hook } = useHarness();
    const first = makeSteer('first');
    const second = makeSteer('second');

    hook.setPendingSteer('chat-1', first);
    hook.setPendingSteer('chat-1', second);

    expect(hook.pendingSteersByChatRef.current).toEqual({ 'chat-1': second });
  });

  it('setPendingSteer on one chat does not disturb another chat', () => {
    const { hook } = useHarness();
    const a = makeSteer('a');
    const b = makeSteer('b');

    hook.setPendingSteer('chat-1', a);
    hook.setPendingSteer('chat-2', b);

    expect(hook.pendingSteersByChatRef.current).toEqual({
      'chat-1': a,
      'chat-2': b,
    });
  });
});

describe('usePendingSteer — consumePendingSteer', () => {
  it('returns the slot and deletes it (consume, not shift)', () => {
    const { hook } = useHarness();
    const steer = makeSteer('x');
    hook.setPendingSteer('chat-1', steer);

    const consumed = hook.consumePendingSteer('chat-1');

    expect(consumed).toEqual(steer);
    expect(hook.pendingSteersByChatRef.current).toEqual({});
  });

  it('returns null for an empty slot without mutating state', () => {
    const { hook } = useHarness();

    const consumed = hook.consumePendingSteer('chat-1');

    expect(consumed).toBeNull();
    expect(hook.pendingSteersByChatRef.current).toEqual({});
  });

  it('consumes only the target chat slot', () => {
    const { hook } = useHarness();
    const a = makeSteer('a');
    const b = makeSteer('b');
    hook.setPendingSteer('chat-1', a);
    hook.setPendingSteer('chat-2', b);

    const consumed = hook.consumePendingSteer('chat-1');

    expect(consumed).toEqual(a);
    expect(hook.pendingSteersByChatRef.current).toEqual({ 'chat-2': b });
  });
});

describe('usePendingSteer — clearPendingSteer', () => {
  it('returns true and removes the slot when it was set', () => {
    const { hook } = useHarness();
    hook.setPendingSteer('chat-1', makeSteer('x'));

    const result = hook.clearPendingSteer('chat-1');

    expect(result).toBe(true);
    expect(hook.pendingSteersByChatRef.current).toEqual({});
  });

  it('returns false and leaves state alone when the slot was empty', () => {
    const { hook } = useHarness();

    const result = hook.clearPendingSteer('chat-1');

    expect(result).toBe(false);
    expect(hook.pendingSteersByChatRef.current).toEqual({});
  });
});

describe('usePendingSteer — mount gating', () => {
  it('updates the ref even when isMountedRef.current is false', () => {
    const { hook } = useHarness(false);
    const steer = makeSteer('x');

    hook.setPendingSteer('chat-1', steer);

    // Ref tracks the latest value so in-flight callbacks (e.g. inside
    // sendMessage) can read the steer even after unmount.
    expect(hook.pendingSteersByChatRef.current).toEqual({ 'chat-1': steer });
  });
});
