import { Loader2, RefreshCw, Plus } from 'lucide-react';
import type React from 'react';
import type { SandboxStatus } from '@/hooks/useSandbox';
import { categorizeSandboxError } from '@/lib/sandbox-error-utils';
import { SandboxCubeIcon } from '@/components/icons/push-custom-icons';
import {
  HUB_MATERIAL_PILL_BUTTON_CLASS,
  HUB_TOP_BANNER_STRIP_CLASS,
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

interface SandboxStatusChipProps {
  status: SandboxStatus;
  error: string | null;
  onOpenWorkspaceHub: () => void;
}

export function SandboxStatusChip({ status, error, onOpenWorkspaceHub }: SandboxStatusChipProps) {
  if (status === 'ready') return null;

  const errorTitle = error ? categorizeSandboxError(error).title : 'Sandbox needs attention';
  const config: {
    label: string;
    title: string;
    className: string;
    indicator: React.ReactNode;
  } =
    status === 'creating'
      ? {
          label: 'Starting',
          title: 'Sandbox is starting',
          className: 'text-push-fg-dim hover:text-push-fg-secondary',
          indicator: <Loader2 className="h-3 w-3 animate-spin" />,
        }
      : status === 'reconnecting'
        ? {
            label: 'Reconnecting',
            title: 'Reconnecting to sandbox',
            className: 'text-amber-300/85 hover:text-amber-200',
            indicator: <Loader2 className="h-3 w-3 animate-spin" />,
          }
        : status === 'error'
          ? {
              label: 'Sandbox',
              title: errorTitle,
              className: 'text-red-300 hover:text-red-200',
              indicator: <span className="h-1.5 w-1.5 rounded-full bg-red-400" />,
            }
          : {
              label: 'Idle',
              title: 'Sandbox is idle',
              className: 'text-push-fg-dim hover:text-push-fg-secondary',
              indicator: <SandboxCubeIcon className="h-3 w-3" />,
            };

  return (
    <button
      type="button"
      onClick={onOpenWorkspaceHub}
      className={`flex h-9 max-w-[132px] items-center gap-1.5 px-1.5 text-push-xs transition-colors active:scale-[0.98] ${config.className}`}
      aria-label={`${config.title}. Open workspace status.`}
      title={`${config.title} - open workspace`}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">{config.indicator}</span>
      <span className="hidden truncate sm:inline">{config.label}</span>
    </button>
  );
}

export function SandboxStatusBanner({
  status,
  error,
  sandboxId,
  isInScratchWorkspace,
  onRetry,
  onNewSandbox,
  onExitWorkspace,
}: SandboxStatusBannerProps) {
  if (status === 'error' && error) {
    const { title, detail } = categorizeSandboxError(error);
    return (
      <div
        className={`mx-4 mt-5 flex items-center justify-between gap-2 px-1 py-2.5 ${HUB_TOP_BANNER_STRIP_CLASS} border-red-500/25`}
      >
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
              <RefreshCw className="h-3 w-3" />
              <span>Retry</span>
            </button>
          )}
          <button
            onClick={onNewSandbox}
            className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} gap-1 px-2.5 text-red-300`}
          >
            <Plus className="h-3 w-3" />
            <span>Restart runtime</span>
          </button>
          {isInScratchWorkspace && onExitWorkspace && (
            <button
              onClick={onExitWorkspace}
              className="text-xs font-medium text-push-fg-dim transition-colors hover:text-push-fg-secondary"
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
