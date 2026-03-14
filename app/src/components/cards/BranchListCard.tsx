import { Shield, Star } from 'lucide-react';
import { BranchWaveIcon } from '@/components/icons/push-custom-icons';
import type { BranchListCardData } from '@/types';
import {
  CARD_SHELL_CLASS,
  CARD_LIST_CLASS,
  CARD_BADGE_INFO,
  CARD_BADGE_WARNING,
} from '@/lib/utils';

export function BranchListCard({ data }: { data: BranchListCardData }) {
  return (
    <div className={CARD_SHELL_CLASS}>
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-push-edge/80 px-3.5 py-3">
        <BranchWaveIcon className="h-3.5 w-3.5 text-push-fg-secondary" />
        <span className="text-push-base font-medium text-push-fg">
          {data.branches.length} branch{data.branches.length !== 1 ? 'es' : ''}
        </span>
        <span className="text-push-sm text-push-fg-dim font-mono">{data.repo}</span>
      </div>

      {/* Branch list */}
      <div className={CARD_LIST_CLASS}>
        {data.branches.map((branch) => (
          <div
            key={branch.name}
            className="flex items-center gap-2 px-3.5 py-2"
          >
            <span className="text-push-base text-push-fg font-mono truncate">
              {branch.name}
            </span>
            {branch.isDefault && (
              <span className={`${CARD_BADGE_INFO} inline-flex items-center gap-0.5 px-1.5 py-0.5 text-push-xs shrink-0`}>
                <Star className="h-2.5 w-2.5" />
                default
              </span>
            )}
            {branch.isProtected && (
              <span className={`${CARD_BADGE_WARNING} inline-flex items-center gap-0.5 px-1.5 py-0.5 text-push-xs shrink-0`}>
                <Shield className="h-2.5 w-2.5" />
                protected
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
