import { GitBranch, Shield, Star } from 'lucide-react';
import type { BranchListCardData } from '@/types';
import { CARD_SHELL_CLASS } from '@/lib/utils';

export function BranchListCard({ data }: { data: BranchListCardData }) {
  return (
    <div className={CARD_SHELL_CLASS}>
      {/* Header */}
      <div className="px-3 py-2 flex items-center gap-2 border-b border-push-edge">
        <GitBranch className="h-3.5 w-3.5 text-push-fg-secondary" />
        <span className="text-[13px] font-medium text-push-fg">
          {data.branches.length} branch{data.branches.length !== 1 ? 'es' : ''}
        </span>
        <span className="text-[12px] text-push-fg-dim font-mono">{data.repo}</span>
      </div>

      {/* Branch list */}
      <div className="divide-y divide-push-edge">
        {data.branches.map((branch) => (
          <div
            key={branch.name}
            className="px-3 py-1.5 flex items-center gap-2"
          >
            <span className="text-[13px] text-[#e4e4e7] font-mono truncate">
              {branch.name}
            </span>
            {branch.isDefault && (
              <span className="inline-flex items-center gap-0.5 text-[11px] text-push-link bg-push-link/10 px-1.5 py-0.5 rounded-full shrink-0">
                <Star className="h-2.5 w-2.5" />
                default
              </span>
            )}
            {branch.isProtected && (
              <span className="inline-flex items-center gap-0.5 text-[11px] text-[#f59e0b] bg-[#f59e0b]/10 px-1.5 py-0.5 rounded-full shrink-0">
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
