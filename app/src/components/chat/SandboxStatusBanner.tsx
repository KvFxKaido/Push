import { Loader2, RefreshCw, Plus, Terminal } from 'lucide-react';
import type { SandboxStatus } from '@/hooks/useSandbox';
import { categorizeSandboxError } from '@/lib/sandbox-error-utils';
import {
  HUB_MATERIAL_PILL_BUTTON_CLASS,
  HUB_PANEL_SUBTLE_SURFACE_CLASS,
  HubControlGlow,
} from '@/components/chat/hub-styles';

interface SandboxStatusBannerProps {
  status: SandboxStatus;
  error: string | null;
  hasMessages: boolean;
  isStreaming: boolean;
  sandboxId: string | null;
  isInScratchWorkspace: boolean;
  onStart: () => void;
  onRetry: () => void;
  onNewSandbox: () => void;
  onExitWorkspace?: () => void;
}

export function SandboxStatusBanner({
  status,
  error,
  hasMessages,
  isStreaming,
  sandboxId,
  isInScratchWorkspace,
  onStart,
  onRetry,
  onNewSandbox,
  onExitWorkspace,
}: SandboxStatusBannerProps) {
  const bannerBaseClass = `mx-4 mt-4 animate-fade-in px-3.5 py-3 ${HUB_PANEL_SUBTLE_SURFACE_CLASS}`;

  // Idle after a confirmed cold session (reconnect already failed or never attempted)
  if (status === 'idle' && hasMessages && !isStreaming) {
    return (
      <div className={`${bannerBaseClass} flex items-center justify-between gap-2`}>
        <div className="flex min-w-0 items-center gap-2.5">
          <Terminal className="h-3.5 w-3.5 flex-shrink-0 text-push-fg-dim" />
          <div>
            <p className="text-xs font-medium text-push-fg-muted">Sandbox not running</p>
            <p className="text-push-2xs text-push-fg-dim">Start to enable code tools for this workspace.</p>
          </div>
        </div>
        <button
          onClick={onStart}
          className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} flex-shrink-0 px-3 text-[#8ad4ff]`}
        >
          <HubControlGlow />
          <span className="relative z-10">Start</span>
        </button>
      </div>
    );
  }

  // Creating (user-initiated, not driven by the agent — agent has AgentStatusBar)
  if (status === 'creating' && !isStreaming) {
    return (
      <div className={`${bannerBaseClass} flex items-center gap-2.5`}>
        <Loader2 className="h-3.5 w-3.5 animate-spin flex-shrink-0 text-push-accent" />
        <p className="text-xs text-push-fg-muted">Starting sandbox…</p>
      </div>
    );
  }

  // Error
  if (status === 'error' && error) {
    const { title, detail } = categorizeSandboxError(error);
    return (
      <div className={`mx-4 mt-4 flex items-center justify-between gap-2 animate-fade-in rounded-[18px] border border-red-500/20 bg-red-500/5 px-3.5 py-3`}>
        <div className="min-w-0">
          <p className="text-xs font-medium text-red-300">{title}</p>
          <p className="text-push-2xs text-red-400/70">{detail}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {sandboxId && (
            <button
              onClick={onRetry}
              className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} gap-1 px-2.5 text-amber-300`}
            >
              <HubControlGlow />
              <RefreshCw className="relative z-10 h-3 w-3" />
              <span className="relative z-10">Retry</span>
            </button>
          )}
          <button
            onClick={onNewSandbox}
            className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} gap-1 px-2.5 text-red-300`}
          >
            <HubControlGlow />
            <Plus className="relative z-10 h-3 w-3" />
            <span className="relative z-10">Restart runtime</span>
          </button>
          {isInScratchWorkspace && onExitWorkspace && (
            <button
              onClick={onExitWorkspace}
              className="text-xs font-medium text-[#71717a] transition-colors hover:text-push-fg-secondary"
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
