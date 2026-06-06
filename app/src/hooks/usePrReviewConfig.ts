import { useCallback, useEffect, useState } from 'react';
import { resolveApiUrl } from '@/lib/api-url';

export interface PrReviewConfigState {
  /** null until the first load resolves (or if it fails). */
  enabled: boolean | null;
  saving: boolean;
  error: string | null;
  setEnabled: (next: boolean) => Promise<void>;
}

/**
 * Read/write the global "automated PR reviewer enabled" flag behind the in-app
 * toggle. GET on mount; POST optimistically on change (revert on failure). The
 * deployment-token header is attached by the global fetch wrapper; the endpoint
 * is session-gated server-side.
 */
export function usePrReviewConfig(): PrReviewConfigState {
  const [enabled, setEnabledState] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(resolveApiUrl('/api/pr-reviews/config'), {
          headers: { Accept: 'application/json' },
        });
        if (cancelled) return;
        if (!res.ok) {
          setError(`config ${res.status}`);
          return;
        }
        const data = (await res.json()) as { enabled?: boolean };
        if (!cancelled && typeof data.enabled === 'boolean') setEnabledState(data.enabled);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setEnabled = useCallback(
    async (next: boolean) => {
      setSaving(true);
      setError(null);
      const prev = enabled;
      setEnabledState(next); // optimistic
      try {
        const res = await fetch(resolveApiUrl('/api/pr-reviews/config'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: next }),
        });
        if (!res.ok) throw new Error(`config ${res.status}`);
        const data = (await res.json()) as { enabled?: boolean };
        setEnabledState(typeof data.enabled === 'boolean' ? data.enabled : next);
      } catch (err) {
        setEnabledState(prev); // revert on failure
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSaving(false);
      }
    },
    [enabled],
  );

  return { enabled, saving, error, setEnabled };
}
