import { GitMerge, X } from 'lucide-react';
import type { BranchSwitchSource } from '@/types';
import {
  HUB_MATERIAL_PILL_BUTTON_CLASS,
  HUB_TOP_BANNER_STRIP_CLASS,
} from '@/components/chat/hub-styles';
import type { MergeDetectedBannerState } from '@/lib/merge-detected-banner-state';

interface MergeDetectedBannerProps extends MergeDetectedBannerState {
  mergeBranchInUI: (
    toBranch: string,
    opts?: { from?: string; prNumber?: number; source?: BranchSwitchSource },
  ) => void;
  onDismiss: () => void;
}

export function MergeDetectedBanner({
  branch,
  defaultBranch,
  pr,
  mergeBranchInUI,
  onDismiss,
}: MergeDetectedBannerProps) {
  return (
    <div
      className={`mx-4 mt-5 mb-1 flex items-center justify-between gap-3 px-1 py-2.5 ${HUB_TOP_BANNER_STRIP_CLASS} border-emerald-500/25`}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <GitMerge className="h-4 w-4 shrink-0 text-emerald-300" />
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-emerald-100">
            {branch} was merged into {defaultBranch} (PR #{pr.number}) — continue this chat on{' '}
            {defaultBranch}?
          </p>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <button
          onClick={() =>
            mergeBranchInUI(defaultBranch, {
              from: branch,
              prNumber: pr.number,
              source: 'merge_detected',
            })
          }
          className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} gap-1.5 px-3 text-emerald-100`}
        >
          <GitMerge className="h-3 w-3" />
          <span>Continue on {defaultBranch}</span>
        </button>
        <button
          onClick={onDismiss}
          className="flex h-7 w-7 items-center justify-center rounded-full text-emerald-100/40 transition-colors hover:bg-emerald-900/20 hover:text-emerald-100/70 active:scale-95"
          aria-label="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
