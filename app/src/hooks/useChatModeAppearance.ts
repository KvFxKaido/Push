import { useCallback } from 'react';
import { safeStorageGet } from '@/lib/safe-storage';
import { SETTINGS_KEYS } from '@/lib/settings-store';
import {
  coerceRepoAppearance,
  DEFAULT_REPO_APPEARANCE,
  type RepoAppearance,
} from '@/lib/repo-appearance';
import { useSetting } from './useSetting';

// Pre-unification localStorage key, read once as a fallback so an existing
// chat-mode palette survives the first load and migrates into the settings doc
// on the next write.
const LEGACY_KEY = 'push:chat-mode-appearance:v1';

const coerce = (raw: unknown): RepoAppearance | undefined => coerceRepoAppearance(raw) ?? undefined;

function legacyChatModeAppearance(): RepoAppearance | undefined {
  const raw = safeStorageGet(LEGACY_KEY);
  if (!raw) return undefined;
  try {
    return coerce(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export function useChatModeAppearance() {
  const [appearance, setAppearanceValue] = useSetting<RepoAppearance>(
    SETTINGS_KEYS.appearanceChatMode,
    DEFAULT_REPO_APPEARANCE,
    { coerce, legacyFallback: legacyChatModeAppearance },
  );

  const setAppearance = useCallback(
    (next: RepoAppearance) => {
      setAppearanceValue(coerceRepoAppearance(next) ?? DEFAULT_REPO_APPEARANCE);
    },
    [setAppearanceValue],
  );

  const resetAppearance = useCallback(() => {
    setAppearanceValue(DEFAULT_REPO_APPEARANCE);
  }, [setAppearanceValue]);

  return { appearance, setAppearance, resetAppearance };
}
