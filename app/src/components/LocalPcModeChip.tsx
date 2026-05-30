/**
 * LocalPcModeChip — persistent indicator shown whenever the active
 * workspace is bound to a local pushd daemon. Renders the port and
 * a status dot so the user can never confuse a Local PC session
 * with a cloud sandbox session.
 *
 * Design instinct: visibility over convenience. This chip is text,
 * not a glyph; it states the mode plainly rather than relying on a
 * subtle icon. Cloud sessions render no chip — the absence is the
 * affordance.
 */
import { Monitor } from 'lucide-react';
import type { ConnectionStatus } from '@/lib/local-daemon-binding';

interface LocalPcModeChipProps {
  port: number;
  status: ConnectionStatus;
}

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

export function LocalPcModeChip({ port, status }: LocalPcModeChipProps) {
  return (
    // Chrome-less so it sits inside the header's launcher-pill frame and reads
    // like the branch pill in repo mode — icon + label + a status dot. Port
    // and status text appear only on wider screens.
    <div
      aria-label={`Local PC mode on port ${port}, ${statusLabel(status.state)}`}
      className="inline-flex min-w-0 items-center gap-1.5 text-xs font-medium text-push-fg-secondary"
    >
      <Monitor className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>Local PC</span>
      <span className="hidden text-push-fg-dim sm:inline">·</span>
      <span className="hidden tabular-nums text-push-fg-dim sm:inline">:{port}</span>
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass(status.state)}`}
        aria-hidden="true"
      />
      <span className="hidden text-push-fg-dim sm:inline">{statusLabel(status.state)}</span>
    </div>
  );
}

export default LocalPcModeChip;
