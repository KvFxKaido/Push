import { PRThreadIcon } from '@/components/icons/push-custom-icons';
import type { PRListCardData } from '@/types';
import { timeAgo, CARD_SHELL_CLASS, CARD_LIST_CLASS } from '@/lib/utils';

export function PRListCard({ data }: { data: PRListCardData }) {
  return (
    <div className={CARD_SHELL_CLASS}>
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-push-edge/80 px-3.5 py-3">
        <PRThreadIcon className="h-3.5 w-3.5 text-push-fg-secondary" />
        <span className="text-push-base font-medium text-push-fg">
          {data.prs.length} {data.state} PR{data.prs.length !== 1 ? 's' : ''}
        </span>
        <span className="text-push-sm text-push-fg-dim font-mono">{data.repo}</span>
      </div>

      {/* PR list */}
      <div className={CARD_LIST_CLASS}>
        {data.prs.map((pr) => (
          <div key={pr.number} className="flex items-start gap-2 px-3.5 py-2.5">
            <span className="text-push-sm text-push-fg-dim font-mono shrink-0 mt-0.5">
              #{pr.number}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-push-base text-push-fg leading-tight truncate">{pr.title}</p>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-push-xs text-push-fg-dim">{pr.author}</span>
                {pr.additions != null && (
                  <span className="text-push-xs font-mono">
                    <span className="text-push-status-success">+{pr.additions}</span>{' '}
                    <span className="text-push-status-error">-{pr.deletions || 0}</span>
                  </span>
                )}
                <span className="text-push-xs text-push-fg-dim">{timeAgo(pr.createdAt)}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
