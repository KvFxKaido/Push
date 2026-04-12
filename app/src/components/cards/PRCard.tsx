import { formatDistanceToNow } from 'date-fns';
import { MergeShieldIcon, PRThreadIcon } from '@/components/icons/push-custom-icons';
import type { PRCardData } from '@/types';
import { useExpandable } from '@/hooks/useExpandable';
import {
  CARD_SHELL_CLASS,
  CARD_BADGE_SUCCESS,
  CARD_BADGE_ERROR,
  CARD_BADGE_INFO,
} from '@/lib/utils';
import { ExpandChevron, ExpandableCardPanel } from './expandable';

const statusConfig = {
  open: { label: 'Open', color: CARD_BADGE_SUCCESS, Icon: PRThreadIcon },
  merged: { label: 'Merged', color: CARD_BADGE_INFO, Icon: MergeShieldIcon },
  closed: { label: 'Closed', color: CARD_BADGE_ERROR, Icon: PRThreadIcon },
};

export function PRCard({ data }: { data: PRCardData }) {
  const { expanded: filesExpanded, toggleExpanded: toggleFilesExpanded } = useExpandable(false);
  const { expanded: reviewExpanded, toggleExpanded: toggleReviewExpanded } = useExpandable(false);
  const { expanded: convoExpanded, toggleExpanded: toggleConvoExpanded } = useExpandable(false);
  const { label, color, Icon } = statusConfig[data.state];

  return (
    <div className={CARD_SHELL_CLASS}>
      {/* Header */}
      <div className="px-3.5 py-3 flex items-start gap-2.5">
        <Icon className="h-4 w-4 mt-0.5 shrink-0 text-push-fg-secondary" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-push-fg leading-tight">{data.title}</span>
            <span className="text-push-sm text-push-fg-dim font-mono">#{data.number}</span>
          </div>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <span
              className={`inline-flex items-center gap-1 text-push-xs font-medium px-1.5 py-0.5 rounded-full ${color}`}
            >
              {label}
            </span>
            <span className="text-push-sm text-push-fg-dim">by {data.author}</span>
            <span className="text-push-sm text-push-fg-dim">
              {new Date(data.createdAt).toLocaleDateString()}
            </span>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="px-3 pb-2 flex items-center gap-3 text-push-sm">
        <span className="text-push-status-success font-mono">+{data.additions}</span>
        <span className="text-push-status-error font-mono">-{data.deletions}</span>
        <span className="text-push-fg-dim">
          {data.changedFiles} file{data.changedFiles !== 1 ? 's' : ''}
        </span>
        <span className="text-push-fg-dim font-mono text-push-xs">
          {data.branch} → {data.baseBranch}
        </span>
      </div>

      {/* Description */}
      {data.description && (
        <div className="px-3 pb-2">
          <p className="text-push-base text-push-fg-secondary leading-relaxed line-clamp-3">
            {data.description}
          </p>
        </div>
      )}

      {/* Files */}
      {data.files && data.files.length > 0 && (
        <div className="border-t border-push-edge">
          <button
            onClick={toggleFilesExpanded}
            className="w-full px-3 py-1.5 flex items-center gap-1 text-push-sm text-push-fg-dim hover:text-push-fg-secondary transition-colors"
          >
            <ExpandChevron expanded={filesExpanded} />
            <span>
              {data.files.length} file{data.files.length !== 1 ? 's' : ''} changed
            </span>
          </button>
          <ExpandableCardPanel
            expanded={filesExpanded}
            bordered={false}
            className="px-3 pb-2 space-y-0.5"
          >
            {data.files.map((f, i) => (
              <div key={i} className="flex items-center gap-2 text-push-sm">
                <span className="text-push-fg-dim font-mono w-12 text-right shrink-0">
                  <span className="text-push-status-success">+{f.additions}</span>{' '}
                  <span className="text-push-status-error">-{f.deletions}</span>
                </span>
                <span className="text-push-fg-secondary font-mono truncate">{f.filename}</span>
              </div>
            ))}
          </ExpandableCardPanel>
        </div>
      )}

      {/* Inline review comments */}
      {data.reviewComments && data.reviewComments.length > 0 && (
        <div className="border-t border-push-edge">
          <button
            onClick={toggleReviewExpanded}
            aria-expanded={reviewExpanded}
            className="w-full px-3 py-1.5 flex items-center gap-1 text-push-sm text-push-fg-dim hover:text-push-fg-secondary transition-colors"
          >
            <ExpandChevron expanded={reviewExpanded} />
            <span>
              {data.reviewComments.length} review comment
              {data.reviewComments.length !== 1 ? 's' : ''}
            </span>
          </button>
          <ExpandableCardPanel
            expanded={reviewExpanded}
            bordered={false}
            className="px-3 pb-2 space-y-2"
          >
            {data.reviewComments.map((c, i) => (
              <div key={i} className="text-push-sm">
                <div className="flex items-baseline gap-1.5 min-w-0 text-push-fg-dim">
                  <span className="font-medium text-push-fg-secondary shrink-0">@{c.author}</span>
                  {c.path && (
                    <span className="font-mono text-push-xs min-w-0 truncate">
                      {c.path}
                      {c.line ? `:${c.line}` : ''}
                    </span>
                  )}
                </div>
                <p className="text-push-fg-secondary mt-0.5 line-clamp-3 whitespace-pre-wrap">
                  {c.body}
                </p>
              </div>
            ))}
          </ExpandableCardPanel>
        </div>
      )}

      {/* Conversation comments */}
      {data.issueComments && data.issueComments.length > 0 && (
        <div className="border-t border-push-edge">
          <button
            onClick={toggleConvoExpanded}
            aria-expanded={convoExpanded}
            className="w-full px-3 py-1.5 flex items-center gap-1 text-push-sm text-push-fg-dim hover:text-push-fg-secondary transition-colors"
          >
            <ExpandChevron expanded={convoExpanded} />
            <span>
              {data.issueComments.length} conversation comment
              {data.issueComments.length !== 1 ? 's' : ''}
            </span>
          </button>
          <ExpandableCardPanel
            expanded={convoExpanded}
            bordered={false}
            className="px-3 pb-2 space-y-2"
          >
            {data.issueComments.map((c, i) => (
              <div key={i} className="text-push-sm">
                <div className="flex items-baseline gap-1.5 text-push-fg-dim">
                  <span className="font-medium text-push-fg-secondary">@{c.author}</span>
                  {c.createdAt && (
                    <span className="text-push-xs">
                      {formatDistanceToNow(new Date(c.createdAt), { addSuffix: true })}
                    </span>
                  )}
                </div>
                <p className="text-push-fg-secondary mt-0.5 line-clamp-3 whitespace-pre-wrap">
                  {c.body}
                </p>
              </div>
            ))}
          </ExpandableCardPanel>
        </div>
      )}
    </div>
  );
}
