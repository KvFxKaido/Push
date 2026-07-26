/**
 * useWarmAction — accept-warm-run kernel for census Wave 3.
 *
 * Hook-under-mocked-React harness (the useSnapshotManager.test.ts pattern):
 * React's useState/useRef/useCallback are replaced with a deterministic cell
 * store, so state updates are synchronous and the hook is exercised as a plain
 * function with manual re-renders.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const reactState = vi.hoisted(() => ({
  cells: [] as Array<{ value: unknown }>,
  refs: [] as Array<{ current: unknown }>,
  index: 0,
  refIndex: 0,
}));

vi.mock('react', () => ({
  useState: (seed: unknown) => {
    const i = reactState.index++;
    if (!reactState.cells[i]) {
      reactState.cells[i] = {
        value: typeof seed === 'function' ? (seed as () => unknown)() : seed,
      };
    }
    const cell = reactState.cells[i];
    return [
      cell.value,
      (next: unknown) => {
        cell.value =
          typeof next === 'function' ? (next as (p: unknown) => unknown)(cell.value) : next;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const i = reactState.refIndex++;
    if (!reactState.refs[i]) reactState.refs[i] = { current: initial };
    return reactState.refs[i];
  },
  useCallback: (fn: unknown) => fn,
}));

import { useWarmAction } from './useWarmAction';

function render(ensure: () => Promise<string | null>) {
  reactState.index = 0;
  reactState.refIndex = 0;
  // React is mocked above — the hook runs as a plain function here.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useWarmAction(ensure);
}

beforeEach(() => {
  reactState.cells = [];
  reactState.refs = [];
  reactState.index = 0;
  reactState.refIndex = 0;
});

describe('useWarmAction', () => {
  it('warms, then runs the action with the live id', async () => {
    const ensure = vi.fn(async () => 'sb-1');
    const action = vi.fn();
    const onUnavailable = vi.fn();

    await render(ensure).run(action, onUnavailable);

    expect(action).toHaveBeenCalledWith('sb-1');
    expect(onUnavailable).not.toHaveBeenCalled();
    expect(render(ensure).warming).toBe(false);
  });

  it('fires onUnavailable and skips the action when the warm fails', async () => {
    const ensure = vi.fn(async () => null);
    const action = vi.fn();
    const onUnavailable = vi.fn();

    await render(ensure).run(action, onUnavailable);

    expect(action).not.toHaveBeenCalled();
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(render(ensure).warming).toBe(false);
  });

  it('reports warming while the warm is in flight and clears it after', async () => {
    let release!: (id: string) => void;
    const ensure = vi.fn(() => new Promise<string | null>((resolve) => (release = resolve)));

    const pending = render(ensure).run(vi.fn(), vi.fn());
    expect(render(ensure).warming).toBe(true);

    release('sb-1');
    await pending;
    expect(render(ensure).warming).toBe(false);
  });

  it('is a no-op while a run is already in flight (double-tap cannot double-start)', async () => {
    let release!: (id: string) => void;
    const ensure = vi.fn(() => new Promise<string | null>((resolve) => (release = resolve)));
    const action = vi.fn();

    const first = render(ensure).run(action, vi.fn());
    // Second tap while the warm is pending — the ref is reserved before the
    // first await, so this must not start a second warm.
    await render(ensure).run(action, vi.fn());
    expect(ensure).toHaveBeenCalledTimes(1);

    release('sb-1');
    await first;
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('clears warming and releases the reservation even when the action throws', async () => {
    const ensure = vi.fn(async () => 'sb-1');

    await expect(
      render(ensure).run(() => {
        throw new Error('action failed');
      }, vi.fn()),
    ).rejects.toThrow('action failed');
    expect(render(ensure).warming).toBe(false);

    // Reservation released — a subsequent run executes normally.
    const action = vi.fn();
    await render(ensure).run(action, vi.fn());
    expect(action).toHaveBeenCalledWith('sb-1');
  });
});
