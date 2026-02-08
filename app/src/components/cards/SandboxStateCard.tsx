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
    <div className="my-2 rounded-lg border border-[#1a1a1a] bg-[#0d0d0d] overflow-hidden">
      <div className="px-3 py-2.5 border-b border-[#1a1a1a] flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <FolderGit2 className="h-4 w-4 text-[#22c55e] shrink-0" />
          <span className="text-[13px] text-[#e4e4e7] font-medium truncate">Sandbox State</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`text-[11px] px-1.5 py-0.5 rounded-full ${hasChanges ? 'bg-[#f59e0b]/15 text-[#f59e0b]' : 'bg-[#22c55e]/15 text-[#22c55e]'}`}>
            {hasChanges ? `${data.changedFiles} changed` : 'clean'}
          </span>
          {onAction && messageId && typeof cardIndex === 'number' && (
            <button
              type="button"
              onClick={() => onAction({ type: 'sandbox-state-refresh', messageId, cardIndex, sandboxId: data.sandboxId })}
              className="inline-flex items-center gap-1 rounded border border-[#27272a] px-2 py-0.5 text-[10px] text-[#a1a1aa] hover:text-[#fafafa] hover:border-[#3f3f46]"
              title="Refresh sandbox state"
            >
              <RefreshCw className="h-3 w-3" />
              Refresh
            </button>
          )}
        </div>
      </div>

      <div className="px-3 py-2 space-y-2">
        <div className="text-[12px] text-[#a1a1aa] flex items-center gap-2">
          <GitBranch className="h-3.5 w-3.5 text-[#71717a]" />
          <span className="font-mono">{data.branch}</span>
        </div>
        {data.statusLine && (
          <div className="text-[11px] text-[#71717a] font-mono truncate">{data.statusLine}</div>
        )}
        <div className="grid grid-cols-2 gap-2 text-[12px]">
          <div className="rounded border border-[#1f1f23] px-2 py-1 text-[#a1a1aa]">
            <span className="text-[#71717a]">Staged:</span> {data.stagedFiles}
          </div>
          <div className="rounded border border-[#1f1f23] px-2 py-1 text-[#a1a1aa]">
            <span className="text-[#71717a]">Unstaged:</span> {data.unstagedFiles}
          </div>
          <div className="rounded border border-[#1f1f23] px-2 py-1 text-[#a1a1aa] col-span-2">
            <span className="text-[#71717a]">Untracked:</span> {data.untrackedFiles}
          </div>
        </div>

        {data.preview.length > 0 && (
          <div className="rounded border border-[#1f1f23] bg-[#0a0a0c] p-2">
            <div className="flex items-center gap-1.5 text-[11px] text-[#71717a] mb-1">
              <Files className="h-3 w-3" />
              <span>Preview</span>
            </div>
            <div className="space-y-0.5">
              {data.preview.map((line, idx) => (
                <div key={`${line}-${idx}`} className="text-[11px] text-[#a1a1aa] font-mono truncate">
                  {line}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center gap-1.5 text-[10px] text-[#52525b]">
          <Clock3 className="h-3 w-3" />
          <span>{new Date(data.fetchedAt).toLocaleTimeString()}</span>
          <span className="font-mono ml-1">{data.repoPath}</span>
        </div>
      </div>
    </div>
  );
}
