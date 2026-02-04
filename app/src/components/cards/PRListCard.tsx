import { GitPullRequest } from 'lucide-react';
import type { PRListCardData } from '@/types';

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

export function PRListCard({ data }: { data: PRListCardData }) {
  return (
    <div className="my-2 rounded-lg border border-[#1a1a1a] bg-[#0d0d0d] overflow-hidden max-w-full">
      {/* Header */}
      <div className="px-3 py-2 flex items-center gap-2 border-b border-[#1a1a1a]">
        <GitPullRequest className="h-3.5 w-3.5 text-[#a1a1aa]" />
        <span className="text-[13px] font-medium text-[#fafafa]">
          {data.prs.length} {data.state} PR{data.prs.length !== 1 ? 's' : ''}
        </span>
        <span className="text-[12px] text-[#52525b] font-mono">{data.repo}</span>
      </div>

      {/* PR list */}
      <div className="divide-y divide-[#1a1a1a]">
        {data.prs.map((pr) => (
          <div key={pr.number} className="px-3 py-2 flex items-start gap-2">
            <span className="text-[12px] text-[#52525b] font-mono shrink-0 mt-0.5">
              #{pr.number}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] text-[#e4e4e7] leading-tight truncate">
                {pr.title}
              </p>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-[11px] text-[#52525b]">{pr.author}</span>
                {pr.additions != null && (
                  <span className="text-[11px] font-mono">
                    <span className="text-[#22c55e]">+{pr.additions}</span>{' '}
                    <span className="text-[#ef4444]">-{pr.deletions || 0}</span>
                  </span>
                )}
                <span className="text-[11px] text-[#3a3a3e]">{timeAgo(pr.createdAt)}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
