import { useEffect, useRef } from 'react';
import { registerBackIntent } from '@/lib/android/back-handler';

/**
 * Register an Android hardware/gesture Back intent while `active` is true.
 *
 * On Back, `onBack` runs (e.g. close this sheet) and the press is consumed — the
 * app does NOT background. LIFO across all active handlers: the most-recently
 * activated one wins, so a sheet opened over another closes first. Inert on web
 * (the registry is never dispatched there). `onBack` is read through a ref so a
 * changing callback identity doesn't churn the registration.
 */
export function useBackHandler(active: boolean, onBack: () => void): void {
  const onBackRef = useRef(onBack);
  useEffect(() => {
    onBackRef.current = onBack;
  });

  useEffect(() => {
    if (!active) return;
    return registerBackIntent(() => {
      onBackRef.current();
      return true;
    });
  }, [active]);
}
