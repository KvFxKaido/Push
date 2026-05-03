import { useState } from 'react';
import { GitMerge, GitPullRequest, GitPullRequestClosed, Shield, Star } from 'lucide-react';
import { BranchWaveIcon } from '@/components/icons/push-custom-icons';
import type { BranchListCardData } from '@/types';
import {
  CARD_SHELL_CLASS,
  CARD_LIST_CLASS,
  CARD_BADGE_INFO,
  CARD_BADGE_WARNING,
  CARD_BADGE_SUCCESS,
} from '@/lib/utils';
import { ExpandChevron, ExpandableCardPanel } from './expandable';

type BranchPR = NonNullable<BranchListCardData['branches'][number]['pr']>;

function PRBadge({ pr }: { pr: BranchPR }) {
  if (pr.state === 'merged') {
    return (
      <span
        className={`${CARD_BADGE_SUCCESS} inline-flex items-center gap-0.5 px-1.5 py-0.5 text-push-xs shrink-0`}
        title={pr.title}
      >
        <GitMerge className="h-2.5 w-2.5" />#{pr.number} merged
      </span>
    );
  }
  if (pr.state === 'open') {
    return (
      <span
        className={`${CARD_BADGE_INFO} inline-flex items-center gap-0.5 px-1.5 py-0.5 text-push-xs shrink-0`}
        title={pr.title}
      >
        <GitPullRequest className="h-2.5 w-2.5" />#{pr.number} open
      </span>
    );
  }
  return (
    <span
      className={`${CARD_BADGE_WARNING} inline-flex items-center gap-0.5 px-1.5 py-0.5 text-push-xs shrink-0`}
      title={pr.title}
    >
      <GitPullRequestClosed className="h-2.5 w-2.5" />#{pr.number} closed
    </span>
  );
}

export function BranchListCard({ data }: { data: BranchListCardData }) {
  const [expanded, setExpanded] = useState(data.branches.length <= 5);

  return (
    <div className={CARD_SHELL_CLASS}>
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3.5 py-3 hover:bg-push-bg-secondary/50 transition-colors"
      >
        <ExpandChevron expanded={expanded} />
        <BranchWaveIcon className="h-3.5 w-3.5 text-push-fg-secondary" />
        <span className="text-push-base font-medium text-push-fg">
          {data.branches.length} branch{data.branches.length !== 1 ? 'es' : ''}
        </span>
        <span className="text-push-sm text-push-fg-dim font-mono ml-auto">{data.repo}</span>
      </button>

      <ExpandableCardPanel expanded={expanded}>
        <div className={CARD_LIST_CLASS}>
          {data.branches.map((branch) => (
            <div
              key={branch.name}
              className="flex items-center gap-2 px-3.5 py-2 hover:bg-push-bg-secondary/30 transition-colors cursor-default"
            >
              <span className="text-push-base text-push-fg font-mono truncate">{branch.name}</span>
              {branch.isDefault && (
                <span
                  className={`${CARD_BADGE_INFO} inline-flex items-center gap-0.5 px-1.5 py-0.5 text-push-xs shrink-0`}
                >
                  <Star className="h-2.5 w-2.5" />
                  default
                </span>
              )}
              {branch.isProtected && (
                <span
                  className={`${CARD_BADGE_WARNING} inline-flex items-center gap-0.5 px-1.5 py-0.5 text-push-xs shrink-0`}
                >
                  <Shield className="h-2.5 w-2.5" />
                  protected
                </span>
              )}
              {!branch.isDefault && branch.pr && <PRBadge pr={branch.pr} />}
            </div>
          ))}
        </div>
      </ExpandableCardPanel>
    </div>
  );
}
