/**
 * useCIPoller.ts
 *
 * Extracted from useChat.ts — polls GitHub CI checks on a 60s interval
 * for the active repo/branch and exposes the latest CIStatus.
 */

import { useState, useEffect } from 'react';
import type { CIStatus } from '@/types';
import { executeToolCall } from '@/lib/github-tools';

export function useCIPoller(
  activeChatId: string,
  activeRepoFullName: string | null,
  branchInfo?: { currentBranch?: string; defaultBranch?: string },
) {
  const [ciStatus, setCiStatus] = useState<CIStatus | null>(null);
  const currentBranch = branchInfo?.currentBranch;
  const defaultBranch = branchInfo?.defaultBranch;
  const branch = currentBranch || defaultBranch;

  useEffect(() => {
    const repo = activeRepoFullName;
    if (!repo || !branch) return;

    let aborted = false;
    const poll = async () => {
      try {
        const result = await executeToolCall(
          { tool: 'fetch_checks', args: { repo, ref: branch } },
          repo,
        );
        if (!aborted && result.card?.type === 'ci-status') {
          setCiStatus(result.card.data as CIStatus);
        }
      } catch (err) {
        console.error('[Push] CI poll failed:', err);
      }
    };

    poll();
    const interval = setInterval(poll, 60_000);

    return () => {
      aborted = true;
      clearInterval(interval);
    };
  }, [activeChatId, activeRepoFullName, currentBranch, defaultBranch, branch]);

  return { ciStatus: activeRepoFullName && branch ? ciStatus : null };
}
