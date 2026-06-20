import { useCallback, useEffect, useRef, useState } from 'react';
import { resolveApiUrl } from '@/lib/api-url';
import type { PrReviewListItem } from '@/worker/pr-review-job-do';

// Fast cadence while a review is in flight (reviews finish in <90s); slow
// background cadence otherwise, so a freshly-pushed webhook review still shows
// up while the hub is open without hammering the endpoint.
const ACTIVE_POLL_MS = 4_000;
const IDLE_POLL_MS = 30_000;

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'superseded', 'duplicate', 'cancelled']);

/**
 * Trigger a fresh review for a PR now (manual re-run). The worker resolves the
 * installation server-side from the repo, so the client only sends repo + pr.
 * Throws on a non-2xx so callers can surface the failure. The deployment-token
 * header is attached by the global fetch wrapper.
 */
export async function triggerPrReview(repoFullName: string, prNumber: number): Promise<void> {
  const res = await fetch(resolveApiUrl('/api/pr-reviews/run'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo: repoFullName, pr: prNumber }),
  });
  if (!res.ok) {
    throw new Error(`pr-review run failed (${res.status})`);
  }
}

/**
 * Cancel an in-flight (queued/running) review for a PR. Addresses the review by
 * `deliveryId` within the PR's DO. Throws on a non-2xx so callers can surface the
 * failure — notably a 409 when the review reached a terminal state first (a
 * stale-tab race), which the caller can treat as "already done" and just refresh.
 * The deployment-token header is attached by the global fetch wrapper.
 */
export async function cancelPrReview(
  repoFullName: string,
  prNumber: number,
  deliveryId: string,
): Promise<void> {
  const res = await fetch(resolveApiUrl('/api/pr-reviews/cancel'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo: repoFullName, pr: prNumber, deliveryId }),
  });
  if (!res.ok) {
    throw new Error(`pr-review cancel failed (${res.status})`);
  }
}

export interface PrReviewHistoryState {
  reviews: PrReviewListItem[];
  loading: boolean;
  error: string | null;
  /** Force an immediate refetch (e.g. after the user posts a manual review). */
  refresh: () => void;
}

function anyInFlight(reviews: PrReviewListItem[]): boolean {
  return reviews.some((r) => !TERMINAL_STATUSES.has(r.status));
}

/**
 * Poll the PrReviewJob DO's review history for one PR. Returns the reviews
 * newest-first and self-schedules a refetch — fast while any review is
 * non-terminal, slow otherwise. No-op (empty, not loading) when repo/PR are
 * unknown. The deployment-token header is attached by the global fetch wrapper.
 */
export function usePrReviewHistory(
  repoFullName: string | null,
  prNumber: number | null,
): PrReviewHistoryState {
  const [reviews, setReviews] = useState<PrReviewListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Bump to force a refetch; also used to cancel in-flight scheduling on
  // unmount / dependency change.
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!repoFullName || !prNumber) {
      const id = setTimeout(() => {
        setReviews([]);
        setError(null);
        setLoading(false);
      }, 0);
      return () => clearTimeout(id);
    }

    let cancelled = false;
    const controller = new AbortController();
    const url = resolveApiUrl(
      `/api/pr-reviews?repo=${encodeURIComponent(repoFullName)}&pr=${prNumber}`,
    );

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
          // hide the surface but keep polling at the idle cadence so a review
          // that starts/finishes later still appears without a remount.
          setReviews([]);
          setError(`pr-reviews ${res.status}`);
          clearTimer();
          timerRef.current = setTimeout(poll, IDLE_POLL_MS);
          return;
        }
        const data = (await res.json()) as { reviews?: PrReviewListItem[] };
        if (cancelled) return;
        const next = Array.isArray(data.reviews) ? data.reviews : [];
        setReviews(next);
        setError(null);
        // Reschedule: fast while a review is running, slow otherwise.
        clearTimer();
        timerRef.current = setTimeout(poll, anyInFlight(next) ? ACTIVE_POLL_MS : IDLE_POLL_MS);
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
        // Back off to the idle cadence on transient failure rather than stop.
        clearTimer();
        timerRef.current = setTimeout(poll, IDLE_POLL_MS);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    const startTimer = setTimeout(() => {
      setLoading(true);
      void poll();
    }, 0);

    return () => {
      cancelled = true;
      clearTimeout(startTimer);
      controller.abort();
      clearTimer();
    };
  }, [repoFullName, prNumber, nonce]);

  return { reviews, loading, error, refresh };
}
