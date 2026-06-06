import { useCallback, useEffect, useState } from 'react';
import type { AIProviderType } from '@push/lib/provider-contract';
import { resolveApiUrl } from '@/lib/api-url';

interface PrReviewConfigResponse {
  enabled?: boolean;
  provider?: AIProviderType;
  model?: string;
}

export interface PrReviewConfigState {
  /** null until the first load resolves (or if it fails). */
  enabled: boolean | null;
  provider: AIProviderType | null;
  model: string | null;
  saving: boolean;
  error: string | null;
  setEnabled: (next: boolean) => Promise<void>;
  setModelConfig: (provider: AIProviderType, model: string) => Promise<void>;
}

/**
 * Read/write the global automated PR reviewer config behind the Workspace Hub
 * controls. GET on mount; POST optimistically on change (revert on failure).
 * The deployment-token header is attached by the global fetch wrapper; the
 * endpoint is session-gated server-side.
 */
export function usePrReviewConfig(): PrReviewConfigState {
  const [enabled, setEnabledState] = useState<boolean | null>(null);
  const [provider, setProviderState] = useState<AIProviderType | null>(null);
  const [model, setModelState] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyConfig = useCallback((data: PrReviewConfigResponse) => {
    if (typeof data.enabled === 'boolean') setEnabledState(data.enabled);
    if (typeof data.provider === 'string') setProviderState(data.provider);
    if (typeof data.model === 'string') setModelState(data.model);
  }, []);

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
        const data = (await res.json()) as PrReviewConfigResponse;
        if (!cancelled) applyConfig(data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyConfig]);

  const setEnabled = useCallback(
    async (next: boolean) => {
      setSaving(true);
      setError(null);
      let prev: boolean | null = null;
      setEnabledState((curr) => {
        prev = curr;
        return next; // optimistic
      });
      try {
        const res = await fetch(resolveApiUrl('/api/pr-reviews/config'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: next }),
        });
        if (!res.ok) throw new Error(`config ${res.status}`);
        applyConfig((await res.json()) as PrReviewConfigResponse);
      } catch (err) {
        setEnabledState(prev); // revert on failure
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSaving(false);
      }
    },
    [applyConfig],
  );

  const setModelConfig = useCallback(
    async (nextProvider: AIProviderType, nextModel: string) => {
      setSaving(true);
      setError(null);
      const prevProvider = provider;
      const prevModel = model;
      setProviderState(nextProvider);
      setModelState(nextModel);
      try {
        const res = await fetch(resolveApiUrl('/api/pr-reviews/config'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider: nextProvider, model: nextModel }),
        });
        if (!res.ok) throw new Error(`config ${res.status}`);
        applyConfig((await res.json()) as PrReviewConfigResponse);
      } catch (err) {
        setProviderState(prevProvider);
        setModelState(prevModel);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSaving(false);
      }
    },
    [applyConfig, model, provider],
  );

  return { enabled, provider, model, saving, error, setEnabled, setModelConfig };
}
