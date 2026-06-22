import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAutoBackScheduler, type AutoBackContext } from './useWorkspaceSandboxAutoBack';
import type { CheckpointCaptureResult } from '@/lib/checkpoint/checkpoint-store';

const DEBOUNCE = 45_000;
const REPO = 'owner/repo';

function setup(ctxOverrides?: Partial<AutoBackContext>) {
  const ctx: AutoBackContext = {
    sandboxId: 'sb-1',
    branch: 'feature/x',
    repoFullName: REPO,
    enabled: true,
    ...ctxOverrides,
  };
  const capture = vi.fn(async (): Promise<CheckpointCaptureResult> => ({ status: 'clean' }));
  const scheduler = createAutoBackScheduler({
    debounceMs: DEBOUNCE,
    getContext: () => ctx,
    capture,
  });
  return { ctx, capture, scheduler };
}

describe('createAutoBackScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('debounces a burst of mutations into a single backup', async () => {
    const { capture, scheduler } = setup();
    scheduler.onMutation('sb-1');
    await vi.advanceTimersByTimeAsync(DEBOUNCE - 1);
    scheduler.onMutation('sb-1'); // resets the debounce window
    await vi.advanceTimersByTimeAsync(DEBOUNCE - 1);
    expect(capture).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(capture).toHaveBeenCalledTimes(1);
    // First capture has no prior token to dedup against.
    expect(capture).toHaveBeenCalledWith({
      repoFullName: REPO,
      sandboxId: 'sb-1',
      branch: 'feature/x',
      priorToken: undefined,
    });
  });

  it('threads the last dedup token into the next capture so it can dedup (#982)', async () => {
    const ctx: AutoBackContext = {
      sandboxId: 'sb-1',
      branch: 'feature/x',
      repoFullName: REPO,
      enabled: true,
    };
    const capture = vi.fn(
      async (): Promise<CheckpointCaptureResult> => ({ status: 'captured', dedupToken: 'tok-1' }),
    );
    const scheduler = createAutoBackScheduler({
      debounceMs: DEBOUNCE,
      getContext: () => ctx,
      capture,
    });

    scheduler.onMutation('sb-1');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(capture).toHaveBeenNthCalledWith(1, {
      repoFullName: REPO,
      sandboxId: 'sb-1',
      branch: 'feature/x',
      priorToken: undefined,
    });

    scheduler.onMutation('sb-1');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    // Second run carries the token the first capture pinned.
    expect(capture).toHaveBeenNthCalledWith(2, {
      repoFullName: REPO,
      sandboxId: 'sb-1',
      branch: 'feature/x',
      priorToken: 'tok-1',
    });
  });

  it('does not reuse the dedup pin across a branch change', async () => {
    const ctx: AutoBackContext = {
      sandboxId: 'sb-1',
      branch: 'feature/x',
      repoFullName: REPO,
      enabled: true,
    };
    const capture = vi.fn(
      async (input): Promise<CheckpointCaptureResult> => ({
        status: 'captured',
        dedupToken: `tok-${input.branch}`,
      }),
    );
    const scheduler = createAutoBackScheduler({
      debounceMs: DEBOUNCE,
      getContext: () => ctx,
      capture,
    });

    scheduler.onMutation('sb-1');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    ctx.branch = 'feature/y';
    scheduler.onMutation('sb-1');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    // New branch → no carried pin (the pin was for feature/x).
    expect(capture).toHaveBeenNthCalledWith(2, {
      repoFullName: REPO,
      sandboxId: 'sb-1',
      branch: 'feature/y',
      priorToken: undefined,
    });
  });

  it('does nothing without a repoFullName (native store needs the durable key)', async () => {
    const { capture, scheduler } = setup({ repoFullName: null });
    scheduler.onMutation('sb-1');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(capture).not.toHaveBeenCalled();
  });

  it('ignores mutations for a different sandbox', async () => {
    const { capture, scheduler } = setup();
    scheduler.onMutation('sb-other');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(capture).not.toHaveBeenCalled();
  });

  it('does nothing while disabled', async () => {
    const { capture, scheduler } = setup({ enabled: false });
    scheduler.onMutation('sb-1');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(capture).not.toHaveBeenCalled();
  });

  it('flush runs a pending backup immediately (before the debounce)', async () => {
    const { capture, scheduler } = setup();
    scheduler.onMutation('sb-1');
    scheduler.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('flush is a no-op when nothing is pending', async () => {
    const { capture, scheduler } = setup();
    scheduler.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(capture).not.toHaveBeenCalled();
  });

  it('dispose cancels a pending backup', async () => {
    const { capture, scheduler } = setup();
    scheduler.onMutation('sb-1');
    scheduler.dispose();
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(capture).not.toHaveBeenCalled();
  });

  it('coalesces a mutation that lands during an in-flight backup', async () => {
    let resolveBackup: () => void = () => {};
    const capture = vi.fn(
      () =>
        new Promise<CheckpointCaptureResult>((resolve) => {
          resolveBackup = () => resolve({ status: 'captured', dedupToken: 'tok' });
        }),
    );
    const ctx: AutoBackContext = {
      sandboxId: 'sb-1',
      branch: 'feature/x',
      repoFullName: REPO,
      enabled: true,
    };
    const scheduler = createAutoBackScheduler({
      debounceMs: DEBOUNCE,
      getContext: () => ctx,
      capture,
    });

    scheduler.onMutation('sb-1');
    await vi.advanceTimersByTimeAsync(DEBOUNCE); // backup #1 starts, in-flight
    expect(capture).toHaveBeenCalledTimes(1);

    scheduler.onMutation('sb-1'); // arrives mid-flight → marked pending
    resolveBackup(); // finish #1 → finally re-schedules
    await vi.advanceTimersByTimeAsync(0); // flush the finally + re-schedule
    await vi.advanceTimersByTimeAsync(DEBOUNCE); // second debounce fires
    expect(capture).toHaveBeenCalledTimes(2);
  });
});
