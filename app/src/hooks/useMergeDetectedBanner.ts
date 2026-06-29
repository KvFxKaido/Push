import { useCallback, useEffect, useRef, useState } from 'react';
import { detectStrandedMergedPR } from '@/lib/github-tools';
import {
  dismissMergeDetectedBanner,
  isMergeDetectedBannerDismissed,
  mergeDetectedCandidate,
  visibleMergeDetectedBannerForChat,
  type MergeDetectedBannerState,
} from '@/lib/merge-detected-banner-state';

interface UseMergeDetectedBannerArgs {
  repoFullName?: string | null;
  activeChatId?: string | null;
  chatBranch?: string | null;
  defaultBranch?: string | null;
}

export function useMergeDetectedBanner({
  repoFullName,
  activeChatId,
  chatBranch,
  defaultBranch,
}: UseMergeDetectedBannerArgs): {
  mergeDetected: MergeDetectedBannerState | null;
  dismissMergeDetected: () => void;
  refreshMergeDetection: () => Promise<void>;
} {
  const [mergeDetected, setMergeDetected] = useState<MergeDetectedBannerState | null>(null);
  const requestSeqRef = useRef(0);

  const refreshMergeDetection = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    const repo = repoFullName?.trim();
    const chatId = activeChatId ?? null;
    const branch = chatBranch?.trim();
    const targetDefault = defaultBranch?.trim();

    if (!repo || !chatId || !branch || (targetDefault && branch === targetDefault)) {
      setMergeDetected(null);
      return;
    }
    if (isMergeDetectedBannerDismissed(chatId)) {
      setMergeDetected(null);
      return;
    }

    const pr = await detectStrandedMergedPR(repo, branch);
    if (seq !== requestSeqRef.current) return;

    const candidate = mergeDetectedCandidate(branch, targetDefault ?? '', pr);
    setMergeDetected(visibleMergeDetectedBannerForChat(chatId, candidate));
  }, [activeChatId, chatBranch, defaultBranch, repoFullName]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void refreshMergeDetection();
    }, 0);
    return () => clearTimeout(timer);
  }, [refreshMergeDetection]);

  const dismissMergeDetected = useCallback(() => {
    dismissMergeDetectedBanner(activeChatId);
    setMergeDetected(null);
  }, [activeChatId]);

  return { mergeDetected, dismissMergeDetected, refreshMergeDetection };
}
