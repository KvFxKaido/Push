/**
 * runViewTransition — a thin, safe wrapper over the View Transitions API.
 *
 * Calls `document.startViewTransition(update)` so the browser can morph
 * between the DOM before and after `update` (e.g. a list card growing into a
 * full-screen overlay via matched `view-transition-name`s). Falls back to
 * running `update` synchronously — same end state, no animation — when:
 *   - the API is unavailable (older Android WebView / Safari, SSR), or
 *   - the user prefers reduced motion, or
 *   - the caller passes `disabled` (e.g. a feature flag).
 *
 * Keeping the fallback here means call sites never branch on support; they
 * always get the correct final DOM, animated where possible.
 */

type ViewTransitionCapableDocument = Document & {
  startViewTransition?: (callback: () => void) => { finished?: Promise<void> };
};

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function supportsViewTransitions(): boolean {
  return (
    typeof document !== 'undefined' &&
    typeof (document as ViewTransitionCapableDocument).startViewTransition === 'function'
  );
}

export function runViewTransition(update: () => void, opts?: { disabled?: boolean }): void {
  if (opts?.disabled || prefersReducedMotion() || !supportsViewTransitions()) {
    update();
    return;
  }
  (document as ViewTransitionCapableDocument).startViewTransition?.(update);
}
