/**
 * RelayModeChip — persistent indicator shown whenever the active
 * workspace is bound to a Remote pushd daemon via the Worker relay.
 * Phase 2.f sibling to `LocalPcModeChip`.
 *
 * Differences from the local chip:
 *
 *   - Shows the deployment host (e.g. `relay.example.com`) instead
 *     of a loopback port. The deployment is the only thing the user
 *     can practically use to distinguish Remote sessions.
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
        @keyframes relay-replay-flash {
          0% {
            background-color: rgba(245, 158, 11, 0.30);
            border-color: rgba(251, 191, 36, 0.80);
            color: rgb(254, 243, 199);
          }
          100% {
            background-color: rgba(14, 165, 233, 0.10);
            border-color: rgba(56, 189, 248, 0.30);
            color: rgb(186, 230, 253);
          }
        }
      `}</style>
      <div
        key={flashKey}
        aria-label={`Remote relay mode at ${host}, ${statusLabel(status.state)}${isReplayEvent ? ' (replay unavailable signal active)' : ''}`}
        className="inline-flex min-w-0 items-center gap-2 rounded-full border border-sky-400/30 bg-sky-500/10 px-3 py-1 text-xs font-medium text-sky-200"
        style={
          isReplayEvent
            ? {
                animation: `relay-replay-flash ${FLASH_DURATION_MS}ms ease-out forwards`,
              }
            : undefined
        }
      >
        <Globe className="h-3.5 w-3.5" aria-hidden="true" />
        <span>Remote</span>
        <span className="text-sky-300/70">·</span>
        <span className="max-w-[180px] truncate text-sky-100">{host}</span>
        <span className="text-sky-300/70">·</span>
        <span className="inline-flex items-center gap-1">
          <span className={`h-1.5 w-1.5 rounded-full ${dotClass(status.state)}`} />
          <span className="text-sky-200/80">{statusLabel(status.state)}</span>
        </span>
      </div>
    </>
  );
}

export default RelayModeChip;
