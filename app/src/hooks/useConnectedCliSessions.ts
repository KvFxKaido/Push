/**
 * useConnectedCliSessions — surfaces the paired remote daemon's CLI/TUI
 * sessions in the MAIN workspace drawer, next to the cloud chats
 * (Claude Code-style "Connected" rows).
 *
 * `useDaemonCliSessions` already closes the "why don't I see my CLI
 * chat" gap *inside* the Local PC / Remote screens, where a daemon
 * binding is mounted anyway. This hook closes it for the surfaces the
 * user actually lives in — the repo/cloud chat drawer — by dialing the
 * stored relay pairing on demand:
 *
 *   - Lazy lifecycle: connects only while `active` (the drawer is
 *     open), closes on deactivate. No standing WS from every chat
 *     screen; freshness comes free because every open re-fetches.
 *   - No targeted attach: the binding is used purely as an
 *     authenticated `list_sessions` transport (`relay_attach` with no
 *     target session). Read-only rows; resume-into-mobile still needs
 *     the per-session bearer flow (Universal Session Bearer).
 *   - No pairing → permanent no-op. The IndexedDB read re-runs on each
 *     activation, so pairing a phone takes effect on the next drawer
 *     open without a reload.
 *   - Errors degrade to an empty list (the section simply doesn't
 *     render) — a broken relay must not make the chats drawer feel
 *     broken. Symmetric structured logs cover the invisible branches.
 *
 * Deps are injectable for tests; production callers pass none.
 */
import { useEffect, useRef, useState } from 'react';

import type { LocalDaemonBinding } from '@/lib/local-daemon-binding';
import { createRelayDaemonBinding } from '@/lib/relay-daemon-binding';
import { getPairedRemote, type PairedRemoteRecord } from '@/lib/relay-storage';
import { parseListSessionsPayload } from '@/hooks/useDaemonCliSessions';
import type { DaemonCliSession } from '@/types';

const LIST_LIMIT = 50;
const LIST_TIMEOUT_MS = 10_000;

export interface UseConnectedCliSessionsResult {
  /** Non-empty only while a live daemon connection has reported rows. */
  sessions: DaemonCliSession[];
}

export interface ConnectedCliSessionsDeps {
  loadPairedRemote?: () => Promise<PairedRemoteRecord | null>;
  createBinding?: (
    record: PairedRemoteRecord,
    handlers: { onOpen: () => void; onDead: () => void },
  ) => LocalDaemonBinding;
}

function defaultCreateBinding(
  record: PairedRemoteRecord,
  handlers: { onOpen: () => void; onDead: () => void },
): LocalDaemonBinding {
  return createRelayDaemonBinding({
    deploymentUrl: record.deploymentUrl,
    sessionId: record.sessionId,
    token: record.token,
    onStatus: (status) => {
      if (status.state === 'open') handlers.onOpen();
      else if (status.state !== 'connecting') handlers.onDead();
    },
  });
}

export function useConnectedCliSessions(
  active: boolean,
  deps: ConnectedCliSessionsDeps = {},
): UseConnectedCliSessionsResult {
  const [sessions, setSessions] = useState<DaemonCliSession[]>([]);
  // Generation counter: each activation owns one connection attempt.
  // Callbacks from a superseded attempt (slow open, late response)
  // check the generation before touching state.
  const genRef = useRef(0);
  const bindingRef = useRef<LocalDaemonBinding | null>(null);
  // Destructured so the effect can depend on the individual functions:
  // production passes no deps (both stay `undefined`, a stable value),
  // and tests pass module-stable fakes — either way the effect only
  // re-runs on `active` flips.
  const { loadPairedRemote: loadPairedRemoteDep, createBinding: createBindingDep } = deps;

  useEffect(() => {
    if (!active) {
      // Deactivate: drop the connection but keep the last rows — the
      // drawer is closed (nothing renders), and keeping them avoids an
      // empty-flash on the next open while the reconnect is in flight.
      genRef.current += 1;
      bindingRef.current?.close();
      bindingRef.current = null;
      return;
    }

    const gen = ++genRef.current;
    const loadPairedRemote = loadPairedRemoteDep ?? getPairedRemote;
    const createBinding = createBindingDep ?? defaultCreateBinding;

    void (async () => {
      let record: PairedRemoteRecord | null;
      try {
        record = await loadPairedRemote();
      } catch {
        // IndexedDB unavailable (private mode, SSR) — treat as unpaired.
        record = null;
      }
      if (gen !== genRef.current) return;
      if (!record) {
        // Unpaired is the common steady state for most users — not a
        // log-worthy branch. The section simply never renders.
        setSessions([]);
        return;
      }

      let binding: LocalDaemonBinding;
      try {
        binding = createBinding(record, {
          onOpen: () => {
            if (gen !== genRef.current) return;
            void (async () => {
              try {
                const res = await binding.request<{ sessions?: unknown }>({
                  type: 'list_sessions',
                  timeoutMs: LIST_TIMEOUT_MS,
                  payload: { limit: LIST_LIMIT, excludeModes: ['headless'] },
                });
                if (gen !== genRef.current) return;
                const rows = parseListSessionsPayload(res?.payload);
                setSessions(rows);
                console.log(
                  JSON.stringify({
                    level: 'info',
                    event: 'connected_cli_sessions_listed',
                    count: rows.length,
                  }),
                );
              } catch (err) {
                if (gen !== genRef.current) return;
                setSessions([]);
                console.log(
                  JSON.stringify({
                    level: 'warn',
                    event: 'connected_cli_sessions_list_failed',
                    error: err instanceof Error ? err.message : String(err),
                  }),
                );
              }
            })();
          },
          onDead: () => {
            if (gen !== genRef.current) return;
            // The daemon went away while the drawer is open: clear the
            // rows so a stale "Connected" section can't outlive the
            // connection that justified it.
            setSessions([]);
            console.log(
              JSON.stringify({ level: 'info', event: 'connected_cli_sessions_disconnected' }),
            );
          },
        });
      } catch (err) {
        if (gen !== genRef.current) return;
        setSessions([]);
        console.log(
          JSON.stringify({
            level: 'warn',
            event: 'connected_cli_sessions_dial_failed',
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        return;
      }
      if (gen !== genRef.current) {
        binding.close();
        return;
      }
      bindingRef.current = binding;
    })();

    return () => {
      genRef.current += 1;
      bindingRef.current?.close();
      bindingRef.current = null;
    };
  }, [active, loadPairedRemoteDep, createBindingDep]);

  return { sessions };
}
