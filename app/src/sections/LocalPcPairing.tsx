/**
 * LocalPcPairing — inline pairing panel for the Local PC workspace
 * mode. Collects a port + bearer token from the user, opens a
 * loopback WebSocket against the running pushd to verify them, and
 * — on a successful connect — persists the binding and notifies the
 * caller.
 *
 * The panel is the only place outside `local-pc-storage.ts` that
 * holds the bearer token as plaintext in memory. Inputs use
 * `type="password"`; the token is never logged, never echoed into
 * error messages, and is cleared from local state on success or
 * cancel.
 *
 * Layout: full-screen-replacement-y. Pairing is rare (one-time per
 * device); the form gets the whole viewport, not a sliver.
 */
import { ArrowLeft, ChevronRight, Loader2, Monitor, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createLocalDaemonBinding, type LocalDaemonBinding } from '@/lib/local-daemon-binding';
import { LOCAL_PC_HOST, isValidPort } from '@/lib/local-pc-binding';
import {
  mintPairedDeviceId,
  setPairedDevice,
  type PairedDeviceRecord,
} from '@/lib/local-pc-storage';
import type { LocalPcBinding } from '@/types';

interface LocalPcPairingProps {
  /** Fired on successful pair. The caller swaps the screen to the workspace. */
  onPaired: (binding: LocalPcBinding) => void;
  /** Optional back button (returns to hub). */
  onCancel?: () => void;
}

type PairState = { kind: 'idle' } | { kind: 'testing' } | { kind: 'failed'; reason: string };

const DEFAULT_PORT_PLACEHOLDER = 'e.g. 49152';
const TEST_TIMEOUT_MS = 10_000;

