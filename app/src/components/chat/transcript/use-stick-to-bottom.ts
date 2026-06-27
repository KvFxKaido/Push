import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '@/types';
import { AUTO_SCROLL_THRESHOLD_PX, AT_BOTTOM_THRESHOLD_PX } from './constants';

function distanceFromBottom(el: HTMLElement): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

export interface StickToBottomController {
  /**
   * Attach to the scroll element. Works as a plain DOM ref
   * (`<div ref={registerScroller}>`) and as Virtuoso's `scrollerRef`. The union
   * includes `Window` only to stay assignable to Virtuoso's ref signature — we
   * don't use window scrolling, so a `Window` (or any non-element) is ignored
   * and leaves tracking disabled by design. For element scrollers the hook
   * wires up the scroll listener and tears it down when the element detaches.
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
  // Whether the user was following (within the 150px grace band) when a scroller
  // element was last detached. Defaults true so a fresh mount aligns; carries
  // that intent across a scroller swap so we re-align a follower without yanking
  // someone who had scrolled away. Uses the follow band, not the 48px at-bottom
  // band, to match what the streaming effect treats as "following".
  const followingRef = useRef(true);
  // Honors intent beyond scroll position: text selection, an upward wheel, a
  // navigation key, or a touch drag all pause auto-follow even while still
  // inside the 150px band — so we never yank the viewport out from under someone
  // reading or selecting the streaming tail. Distance alone can't see these
  // (the reader hasn't left the band yet). Re-armed when the reader returns to
  // the bottom, clicks "jump to latest", or sends a new turn — all explicit
  // "follow again" signals.
  const followPausedRef = useRef(false);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const syncBottomState = useCallback(() => {
    const el = elRef.current;
    if (!el) return;
    const atBottom = distanceFromBottom(el) <= AT_BOTTOM_THRESHOLD_PX;
    // Reaching the bottom is the reader rejoining the live edge — resume
    // following. Only a real scroll reaches here, so a paused-at-bottom reader
    // (e.g. selecting text) stays paused until they actually scroll.
    if (atBottom) followPausedRef.current = false;
    setIsAtBottom(atBottom);
  }, []);

  // Mark follow as paused on an explicit reading/navigation gesture. Position-
  // independent on purpose: selecting text while pinned at the bottom must stop
  // the per-frame pin too, or the selection is torn away on the next token.
  const pauseFollow = useCallback(() => {
    followPausedRef.current = true;
  }, []);

  // Upward wheel = intent to read back; downward wheel is left to syncBottomState
  // (it re-arms once the reader lands at the bottom).
  const onWheel = useCallback((event: WheelEvent) => {
    if (event.deltaY < 0) followPausedRef.current = true;
  }, []);

  // Navigation keys driven from within the transcript subtree (a focused link or
  // the container) signal manual control. Re-arm is handled by the scroll events
  // those keys produce once the reader reaches the bottom.
  const onKeyDown = useCallback((event: KeyboardEvent) => {
    const NAV_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
    if (NAV_KEYS.has(event.key)) followPausedRef.current = true;
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
      // Explicit "jump to latest" — resume following from here.
      followPausedRef.current = false;
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
      if (previous) {
        // Capture follow intent against the 150px grace band (the band the
        // streaming effect follows within) before detaching the old element.
        followingRef.current = distanceFromBottom(previous) < AUTO_SCROLL_THRESHOLD_PX;
        previous.removeEventListener('scroll', syncBottomState);
        previous.removeEventListener('wheel', onWheel);
        previous.removeEventListener('keydown', onKeyDown);
        previous.removeEventListener('touchmove', pauseFollow);
        previous.removeEventListener('selectstart', pauseFollow);
      }
      elRef.current = node;
      if (!node) return;
      node.addEventListener('scroll', syncBottomState, { passive: true });
      // Non-scroll intent signals (shadcn "every interaction is intent"): each
      // pauses auto-follow so streaming never moves the viewport mid-read.
      node.addEventListener('wheel', onWheel, { passive: true });
      node.addEventListener('keydown', onKeyDown);
      node.addEventListener('touchmove', pauseFollow, { passive: true });
      node.addEventListener('selectstart', pauseFollow);
      // Bottom-align on attach (virtualized threshold crossover), but only while
      // the user is following. On first mount `followingRef` defaults true so we
      // align; if Virtuoso ever swaps its scroller element mid-life we re-align a
      // following user but leave a scrolled-away user where they were.
      if (alignOnMount && followingRef.current) {
        node.scrollTo({ top: node.scrollHeight });
      }
      syncBottomState();
    },
    [alignOnMount, syncBottomState, onWheel, onKeyDown, pauseFollow],
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
      // The reader sent a turn — an unambiguous "follow again" signal that
      // clears any prior pause and jumps to the new message.
      followPausedRef.current = false;
      scrollElementToBottom('smooth');
      return;
    }
    if (!followPausedRef.current && distanceFromBottom(el) < AUTO_SCROLL_THRESHOLD_PX) {
      scrollElementToBottom('smooth');
    }
  }, [lastMessage, streamingContent, scrollElementToBottom]);

  // Follow the *animated* growth of a streaming message. The smooth-stream
  // reveal grows the DOM height across animation frames without changing
  // `lastMessage.content`, so the content-keyed effect above never re-fires for
  // those frames — left to it alone, the view would scroll once on each token
  // and then fall behind the reveal, potentially drifting outside the follow
  // band before the final flush. While the tail is streaming and the user is
  // within the band, pin the bottom every frame (instant, so it tracks the
  // height growth rather than compounding smooth scrolls). The band check leaves
  // a user who has scrolled up alone, and resumes following if they return; the
  // pause check additionally backs off mid-band on a read/select/keyboard
  // gesture so the reveal never tears a selection away.
  const isStreamingTail = lastMessage?.status === 'streaming';
  useEffect(() => {
    if (!isStreamingTail || typeof requestAnimationFrame !== 'function') return;
    let raf = 0;
    const follow = () => {
      const el = elRef.current;
      if (el && !followPausedRef.current && distanceFromBottom(el) < AUTO_SCROLL_THRESHOLD_PX) {
        el.scrollTop = el.scrollHeight;
      }
      raf = requestAnimationFrame(follow);
    };
    raf = requestAnimationFrame(follow);
    return () => cancelAnimationFrame(raf);
  }, [isStreamingTail]);

  return { registerScroller, isAtBottom, scrollToBottom };
}
