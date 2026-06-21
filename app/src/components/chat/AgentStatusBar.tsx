import { useEffect, useState } from 'react';
import type { AgentStatus } from '@/types';
import { formatElapsedTime } from '@/lib/utils';

interface AgentStatusBarProps {
  status: AgentStatus;
}

// Rotation cadence for themed thinking verbs. Derived from wall-clock `now`
// (which ticks every second) so rotation needs no extra state and never
// resets when the lane re-sets the same status mid-stream.
const VERB_ROTATE_MS = 3500;

export function AgentStatusBar({ status }: AgentStatusBarProps) {
  // Re-render once a second when there's a startedAt to render against
  // (elapsed ticker) OR verbs to rotate through. Without this the timer
  // shows whatever value `Date.now() - startedAt` was on the last
  // parent re-render — which for slow phases is "the whole thing"
  // since the parent rarely re-renders mid-execution. The interval
  // updates `now` from real time on each tick; we deliberately don't
  // reset it inside the effect (eslint react-hooks/set-state-in-effect)
  // — the at-most-1s lag before the first interval fires is invisible
  // for a freshly-started tool call (elapsed shows "0s" briefly).
  const hasVerbs = (status.verbs?.length ?? 0) > 0;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!status.active || (!status.startedAt && !hasVerbs)) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [status.active, status.startedAt, hasVerbs]);

  if (!status.active) return null;

  const elapsedLabel = status.startedAt
    ? formatElapsedTime(Math.max(0, now - status.startedAt))
    : null;

  // During thinking dead air the bar rotates a themed verb instead of a
  // static label; the kernel's internal detail is dropped (it's noise the
  // verb replaces). Phase-first states show their label + detail as before.
  const verbs = status.verbs;
  const label =
    hasVerbs && verbs ? verbs[Math.floor(now / VERB_ROTATE_MS) % verbs.length] : status.phase;

  return (
    <div className="flex items-center gap-2.5 px-5 py-2.5 animate-fade-in">
      {/* Glow matches the sky push-accent dot (was a stale #0070f3 blue). */}
      <span className="agent-pulse inline-block h-1.5 w-1.5 rounded-full bg-push-accent shadow-[0_0_8px_rgba(125,211,252,0.4)]" />
      {/* Mono so the live phase/verb line reads like the TUI status line. */}
      <span className="font-mono text-xs text-push-fg-secondary tracking-wide">
        {/* Keyed on `label` so each verb/phase change remounts the span and
            replays `status-verb-swap-in` exactly once (enter-only). The 1s
            elapsed-timer tick re-renders the parent but leaves this key
            unchanged, so the swap fires only on real text changes. */}
        <span key={label} className="status-verb-swap">
          {label}
        </span>
        {!hasVerbs && status.detail && (
          <span className="text-push-fg-dimmest ml-1.5">{status.detail}</span>
        )}
        {elapsedLabel && <span className="text-push-fg-dimmest ml-1.5">({elapsedLabel})</span>}
      </span>
    </div>
  );
}