export function LocalPcPairing({ onPaired, onCancel }: LocalPcPairingProps) {
  const [portInput, setPortInput] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const [state, setState] = useState<PairState>({ kind: 'idle' });

  // The test connection is owned by this component; close it on
  // unmount (Strict Mode + navigation), and never let two probes
  // run concurrently if the user double-clicks Pair. The handle +
  // its backstop timer travel together so a callback from probe N
  // can't accidentally clear the timer belonging to probe N+1
  // (race surfaced in PR #510 review).
  const inFlightRef = useRef<{
    handle: LocalDaemonBinding;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);

  useEffect(() => {
    return () => {
      if (inFlightRef.current) {
        clearTimeout(inFlightRef.current.timer);
        inFlightRef.current.handle.close();
        inFlightRef.current = null;
      }
    };
  }, []);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const commandPreview = `push daemon pair --origin ${origin || 'http://localhost:5173'}`;

  const portValid = portInput.length === 0 || isValidPort(portInput);
  const formValid = isValidPort(portInput) && tokenInput.trim().length > 0;

  const finishTest = (
    handle: LocalDaemonBinding,
    outcome: PairState,
    paired?: { binding: LocalPcBinding; record: PairedDeviceRecord },
  ) => {
    // Only the in-flight probe gets to retire. Late callbacks from a
    // superseded handle close their own WS and bail.
    const inFlight = inFlightRef.current;
    if (!inFlight || inFlight.handle !== handle) {
      handle.close();
      return;
    }
    clearTimeout(inFlight.timer);
    inFlight.handle.close();
    inFlightRef.current = null;

    if (paired) {
      // Storage failure here is recoverable: if the put fails, the user
      // re-clicks Local PC on next boot and lands back on the pairing
      // form (the load path drops a tombstone with no binding). The
      // alternative — awaiting setPairedDevice — would block the UI
      // transition behind a write that almost never fails.
      void setPairedDevice(paired.record);
      onPaired(paired.binding);
      return;
    }
    setState(outcome);
  };

  const handlePair = (event?: { preventDefault?: () => void }) => {
    event?.preventDefault?.();
    // Synchronous in-flight guard. `state.kind === 'testing'` lags by
    // a render after `setState`, so two clicks dispatched in the same
    // frame would both pass that check; the ref reflects the truth at
    // the moment of the call.
    if (!formValid || inFlightRef.current !== null) return;
    setState({ kind: 'testing' });

    const portNum = Number(portInput);
    const token = tokenInput.trim();

    const handle = createLocalDaemonBinding({
      port: portNum,
      token,
      host: LOCAL_PC_HOST,
      onStatus: (status) => {
        if (status.state === 'connecting') return;
        if (status.state === 'open') {
          // Phase 3 slice 2: as soon as the WS proves the device
          // token is valid, immediately mint a device-attach token
          // on the SAME connection and persist THAT instead of the
          // durable bearer. The durable token never reaches
          // IndexedDB — the only place it ever was held is this
          // function's local `token` variable, which the React
          // controlled-input flow clears on success below.
          //
          // The mint is best-effort: older daemons that don't yet
          // implement `mint_device_attach_token` reject the request
          // with UNSUPPORTED_REQUEST_TYPE. We fall back to storing
          // the device token directly so pairing still works against
          // pre-slice-2 daemons. The CLI ships in lockstep, so this
          // matters only for users running mixed versions during
          // upgrade.
          void (async () => {
            const id = mintPairedDeviceId();
            let bearer = token;
            let attachTokenId: string | undefined;
            try {
              const mintResponse = await handle.request<{
                token: string;
                tokenId: string;
                ttlMs: number;
                parentTokenId: string;
              }>({
                type: 'mint_device_attach_token',
                payload: {},
                timeoutMs: 5_000,
              });
              bearer = mintResponse.payload.token;
              attachTokenId = mintResponse.payload.tokenId;
            } catch {
              // Pre-slice-2 daemon, transient error, or the bearer
              // is somehow already an attach token. Either way, fall
              // back to the device-token-only path — pairing still
              // works, just without the blast-radius reduction.
            }
            const binding: LocalPcBinding = {
              port: portNum,
              token: bearer,
              boundOrigin: origin,
            };
            const record: PairedDeviceRecord = {
              id,
              port: portNum,
              token: bearer,
              attachTokenId,
              boundOrigin: origin,
              pairedAt: Date.now(),
              lastUsedAt: Date.now(),
            };
            finishTest(handle, { kind: 'idle' }, { binding, record });
          })();
          return;
        }
        // unreachable | closed — surface a generic reason. The
        // adapter intentionally collapses upgrade failures into one
        // bucket so we don't leak whether the token, origin, or
        // port was the wrong one.
        finishTest(handle, {
          kind: 'failed',
          reason:
            status.reason ||
            (status.state === 'unreachable'
              ? 'could not reach pushd on that port + token'
              : 'connection closed unexpectedly'),
        });
      },
    });

    // Backstop: if the WS upgrade hangs (e.g. pushd not listening at
    // all, OS holding the SYN), the adapter would sit at 'connecting'
    // indefinitely. Cap the test wait independently — and capture the
    // timer alongside the handle so finishTest can clear the right one.
    const timer = setTimeout(() => {
      finishTest(handle, {
        kind: 'failed',
        reason: 'timed out waiting for pushd',
      });
    }, TEST_TIMEOUT_MS);
    inFlightRef.current = { handle, timer };
  };

  const isTesting = state.kind === 'testing';

  return (
    <div className="flex h-dvh flex-col bg-[linear-gradient(180deg,rgba(4,6,10,1)_0%,rgba(2,4,8,1)_100%)] safe-area-top safe-area-bottom">
      <header className="flex items-center justify-between border-b border-push-edge/40 px-4 py-3">
        <div className="flex items-center gap-2.5">
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              aria-label="Back to hub"
              className="-ml-2 inline-flex h-8 w-8 items-center justify-center rounded-full text-push-fg-secondary transition hover:bg-white/5"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
          )}
          <Monitor className="h-4 w-4 text-amber-300" aria-hidden="true" />
          <h1 className="text-sm font-semibold tracking-tight text-push-fg">Pair Local PC</h1>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto flex w-full max-w-md flex-col gap-6">
          <section className="space-y-2">
            <h2 className="text-base font-medium text-push-fg">Run this on your PC</h2>
            <p className="text-xs text-push-fg-dim">
              Mints a one-time bearer token bound to this browser&apos;s origin. Copy the bearer
              into the form below — it&apos;s only shown once.
            </p>
            <pre
              className="overflow-x-auto rounded-lg border border-push-edge/50 bg-black/40 p-3 font-mono text-xs text-push-fg-secondary"
              aria-label="Pairing command"
            >
              {commandPreview}
            </pre>
            <p className="flex items-center gap-1.5 text-[11px] text-push-fg-dim">
              <ShieldCheck className="h-3 w-3 text-emerald-300" aria-hidden="true" />
              Origin auto-filled from this tab so it can&apos;t drift.
            </p>
          </section>

          <form className="space-y-3" onSubmit={handlePair} aria-label="Local PC pairing">
            <div className="space-y-1.5">
              <label htmlFor="local-pc-port" className="text-xs font-medium text-push-fg-secondary">
                Port
              </label>
              <input
                id="local-pc-port"
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
                placeholder={DEFAULT_PORT_PLACEHOLDER}
                value={portInput}
                disabled={isTesting}
                onChange={(e) => setPortInput(e.target.value.replace(/[^0-9]/g, ''))}
                className={`w-full rounded-lg border bg-black/40 px-3 py-2 text-sm text-push-fg outline-none placeholder:text-push-fg-dim focus:border-amber-400/60 ${
                  portValid ? 'border-push-edge/60' : 'border-rose-400/60'
                }`}
              />
              <p className="text-[11px] text-push-fg-dim">
                Find this with{' '}
                <code className="rounded bg-white/5 px-1 py-0.5 text-push-fg-secondary">
                  cat ~/.push/run/pushd.port
                </code>{' '}
                on your PC.
              </p>
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="local-pc-token"
                className="text-xs font-medium text-push-fg-secondary"
              >
                Bearer token
              </label>
              <input
                id="local-pc-token"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="Paste the bearer token"
                value={tokenInput}
                disabled={isTesting}
                onChange={(e) => setTokenInput(e.target.value)}
                className="w-full rounded-lg border border-push-edge/60 bg-black/40 px-3 py-2 text-sm text-push-fg outline-none placeholder:text-push-fg-dim focus:border-amber-400/60"
              />
              <p className="text-[11px] text-push-fg-dim">
                Stored in this browser&apos;s IndexedDB. Only sent to{' '}
                <code className="rounded bg-white/5 px-1 py-0.5 text-push-fg-secondary">
                  {LOCAL_PC_HOST}
                </code>{' '}
                on your PC.
              </p>
            </div>

            {state.kind === 'failed' && (
              <div
                role="alert"
                className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200"
              >
                <p className="font-medium text-rose-100">Pairing failed</p>
                <p className="mt-0.5 text-rose-200/80">{state.reason}</p>
                <p className="mt-1.5 text-rose-200/70">
                  Check that pushd is running with{' '}
                  <code className="rounded bg-black/30 px-1 py-0.5">PUSHD_WS=1</code> and that the
                  port + token match.
                </p>
              </div>
            )}

            <button
              type="submit"
              disabled={!formValid || isTesting}
              className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-full border border-amber-400/40 bg-amber-500/15 text-sm font-medium text-amber-100 transition hover:bg-amber-500/25 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isTesting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  <span>Testing connection…</span>
                </>
              ) : (
                <>
                  <span>Pair this PC</span>
                  <ChevronRight className="h-4 w-4" aria-hidden="true" />
                </>
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

export default LocalPcPairing;
