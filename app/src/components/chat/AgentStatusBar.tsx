import { useEffect, useState } from 'react';
import type { AgentStatus } from '@/types';
import { formatStatusElapsed } from '@/lib/chat-tool-messages';

interface AgentStatusBarProps {
  status: AgentStatus;
}

export function AgentStatusBar({ status }: AgentStatusBarProps) {
  // Re-render once a second when there's a startedAt to render against
  // so the elapsed-time suffix ticks visibly. Without this the timer
  // shows whatever value `Date.now() - startedAt` was on the last
  // parent re-render — which for slow phases is "the whole thing"
  // since the parent rarely re-renders mid-execution. The interval
  // updates `now` from real time on each tick; we deliberately don't
  // reset it inside the effect (eslint react-hooks/set-state-in-effect)
  // — the at-most-1s lag before the first interval fires is invisible
  // for a freshly-started tool call (elapsed shows "0s" briefly).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!status.active || !status.startedAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [status.active, status.startedAt]);

  if (!status.active) return null;

  const elapsedLabel = status.startedAt ? formatStatusElapsed(now - status.startedAt) : null;

  return (
    <div className="flex items-center gap-2.5 px-5 py-2.5 animate-fade-in">
      <span className="agent-pulse inline-block h-1.5 w-1.5 rounded-full bg-push-accent shadow-[0_0_8px_rgba(0,112,243,0.4)]" />
      <span className="text-xs text-push-fg-secondary tracking-wide">
        {status.phase}
        {status.detail && <span className="text-[#52525b] ml-1.5">{status.detail}</span>}
        {elapsedLabel && <span className="text-[#52525b] ml-1.5">({elapsedLabel})</span>}
      </span>
    </div>
  );
}
