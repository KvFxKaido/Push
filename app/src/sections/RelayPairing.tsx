/**
 * RelayPairing — single-field pairing panel for the Remote (relay)
 * workspace mode. Phase 2.f sibling to `LocalPcPairing`.
 *
 * UX: one textarea for the bundle string from `push daemon pair
 * --remote`. The panel decodes the bundle, opens a transient WS to
 * the relay to verify the bearer authenticates + the deployment is
 * reachable, and on success persists the binding to IndexedDB and
 * notifies the caller.
 *
 * Token discipline mirrors `LocalPcPairing`: the bundle is held in
 * memory only for the duration of the panel, is type=password
 * via a hidden textarea autocomplete, and is cleared on success /
 * failure / cancel. Never logged, never echoed into error messages.
 *
 * The 2.f scope picked single bundled paste as the main UX (vs
 * three-field manual entry). If users hit edge cases that require
 * raw three-field paste — e.g. trying to debug a malformed bundle
 * mid-rollout — that lands as a separate debug-mode panel; this
 * one stays focused on the happy path.
 */
import { ArrowLeft, ChevronRight, Globe, Loader2, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createRelayDaemonBinding } from '@/lib/relay-daemon-binding';
import { type LocalDaemonBinding } from '@/lib/local-daemon-binding';
import { parseRemotePairBundle } from '@/lib/relay-binding';
import { mintPairedRemoteId, setPairedRemote, type PairedRemoteRecord } from '@/lib/relay-storage';
import type { RelayBinding } from '@/types';

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

  // In-flight probe handle + backstop timer. Mirrors LocalPcPairing's
  // race-safe pattern: each probe carries its own handle reference;
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
    };

    const handle = createRelayDaemonBinding({
      deploymentUrl: binding.deploymentUrl,
      sessionId: binding.sessionId,
      token: binding.token,
      onStatus: (status) => {
        if (status.state === 'open') {
          // Success — persist and notify.
          const record: PairedRemoteRecord = {
            id: mintPairedRemoteId(),
            deploymentUrl: binding.deploymentUrl,
            sessionId: binding.sessionId,
            token: binding.token,
            pairedAt: Date.now(),
            lastUsedAt: Date.now(),
          };
          finishTest(handle, { kind: 'idle' }, { binding, record });
        } else if (status.state === 'unreachable' || status.state === 'closed') {
          // Pre-open / post-open terminal. Browsers hide WS upgrade
          // status so we can't distinguish auth-fail from bad URL
          // from network. Generic message + the user's actionable
          // path is re-running pair on the PC.
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

    const timer = setTimeout(() => {
      finishTest(handle, {
        kind: 'failed',
        reason: 'Pair test timed out. The relay may be unreachable from this network.',
      });
    }, TEST_TIMEOUT_MS);

    inFlightRef.current = { handle, timer };
  };

  return (
    <div className="min-h-screen w-full overflow-y-auto bg-background text-foreground">
      <div className="mx-auto max-w-2xl px-6 py-8">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>
        )}

        <div className="mb-6 inline-flex items-center gap-2 text-sm text-muted-foreground">
          <Globe className="h-4 w-4" />
          <span className="font-medium">Remote · Experimental</span>
        </div>

        <h1 className="mb-2 text-2xl font-medium tracking-tight">Pair a Remote daemon</h1>
        <p className="mb-8 text-sm text-muted-foreground">
          Push connects this phone to a paired computer through the Worker relay. Run{' '}
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">push daemon pair --remote</code>{' '}
          on the computer and paste the bundle below.
        </p>

        <form onSubmit={handlePair} className="space-y-6">
          <label className="block">
            <span className="mb-2 block text-sm font-medium">Pairing bundle</span>
            <textarea
              value={bundleInput}
              onChange={(e) => setBundleInput(e.target.value)}
              placeholder="push-remote.…"
              autoComplete="off"
              spellCheck={false}
              rows={3}
              className="block w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              disabled={state.kind === 'testing'}
            />
          </label>

          {state.kind === 'failed' && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {state.reason}
            </div>
          )}

          <button
            type="submit"
            disabled={!formValid}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
          >
            {state.kind === 'testing' ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Testing connection…
              </>
            ) : (
              <>
                <ShieldCheck className="h-4 w-4" />
                Pair
                <ChevronRight className="h-4 w-4" />
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
