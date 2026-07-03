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
 * Local-PC mode has no session-attach concept yet (see
 * `DaemonChatBody`'s `sessionAttachToken` doc), so this hook is Remote
 * (relay) only for now — a session id is required to call either RPC.
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
  /** Fetch the daemon's live provider/model for this session. */
  refreshCurrent: () => Promise<void>;
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

  const refreshCurrent = useCallback(async () => {
    if (status.state !== 'open' || !sessionId) return;
    const nonce = ++currentNonceRef.current;
    setLoadingCurrent(true);
    setError(null);
    try {
      const res = await request<unknown>({
        type: 'get_session_snapshot',
        payload: { sessionId, ...(attachToken ? { attachToken } : {}) },
        timeoutMs: 10_000,
      });
      if (currentNonceRef.current !== nonce) return;
      const snapshot = parseSessionSnapshot(res.payload);
      if (!snapshot) throw new Error('daemon returned malformed session snapshot');
      setCurrent({ provider: snapshot.session.provider, model: snapshot.session.model });
    } catch (err) {
      if (currentNonceRef.current !== nonce) return;
      setError(err instanceof Error ? err.message : 'get_session_snapshot failed');
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
  const lastRefreshKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const key = status.state === 'open' && sessionId ? `${sessionId}` : null;
    if (key && key !== lastRefreshKeyRef.current) {
      void refreshCurrent();
    }
    if (!key) {
      // Disconnect/no-session transition — clear synchronously so a
      // resumed session (or reconnect) never briefly shows the prior
      // session's stale provider/model before its own snapshot lands.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCurrent(null);
    }
    lastRefreshKeyRef.current = key;
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
