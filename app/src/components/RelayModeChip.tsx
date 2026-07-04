/**
 * RelayModeChip — persistent indicator shown whenever the active
 * workspace is bound to a Remote pushd daemon via the Worker relay.
 *
 * Shows the deployment host (e.g. `relay.example.com`), which is the
 * practical identifier for Remote sessions.
 *
 *   - Flashes amber briefly when the relay emits
 *     `relay_replay_unavailable` — the lightweight signal the 2.f
 *     scope picked for "you missed events while disconnected." The
 *     flash decays after FLASH_DURATION_MS; the parent screen passes
 *     `replayUnavailableAt` (a timestamp that flips on each event)
 *     and we derive the amber state from it via animation frames.
 */
import { Globe } from 'lucide-react';
import type { ConnectionStatus } from '@/lib/local-daemon-binding';

interface RelayModeChipProps {
  deploymentUrl: string;
  status: ConnectionStatus;
  /**
   * `Date.now()` ms when the relay last emitted
   * `relay_replay_unavailable`, or null if no replay-unavailable
   * signal has fired since the last successful connect. The chip
   * compares against the current clock to render a 3s amber flash
   * after each event.
   */
  replayUnavailableAt: number | null;
}

const FLASH_DURATION_MS = 3_000;

function dotClass(state: ConnectionStatus['state']): string {
  switch (state) {
    case 'open':
      return 'bg-emerald-400';
    case 'connecting':
      return 'bg-amber-300 animate-pulse';
    case 'unreachable':
      return 'bg-rose-500';
    case 'closed':
      return 'bg-zinc-500';
  }
}

function statusLabel(state: ConnectionStatus['state']): string {
  switch (state) {
    case 'open':
      return 'connected';
    case 'connecting':
      return 'connecting…';
    case 'unreachable':
      return 'unreachable';
    case 'closed':
      return 'closed';
  }
}

function shortHost(deploymentUrl: string): string {
  try {
    const normalized =
      deploymentUrl.startsWith('ws://') || deploymentUrl.startsWith('wss://')
        ? deploymentUrl.replace(/^ws/, 'http')
        : deploymentUrl;
    return new URL(normalized).host;
  } catch {
    return deploymentUrl;
  }
}

export function RelayModeChip({ deploymentUrl, status, replayUnavailableAt }: RelayModeChipProps) {
  // CSS-driven flash: a CSS @keyframes animation transitions amber
  // colors back to the steady-state sky colors over FLASH_DURATION_MS.
  // We bind the animation lifetime to a key derived from
  // `replayUnavailableAt` so each new event restarts the animation
  // cleanly. No React effect, no timer, no setState — keeps the
  // render path pure (react-hooks/set-state-in-effect).
  const flashKey = replayUnavailableAt ?? 0;
  const isReplayEvent = replayUnavailableAt !== null;

  const host = shortHost(deploymentUrl);

  return (
    <>
      {/* Per-keyframe animation injected once — the chip's
          steady-state colors come from utility classes, the amber
          flash comes from this @keyframes rule. CSS-driven because
          React state setters in effects trip the
          react-hooks/set-state-in-effect rule. */}
      <style>{`
        /* Only the amber flash start is specified; the implicit 100% resolves
           to the element's own color (the text-push-fg-secondary token class),
           so the steady-state color stays token-driven and can't drift from a
           hardcoded hex. No fill-mode: after the flash, color reverts to the
           class value (which equals the implicit 100%, so there's no snap). */
        @keyframes relay-replay-flash {
          0% { color: rgb(var(--push-warning-bright-rgb)); }
        }
      `}</style>
      {/* Chrome-less so it sits inside the header's launcher-pill frame and
          reads like the branch pill in repo mode — icon + label + a status
          dot. Host and status text appear only on wider screens. The
          replay-unavailable signal flashes the text amber → steady. */}
      <div
        key={flashKey}
        aria-label={`Remote relay mode at ${host}, ${statusLabel(status.state)}${isReplayEvent ? ' (replay unavailable signal active)' : ''}`}
        className="inline-flex min-w-0 items-center gap-1.5 text-xs font-medium text-push-fg-secondary"
        style={
          isReplayEvent
            ? { animation: `relay-replay-flash ${FLASH_DURATION_MS}ms ease-out` }
            : undefined
        }
      >
        <Globe className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>Remote</span>
        <span className="hidden text-push-fg-dim sm:inline">·</span>
        <span className="hidden max-w-[140px] truncate text-push-fg-dim sm:inline">{host}</span>
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass(status.state)}`}
          aria-hidden="true"
        />
        <span className="hidden text-push-fg-dim sm:inline">{statusLabel(status.state)}</span>
      </div>
    </>
  );
}

export default RelayModeChip;
