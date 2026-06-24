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
    onPointerMove: (e: PointerEvent) => void;
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

// A held finger jitters by a few px; only a real drag/scroll should abort the
// press. Without a threshold, the sub-pixel `pointermove` events a stationary
// touch emits kill the timer before it fires — the "long-press does nothing on
// touch" bug. Tuned to the usual tap-vs-drag slop.
const MOVE_CANCEL_THRESHOLD_PX = 10;

/**
 * Press-and-hold detection for touch. Pointer devices reveal via hover, so the
 * handlers only arm on `pointerType === 'touch'`; a lift/cancel, or movement
 * past `MOVE_CANCEL_THRESHOLD_PX` from the press origin, aborts (so a scroll
 * that starts on the trigger never fires it — but finger micro-jitter doesn't).
 * Shared by the `Tip` tooltip (long-press to reveal the explanation) and the
 * workspace branch picker (long-press to reveal Delete).
 */
export function useLongPress(
  onLongPress: () => void,
  { delayMs = 400 }: UseLongPressOptions = {},
): UseLongPress {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);
  const startPos = useRef<{ x: number; y: number } | null>(null);

  const clear = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    startPos.current = null;
  }, []);

  const onPointerDown = useCallback(
    (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      fired.current = false;
      clear();
      startPos.current = { x: e.clientX, y: e.clientY };
      timer.current = setTimeout(() => {
        fired.current = true;
        onLongPress();
      }, delayMs);
    },
    [clear, delayMs, onLongPress],
  );

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      const start = startPos.current;
      if (!start || !timer.current) return;
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > MOVE_CANCEL_THRESHOLD_PX) {
        clear();
      }
    },
    [clear],
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
      onPointerMove,
      onPointerLeave: clear,
      onPointerCancel: clear,
    },
    consumeClick,
  };
}
