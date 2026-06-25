import { useEffect } from 'react';

/**
 * Modal affordances for an overlay: dismiss on Escape and lock background
 * scroll while mounted. Extracted from the scratchpad memory reader so the
 * full-screen note editor and the reader share one implementation.
 *
 * Escape is handled in the **capture** phase (and propagation stopped) because
 * these overlays can mount inside the workspace hub's Radix Sheet — Radix
 * dismisses the topmost dialog on a bubble-phase Escape (its listener sits on
 * `document`), which would close the whole hub behind the overlay. Capture
 * precedes every bubble-phase listener, so Esc dismisses only this overlay.
 *
 * Scroll lock is save/restore rather than hard-set-to-'auto': we cache the
 * prior `overflow` and put it back on unmount, so if another component already
 * locked the body we faithfully restore its value instead of clobbering it.
 */
export function useEscapeAndScrollLock(onEscape: () => void): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onEscape();
    };
    window.addEventListener('keydown', onKeyDown, true);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = previousOverflow;
    };
  }, [onEscape]);
}
