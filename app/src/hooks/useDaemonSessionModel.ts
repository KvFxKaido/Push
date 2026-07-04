/**
 * useDaemonSessionModel — web-side read/write model for a Remote daemon
 * session's active provider/model.
 *
 * Unlike `useDaemonRuntimeSettings` (daemon-global exec mode / search
 * backend), the active model is per-SESSION state owned by pushd
 * (`state.provider`/`state.model`, mutated via `update_session`) — the
 * same RPC the TUI's own `/model` and `/provider` commands already call
 * (`switchModel`/`switchProvider` in `cli/tui.ts`). This hook makes the
 * web client another caller of that same verb instead of rendering a
 * browser-local preference that has nothing to do with what the paired
 * session is actually running.
 *
 * This hook is Remote (relay) only: a daemon session id is required to call
 * either RPC.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { parseSessionSnapshot } from '@/lib/daemon-snapshot';
import type { ConnectionStatus, RequestOptions, SessionResponse } from '@/lib/local-daemon-binding';

export interface DaemonProviderOption {
  id: string;
  url: string;
  defaultModel: string;
  requiresKey: boolean;
  hasKey: boolean;
  models: string[];
}

export interface DaemonSessionModel {
  provider: string | null;
  model: string | null;
}

export interface UseDaemonSessionModelResult {
  current: DaemonSessionModel | null;
  providers: DaemonProviderOption[] | null;
  loadingCurrent: boolean;
  loadingProviders: boolean;
  updating: boolean;
  error: string | null;
  /** Fetch the daemon's live provider/model for this session. Resolves to
   *  whether it actually landed, so a caller can decide to retry. */
  refreshCurrent: () => Promise<boolean>;
  /** Fetch the daemon's provider/model catalog. On-demand (picker open), not eager. */
  loadProviders: () => Promise<void>;
  /** Switch this session's provider/model through the daemon's own `update_session` verb. */
  setModel: (provider: string, model: string) => Promise<void>;
}

function parseProviderList(payload: unknown): DaemonProviderOption[] | null {
  if (!payload || typeof payload !== 'object') return null;
  const providers = (payload as Record<string, unknown>).providers;
  if (!Array.isArray(providers)) return null;
  const parsed: DaemonProviderOption[] = [];
  for (const entry of providers) {
    if (!entry || typeof entry !== 'object') continue;
    const p = entry as Record<string, unknown>;
    if (typeof p.id !== 'string' || typeof p.defaultModel !== 'string') continue;
    parsed.push({
      id: p.id,
      url: typeof p.url === 'string' ? p.url : '',
      defaultModel: p.defaultModel,
      requiresKey: p.requiresKey === true,
      hasKey: p.hasKey === true,
      models: Array.isArray(p.models)
        ? p.models.filter((m): m is string => typeof m === 'string')
        : [],
    });
  }
  return parsed;
}

function parseUpdateSessionModel(payload: unknown): DaemonSessionModel | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const provider = typeof p.provider === 'string' ? p.provider : null;
  const model = typeof p.model === 'string' ? p.model : null;
  if (!provider && !model) return null;
  return { provider, model };
}

/**
 * `curated` is a static list (`getCuratedModels`) — the session's actual
 * active model can be a config-set or provider-live one outside it. The
 * picker must always let the real active model show as selected, not just
 * approximate it via the trigger label while the dropdown itself lists
 * only the curated set (fugu's review on #1319).
 */
export function mergeModelOptions(curated: readonly string[], value: string): string[] {
  return curated.includes(value) ? [...curated] : [value, ...curated];
}

