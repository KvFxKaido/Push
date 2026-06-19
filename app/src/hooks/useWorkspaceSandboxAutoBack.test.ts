import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAutoBackScheduler, type AutoBackContext } from './useWorkspaceSandboxAutoBack';
import type { AutoBackResult } from '@/lib/sandbox-auto-back';

const DEBOUNCE = 45_000;

function setup(ctxOverrides?: Partial<AutoBackContext>) {
  const ctx: AutoBackContext = {
    sandboxId: 'sb-1',
    branch: 'feature/x',
    enabled: true,
    ...ctxOverrides,
  };
  const backUp = vi.fn(async (): Promise<AutoBackResult> => ({ status: 'clean' }));
  const scheduler = createAutoBackScheduler({
    debounceMs: DEBOUNCE,
    getContext: () => ctx,
    backUp,
  });
  return { ctx, backUp, scheduler };
}

describe('createAutoBackScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('debounces a burst of mutations into a single backup', async () => {
    const { backUp, scheduler } = setup();
    scheduler.onMutation('sb-1');
    await vi.advanceTimersByTimeAsync(DEBOUNCE - 1);
    scheduler.onMutation('sb-1'); // resets the debounce window
    await vi.advanceTimersByTimeAsync(DEBOUNCE - 1);
    expect(backUp).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(backUp).toHaveBeenCalledTimes(1);
    // First backup has no prior tree to dedup against.
    expect(backUp).toHaveBeenCalledWith('sb-1', 'feature/x', undefined);
  });

  it('threads the last backed-up tree into the next backup so it can dedup (#982)', async () => {
    const ctx: AutoBackContext = { sandboxId: 'sb-1', branch: 'feature/x', enabled: true };
    const backUp = vi.fn(
      async (): Promise<AutoBackResult> => ({
        status: 'backed-up',
        ref: 'draft/auto/feature/x',
        sha: 's',
        tree: 'tree-1',
      }),
    );
    const scheduler = createAutoBackScheduler({
      debounceMs: DEBOUNCE,
      getContext: () => ctx,
      backUp,
    });

    scheduler.onMutation('sb-1');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(backUp).toHaveBeenNthCalledWith(1, 'sb-1', 'feature/x', undefined);

    scheduler.onMutation('sb-1');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    // Second run carries the tree the first backup pinned.
    expect(backUp).toHaveBeenNthCalledWith(2, 'sb-1', 'feature/x', 'tree-1');
  });

  it('does not reuse the dedup tree across a branch change', async () => {
    const ctx: AutoBackContext = { sandboxId: 'sb-1', branch: 'feature/x', enabled: true };
    const backUp = vi.fn(
      async (_id: string, branch: string): Promise<AutoBackResult> => ({
        status: 'backed-up',
        ref: `draft/auto/${branch}`,
        sha: 's',
        tree: `tree-${branch}`,
      }),
    );
    const scheduler = createAutoBackScheduler({
      debounceMs: DEBOUNCE,
      getContext: () => ctx,
      backUp,
    });

    scheduler.onMutation('sb-1');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    ctx.branch = 'feature/y';
    scheduler.onMutation('sb-1');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    // New branch → no carried tree (the pin was for feature/x).
    expect(backUp).toHaveBeenNthCalledWith(2, 'sb-1', 'feature/y', undefined);
  });

  it('ignores mutations for a different sandbox', async () => {
    const { backUp, scheduler } = setup();
    scheduler.onMutation('sb-other');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(backUp).not.toHaveBeenCalled();
  });

  it('does nothing while disabled', async () => {
    const { backUp, scheduler } = setup({ enabled: false });
    scheduler.onMutation('sb-1');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(backUp).not.toHaveBeenCalled();
  });

  it('flush runs a pending backup immediately (before the debounce)', async () => {
    const { backUp, scheduler } = setup();
    scheduler.onMutation('sb-1');
    scheduler.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(backUp).toHaveBeenCalledTimes(1);
  });

  it('flush is a no-op when nothing is pending', async () => {
    const { backUp, scheduler } = setup();
    scheduler.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(backUp).not.toHaveBeenCalled();
  });

  it('dispose cancels a pending backup', async () => {
    const { backUp, scheduler } = setup();
    scheduler.onMutation('sb-1');
    scheduler.dispose();
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(backUp).not.toHaveBeenCalled();
  });

  it('coalesces a mutation that lands during an in-flight backup', async () => {
    let resolveBackup: () => void = () => {};
    const backUp = vi.fn(
      () =>
        new Promise<AutoBackResult>((resolve) => {
          resolveBackup = () => resolve({ status: 'backed-up', ref: 'r', sha: 's', tree: 't' });
        }),
    );
    const ctx: AutoBackContext = { sandboxId: 'sb-1', branch: 'feature/x', enabled: true };
    const scheduler = createAutoBackScheduler({
      debounceMs: DEBOUNCE,
      getContext: () => ctx,
      backUp,
    });

    scheduler.onMutation('sb-1');
    await vi.advanceTimersByTimeAsync(DEBOUNCE); // backup #1 starts, in-flight
    expect(backUp).toHaveBeenCalledTimes(1);

    scheduler.onMutation('sb-1'); // arrives mid-flight → marked pending
    resolveBackup(); // finish #1 → finally re-schedules
    await vi.advanceTimersByTimeAsync(0); // flush the finally + re-schedule
    await vi.advanceTimersByTimeAsync(DEBOUNCE); // second debounce fires
    expect(backUp).toHaveBeenCalledTimes(2);
  });
});
