import { describe, expect, it, vi } from 'vitest';
import { createRunDiffSnapshotTracker } from './run-diff-snapshot';

function makeTracker(overrides?: {
  fetchDiff?: (sandboxId: string) => Promise<string>;
  minIntervalMs?: number;
  maxAgeMs?: number;
  now?: () => number;
}) {
  return createRunDiffSnapshotTracker({
    fetchDiff: overrides?.fetchDiff ?? (async () => 'diff --git a/x b/x'),
    minIntervalMs: overrides?.minIntervalMs,
    maxAgeMs: overrides?.maxAgeMs,
    now: overrides?.now,
  });
}

describe('createRunDiffSnapshotTracker', () => {
  it('captures and serves a snapshot for the matching sandbox', async () => {
    const tracker = makeTracker();

    const snapshot = await tracker.capture('sb-1');

    expect(snapshot?.diff).toBe('diff --git a/x b/x');
    expect(tracker.getSavedDiffFor('sb-1')).toBe('diff --git a/x b/x');
  });

  it('does not serve a snapshot for a different (e.g. recreated) sandbox', async () => {
    const tracker = makeTracker();

    await tracker.capture('sb-1');

    expect(tracker.getSavedDiffFor('sb-2')).toBeUndefined();
    expect(tracker.getSavedDiffFor(null)).toBeUndefined();
  });

  it('treats an empty diff as "nothing to offer" rather than a snapshot', async () => {
    const tracker = makeTracker({ fetchDiff: async () => '' });

    await tracker.capture('sb-1');

    expect(tracker.getSavedDiffFor('sb-1')).toBeUndefined();
  });

  it('throttles capture attempts inside the minimum interval', async () => {
    let clock = 0;
    const fetchDiff = vi.fn(async () => 'diff');
    const tracker = makeTracker({ fetchDiff, minIntervalMs: 30_000, now: () => clock });

    await tracker.capture('sb-1');
    clock += 10_000;
    expect(await tracker.capture('sb-1')).toBeNull();
    expect(fetchDiff).toHaveBeenCalledTimes(1);

    clock += 30_000;
    expect(await tracker.capture('sb-1')).not.toBeNull();
    expect(fetchDiff).toHaveBeenCalledTimes(2);
  });

  it('throttles on attempt time even when the fetch fails', async () => {
    let clock = 0;
    const fetchDiff = vi.fn(async () => {
      throw new Error('sandbox wedged');
    });
    const tracker = makeTracker({ fetchDiff, minIntervalMs: 30_000, now: () => clock });

    expect(await tracker.capture('sb-1')).toBeNull();
    clock += 10_000;
    expect(await tracker.capture('sb-1')).toBeNull();
    expect(fetchDiff).toHaveBeenCalledTimes(1);
  });

  it('is single-flight: a capture during an in-flight fetch is skipped', async () => {
    let release: (diff: string) => void = () => {};
    const fetchDiff = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const tracker = makeTracker({ fetchDiff, minIntervalMs: 0 });

    const first = tracker.capture('sb-1');
    expect(await tracker.capture('sb-1')).toBeNull();
    release('diff');
    expect((await first)?.diff).toBe('diff');
    expect(fetchDiff).toHaveBeenCalledTimes(1);
  });

  it('expires snapshots past the max age', async () => {
    let clock = 0;
    const tracker = makeTracker({ maxAgeMs: 600_000, now: () => clock });

    await tracker.capture('sb-1');
    clock += 599_000;
    expect(tracker.getSavedDiffFor('sb-1')).toBe('diff --git a/x b/x');

    clock += 2_000;
    expect(tracker.getSavedDiffFor('sb-1')).toBeUndefined();
  });

  it('absorbs fetch failures and keeps the previous snapshot', async () => {
    let clock = 0;
    let fail = false;
    const tracker = makeTracker({
      fetchDiff: async () => {
        if (fail) throw new Error('boom');
        return 'good diff';
      },
      minIntervalMs: 0,
      now: () => clock,
    });

    await tracker.capture('sb-1');
    fail = true;
    clock += 1_000;
    expect(await tracker.capture('sb-1')).toBeNull();
    expect(tracker.getSavedDiffFor('sb-1')).toBe('good diff');
  });

  it('reset drops the stashed snapshot', async () => {
    const tracker = makeTracker();

    await tracker.capture('sb-1');
    tracker.reset();

    expect(tracker.getSavedDiffFor('sb-1')).toBeUndefined();
  });
});
