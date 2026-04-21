/**
 * Global background-mode preference.
 *
 * Phase 1 ships a single global toggle — not a per-chat flag — because
 * the value of Phase 1 is proving the background-job loop and replay
 * model, not UX polish. A per-chat override can be layered later
 * without changing this module's contract: callers read the flag
 * through `isBackgroundModeEnabled()` / `useBackgroundModeEnabled()`
 * and a future per-chat lookup would short-circuit before reaching
 * the global.
 *
 * Storage key is deliberately named as a mode *preference*, not a
 * permanent capability flag — leaves the door open for later per-chat
 * override without semantic awkwardness.
 */

import { useEffect, useState } from 'react';
import { safeStorageGet, safeStorageSet } from './safe-storage';

const STORAGE_KEY = 'push:background-mode-preference';

export function isBackgroundModeEnabled(): boolean {
  return safeStorageGet(STORAGE_KEY) === '1';
}

export function setBackgroundModeEnabled(enabled: boolean): void {
  safeStorageSet(STORAGE_KEY, enabled ? '1' : '0');
  // Notify same-tab listeners — `storage` events only fire cross-tab.
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('push:background-mode-changed'));
  }
}

export function useBackgroundModeEnabled(): [boolean, (next: boolean) => void] {
  const [enabled, setEnabled] = useState<boolean>(() => isBackgroundModeEnabled());

  useEffect(() => {
    const sync = () => setEnabled(isBackgroundModeEnabled());
    window.addEventListener('push:background-mode-changed', sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener('push:background-mode-changed', sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const setter = (next: boolean) => {
    setBackgroundModeEnabled(next);
    setEnabled(next);
  };

  return [enabled, setter];
}
