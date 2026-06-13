import type { MergedPRForBranch } from './github-tools';
import { safeStorageGet, safeStorageSet } from './safe-storage';

const DISMISSED_STORAGE_KEY = 'push:merge-detected-banner-dismissed-chats';

export interface MergeDetectedBannerState {
  branch: string;
  defaultBranch: string;
  pr: MergedPRForBranch;
}

function parseDismissedChats(raw: string | null): Set<string> {
  if (!raw) return new Set();

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter((item): item is string => typeof item === 'string' && item.length > 0),
    );
  } catch {
    return new Set();
  }
}

function persistDismissedChats(chats: Set<string>): void {
  safeStorageSet(DISMISSED_STORAGE_KEY, JSON.stringify([...chats].sort()));
}

export function isMergeDetectedBannerDismissed(chatId: string | null | undefined): boolean {
  if (!chatId) return false;
  return parseDismissedChats(safeStorageGet(DISMISSED_STORAGE_KEY)).has(chatId);
}

export function dismissMergeDetectedBanner(chatId: string | null | undefined): void {
  if (!chatId) return;
  const dismissed = parseDismissedChats(safeStorageGet(DISMISSED_STORAGE_KEY));
  dismissed.add(chatId);
  persistDismissedChats(dismissed);
}

export function visibleMergeDetectedBannerForChat(
  chatId: string | null | undefined,
  candidate: MergeDetectedBannerState | null,
): MergeDetectedBannerState | null {
  if (!candidate || isMergeDetectedBannerDismissed(chatId)) return null;
  return candidate;
}

/** Build a banner candidate only when the merged PR actually targeted the
 *  default branch. The banner claims "<branch> was merged into <default>" and
 *  migrates the chat to <default>; a PR that merged into a non-default base
 *  (stacked PR, release branch, develop) would make that claim false and
 *  strand the conversation on the wrong branch, so it must not surface. */
export function mergeDetectedCandidate(
  branch: string,
  defaultBranch: string,
  pr: MergedPRForBranch | null,
): MergeDetectedBannerState | null {
  if (!pr || pr.baseBranch !== defaultBranch) return null;
  return { branch, defaultBranch, pr };
}
