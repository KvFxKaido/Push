import { useCallback, useState } from 'react';
import { safeStorageGet, safeStorageSet } from '@/lib/safe-storage';
import {
  coerceRepoAppearance,
  DEFAULT_REPO_APPEARANCE,
  type RepoAppearance,
} from '@/lib/repo-appearance';

const CHAT_MODE_APPEARANCE_STORAGE_KEY = 'push:chat-mode-appearance:v1';

function loadChatModeAppearance(): RepoAppearance {
  const raw = safeStorageGet(CHAT_MODE_APPEARANCE_STORAGE_KEY);
  if (!raw) return DEFAULT_REPO_APPEARANCE;

  try {
    const parsed = JSON.parse(raw) as unknown;
    return coerceRepoAppearance(parsed) ?? DEFAULT_REPO_APPEARANCE;
  } catch {
    return DEFAULT_REPO_APPEARANCE;
  }
}

export function useChatModeAppearance() {
  const [appearance, setAppearanceState] = useState<RepoAppearance>(loadChatModeAppearance);

  const setAppearance = useCallback((next: RepoAppearance) => {
    const normalized = coerceRepoAppearance(next) ?? DEFAULT_REPO_APPEARANCE;
    safeStorageSet(CHAT_MODE_APPEARANCE_STORAGE_KEY, JSON.stringify(normalized));
    setAppearanceState(normalized);
  }, []);

  const resetAppearance = useCallback(() => {
    safeStorageSet(CHAT_MODE_APPEARANCE_STORAGE_KEY, JSON.stringify(DEFAULT_REPO_APPEARANCE));
    setAppearanceState(DEFAULT_REPO_APPEARANCE);
  }, []);

  return { appearance, setAppearance, resetAppearance };
}
