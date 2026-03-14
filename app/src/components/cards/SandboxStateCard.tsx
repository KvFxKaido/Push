import { Clock3, RefreshCw } from 'lucide-react';
import type { SandboxStateCardData, CardAction } from '@/types';
import {
  CARD_SHELL_CLASS,
  CARD_BADGE_SUCCESS,
  CARD_BADGE_WARNING,
  CARD_BUTTON_CLASS,
  CARD_PANEL_SUBTLE_CLASS,
} from '@/lib/utils';
import { BranchWaveIcon, FilesStackIcon, RepoLedgerIcon } from '@/components/icons/push-custom-icons';

interface SandboxStateCardProps {
  data: SandboxStateCardData;
  messageId?: string;
  cardIndex?: number;
  onAction?: (action: CardAction) => void;
}

export function SandboxStateCard({ data, messageId, cardIndex, onAction }: SandboxStateCardProps) {
  const hasChanges = data.changedFiles > 0;

  return (
    <div className={CARD_SHELL_CLASS}>
      <div className="flex items-center justify-between gap-2 border-b border-push-edge/80 px-3 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <RepoLedgerIcon className="h-4 w-4 text-push-status-success shrink-0" />
          <span className="text-push-base text-push-fg font-medium truncate">Workspace Status</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`text-push-xs px-1.5 py-0.5 rounded-full ${hasChanges ? CARD_BADGE_WARNING : CARD_BADGE_SUCCESS}`}>
            {hasChanges ? `${data.changedFiles} changed` : 'clean'}
          </span>
          {onAction && messageId && typeof cardIndex === 'number' && (
            <button
              type="button"
              onClick={() => onAction({ type: 'sandbox-state-refresh', messageId, cardIndex, sandboxId: data.sandboxId })}
              className={`${CARD_BUTTON_CLASS} h-7 px-2.5 text-push-2xs`}
              title="Refresh workspace status"
            >
              <RefreshCw className="h-3 w-3" />
              Refresh
            </button>
          )}
        </div>
      </div>

      <div className="px-3 py-2 space-y-2">
        <div className="text-push-sm text-push-fg-secondary flex items-center gap-2">
          <BranchWaveIcon className="h-3.5 w-3.5 text-push-fg-muted" />
          <span className="font-mono">{data.branch}</span>
        </div>
        {data.statusLine && (
          <div className="text-push-xs text-push-fg-muted font-mono truncate">{data.statusLine}</div>
        )}
        <div className="grid grid-cols-2 gap-2 text-push-sm">
          <div className={`${CARD_PANEL_SUBTLE_CLASS} px-2.5 py-1.5 text-push-fg-secondary`}>
            <span className="text-push-fg-muted">Staged:</span> {data.stagedFiles}
          </div>
          <div className={`${CARD_PANEL_SUBTLE_CLASS} px-2.5 py-1.5 text-push-fg-secondary`}>
            <span className="text-push-fg-muted">Unstaged:</span> {data.unstagedFiles}
          </div>
          <div className={`${CARD_PANEL_SUBTLE_CLASS} col-span-2 px-2.5 py-1.5 text-push-fg-secondary`}>
            <span className="text-push-fg-muted">Untracked:</span> {data.untrackedFiles}
          </div>
        </div>

        {data.preview.length > 0 && (
          <div className={`${CARD_PANEL_SUBTLE_CLASS} p-2.5`}>
            <div className="flex items-center gap-1.5 text-push-xs text-push-fg-muted mb-1">
              <FilesStackIcon className="h-3 w-3" />
              <span>Preview</span>
            </div>
            <div className="space-y-0.5">
              {data.preview.map((line, idx) => (
                <div key={`${line}-${idx}`} className="text-push-xs text-push-fg-secondary font-mono truncate">
                  {line}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center gap-1.5 text-push-2xs text-push-fg-dim">
          <Clock3 className="h-3 w-3" />
          <span>{new Date(data.fetchedAt).toLocaleTimeString()}</span>
          <span className="font-mono ml-1">{data.repoPath}</span>
        </div>
      </div>
    </div>
  );
}
