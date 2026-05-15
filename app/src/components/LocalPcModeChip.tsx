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
    <div
      aria-label={`Local PC mode on port ${port}, ${statusLabel(status.state)}`}
      className="inline-flex min-w-0 items-center gap-2 rounded-full border border-amber-400/30 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-200"
    >
      <Monitor className="h-3.5 w-3.5" aria-hidden="true" />
      <span>Local PC</span>
      <span className="text-amber-300/70">·</span>
      <span className="tabular-nums text-amber-100">:{port}</span>
      <span className="text-amber-300/70">·</span>
      <span className="inline-flex items-center gap-1">
        <span className={`h-1.5 w-1.5 rounded-full ${dotClass(status.state)}`} />
        <span className="text-amber-200/80">{statusLabel(status.state)}</span>
      </span>
    </div>
  );
}

export default LocalPcModeChip;
