import { type PointerEvent, useCallback, useEffect, useRef } from 'react';

interface UseLongPressOptions {
  /** Hold duration before firing, in ms. */
  delayMs?: number;
}

interface UseLongPress {
  /**
   * Spread onto the trigger element. Long-press is touch-only — mouse/pen
   * reveal via hover, so the handlers no-op for those pointer types.
   */
  pointerHandlers: {
    onPointerDown: (e: PointerEvent) => void;
    onPointerUp: () => void;
    onPointerMove: () => void;
    onPointerLeave: () => void;
    onPointerCancel: () => void;
  };
  /**
   * Returns true exactly once if a long-press just fired, then resets. Call it
   * at the top of the trigger's `onClick` to swallow the click that follows the
   * release, so a long-press doesn't also fire the element's tap action.
   */
  consumeClick: () => boolean;
}

/**
 * Press-and-hold detection for touch. Pointer devices reveal via hover, so the
 * handlers only arm on `pointerType === 'touch'`; any move/lift/cancel before
 * the hold completes aborts (so a scroll that starts on the trigger never fires
 * it). Shared by the `Tip` tooltip (long-press to reveal the explanation) and
 * the workspace branch picker (long-press to reveal Delete).
 */
export function useLongPress(
  onLongPress: () => void,
  { delayMs = 400 }: UseLongPressOptions = {},
): UseLongPress {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);

  const clear = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const onPointerDown = useCallback(
    (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      fired.current = false;
      clear();
      timer.current = setTimeout(() => {
        fired.current = true;
        onLongPress();
      }, delayMs);
    },
    [clear, delayMs, onLongPress],
  );

  // Cancel any in-flight hold if the trigger unmounts mid-press.
  useEffect(() => clear, [clear]);

  const consumeClick = useCallback(() => {
    if (fired.current) {
      fired.current = false;
      return true;
    }
    return false;
  }, []);

  return {
    pointerHandlers: {
      onPointerDown,
      onPointerUp: clear,
      onPointerMove: clear,
      onPointerLeave: clear,
      onPointerCancel: clear,
    },
    consumeClick,
  };
}
