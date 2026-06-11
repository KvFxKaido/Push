/**
 * run-diff-snapshot.ts
 *
 * Throttled mid-run diff snapshots for checkpoint cold-resume.
 *
 * Expiry checkpoints have always carried a `savedDiff` because the expiry
 * warning gives us a scheduled moment to fetch one. Mid-run (interrupt)
 * checkpoints historically did not — so when the sandbox died mid-run (OOM
 * kill, container teardown), the cold-resume path could restore the
 * conversation but uncommitted file changes were gone.
 *
 * This tracker closes that gap: checkpoint flush sites kick `capture()`
 * after each save, and the next save folds the freshest snapshot in via
 * `getSavedDiffFor()`. Capture is throttled (a diff fetch is an exec round
 * trip into the sandbox) and single-flight; throttle skips are the designed
 * steady state, not a degradation, so only fetch success/failure get
 * structured log lines.
 *
 * Owned here as a plain factory (not a hook) so the throttle/staleness
 * logic is unit-testable without React; `useChatCheckpoint` holds the one
 * instance per chat surface.
 */

export interface RunDiffSnapshot {
  sandboxId: string;
  diff: string;
  capturedAt: number;
}

export interface RunDiffSnapshotTrackerOptions {
  /** Fetches the uncommitted diff (tracked + untracked) for a sandbox. */
  fetchDiff: (sandboxId: string) => Promise<string>;
  /** Minimum gap between fetches. Default 30s. */
  minIntervalMs?: number;
  /**
   * Snapshots older than this are not offered to checkpoints — a very stale
   * diff is more misleading than the explicit "no snapshot" resume message.
   * Default 10 minutes.
   */
  maxAgeMs?: number;
  now?: () => number;
}

export interface RunDiffSnapshotTracker {
  /**
   * Fetch and stash a snapshot for `sandboxId`. Resolves with the new
   * snapshot, or null when skipped (throttled, already in flight, fetch
   * failed). Never rejects — failures are logged and absorbed so callers
   * can fire-and-forget from synchronous checkpoint paths.
   */
  capture(sandboxId: string): Promise<RunDiffSnapshot | null>;
  /**
   * Latest stashed diff, if it belongs to `sandboxId`, is fresh enough, and
   * is non-empty. An empty diff means "nothing uncommitted at capture time",
   * which the resume message already conveys by omission.
   */
  getSavedDiffFor(sandboxId: string | null | undefined): string | undefined;
  /** Drop any stashed snapshot (e.g. on sandbox teardown). */
  reset(): void;
}

const DEFAULT_MIN_INTERVAL_MS = 30_000;
const DEFAULT_MAX_AGE_MS = 10 * 60_000;

export function createRunDiffSnapshotTracker(
  options: RunDiffSnapshotTrackerOptions,
): RunDiffSnapshotTracker {
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const now = options.now ?? Date.now;

  let snapshot: RunDiffSnapshot | null = null;
  let inFlight = false;
  // Throttle on attempt time, not success time — a failing diff fetch
  // (wedged container) must not turn into a tight retry loop just because
  // it never produces a fresh snapshot. Null = no attempt yet; comparing
  // against 0 would throttle the first capture under any clock near epoch.
  let lastAttemptAt: number | null = null;

  return {
    async capture(sandboxId: string): Promise<RunDiffSnapshot | null> {
      if (!sandboxId) return null;
      if (inFlight) return null;
      const startedAt = now();
      if (lastAttemptAt !== null && startedAt - lastAttemptAt < minIntervalMs) return null;
      inFlight = true;
      lastAttemptAt = startedAt;
      try {
        const diff = await options.fetchDiff(sandboxId);
        const next: RunDiffSnapshot = { sandboxId, diff, capturedAt: now() };
        snapshot = next;
        console.log(
          JSON.stringify({
            level: 'info',
            event: 'run_diff_snapshot_captured',
            sandboxId,
            bytes: diff.length,
          }),
        );
        return next;
      } catch (err) {
        console.log(
          JSON.stringify({
            level: 'warn',
            event: 'run_diff_snapshot_failed',
            sandboxId,
            message: err instanceof Error ? err.message : String(err),
          }),
        );
        return null;
      } finally {
        inFlight = false;
      }
    },

    getSavedDiffFor(sandboxId: string | null | undefined): string | undefined {
      if (!sandboxId || !snapshot) return undefined;
      if (snapshot.sandboxId !== sandboxId) return undefined;
      if (now() - snapshot.capturedAt > maxAgeMs) return undefined;
      return snapshot.diff || undefined;
    },

    reset(): void {
      snapshot = null;
    },
  };
}
