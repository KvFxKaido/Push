import { GitCommit } from 'lucide-react';
import type { CommitListCardData } from '@/types';

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

export function CommitListCard({ data }: { data: CommitListCardData }) {
  return (
    <div className="my-2.5 max-w-full overflow-hidden rounded-xl border border-push-edge bg-[linear-gradient(180deg,#090d14_0%,#06090f_100%)] shadow-push-card">
      {/* Header */}
      <div className="px-3.5 py-2.5 flex items-center gap-2 border-b border-push-edge">
        <GitCommit className="h-3.5 w-3.5 text-push-fg-secondary" />
        <span className="text-[13px] font-medium text-push-fg">
          {data.commits.length} recent commit{data.commits.length !== 1 ? 's' : ''}
        </span>
        <span className="text-[12px] text-push-fg-dim font-mono">{data.repo}</span>
      </div>

      {/* Commit list */}
      <div className="divide-y divide-push-edge">
        {data.commits.map((commit) => (
          <div key={commit.sha} className="px-3 py-2 flex items-start gap-2">
            <span className="text-[12px] text-push-link font-mono shrink-0 mt-0.5">
              {commit.sha.slice(0, 7)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] text-[#e4e4e7] leading-tight truncate">
                {commit.message}
              </p>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-[11px] text-push-fg-dim">{commit.author}</span>
                <span className="text-[11px] text-[#5f6b80]">{timeAgo(commit.date)}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
