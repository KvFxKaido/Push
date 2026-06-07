import { useCallback, useEffect, useRef, useState } from 'react';
import { resolveApiUrl } from '@/lib/api-url';
import type { PrReviewListItem } from '@/worker/pr-review-job-do';

// Poll briskly while reviews are in flight (they finish in <90s, so a stale
// "running" should clear fast), and slowly when none are, just to discover a
// newly-started one without hammering the endpoint.
const ACTIVE_POLL_MS = 4_000;
const IDLE_POLL_MS = 15_000;

export interface PrReviewInflightState {
  /** Every queued/running review across all of the repo's PRs, newest-first. */
  reviews: PrReviewListItem[];
  error: string | null;
  /** Force an immediate refetch (e.g. right after issuing a cancel). */
  refresh: () => void;
}

/**
 * Poll the cross-PR in-flight view for a repo. Unlike `usePrReviewHistory`
 * (scoped to one PR), this lists active reviews regardless of which branch's PR
 * they belong to — the data behind the global "active reviews" / cancel surface.
 * No-op (empty) when the repo is unknown. The deployment-token header is
 * attached by the global fetch wrapper.
 */
export function usePrReviewInflight(repoFullName: string | null): PrReviewInflightState {
  const [reviews, setReviews] = useState<PrReviewListItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset the cached list the instant the repo changes — React's blessed
  // "adjust state during render" pattern, NOT an in-effect setState. Without
  // this, repo A's rows survive into repo B until B's first poll resolves (and
  // indefinitely if that poll fails), and because the cancel handler binds the
  // *current* repoFullName to a stale row's deliveryId, a cancel could hit the
  // wrong repo's DO. Resetting here scopes the list to repoFullName at all times
  // while still preserving same-repo rows across transient poll failures.
  const [trackedRepo, setTrackedRepo] = useState(repoFullName);
  if (repoFullName !== trackedRepo) {
    setTrackedRepo(repoFullName);
    setReviews([]);
    setError(null);
  }

  useEffect(() => {
    // No repo → nothing to poll (the cross-repo reset above already cleared the
    // list). A repo switch re-runs the effect and the first poll repopulates.
    if (!repoFullName) return;

    let cancelled = false;
    const controller = new AbortController();
    const url = resolveApiUrl(`/api/pr-reviews/inflight?repo=${encodeURIComponent(repoFullName)}`);

    const clearTimer = () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const poll = async () => {
      try {
        const res = await fetch(url, {
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        if (cancelled) return;
        if (!res.ok) {
          // Non-OK (503 unconfigured DO, transient 429/5xx during a deploy):
          // keep the last list and retry at the idle cadence rather than wiping
          // the surface, so an in-progress cancel target doesn't flicker away.
          setError(`pr-reviews/inflight ${res.status}`);
          clearTimer();
          timerRef.current = setTimeout(poll, IDLE_POLL_MS);
          return;
        }
        const data = (await res.json()) as { reviews?: PrReviewListItem[] };
        if (cancelled) return;
        const next = Array.isArray(data.reviews) ? data.reviews : [];
        setReviews(next);
        setError(null);
        clearTimer();
        timerRef.current = setTimeout(poll, next.length > 0 ? ACTIVE_POLL_MS : IDLE_POLL_MS);
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
        clearTimer();
        timerRef.current = setTimeout(poll, IDLE_POLL_MS);
      }
    };

    void poll();

    return () => {
      cancelled = true;
      controller.abort();
      clearTimer();
    };
  }, [repoFullName, nonce]);

  return { reviews, error, refresh };
}
