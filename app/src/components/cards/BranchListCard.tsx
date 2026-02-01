import { GitBranch, Shield, Star } from 'lucide-react';
import type { BranchListCardData } from '@/types';

export function BranchListCard({ data }: { data: BranchListCardData }) {
  return (
    <div className="my-2 rounded-lg border border-[#1a1a1e] bg-[#111113] overflow-hidden max-w-full">
      {/* Header */}
      <div className="px-3 py-2 flex items-center gap-2 border-b border-[#1a1a1e]">
        <GitBranch className="h-3.5 w-3.5 text-[#a1a1aa]" />
        <span className="text-[13px] font-medium text-[#fafafa]">
          {data.branches.length} branch{data.branches.length !== 1 ? 'es' : ''}
        </span>
        <span className="text-[12px] text-[#52525b] font-mono">{data.repo}</span>
      </div>

      {/* Branch list */}
      <div className="divide-y divide-[#1a1a1e]">
        {data.branches.map((branch) => (
          <div
            key={branch.name}
            className="px-3 py-1.5 flex items-center gap-2"
          >
            <span className="text-[13px] text-[#e4e4e7] font-mono truncate">
              {branch.name}
            </span>
            {branch.isDefault && (
              <span className="inline-flex items-center gap-0.5 text-[11px] text-[#0070f3] bg-[#0070f3]/10 px-1.5 py-0.5 rounded-full shrink-0">
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
