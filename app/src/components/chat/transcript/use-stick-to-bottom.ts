import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '@/types';
import {
  AT_BOTTOM_THRESHOLD_PX,
  AUTO_SCROLL_THRESHOLD_PX,
  TURN_ANCHOR_TOP_GAP_PX,
  turnSpacerHeight,
} from './constants';

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
  /**
   * Height (px) of the bottom spacer the caller must render after its content so
   * the anchored turn can reach the top of the viewport. Always 0 unless
   * top-anchoring is active (a `contentRef` was passed) — the virtualized path
   * leaves it 0 and ignores it.
   */
  bottomSpacerHeight: number;
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
 *
 * Top-anchoring (shadcn points 4–5, 11) is opt-in via `contentRef` +
 * `anchorMessageId`: when both are supplied (the plain path) the hook scrolls
 * `anchorMessageId`'s element near the top of the viewport whenever it changes —
 * on load (the last user message → "reopen where the reader left off") and on
 * each new turn (the just-sent message → "start a new turn near the top") — and
 * sizes `bottomSpacerHeight` so that turn can reach the top. The virtualized
 * path omits both and keeps the pure stick-to-bottom behavior.
 */
export function useStickToBottom(
  lastMessage: ChatMessage | null,
  options: {
    alignOnMount?: boolean;
    /** Message to anchor near the top when it changes (plain path: the last
     *  user message). Requires `contentRef`; ignored without it. */
    anchorMessageId?: string | null;
    /** The inner content element (whose children carry `data-message-id`).
     *  Presence switches on top-anchoring + the bottom spacer. */
    contentRef?: RefObject<HTMLElement | null>;
  } = {},
): StickToBottomController {
  const { alignOnMount = false, anchorMessageId = null, contentRef } = options;
  const elRef = useRef<HTMLElement | null>(null);
  const lastMessageIdRef = useRef<string | null>(null);
  // Anchor target last applied — so the anchor effect fires only on a genuine
  // change (new turn / chat load), not on every streaming token.
  const anchorIdRef = useRef<string | null>(null);
  // Suppresses the follow-resume in `syncBottomState` for the one programmatic
  // scroll the anchor performs: a tiny fresh turn anchors to a position that is
  // also "at the bottom", and without this guard that scroll's own trailing
  // event would immediately re-arm follow and chase the answer off the top.
  const ignoreScrollClearRef = useRef(false);
  const [bottomSpacerHeight, setBottomSpacerHeight] = useState(0);
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

  // Recompute `isAtBottom` from live geometry and return it. Pure w.r.t. follow
  // state — it never re-arms — so it's safe to call from non-scroll paths like
  // the resize observer below, where streaming content grows the height without
  // firing a `scroll` event.
  const refreshIsAtBottom = useCallback(() => {
    const el = elRef.current;
    if (!el) return false;
    const atBottom = distanceFromBottom(el) <= AT_BOTTOM_THRESHOLD_PX;
    setIsAtBottom(atBottom);
    return atBottom;
  }, []);

  const syncBottomState = useCallback(() => {
    const atBottom = refreshIsAtBottom();
    // Reaching the bottom is the reader rejoining the live edge — resume
    // following. Only a real scroll reaches here, so a paused-at-bottom reader
    // (e.g. selecting text) stays paused until they actually scroll. The guard
    // exempts the anchor's own programmatic scroll (see `ignoreScrollClearRef`).
    if (atBottom && !ignoreScrollClearRef.current) followPausedRef.current = false;
  }, [refreshIsAtBottom]);

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

  // The DOM node for the current anchor target, looked up by `data-message-id`
  // within the caller's content element. Null when anchoring is off, the id is
  // absent, or the element isn't mounted yet.
  const findAnchorEl = useCallback((): HTMLElement | null => {
    const content = contentRef?.current;
    if (!content || !anchorMessageId) return null;
    const selector =
      typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
        ? CSS.escape(anchorMessageId)
        : anchorMessageId;
    return content.querySelector<HTMLElement>(`[data-message-id="${selector}"]`);
  }, [contentRef, anchorMessageId]);

  // Spacer height needed for the anchor target to reach the top. `turnHeight` is
  // the distance from the target's top to the bottom of the rendered content
  // (the spacer is the content's sibling, so it never feeds back into this
  // measurement). Scroll-independent: both rects shift together with scroll.
  const measureSpacer = useCallback((): number => {
    const el = elRef.current;
    const content = contentRef?.current;
    const target = findAnchorEl();
    if (!el || !content || !target) return 0;
    const turnHeight = content.getBoundingClientRect().bottom - target.getBoundingClientRect().top;
    return turnSpacerHeight(el.clientHeight, turnHeight);
  }, [contentRef, findAnchorEl]);

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
      // When top-anchoring is active, the dedicated anchor effect positions the
      // new turn near the top and owns the follow state — don't also yank to the
      // bottom. Without it (virtualized path), keep the original behavior: a new
      // user turn is a "follow again" signal that jumps to the bottom.
      if (contentRef) return;
      followPausedRef.current = false;
      scrollElementToBottom('smooth');
      return;
    }
    if (!followPausedRef.current && distanceFromBottom(el) < AUTO_SCROLL_THRESHOLD_PX) {
      scrollElementToBottom('smooth');
    }
  }, [lastMessage, streamingContent, scrollElementToBottom, contentRef]);

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

  // Keep the bottom spacer sized while anchoring is active. A ResizeObserver on
  // the content (grows as the answer streams) and the scroller (viewport resize)
  // recomputes it; the spacer collapses to 0 once the turn fills the viewport,
  // so a long answer leaves no trailing blank space. Guarded so redundant equal
  // values don't churn renders. Gated on `contentRef` → plain path only.
  useEffect(() => {
    if (!contentRef) return;
    const el = elRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const update = () => {
      setBottomSpacerHeight((prev) => {
        const next = measureSpacer();
        return next === prev ? prev : next;
      });
      // Content height changed (streaming tokens grow the answer) without a
      // `scroll` event, so `isAtBottom` would otherwise go stale: once the
      // spacer collapses to 0, further tokens push the live edge past the
      // threshold below the viewport. Resync the flag so the scroll-to-bottom
      // button + streaming dot reflect content that's now off-screen. No follow
      // re-arm — a resize isn't the reader rejoining the live edge.
      refreshIsAtBottom();
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(content);
    observer.observe(el);
    return () => observer.disconnect();
  }, [contentRef, measureSpacer, refreshIsAtBottom]);

  // Anchor the target near the top of the viewport whenever it changes — a new
  // turn (the just-sent user message) or a chat load (the last user message).
  // Size the spacer first so there's room, then scroll on the next frame once
  // it's applied, and pause follow: the reader is now reading the turn from its
  // top, not glued to the live edge (follow re-arms when they scroll back down).
  useEffect(() => {
    if (!contentRef) return;
    const previous = anchorIdRef.current;
    anchorIdRef.current = anchorMessageId;
    if (!anchorMessageId || anchorMessageId === previous) return;
    if (!elRef.current) return;
    setBottomSpacerHeight(measureSpacer());
    const raf = requestAnimationFrame(() => {
      const scroller = elRef.current;
      const target = findAnchorEl();
      if (!scroller || !target) return;
      const delta = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      ignoreScrollClearRef.current = true;
      scroller.scrollTop += delta - TURN_ANCHOR_TOP_GAP_PX;
      followPausedRef.current = true;
      // Release the guard after the programmatic scroll's event has been
      // dispatched (scroll events fire before the next animation frame).
      requestAnimationFrame(() => {
        ignoreScrollClearRef.current = false;
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [anchorMessageId, contentRef, measureSpacer, findAnchorEl]);

  return { registerScroller, isAtBottom, scrollToBottom, bottomSpacerHeight };
}
