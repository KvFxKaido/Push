import { GitMerge, X } from 'lucide-react';
import { useState } from 'react';
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
  ) => Promise<{ ok: boolean; errorMessage?: string } | void> | void;
  onDismiss: () => void;
}

interface MergeDetectedBannerViewProps extends MergeDetectedBannerState {
  pending?: boolean;
  error?: string | null;
  onContinue: () => void;
  onDismiss: () => void;
}

export function MergeDetectedBannerView({
  branch,
  baseBranch,
  pr,
  pending = false,
  error = null,
  onContinue,
  onDismiss,
}: MergeDetectedBannerViewProps) {
  return (
    <div
      data-push-toast-clearance
      className={`mx-4 mt-5 mb-1 flex items-center justify-between gap-3 px-1 py-2.5 ${HUB_TOP_BANNER_STRIP_CLASS} border-emerald-500/25`}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <GitMerge className="h-4 w-4 shrink-0 text-emerald-300" />
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-emerald-100">
            {branch} was merged into {baseBranch} (PR #{pr.number}) — continue this chat on{' '}
            {baseBranch}?
          </p>
          {error ? <p className="mt-1 truncate text-[11px] text-red-200">{error}</p> : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <button
          onClick={onContinue}
          disabled={pending}
          className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} gap-1.5 px-3 text-emerald-100`}
        >
          <GitMerge className="h-3 w-3" />
          <span>{pending ? 'Switching...' : `Continue on ${baseBranch}`}</span>
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

export function MergeDetectedBanner(props: MergeDetectedBannerProps) {
  const { branch, baseBranch, pr, mergeBranchInUI } = props;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleContinue = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await mergeBranchInUI(baseBranch, {
        from: branch,
        prNumber: pr.number,
        source: 'merge_detected',
      });
      if (result && result.ok === false) {
        setError(result.errorMessage ?? `Could not switch to ${baseBranch}.`);
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <MergeDetectedBannerView
      {...props}
      pending={pending}
      error={error}
      onContinue={() => void handleContinue()}
    />
  );
}
