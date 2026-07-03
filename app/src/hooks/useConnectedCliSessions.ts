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
 *   - Rows are cleared on deactivate AND on every failure path. The
 *     `CliSessionRow` green "Connected" indicator is honest by
 *     construction only if rows never outlive the connection that
 *     justified them — so no retain-on-close, at the cost of a brief
 *     empty window on reopen while the re-dial + list round-trips.
 *   - Errors degrade to an empty list (the section simply doesn't
 *     render) — a broken relay must not make the chats drawer feel
 *     broken. Symmetric structured logs cover the invisible branches.
 *
 * The connection lifecycle lives in `createConnectedCliSessionsController`,
 * a plain (non-React) controller so the generation guards, the
 * synchronous-open edge, and every failure branch are unit-testable
 * without a DOM renderer; the hook is thin effect glue around it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

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
  /**
   * Tap-to-resume grant over the currently-open connection (see
   * ConnectedCliSessionsController.grant). Resolves null when the
   * drawer's connection isn't open or the daemon refuses.
   */
  grantSessionAttach: (sessionId: string) => Promise<string | null>;
}

export interface ConnectedCliSessionsDeps {
  loadPairedRemote?: () => Promise<PairedRemoteRecord | null>;
  createBinding?: (
    record: PairedRemoteRecord,
    handlers: { onOpen: () => void; onDead: () => void },
  ) => LocalDaemonBinding;
}

