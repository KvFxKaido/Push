import { Loader2, RefreshCw, Plus, Terminal } from 'lucide-react';
import type { SandboxStatus } from '@/hooks/useSandbox';
import { categorizeSandboxError } from '@/lib/sandbox-error-utils';

interface SandboxStatusBannerProps {
  status: SandboxStatus;
  error: string | null;
  hasMessages: boolean;
  isStreaming: boolean;
  sandboxId: string | null;
  isSandboxMode: boolean;
  onStart: () => void;
  onRetry: () => void;
  onNewSandbox: () => void;
  onExitSandboxMode?: () => void;
}

export function SandboxStatusBanner({
  status,
  error,
  hasMessages,
  isStreaming,
  sandboxId,
  isSandboxMode,
  onStart,
  onRetry,
  onNewSandbox,
  onExitSandboxMode,
}: SandboxStatusBannerProps) {
  // Idle after a confirmed cold session (reconnect already failed or never attempted)
  if (status === 'idle' && hasMessages && !isStreaming) {
    return (
      <div className="mx-4 mt-2 rounded-xl border border-[#1b2230] bg-[#080d14] px-3.5 py-3 flex items-center justify-between gap-2 animate-fade-in-down">
        <div className="flex items-center gap-2.5 min-w-0">
          <Terminal className="h-3.5 w-3.5 text-[#5f6b80] flex-shrink-0" />
          <div>
            <p className="text-xs font-medium text-[#8b96aa]">Sandbox not running</p>
            <p className="text-[10px] text-push-fg-dim">Start to enable code tools for this session.</p>
          </div>
        </div>
        <button
          onClick={onStart}
          className="flex-shrink-0 rounded-lg border border-[#243148] bg-[#0b1220] px-3 py-1.5 text-xs font-medium text-[#8ad4ff] transition-colors hover:bg-[#0d1526] active:scale-95"
        >
          Start
        </button>
      </div>
    );
  }

  // Creating (user-initiated, not driven by the agent — agent has AgentStatusBar)
  if (status === 'creating' && !isStreaming) {
    return (
      <div className="mx-4 mt-2 rounded-xl border border-[#1b2230] bg-[#080d14] px-3.5 py-3 flex items-center gap-2.5 animate-fade-in-down">
        <Loader2 className="h-3.5 w-3.5 text-push-accent animate-spin flex-shrink-0" />
        <p className="text-xs text-[#8b96aa]">Starting sandbox…</p>
      </div>
    );
  }

  // Error
  if (status === 'error' && error) {
    const { title, detail } = categorizeSandboxError(error);
    return (
      <div className="mx-4 mt-2 rounded-xl border border-red-500/20 bg-red-500/5 px-3.5 py-3 flex items-center justify-between gap-2 animate-fade-in-down">
        <div className="min-w-0">
          <p className="text-xs font-medium text-red-300">{title}</p>
          <p className="text-[10px] text-red-400/70">{detail}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {sandboxId && (
            <button
              onClick={onRetry}
              className="flex items-center gap-1 rounded-lg border border-amber-500/25 bg-amber-500/10 px-2.5 py-1.5 text-xs font-medium text-amber-300 transition-colors hover:bg-amber-500/15 active:scale-95"
            >
              <RefreshCw className="h-3 w-3" />
              Retry
            </button>
          )}
          <button
            onClick={onNewSandbox}
            className="flex items-center gap-1 rounded-lg border border-red-500/25 bg-red-500/10 px-2.5 py-1.5 text-xs font-medium text-red-300 transition-colors hover:bg-red-500/20 active:scale-95"
          >
            <Plus className="h-3 w-3" />
            New sandbox
          </button>
          {isSandboxMode && onExitSandboxMode && (
            <button
              onClick={onExitSandboxMode}
              className="text-xs font-medium text-[#71717a] hover:text-[#a1a1aa] transition-colors"
            >
              Exit
            </button>
          )}
        </div>
      </div>
    );
  }

  return null;
}
