import { useCallback, useEffect, useRef, useState } from 'react';
import { resolveApiUrl } from '@/lib/api-url';
import type { PrReviewListItem } from '@/worker/pr-review-job-do';

// Fast cadence while a review is in flight (reviews finish in <90s); slow
// background cadence otherwise, so a freshly-pushed webhook review still shows
// up while the hub is open without hammering the endpoint.
const ACTIVE_POLL_MS = 4_000;
const IDLE_POLL_MS = 30_000;

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'superseded', 'duplicate']);

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
      setReviews([]);
      setError(null);
      setLoading(false);
      return;
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
          // 503 (DO not bound) / other: treat as "no history" — the surface
          // stays hidden rather than showing an error for an unconfigured env.
          setReviews([]);
          setError(`pr-reviews ${res.status}`);
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

    setLoading(true);
    void poll();

    return () => {
      cancelled = true;
      controller.abort();
      clearTimer();
    };
  }, [repoFullName, prNumber, nonce]);

  return { reviews, loading, error, refresh };
}
