/**
 * LocalPcWorkspace — workspace shell for a paired `kind: 'local-pc'`
 * session. PR 3b minimum: prove the WS round-trip works end-to-end.
 *
 * What this screen does today:
 *   - Owns one `useLocalDaemon` keyed to the session's binding.
 *   - Renders the always-visible `LocalPcModeChip` in the header.
 *   - Exposes a "Send ping" probe that exercises the request path.
 *   - Streams any events the daemon emits into a capped log.
 *   - Offers an Unpair action that clears storage and exits.
 *
 * What this screen explicitly does NOT do yet (deferred to PR 3c):
 *   - Route `useChat` / sandbox-tools traffic through the daemon.
 *   - Mirror the cloud workspace's chat surface, file browser, etc.
 *
 * Keeping the surface intentionally small here means PR 3b lands as
 * a self-contained "is the transport alive?" view. PR 3c bolts the
 * real workspace UX onto the same `useLocalDaemon` seam.
 */
import { Loader2, MonitorOff, Send } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { LocalPcModeChip } from '@/components/LocalPcModeChip';
import { useLocalDaemon } from '@/hooks/useLocalDaemon';
import { DaemonRequestError, type SessionResponse } from '@/lib/local-daemon-binding';
import { clearPairedDevice } from '@/lib/local-pc-storage';
import type { LocalPcBinding } from '@/types';

interface DaemonIdentity {
  tokenId: string;
  boundOrigin: string;
  daemonVersion: string;
  protocolVersion: string;
}

interface LocalPcWorkspaceProps {
  binding: LocalPcBinding;
  /** Called after the user unpairs — caller ends the workspace session. */
  onUnpair: () => void;
}

interface PingResult {
  ok: boolean;
  detail: string;
  at: number;
  /** Monotonic sequence number — guaranteed unique even if two pings
   *  land in the same millisecond, which `at` alone can't promise. */
  seq: number;
}

