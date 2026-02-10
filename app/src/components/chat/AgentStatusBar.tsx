import type { AgentStatus } from '@/types';

interface AgentStatusBarProps {
  status: AgentStatus;
}

export function AgentStatusBar({ status }: AgentStatusBarProps) {
  if (!status.active) return null;

  return (
    <div className="flex items-center gap-2.5 px-5 py-2">
      <span className="agent-pulse inline-block h-1.5 w-1.5 rounded-full bg-push-accent" />
      <span className="text-xs text-[#a1a1aa] tracking-wide">
        {status.phase}
        {status.detail && (
          <span className="text-[#52525b] ml-1.5">{status.detail}</span>
        )}
      </span>
    </div>
  );
}
