import { FolderGit2, GitBranch, Files, Clock3, RefreshCw } from 'lucide-react';
import type { SandboxStateCardData, CardAction } from '@/types';

interface SandboxStateCardProps {
  data: SandboxStateCardData;
  messageId?: string;
  cardIndex?: number;
  onAction?: (action: CardAction) => void;
}

export function SandboxStateCard({ data, messageId, cardIndex, onAction }: SandboxStateCardProps) {
  const hasChanges = data.changedFiles > 0;

  return (
    <div className="my-2.5 overflow-hidden rounded-xl border border-push-edge bg-push-grad-card shadow-push-card">
      <div className="px-3 py-2.5 border-b border-push-edge flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <FolderGit2 className="h-4 w-4 text-push-status-success shrink-0" />
          <span className="text-push-base text-push-fg font-medium truncate">Sandbox State</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`text-push-xs px-1.5 py-0.5 rounded-full ${hasChanges ? 'bg-push-status-warning/15 text-push-status-warning' : 'bg-push-status-success/15 text-push-status-success'}`}>
            {hasChanges ? `${data.changedFiles} changed` : 'clean'}
          </span>
          {onAction && messageId && typeof cardIndex === 'number' && (
            <button
              type="button"
              onClick={() => onAction({ type: 'sandbox-state-refresh', messageId, cardIndex, sandboxId: data.sandboxId })}
              className="inline-flex items-center gap-1 rounded border border-[#2a3447] px-2 py-0.5 text-push-2xs text-push-fg-secondary hover:text-push-fg hover:border-push-edge-hover"
              title="Refresh sandbox state"
            >
              <RefreshCw className="h-3 w-3" />
              Refresh
            </button>
          )}
        </div>
      </div>

      <div className="px-3 py-2 space-y-2">
        <div className="text-push-sm text-push-fg-secondary flex items-center gap-2">
          <GitBranch className="h-3.5 w-3.5 text-push-fg-muted" />
          <span className="font-mono">{data.branch}</span>
        </div>
        {data.statusLine && (
          <div className="text-push-xs text-push-fg-muted font-mono truncate">{data.statusLine}</div>
        )}
        <div className="grid grid-cols-2 gap-2 text-push-sm">
          <div className="rounded border border-[#1f1f23] px-2 py-1 text-push-fg-secondary">
            <span className="text-push-fg-muted">Staged:</span> {data.stagedFiles}
          </div>
          <div className="rounded border border-[#1f1f23] px-2 py-1 text-push-fg-secondary">
            <span className="text-push-fg-muted">Unstaged:</span> {data.unstagedFiles}
          </div>
          <div className="rounded border border-[#1f1f23] px-2 py-1 text-push-fg-secondary col-span-2">
            <span className="text-push-fg-muted">Untracked:</span> {data.untrackedFiles}
          </div>
        </div>

        {data.preview.length > 0 && (
          <div className="rounded border border-[#1f1f23] bg-push-surface-inset p-2">
            <div className="flex items-center gap-1.5 text-push-xs text-push-fg-muted mb-1">
              <Files className="h-3 w-3" />
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