export function LocalPcWorkspace({ binding, onUnpair }: LocalPcWorkspaceProps) {
  const { status, events, request, reconnect } = useLocalDaemon(binding);
  const [pingPending, setPingPending] = useState(false);
  const [pingHistory, setPingHistory] = useState<PingResult[]>([]);
  const [identity, setIdentity] = useState<DaemonIdentity | null>(null);
  const pingSeqRef = useRef(0);

  // Fetch daemon identity once the WS is open. Fills the tokenId
  // placeholder in the pairing-details panel; the bearer never round-
  // trips back (pushd only echoes the hashed id + bound origin).
  useEffect(() => {
    if (status.state !== 'open') return;
    let cancelled = false;
    (async () => {
      try {
        const response = (await request({
          type: 'daemon_identify',
        })) as SessionResponse<DaemonIdentity>;
        if (!cancelled) setIdentity(response.payload);
      } catch {
        // Non-fatal: identity is diagnostic UI surface, not transport
        // correctness. The mode chip + ping probe still work without it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status.state, request]);

  const handlePing = async () => {
    if (pingPending) return;
    setPingPending(true);
    const startedAt = Date.now();
    try {
      const response = (await request({ type: 'ping' })) as SessionResponse<{ pong?: boolean }>;
      const rttMs = Date.now() - startedAt;
      setPingHistory((prev) =>
        [
          {
            ok: true,
            detail: response.payload?.pong ? `pong in ${rttMs}ms` : `response in ${rttMs}ms`,
            at: Date.now(),
            seq: ++pingSeqRef.current,
          },
          ...prev,
        ].slice(0, 10),
      );
    } catch (err) {
      const detail =
        err instanceof DaemonRequestError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : 'unknown error';
      setPingHistory((prev) =>
        [{ ok: false, detail, at: Date.now(), seq: ++pingSeqRef.current }, ...prev].slice(0, 10),
      );
    } finally {
      setPingPending(false);
    }
  };

  const handleUnpair = async () => {
    await clearPairedDevice();
    onUnpair();
  };

  return (
    <div className="flex h-dvh flex-col bg-[linear-gradient(180deg,rgba(4,6,10,1)_0%,rgba(2,4,8,1)_100%)] safe-area-top safe-area-bottom">
      <header className="flex items-center justify-between gap-3 border-b border-push-edge/40 px-4 py-3">
        <LocalPcModeChip port={binding.port} status={status} />
        <button
          type="button"
          onClick={handleUnpair}
          className="inline-flex items-center gap-1.5 rounded-full border border-push-edge/60 px-3 py-1.5 text-xs text-push-fg-secondary transition hover:border-rose-400/40 hover:text-rose-200"
        >
          <MonitorOff className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Unpair</span>
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto flex w-full max-w-md flex-col gap-6">
          <section className="space-y-2">
            <h1 className="text-lg font-semibold tracking-tight text-push-fg">Paired</h1>
            <p className="text-sm text-push-fg-dim">
              This browser is talking to a pushd running on{' '}
              <code className="rounded bg-white/5 px-1 py-0.5 text-push-fg-secondary">
                127.0.0.1:{binding.port}
              </code>
              . The chat surface still runs against the cloud sandbox in this build — wiring local
              tool dispatch is the next PR.
            </p>
          </section>

          {status.state === 'unreachable' && (
            <div
              role="alert"
              className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200"
            >
              <p className="font-medium text-rose-100">Daemon unreachable</p>
              <p className="mt-0.5 text-rose-200/80">{status.reason}</p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={reconnect}
                  className="inline-flex items-center gap-1 rounded-full border border-rose-400/40 px-2.5 py-1 text-[11px] text-rose-100 transition hover:bg-rose-500/15"
                >
                  Retry
                </button>
                <button
                  type="button"
                  onClick={handleUnpair}
                  className="inline-flex items-center gap-1 rounded-full border border-rose-400/40 px-2.5 py-1 text-[11px] text-rose-100 transition hover:bg-rose-500/15"
                >
                  Re-pair
                </button>
              </div>
            </div>
          )}

          <section className="space-y-3">
            <h2 className="text-sm font-medium text-push-fg-secondary">Round-trip probe</h2>
            <button
              type="button"
              onClick={handlePing}
              disabled={status.state !== 'open' || pingPending}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-full border border-amber-400/40 bg-amber-500/15 px-4 text-sm font-medium text-amber-100 transition hover:bg-amber-500/25 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pingPending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Send className="h-4 w-4" aria-hidden="true" />
              )}
              <span>Send ping</span>
            </button>

            {pingHistory.length > 0 && (
              <ul className="space-y-1 text-xs">
                {pingHistory.map((entry) => (
                  <li
                    key={entry.seq}
                    className={`flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 ${
                      entry.ok
                        ? 'border-emerald-400/30 bg-emerald-500/5 text-emerald-100'
                        : 'border-rose-400/30 bg-rose-500/5 text-rose-100'
                    }`}
                  >
                    <span className="truncate">{entry.detail}</span>
                    <span className="tabular-nums text-push-fg-dim">
                      {new Date(entry.at).toLocaleTimeString()}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-medium text-push-fg-secondary">
              Events <span className="text-push-fg-dim">({events.length})</span>
            </h2>
            {events.length === 0 ? (
              <p className="text-xs text-push-fg-dim">
                No events yet. The daemon emits events when a session is attached; this build
                doesn&apos;t open one yet.
              </p>
            ) : (
              <ul className="space-y-1 text-[11px] font-mono">
                {events.slice(-20).map((event) => (
                  <li
                    key={`${event.sessionId}:${event.seq}`}
                    className="rounded-md border border-push-edge/40 bg-black/30 px-2 py-1.5 text-push-fg-secondary"
                  >
                    <span className="text-amber-300">{event.type}</span>
                    <span className="ml-1 text-push-fg-dim">
                      seq={event.seq} session={event.sessionId.slice(0, 8)}…
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-2 text-[11px] text-push-fg-dim">
            <h2 className="text-xs font-medium text-push-fg-secondary">Pairing details</h2>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className="text-push-fg-dim">host</dt>
              <dd className="text-push-fg-secondary">127.0.0.1:{binding.port}</dd>
              <dt className="text-push-fg-dim">origin</dt>
              <dd className="text-push-fg-secondary">
                {identity?.boundOrigin || binding.boundOrigin || '(unknown)'}
              </dd>
              <dt className="text-push-fg-dim">token id</dt>
              <dd className="text-push-fg-secondary">
                {identity?.tokenId || binding.tokenId || '(awaiting daemon identity)'}
              </dd>
              {identity && (
                <>
                  <dt className="text-push-fg-dim">daemon</dt>
                  <dd className="text-push-fg-secondary">
                    v{identity.daemonVersion} · proto {identity.protocolVersion}
                  </dd>
                </>
              )}
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
}

export default LocalPcWorkspace;
