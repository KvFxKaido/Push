import { GitPullRequest } from 'lucide-react';
import type { PRListCardData } from '@/types';
import { timeAgo, CARD_SHELL_CLASS } from '@/lib/utils';

export function PRListCard({ data }: { data: PRListCardData }) {
  return (
    <div className={CARD_SHELL_CLASS}>
      {/* Header */}
      <div className="px-3 py-2 flex items-center gap-2 border-b border-push-edge">
        <GitPullRequest className="h-3.5 w-3.5 text-push-fg-secondary" />
        <span className="text-[13px] font-medium text-push-fg">
          {data.prs.length} {data.state} PR{data.prs.length !== 1 ? 's' : ''}
        </span>
        <span className="text-[12px] text-push-fg-dim font-mono">{data.repo}</span>
      </div>

      {/* PR list */}
      <div className="divide-y divide-push-edge">
        {data.prs.map((pr) => (
          <div key={pr.number} className="px-3 py-2 flex items-start gap-2">
            <span className="text-[12px] text-push-fg-dim font-mono shrink-0 mt-0.5">
              #{pr.number}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] text-[#e4e4e7] leading-tight truncate">
                {pr.title}
              </p>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-[11px] text-push-fg-dim">{pr.author}</span>
                {pr.additions != null && (
                  <span className="text-[11px] font-mono">
                    <span className="text-[#22c55e]">+{pr.additions}</span>{' '}
                    <span className="text-[#ef4444]">-{pr.deletions || 0}</span>
                  </span>
                )}
                <span className="text-[11px] text-[#5f6b80]">{timeAgo(pr.createdAt)}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
