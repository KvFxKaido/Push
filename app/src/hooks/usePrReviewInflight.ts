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

  useEffect(() => {
    // No repo → nothing to poll. The consuming section is hidden when there's
    // no repo, so any stale list is never rendered; we deliberately don't reset
    // state synchronously here (it would make this a "you might not need an
    // effect" reset). A repo switch re-runs the effect and the first poll
    // replaces the list.
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
