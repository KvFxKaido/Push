/**
 * useDaemonAppearance — per-mode appearance state for daemon-backed
 * workspaces. Mirrors `useChatModeAppearance` in shape: read from
 * localStorage at mount, re-read when `mode` changes, write through on
 * every change.
 *
 * Why keyed by mode: local-pc and relay sessions render the same shell
 * but the user is likely to think of them as different "places" (one
 * runs locally, the other talks to a remote machine). Sharing one
 * appearance would force them to look identical; keying per mode lets
 * the user paint each lane distinctly without bleeding into the other.
 */
import { useCallback, useEffect, useState } from 'react';
import { safeStorageGet, safeStorageSet } from '@/lib/safe-storage';
import {
  coerceRepoAppearance,
  DEFAULT_REPO_APPEARANCE,
  type RepoAppearance,
} from '@/lib/repo-appearance';
import type { WorkspaceMode } from '@/types';

type DaemonAppearanceMode = Extract<WorkspaceMode, 'local-pc' | 'relay'>;

// Daemon sessions deliberately start with the glow off — the animated
// blob layer is a wasted compositor cost when the user hasn't opted in
// to a colored accent. `DEFAULT_REPO_APPEARANCE.glowEnabled` defaults
// to true, which is the right default for repo sessions (the accent is
// the cue the user is in a particular project) but the wrong one here,
// so the daemon default forks.
const DAEMON_DEFAULT_APPEARANCE: RepoAppearance = {
  ...DEFAULT_REPO_APPEARANCE,
  glowEnabled: false,
};

function storageKey(mode: DaemonAppearanceMode): string {
  return `push:daemon-appearance:${mode}:v1`;
}

function loadAppearance(mode: DaemonAppearanceMode): RepoAppearance {
  const raw = safeStorageGet(storageKey(mode));
  if (!raw) return DAEMON_DEFAULT_APPEARANCE;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return coerceRepoAppearance(parsed) ?? DAEMON_DEFAULT_APPEARANCE;
  } catch {
    return DAEMON_DEFAULT_APPEARANCE;
  }
}

export function useDaemonAppearance(mode: DaemonAppearanceMode) {
  const [appearance, setAppearanceState] = useState<RepoAppearance>(() => loadAppearance(mode));

  // Re-read from storage when `mode` changes. The hook initializes
  // once at mount, so without this a parent that swaps between modes
  // on the same mounted DaemonChatBody (theoretical today, but cheap
  // to guard) would keep showing the previous mode's palette until a
  // manual update or unmount.
  useEffect(() => {
    setAppearanceState(loadAppearance(mode));
  }, [mode]);

  const setAppearance = useCallback(
    (next: RepoAppearance) => {
      const normalized = coerceRepoAppearance(next) ?? DAEMON_DEFAULT_APPEARANCE;
      safeStorageSet(storageKey(mode), JSON.stringify(normalized));
      setAppearanceState(normalized);
    },
    [mode],
  );

  const resetAppearance = useCallback(() => {
    safeStorageSet(storageKey(mode), JSON.stringify(DAEMON_DEFAULT_APPEARANCE));
    setAppearanceState(DAEMON_DEFAULT_APPEARANCE);
  }, [mode]);

  return { appearance, setAppearance, resetAppearance };
}
