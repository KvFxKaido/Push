/**
 * useDaemonRuntimeSettings - web-side read/write model for daemon-owned
 * execution controls.
 *
 * Repo mode stores these preferences locally because the browser/Worker runs
 * the turn. Daemon sessions run on the paired machine, so this hook round-trips
 * through pushd and only exposes state the daemon actually reported.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  approvalModeToDaemonExecMode,
  daemonExecModeToApprovalMode,
  isDaemonExecMode,
  isDaemonWebSearchBackend,
  type DaemonApprovalMode,
  type DaemonExecMode,
  type DaemonWebSearchBackend,
} from '@push/lib/daemon-runtime-settings';

import type { ConnectionStatus, RequestOptions, SessionResponse } from '@/lib/local-daemon-binding';

export interface DaemonRuntimeSettings {
  execMode: DaemonExecMode;
  approvalMode: DaemonApprovalMode;
  webSearchBackend: DaemonWebSearchBackend;
  configPath?: string;
}

export interface UseDaemonRuntimeSettingsResult {
  settings: DaemonRuntimeSettings | null;
  loading: boolean;
  updating: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  setApprovalMode: (mode: DaemonApprovalMode) => Promise<void>;
  setWebSearchBackend: (backend: DaemonWebSearchBackend) => Promise<void>;
}

function parseDaemonRuntimeSettingsPayload(payload: unknown): DaemonRuntimeSettings | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (!isDaemonExecMode(p.execMode) || !isDaemonWebSearchBackend(p.webSearchBackend)) return null;
  return {
    execMode: p.execMode,
    approvalMode: daemonExecModeToApprovalMode(p.execMode),
    webSearchBackend: p.webSearchBackend,
    ...(typeof p.configPath === 'string' && p.configPath.length > 0
      ? { configPath: p.configPath }
      : {}),
  };
}

export function useDaemonRuntimeSettings(
  request: <T = unknown>(opts: RequestOptions) => Promise<SessionResponse<T>>,
  status: ConnectionStatus,
): UseDaemonRuntimeSettingsResult {
  const [settings, setSettings] = useState<DaemonRuntimeSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetchNonceRef = useRef(0);
  const updateNonceRef = useRef(0);

  const refresh = useCallback(async () => {
    if (status.state !== 'open') return;
    const nonce = ++fetchNonceRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await request<unknown>({
        type: 'get_daemon_runtime_config',
        payload: {},
        timeoutMs: 10_000,
      });
      if (fetchNonceRef.current !== nonce) return;
      const parsed = parseDaemonRuntimeSettingsPayload(res.payload);
      if (!parsed) throw new Error('daemon returned malformed runtime config');
      setSettings(parsed);
    } catch (err) {
      if (fetchNonceRef.current !== nonce) return;
      setError(err instanceof Error ? err.message : 'get_daemon_runtime_config failed');
    } finally {
      if (fetchNonceRef.current === nonce) setLoading(false);
    }
  }, [request, status.state]);

  const update = useCallback(
    async (patch: Partial<Pick<DaemonRuntimeSettings, 'execMode' | 'webSearchBackend'>>) => {
      if (status.state !== 'open') return;
      const nonce = ++updateNonceRef.current;
      setUpdating(true);
      setError(null);
      try {
        const res = await request<unknown>({
          type: 'set_daemon_runtime_config',
          payload: { patch },
          timeoutMs: 10_000,
        });
        if (updateNonceRef.current !== nonce) return;
        const parsed = parseDaemonRuntimeSettingsPayload(res.payload);
        if (!parsed) throw new Error('daemon returned malformed runtime config');
        setSettings(parsed);
      } catch (err) {
        if (updateNonceRef.current !== nonce) return;
        setError(err instanceof Error ? err.message : 'set_daemon_runtime_config failed');
      } finally {
        if (updateNonceRef.current === nonce) setUpdating(false);
      }
    },
    [request, status.state],
  );

  const setApprovalMode = useCallback(
    async (mode: DaemonApprovalMode) => {
      await update({ execMode: approvalModeToDaemonExecMode(mode) });
    },
    [update],
  );

  const setWebSearchBackend = useCallback(
    async (backend: DaemonWebSearchBackend) => {
      await update({ webSearchBackend: backend });
    },
    [update],
  );

  const lastStatusRef = useRef<ConnectionStatus['state'] | null>(null);
  useEffect(() => {
    if (status.state === 'open' && lastStatusRef.current !== 'open') {
      void refresh();
    }
    lastStatusRef.current = status.state;
  }, [status.state, refresh]);

  return {
    settings,
    loading,
    updating,
    error,
    refresh,
    setApprovalMode,
    setWebSearchBackend,
  };
}

export const __test__ = { parseDaemonRuntimeSettingsPayload };
