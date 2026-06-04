import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '@/types';
import { AUTO_SCROLL_THRESHOLD_PX, AT_BOTTOM_THRESHOLD_PX } from './constants';

function distanceFromBottom(el: HTMLElement): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

export interface StickToBottomController {
  /**
   * Attach to the scroll element. Works as a plain DOM ref
   * (`<div ref={registerScroller}>`) and as Virtuoso's `scrollerRef` (which may
   * hand back a `Window`); the hook wires up the scroll listener and tears it
   * down when the element detaches.
   */
  registerScroller: (el: HTMLElement | Window | null) => void;
  /** True while within `AT_BOTTOM_THRESHOLD_PX` of the bottom — drives the button. */
  isAtBottom: boolean;
  /** Imperatively scroll to the very bottom (past any footer). */
  scrollToBottom: (behavior?: ScrollBehavior) => void;
}

/**
 * Stick-to-bottom behavior shared by both transcript paths. Encapsulates the
 * scroll-position tracking and the auto-follow rule that were previously
 * hand-duplicated in PlainTranscript and VirtualizedTranscript:
 *
 *  - jump to the bottom on a new *user* message, even if scrolled away;
 *  - otherwise follow streaming output only while within the 150px grace
 *    distance (`AUTO_SCROLL_THRESHOLD_PX`);
 *  - report `isAtBottom` against the 48px threshold (`AT_BOTTOM_THRESHOLD_PX`).
 *
 * Both paths drive this against a real scroll element — the plain container's
 * div, or Virtuoso's scroller — so the only difference is mount behavior:
 * `alignOnMount` bottom-aligns the virtualized list when it mounts fresh at the
 * threshold crossover, which the plain path deliberately does not do.
 */
export function useStickToBottom(
  lastMessage: ChatMessage | null,
  options: { alignOnMount?: boolean } = {},
): StickToBottomController {
  const { alignOnMount = false } = options;
  const elRef = useRef<HTMLElement | null>(null);
  const lastMessageIdRef = useRef<string | null>(null);
  const alignedRef = useRef(false);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const syncBottomState = useCallback(() => {
    const el = elRef.current;
    if (el) setIsAtBottom(distanceFromBottom(el) <= AT_BOTTOM_THRESHOLD_PX);
  }, []);

  // Raw scroll with no state write — safe to call from the effect. The
  // programmatic scroll fires `scroll` events that feed `syncBottomState`, so
  // `isAtBottom` settles without setting state inside the effect.
  const scrollElementToBottom = useCallback((behavior: ScrollBehavior) => {
    const el = elRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  // Public handle for the button (an event handler): optimistically marks
  // at-bottom so the button hides immediately, ahead of the scroll settling.
  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'smooth') => {
      scrollElementToBottom(behavior);
      setIsAtBottom(true);
    },
    [scrollElementToBottom],
  );

  const registerScroller = useCallback(
    (el: HTMLElement | Window | null) => {
      // Only element scrollers are supported (Virtuoso's default). Narrow
      // positively to HTMLElement, guarding the global so a non-browser runtime
      // can't throw on `instanceof`; Window (useWindowScroll) or anything else
      // falls back to null rather than tracking the wrong target.
      const node = typeof HTMLElement !== 'undefined' && el instanceof HTMLElement ? el : null;
      const previous = elRef.current;
      if (previous) previous.removeEventListener('scroll', syncBottomState);
      elRef.current = node;
      if (!node) return;
      node.addEventListener('scroll', syncBottomState, { passive: true });
      // Bottom-align once on first attach (virtualized threshold crossover).
      if (alignOnMount && !alignedRef.current) {
        alignedRef.current = true;
        node.scrollTo({ top: node.scrollHeight });
      }
      syncBottomState();
    },
    [alignOnMount, syncBottomState],
  );

  // Follow new messages / streaming output. Keyed on the streaming content so it
  // re-evaluates on every chunk; `lastMessage` covers new-message transitions.
  const streamingContent = lastMessage?.content ?? '';
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;

    const previousId = lastMessageIdRef.current;
    const isNewMessage = lastMessage && lastMessage.id !== previousId;
    lastMessageIdRef.current = lastMessage?.id ?? null;

    if (isNewMessage && lastMessage.role === 'user') {
      scrollElementToBottom('smooth');
      return;
    }
    if (distanceFromBottom(el) < AUTO_SCROLL_THRESHOLD_PX) {
      scrollElementToBottom('smooth');
    }
  }, [lastMessage, streamingContent, scrollElementToBottom]);

  return { registerScroller, isAtBottom, scrollToBottom };
}