export function useDaemonSessionModel(
  request: <T = unknown>(opts: RequestOptions) => Promise<SessionResponse<T>>,
  status: ConnectionStatus,
  sessionId: string | null,
  attachToken: string | null,
): UseDaemonSessionModelResult {
  const [current, setCurrent] = useState<DaemonSessionModel | null>(null);
  const [providers, setProviders] = useState<DaemonProviderOption[] | null>(null);
  const [loadingCurrent, setLoadingCurrent] = useState(false);
  const [loadingProviders, setLoadingProviders] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currentNonceRef = useRef(0);
  const providersNonceRef = useRef(0);
  const updateNonceRef = useRef(0);

  /** Returns whether the fetch actually landed — the auto-retry effect below
   *  needs to distinguish success from a stale/superseded nonce no-op. */
  const refreshCurrent = useCallback(async (): Promise<boolean> => {
    if (status.state !== 'open' || !sessionId) return false;
    const nonce = ++currentNonceRef.current;
    setLoadingCurrent(true);
    setError(null);
    try {
      const res = await request<unknown>({
        type: 'get_session_snapshot',
        payload: { sessionId, ...(attachToken ? { attachToken } : {}) },
        timeoutMs: 10_000,
      });
      if (currentNonceRef.current !== nonce) return false;
      const snapshot = parseSessionSnapshot(res.payload);
      if (!snapshot) throw new Error('daemon returned malformed session snapshot');
      setCurrent({ provider: snapshot.session.provider, model: snapshot.session.model });
      return true;
    } catch (err) {
      if (currentNonceRef.current !== nonce) return false;
      setError(err instanceof Error ? err.message : 'get_session_snapshot failed');
      return false;
    } finally {
      if (currentNonceRef.current === nonce) setLoadingCurrent(false);
    }
  }, [request, status.state, sessionId, attachToken]);

  const loadProviders = useCallback(async () => {
    if (status.state !== 'open') return;
    const nonce = ++providersNonceRef.current;
    setLoadingProviders(true);
    setError(null);
    try {
      const res = await request<unknown>({
        type: 'list_providers',
        payload: {},
        timeoutMs: 10_000,
      });
      if (providersNonceRef.current !== nonce) return;
      const parsed = parseProviderList(res.payload);
      if (!parsed) throw new Error('daemon returned malformed provider list');
      setProviders(parsed);
    } catch (err) {
      if (providersNonceRef.current !== nonce) return;
      setError(err instanceof Error ? err.message : 'list_providers failed');
    } finally {
      if (providersNonceRef.current === nonce) setLoadingProviders(false);
    }
  }, [request, status.state]);

  const setModel = useCallback(
    async (provider: string, model: string) => {
      if (status.state !== 'open' || !sessionId) return;
      const nonce = ++updateNonceRef.current;
      setUpdating(true);
      setError(null);
      try {
        const res = await request<unknown>({
          type: 'update_session',
          payload: {
            sessionId,
            ...(attachToken ? { attachToken } : {}),
            patch: { provider, model },
          },
          timeoutMs: 10_000,
        });
        if (updateNonceRef.current !== nonce) return;
        const parsed = parseUpdateSessionModel(res.payload);
        if (!parsed) throw new Error('daemon returned malformed session state');
        setCurrent(parsed);
      } catch (err) {
        if (updateNonceRef.current !== nonce) return;
        setError(err instanceof Error ? err.message : 'update_session failed');
      } finally {
        if (updateNonceRef.current === nonce) setUpdating(false);
      }
    },
    [request, status.state, sessionId, attachToken],
  );

  // Refresh once per open transition, keyed on sessionId too — a resumed
  // Connected-session switch (RelayChatScreen's tap-to-resume) re-targets
  // the same open connection to a different sessionId without a status
  // transition, and the previous session's provider/model must not leak
  // into the new one's picker.
  //
  // `lastRefreshKeyRef` is marked as soon as the fetch is FIRED (not once
  // it succeeds) so this effect doesn't refire the same request on every
  // unrelated re-render. That alone would mean a transient failure (a
  // timeout, a blip) never retries without a full reconnect — fugu's
  // review on #1319. One bounded automatic retry after a short delay
  // covers that without risking an unbounded retry loop; a session/status
  // change mid-retry cancels the pending timer via the key check.
  const lastRefreshKeyRef = useRef<string | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const key = status.state === 'open' && sessionId ? `${sessionId}` : null;
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    if (key && key !== lastRefreshKeyRef.current) {
      lastRefreshKeyRef.current = key;
      void refreshCurrent().then((ok) => {
        if (ok || lastRefreshKeyRef.current !== key) return;
        retryTimerRef.current = setTimeout(() => {
          if (lastRefreshKeyRef.current === key) void refreshCurrent();
        }, 2_000);
      });
    }
    if (!key) {
      // Disconnect/no-session transition — clear synchronously so a
      // resumed session (or reconnect) never briefly shows the prior
      // session's stale provider/model before its own snapshot lands.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCurrent(null);
      lastRefreshKeyRef.current = null;
    }
    return () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, [status.state, sessionId, refreshCurrent]);

  return {
    current,
    providers,
    loadingCurrent,
    loadingProviders,
    updating,
    error,
    refreshCurrent,
    loadProviders,
    setModel,
  };
}

export const __test__ = { parseProviderList, parseUpdateSessionModel };