export interface ConnectedCliSessionsController {
  /** Dial the stored pairing and emit rows once listed. Supersedes any prior activation. */
  activate(): void;
  /** Close the connection and emit an empty list (Connected rows must not outlive it). */
  deactivate(): void;
  /**
   * Tap-to-resume: ask the daemon for `sessionId`'s attach token over
   * the live connection (`grant_session_attach`). Resolves the bearer,
   * or null when no connection is open / the daemon refuses — callers
   * treat null as "can't resume right now," never as a crash.
   */
  grant(sessionId: string): Promise<string | null>;
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

/**
 * Non-React core of the hook. Each `activate()` bumps a generation
 * counter that every async callback re-checks before emitting, so a
 * superseded attempt (slow IDB read, late WS open, late list response)
 * can never clobber the current one.
 */
export function createConnectedCliSessionsController(opts: {
  loadPairedRemote: () => Promise<PairedRemoteRecord | null>;
  createBinding: (
    record: PairedRemoteRecord,
    handlers: { onOpen: () => void; onDead: () => void },
  ) => LocalDaemonBinding;
  onSessions: (rows: DaemonCliSession[]) => void;
}): ConnectedCliSessionsController {
  let gen = 0;
  let binding: LocalDaemonBinding | null = null;

  const closeBinding = () => {
    binding?.close();
    binding = null;
  };

  const activate = () => {
    const myGen = ++gen;
    closeBinding();
    void (async () => {
      let record: PairedRemoteRecord | null;
      try {
        record = await opts.loadPairedRemote();
      } catch {
        // IndexedDB unavailable (private mode, SSR) — treat as unpaired.
        record = null;
      }
      if (myGen !== gen) return;
      if (!record) {
        // Unpaired is the common steady state for most users — not a
        // log-worthy branch. The section simply never renders.
        opts.onSessions([]);
        return;
      }

      // `created` is assigned after createBinding returns, but a
      // binding implementation may fire onOpen SYNCHRONOUSLY during
      // construction (a test stub; a future pre-opened transport). The
      // `openedBeforeAssign` latch defers the fetch to just after the
      // assignment instead of dereferencing an unassigned variable.
      let created: LocalDaemonBinding | null = null;
      let openedBeforeAssign = false;

      const fetchSessions = () => {
        if (myGen !== gen) return;
        if (!created) {
          openedBeforeAssign = true;
          return;
        }
        const b = created;
        void (async () => {
          try {
            const res = await b.request<{ sessions?: unknown }>({
              type: 'list_sessions',
              timeoutMs: LIST_TIMEOUT_MS,
              payload: { limit: LIST_LIMIT, excludeModes: ['headless'] },
            });
            if (myGen !== gen) return;
            const rows = parseListSessionsPayload(res?.payload);
            opts.onSessions(rows);
            console.log(
              JSON.stringify({
                level: 'info',
                event: 'connected_cli_sessions_listed',
                count: rows.length,
              }),
            );
          } catch (err) {
            if (myGen !== gen) return;
            opts.onSessions([]);
            console.log(
              JSON.stringify({
                level: 'warn',
                event: 'connected_cli_sessions_list_failed',
                error: err instanceof Error ? err.message : String(err),
              }),
            );
          }
        })();
      };

      const onDead = () => {
        if (myGen !== gen) return;
        // The daemon went away while the drawer is open: clear the
        // rows so a stale "Connected" section can't outlive the
        // connection that justified it.
        opts.onSessions([]);
        console.log(
          JSON.stringify({ level: 'info', event: 'connected_cli_sessions_disconnected' }),
        );
      };

      try {
        created = opts.createBinding(record, { onOpen: fetchSessions, onDead });
      } catch (err) {
        if (myGen !== gen) return;
        opts.onSessions([]);
        console.log(
          JSON.stringify({
            level: 'warn',
            event: 'connected_cli_sessions_dial_failed',
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        return;
      }
      if (myGen !== gen) {
        created.close();
        return;
      }
      binding = created;
      if (openedBeforeAssign) fetchSessions();
    })();
  };

  const deactivate = () => {
    gen += 1;
    closeBinding();
    // Clear instead of retaining: a retained row would render the green
    // "Connected" indicator through the next open's reconnect window —
    // or indefinitely if the daemon is gone — breaking the row's
    // honest-by-construction contract. The brief empty state on reopen
    // IS the honest state.
    opts.onSessions([]);
  };

  const grant = async (sessionId: string): Promise<string | null> => {
    const b = binding;
    if (!b) {
      console.log(
        JSON.stringify({ level: 'warn', event: 'connected_cli_sessions_grant_no_binding' }),
      );
      return null;
    }
    try {
      const res = await b.request<{ attachToken?: unknown }>({
        type: 'grant_session_attach',
        timeoutMs: LIST_TIMEOUT_MS,
        payload: { sessionId },
      });
      const token = res?.payload?.attachToken;
      if (typeof token === 'string' && token) return token;
      console.log(
        JSON.stringify({ level: 'warn', event: 'connected_cli_sessions_grant_malformed' }),
      );
      return null;
    } catch (err) {
      console.log(
        JSON.stringify({
          level: 'warn',
          event: 'connected_cli_sessions_grant_failed',
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      return null;
    }
  };

  return { activate, deactivate, grant };
}

export function useConnectedCliSessions(
  active: boolean,
  deps: ConnectedCliSessionsDeps = {},
): UseConnectedCliSessionsResult {
  const [sessions, setSessions] = useState<DaemonCliSession[]>([]);
  // The live controller, so `grantSessionAttach` reaches the CURRENT
  // activation's connection (a stale closure would grant over a closed
  // binding after a drawer close/reopen cycle).
  const controllerRef = useRef<ConnectedCliSessionsController | null>(null);
  // Destructured so the effect can depend on the individual functions:
  // production passes no deps (both stay `undefined`, a stable value),
  // and tests pass module-stable fakes — either way the effect only
  // re-runs on `active` flips.
  const { loadPairedRemote: loadPairedRemoteDep, createBinding: createBindingDep } = deps;

  useEffect(() => {
    if (!active) return;
    const controller = createConnectedCliSessionsController({
      loadPairedRemote: loadPairedRemoteDep ?? getPairedRemote,
      createBinding: createBindingDep ?? defaultCreateBinding,
      onSessions: setSessions,
    });
    controllerRef.current = controller;
    controller.activate();
    return () => {
      controller.deactivate();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [active, loadPairedRemoteDep, createBindingDep]);

  const grantSessionAttach = useCallback(
    (sessionId: string) => controllerRef.current?.grant(sessionId) ?? Promise.resolve(null),
    [],
  );

  return { sessions, grantSessionAttach };
}
