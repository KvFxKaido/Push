import { useState } from 'react';
import { ChevronRight, GitPullRequest, GitMerge } from 'lucide-react';
import type { PRCardData } from '@/types';
import { CARD_SHELL_CLASS } from '@/lib/utils';

const statusConfig = {
  open: { label: 'Open', color: 'bg-[#22c55e]/15 text-[#22c55e]', Icon: GitPullRequest },
  merged: { label: 'Merged', color: 'bg-[#a855f7]/15 text-[#a855f7]', Icon: GitMerge },
  closed: { label: 'Closed', color: 'bg-[#ef4444]/15 text-[#ef4444]', Icon: GitPullRequest },
};

export function PRCard({ data }: { data: PRCardData }) {
  const [filesExpanded, setFilesExpanded] = useState(false);
  const { label, color, Icon } = statusConfig[data.state];

  return (
    <div className={CARD_SHELL_CLASS}>
      {/* Header */}
      <div className="px-3.5 py-3 flex items-start gap-2.5">
        <Icon className="h-4 w-4 mt-0.5 shrink-0 text-push-fg-secondary" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-push-fg leading-tight">
              {data.title}
            </span>
            <span className="text-[12px] text-push-fg-dim font-mono">#{data.number}</span>
          </div>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <span className={`inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded-full ${color}`}>
              {label}
            </span>
            <span className="text-[12px] text-push-fg-dim">
              by {data.author}
            </span>
            <span className="text-[12px] text-push-fg-dim">
              {new Date(data.createdAt).toLocaleDateString()}
            </span>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="px-3 pb-2 flex items-center gap-3 text-[12px]">
        <span className="text-[#22c55e] font-mono">+{data.additions}</span>
        <span className="text-[#ef4444] font-mono">-{data.deletions}</span>
        <span className="text-push-fg-dim">{data.changedFiles} file{data.changedFiles !== 1 ? 's' : ''}</span>
        <span className="text-push-fg-dim font-mono text-[11px]">
          {data.branch} → {data.baseBranch}
        </span>
      </div>

      {/* Description */}
      {data.description && (
        <div className="px-3 pb-2">
          <p className="text-[13px] text-push-fg-secondary leading-relaxed line-clamp-3">
            {data.description}
          </p>
        </div>
      )}

      {/* Files */}
      {data.files && data.files.length > 0 && (
        <div className="border-t border-push-edge">
          <button
            onClick={() => setFilesExpanded((e) => !e)}
            className="w-full px-3 py-1.5 flex items-center gap-1 text-[12px] text-push-fg-dim hover:text-push-fg-secondary transition-colors"
          >
            <ChevronRight
              className={`h-3 w-3 transition-transform duration-200 ${filesExpanded ? 'rotate-90' : ''}`}
            />
            <span>{data.files.length} file{data.files.length !== 1 ? 's' : ''} changed</span>
          </button>
          {filesExpanded && (
            <div className="px-3 pb-2 space-y-0.5 expand-in">
              {data.files.map((f, i) => (
                <div key={i} className="flex items-center gap-2 text-[12px]">
                  <span className="text-push-fg-dim font-mono w-12 text-right shrink-0">
                    <span className="text-[#22c55e]">+{f.additions}</span>{' '}
                    <span className="text-[#ef4444]">-{f.deletions}</span>
                  </span>
                  <span className="text-push-fg-secondary font-mono truncate">{f.filename}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
