import { CommitPulseIcon } from '@/components/icons/push-custom-icons';
import type { CommitListCardData } from '@/types';
import { timeAgo, CARD_SHELL_CLASS, CARD_LIST_CLASS } from '@/lib/utils';

export function CommitListCard({ data }: { data: CommitListCardData }) {
  return (
    <div className={CARD_SHELL_CLASS}>
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-push-edge/80 px-3.5 py-3">
        <CommitPulseIcon className="h-3.5 w-3.5 text-push-fg-secondary" />
        <span className="text-push-base font-medium text-push-fg">
          {data.commits.length} recent commit{data.commits.length !== 1 ? 's' : ''}
        </span>
        <span className="text-push-sm text-push-fg-dim font-mono">{data.repo}</span>
      </div>

      {/* Commit list */}
      <div className={CARD_LIST_CLASS}>
        {data.commits.map((commit) => (
          <div key={commit.sha} className="flex items-start gap-2 px-3.5 py-2.5">
            <span className="text-push-sm text-push-link font-mono shrink-0 mt-0.5">
              {commit.sha.slice(0, 7)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-push-base text-push-fg leading-tight truncate">{commit.message}</p>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-push-xs text-push-fg-dim">{commit.author}</span>
                <span className="text-push-xs text-push-fg-dim">{timeAgo(commit.date)}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
