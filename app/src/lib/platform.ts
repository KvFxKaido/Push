/**
 * Web-surface platform probe.
 *
 * Detects whether the PWA is running inside the Capacitor native shell
 * (Android today) versus a plain browser. Capacitor injects a `Capacitor`
 * global with `isNativePlatform()`; outside the shell the global is absent.
 *
 * Lives in `app/src/lib/` (not root `lib/`) because it's inherently a
 * web/Capacitor concern — the CLI surface has no `window.Capacitor`. Promoted
 * here from `api-url.ts` on its second consumer (the git-session selection
 * seam), per CLAUDE.md's promote-on-second-surface rule.
 */

type CapacitorGlobal = { isNativePlatform?: () => boolean };

/** True when running inside the Capacitor native (Android) shell. */
export function isNativePlatform(): boolean {
  if (typeof window === 'undefined') return false;
  const cap = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
  return cap?.isNativePlatform?.() ?? false;
}
