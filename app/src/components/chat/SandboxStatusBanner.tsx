import { Loader2 } from 'lucide-react';
import type React from 'react';
import type { SandboxStatus } from '@/hooks/useSandbox';
import { categorizeSandboxError } from '@/lib/sandbox-error-utils';
import { SandboxCubeIcon } from '@/components/icons/push-custom-icons';

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
