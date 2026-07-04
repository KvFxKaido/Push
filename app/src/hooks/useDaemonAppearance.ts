/**
 * useDaemonAppearance — per-mode appearance state for daemon-backed
 * workspaces. Mirrors `useChatModeAppearance` in shape: read at mount,
 * re-read when `mode` changes, write through on every change.
 *
 * Storage moved from per-mode localStorage keys into the unified settings
 * document (a `{ [mode]: RepoAppearance }` map under one canonical key), so the
 * daemon palette follows the signed-in identity across devices.
 *
 * Keyed by daemon mode so Remote keeps its own accent separate from repo/chat
 * surfaces.
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { safeStorageGet } from '@/lib/safe-storage';
import { getSetting, SETTINGS_KEYS, setSetting, subscribeSetting } from '@/lib/settings-store';
import {
  coerceRepoAppearance,
  DEFAULT_REPO_APPEARANCE,
  type RepoAppearance,
} from '@/lib/repo-appearance';
import type { WorkspaceMode } from '@/types';

type DaemonAppearanceMode = Extract<WorkspaceMode, 'relay'>;

type DaemonAppearanceMap = Partial<Record<DaemonAppearanceMode, RepoAppearance>>;

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

// Pre-unification per-mode localStorage key, read once as a fallback.
function legacyKey(mode: DaemonAppearanceMode): string {
  return `push:daemon-appearance:${mode}:v1`;
}

function legacyAppearance(mode: DaemonAppearanceMode): RepoAppearance | undefined {
  const raw = safeStorageGet(legacyKey(mode));
  if (!raw) return undefined;
  try {
    return coerceRepoAppearance(JSON.parse(raw)) ?? undefined;
  } catch {
    return undefined;
  }
}

function resolveMode(mode: DaemonAppearanceMode, rawMap: unknown): RepoAppearance {
  const map = rawMap && typeof rawMap === 'object' ? (rawMap as DaemonAppearanceMap) : undefined;
  const stored = map?.[mode];
  const coerced = stored !== undefined ? coerceRepoAppearance(stored) : null;
  return coerced ?? legacyAppearance(mode) ?? DAEMON_DEFAULT_APPEARANCE;
}

function writeMode(mode: DaemonAppearanceMode, value: RepoAppearance): void {
  const map = getSetting<DaemonAppearanceMap>(SETTINGS_KEYS.appearanceDaemon) ?? {};
  setSetting(SETTINGS_KEYS.appearanceDaemon, { ...map, [mode]: value });
}

export function useDaemonAppearance(mode: DaemonAppearanceMode) {
  // Subscribe to the raw daemon-appearance map; the per-mode value is derived in
  // a memo so the snapshot stays referentially stable (the map ref only changes
  // on a real write) and a `mode` change re-derives without a setState-in-effect.
  const rawMap = useSyncExternalStore(
    (cb) => subscribeSetting(SETTINGS_KEYS.appearanceDaemon, cb),
    () => getSetting(SETTINGS_KEYS.appearanceDaemon),
    () => undefined,
  );
  const appearance = useMemo(() => resolveMode(mode, rawMap), [mode, rawMap]);

  const setAppearance = useCallback(
    (next: RepoAppearance) => {
      writeMode(mode, coerceRepoAppearance(next) ?? DAEMON_DEFAULT_APPEARANCE);
    },
    [mode],
  );

  const resetAppearance = useCallback(() => {
    writeMode(mode, DAEMON_DEFAULT_APPEARANCE);
  }, [mode]);

  return { appearance, setAppearance, resetAppearance };
}
