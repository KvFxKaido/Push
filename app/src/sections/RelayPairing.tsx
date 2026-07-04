/**
 * RelayPairing — single-field pairing panel for the Remote (relay)
 * workspace mode.
 *
 * UX: one textarea for the bundle string from `push daemon pair
 * --remote`. The panel decodes the bundle, opens a transient WS to
 * the relay to verify the bearer authenticates + the deployment is
 * reachable, and on success persists the binding to IndexedDB and
 * notifies the caller.
 *
 * Token discipline: the bundle is held in memory only for the duration of the
 * panel, is type=password via a hidden textarea autocomplete, and is cleared on
 * success / failure / cancel. Never logged, never echoed into error messages.
 *
 * The 2.f scope picked single bundled paste as the main UX (vs
 * three-field manual entry). If users hit edge cases that require
 * raw three-field paste — e.g. trying to debug a malformed bundle
 * mid-rollout — that lands as a separate debug-mode panel; this
 * one stays focused on the happy path.
 */
import { ChevronRight, Globe, Loader2, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createRelayDaemonBinding } from '@/lib/relay-daemon-binding';
import { type LocalDaemonBinding } from '@/lib/local-daemon-binding';
import { parseRemotePairBundle } from '@/lib/relay-binding';
import { mintPairedRemoteId, setPairedRemote, type PairedRemoteRecord } from '@/lib/relay-storage';
import type { RelayBinding } from '@/types';
import { HeaderBar, PageScaffold, SectionCard, StatusBanner } from '@/components/layout';
import { HUB_MATERIAL_BUTTON_CLASS, HUB_MATERIAL_INPUT_CLASS } from '@/components/chat/hub-styles';

interface RelayPairingProps {
  /** Fired on successful pair. The caller swaps the screen to the workspace. */
  onPaired: (binding: RelayBinding) => void;
  /** Optional back button (returns to hub). */
  onCancel?: () => void;
}

type PairState = { kind: 'idle' } | { kind: 'testing' } | { kind: 'failed'; reason: string };

const TEST_TIMEOUT_MS = 10_000;

