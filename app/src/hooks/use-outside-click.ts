import { useEffect, type RefObject } from 'react';

/**
 * Fire `handler` when a pointer/touch press lands outside `ref`. Used to
 * dismiss lightweight overlays (the scratchpad memory card, popovers) without
 * a full focus-trap modal. Listens on `mousedown`/`touchstart` so the dismiss
 * happens on press, before a click resolves on the element underneath.
 *
 * `handler` is read fresh on every event via the effect dep, so callers can
 * pass an inline closure without memoizing.
 */
export function useOutsideClick(
  ref: RefObject<HTMLElement | null>,
  handler: (event: MouseEvent | TouchEvent) => void,
): void {
  useEffect(() => {
    const listener = (event: MouseEvent | TouchEvent) => {
      const el = ref.current;
      // Ignore presses inside the ref'd element (or if it's gone).
      if (!el || el.contains(event.target as Node)) return;
      handler(event);
    };

    document.addEventListener('mousedown', listener);
    document.addEventListener('touchstart', listener);
    return () => {
      document.removeEventListener('mousedown', listener);
      document.removeEventListener('touchstart', listener);
    };
  }, [ref, handler]);
}