export function RelayPairing({ onPaired, onCancel }: RelayPairingProps) {
  const [bundleInput, setBundleInput] = useState('');
  const [state, setState] = useState<PairState>({ kind: 'idle' });

  // In-flight probe handle + backstop timer. Each probe carries its own
  // handle reference;
  // a late callback from a superseded handle closes its own WS and
  // bails so it can't retire the current probe.
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

  const formValid = bundleInput.trim().length > 0 && state.kind !== 'testing';

  const finishTest = (
    handle: LocalDaemonBinding,
    outcome: PairState,
    paired?: { binding: RelayBinding; record: PairedRemoteRecord },
  ) => {
    const inFlight = inFlightRef.current;
    if (!inFlight || inFlight.handle !== handle) {
      handle.close();
      return;
    }
    clearTimeout(inFlight.timer);
    inFlight.handle.close();
    inFlightRef.current = null;

    // Clear the bundle from local state on either success OR failure.
    // The bundle carries the bearer; leaving it in a textarea state
    // would survive component pooling and any future devtools dump.
    // Failure clear forces a re-paste (intentional: a mistyped paste
    // shouldn't sit in the input).
    setBundleInput('');
    setState(outcome);

    if (paired) {
      void setPairedRemote(paired.record).catch((err) => {
        // Persistence failure shouldn't block the user from using
        // the binding for this session — surface it on the next
        // open via the dashboard, but proceed to the chat screen.
        console.warn('[relay-pairing] persist failed', err);
      });
      onPaired(paired.binding);
    }
  };

  const handlePair = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formValid) return;

    const decoded = parseRemotePairBundle(bundleInput);
    if (!decoded) {
      // #530 Copilot review: token discipline says clear on
      // success / failure / cancel — the malformed-bundle early
      // return forgot to clear, leaving the bearer in component
      // state. The user has to re-paste anyway because we can't
      // tell them which field went wrong without leaking which
      // check failed, so the clear is also UX-honest.
      setBundleInput('');
      setState({
        kind: 'failed',
        reason:
          "That doesn't look like a Remote pairing bundle. Re-run `push daemon pair --remote` and paste the full output line.",
      });
      return;
    }

    setState({ kind: 'testing' });

    const binding: RelayBinding = {
      deploymentUrl: decoded.deploymentUrl,
      sessionId: decoded.sessionId,
      token: decoded.token,
      attachTokenId: decoded.attachTokenId,
      deviceTokenId: decoded.deviceTokenId,
      targetSessionId: decoded.targetSessionId,
      targetAttachToken: decoded.targetAttachToken,
    };

    // #530 Copilot review: createRelayDaemonBinding can throw
    // synchronously (loopback host refusal, invalid URL). Without
    // this guard a bad bundle would crash the pairing screen
    // instead of surfacing a recoverable error.
    let handle: ReturnType<typeof createRelayDaemonBinding>;
    try {
      handle = createRelayDaemonBinding({
        deploymentUrl: binding.deploymentUrl,
        sessionId: binding.sessionId,
        token: binding.token,
        onStatus: (status) => {
          if (status.state === 'open') {
            // #530 Codex P2: WS `open` only proves the relay route
            // accepted the bearer's SHAPE (it does a format-only
            // check for `pushd_da_*`). Actual forwarding to pushd
            // is gated on the DO's allowlist. A stale bundle, an
            // allowlist-orphaned bundle, or a disconnected daemon
            // will all let `open` succeed and then fail every
            // subsequent request. Hit the daemon with a
            // `daemon_identify` round-trip before persisting so
            // pairing only "succeeds" when the relay is actually
            // routing.
            void handle
              .request({ type: 'daemon_identify', timeoutMs: 5_000 })
              .then(() => {
                const record: PairedRemoteRecord = {
                  id: mintPairedRemoteId(),
                  deploymentUrl: binding.deploymentUrl,
                  sessionId: binding.sessionId,
                  token: binding.token,
                  attachTokenId: binding.attachTokenId,
                  deviceTokenId: binding.deviceTokenId,
                  targetSessionId: binding.targetSessionId,
                  targetAttachToken: binding.targetAttachToken,
                  pairedAt: Date.now(),
                  lastUsedAt: Date.now(),
                };
                finishTest(handle, { kind: 'idle' }, { binding, record });
              })
              .catch(() => {
                finishTest(handle, {
                  kind: 'failed',
                  reason:
                    "Relay accepted the connection but the daemon didn't answer. The bundle may be stale or the daemon may be offline — re-run `push daemon pair --remote` for a fresh bundle.",
                });
              });
          } else if (status.state === 'unreachable' || status.state === 'closed') {
            // Pre-open / post-open terminal. Browsers hide WS
            // upgrade status so we can't distinguish auth-fail
            // from bad URL from network. Generic message + the
            // user's actionable path is re-running pair on the PC.
            finishTest(handle, {
              kind: 'failed',
              reason:
                status.state === 'unreachable'
                  ? 'Could not reach the relay. Check that the daemon is running, the relay is enabled (`push daemon relay status`), and the bundle is fresh.'
                  : `Connection closed (code ${status.code}). Re-run \`push daemon pair --remote\` for a fresh bundle.`,
            });
          }
        },
      });
    } catch (err) {
      // Sync throw before any handle existed; no timer set yet.
      setState({
        kind: 'failed',
        reason: `Pair test failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    const timer = setTimeout(() => {
      finishTest(handle, {
        kind: 'failed',
        reason: 'Pair test timed out. The relay may be unreachable from this network.',
      });
    }, TEST_TIMEOUT_MS);

    inFlightRef.current = { handle, timer };
  };

  return (
    <PageScaffold
      width="md"
      className="px-4 py-6"
      header={
        <HeaderBar
          back={onCancel}
          backLabel="Back to hub"
          icon={<Globe className="size-4 text-push-sky" aria-hidden="true" />}
          title="Pair a Remote daemon"
          subtitle="Remote · Experimental"
        />
      }
    >
      <SectionCard
        title="Run this on a paired computer"
        description={
          <>
            Push connects this phone to a paired computer through the Worker relay. Run{' '}
            <code className="rounded bg-white/5 px-1 py-0.5 text-push-fg-secondary">
              push daemon pair --remote
            </code>{' '}
            on the computer and paste the bundle below.
          </>
        }
      >
        <form onSubmit={handlePair} className="space-y-3" aria-label="Remote daemon pairing">
          <div className="space-y-1.5">
            <label
              htmlFor="relay-pair-bundle"
              className="text-xs font-medium text-push-fg-secondary"
            >
              Pairing bundle
            </label>
            <input
              id="relay-pair-bundle"
              type="password"
              value={bundleInput}
              onChange={(e) => setBundleInput(e.target.value)}
              placeholder="push-remote.…"
              autoComplete="off"
              spellCheck={false}
              disabled={state.kind === 'testing'}
              className={`${HUB_MATERIAL_INPUT_CLASS} block w-full font-mono`}
            />
            <p className="text-[11px] text-push-fg-dim">
              The bundle is a single line that starts with{' '}
              <code className="rounded bg-white/5 px-1 py-0.5 text-push-fg-secondary">
                push-remote.
              </code>{' '}
              — paste it from the daemon's output.
            </p>
          </div>

          {state.kind === 'failed' && (
            <StatusBanner variant="error" title="Pairing failed">
              {state.reason}
            </StatusBanner>
          )}

          <button
            type="submit"
            disabled={!formValid}
            className={`${HUB_MATERIAL_BUTTON_CLASS} inline-flex h-11 w-full items-center justify-center gap-2 rounded-full px-4 text-sm font-medium text-push-fg disabled:cursor-not-allowed disabled:opacity-50`}
          >
            {state.kind === 'testing' ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                <span>Testing connection…</span>
              </>
            ) : (
              <>
                <ShieldCheck className="size-4 text-push-sky" aria-hidden="true" />
                <span>Pair</span>
                <ChevronRight className="size-4" aria-hidden="true" />
              </>
            )}
          </button>
        </form>
      </SectionCard>
    </PageScaffold>
  );
}
