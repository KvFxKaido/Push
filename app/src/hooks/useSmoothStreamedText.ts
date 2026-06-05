import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * Smooth-streaming reveal for model output.
 *
 * Raw token streams arrive in bursty, uneven clumps — the network and the model
 * both deliver chunks at wildly different rates, so text "spills" onto the page
 * in visible jumps. This hook decouples the *displayed* text from the *received*
 * text: it reveals characters toward the full buffer at a steady, frame-rate-
 * independent cadence, so bursts drain smoothly instead of popping.
 *
 * It is a pure presentation layer — the underlying message content is untouched
 * (copy/pin/regenerate all still see the full text). The hook only governs how
 * many leading characters of `fullText` are currently painted.
 *
 * Flush-to-full happens immediately when:
 *  - `animate` is false (settled / historical messages),
 *  - the user prefers reduced motion, or
 *  - `requestAnimationFrame` is unavailable (SSR / node test env).
 */

// Time-constant for the exponential ease-out, in milliseconds. Each frame closes
// roughly `1 - e^(-dt/TAU)` of the remaining gap, so smaller = snappier catch-up.
// ~85ms keeps the displayed text trailing real output by a hair while still
// feeling responsive on fast streams.
const REVEAL_TAU_MS = 85;
// Always advance at least one character per frame so a slow trickle never stalls.
const MIN_CHARS_PER_FRAME = 1;
// Backlog beyond this many characters snaps to full instantly rather than
// crawling — guards against paste-sized bursts (resumed runs, big tool results
// echoed into content) where a gradual reveal would feel broken.
const SNAP_THRESHOLD = 1500;

/**
 * Pure stepping function: given the current revealed length, the target length,
 * and the elapsed time since the last frame, return the next revealed length.
 * Exported for unit testing without a DOM / animation loop.
 */
export function revealStep(current: number, target: number, dtMs: number): number {
  if (current >= target) return target;
  const pending = target - current;
  if (pending >= SNAP_THRESHOLD) return target;
  // Exponential ease-out derived from elapsed time → perceived speed is
  // independent of the actual frame rate (60fps, 120fps, or a throttled tab).
  const fraction = 1 - Math.exp(-Math.max(0, dtMs) / REVEAL_TAU_MS);
  const advance = Math.max(MIN_CHARS_PER_FRAME, Math.ceil(pending * fraction));
  return Math.min(target, current + advance);
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Trim a code-unit slice index back so it never lands inside a surrogate pair
 * or right after a zero-width joiner — either would momentarily render a broken
 * glyph (tofu / a dangling joiner) mid-reveal. The reveal accounting stays in
 * UTF-16 code units (revealStep's internal contract); we only snap the
 * displayed boundary. Full grapheme segmentation (Intl.Segmenter) is avoided on
 * purpose: it would re-segment the whole growing string every frame (O(n^2)
 * over a long message) for this marginal, self-healing case.
 */
export function sliceToSafeBoundary(text: string, end: number): string {
  let n = end;
  if (n > 0 && n < text.length) {
    // Don't split a surrogate pair: back off a leading low surrogate.
    const code = text.charCodeAt(n);
    if (code >= 0xdc00 && code <= 0xdfff) n -= 1;
    // Don't end on a dangling ZWJ: drop a trailing joiner so we never show a
    // base glyph + joiner without its continuation.
    while (n > 0 && text.charCodeAt(n - 1) === 0x200d) n -= 1;
  }
  return text.slice(0, n);
}

export function useSmoothStreamedText(fullText: string, animate: boolean): string {
  const [revealedLength, setRevealedLength] = useState(fullText.length);
  const [reduceMotion, setReduceMotion] = useState(prefersReducedMotion);
  const [prevText, setPrevText] = useState(fullText);

  // Refs hold the live values the rAF loop reads, so the loop callback stays
  // stable (no per-token re-subscription) while always seeing the latest target.
  const lengthRef = useRef(fullText.length);
  const targetRef = useRef(fullText);
  const rafRef = useRef<number | null>(null);
  const lastFrameRef = useRef(0);

  // Reset the reveal synchronously *during render* when the content shrinks —
  // a regenerated or replaced message restarts streaming from a shorter string.
  // Collapsing the displayed length here (React's endorsed "adjust state during
  // render" pattern) avoids a one-frame flash of the full new text: without it,
  // the clamp in the return value would briefly paint the entire new message
  // before the loop reset on its next frame. The matching `lengthRef` reset
  // (which the rAF loop reads) happens in the effect below, where ref writes are
  // allowed; the tick also defensively treats an over-target length as 0.
  if (fullText !== prevText) {
    setPrevText(fullText);
    if (fullText.length < prevText.length) {
      setRevealedLength(0);
    }
  }

  // Track reduced-motion changes live so toggling the OS setting mid-stream
  // takes effect without a remount.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduceMotion(mq.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);

  // The animation loop, held in a ref so it can schedule itself without a
  // forward reference. Its body closes over only stable values (refs + the
  // stable setState), so it's defined once on mount. All state writes happen
  // here (inside rAF), never synchronously in an effect body — which keeps the
  // driving effect free to re-run every token without tearing the loop down.
  const tickRef = useRef<(now: number) => void>(() => {});
  useEffect(() => {
    tickRef.current = (now: number) => {
      const dt = now - lastFrameRef.current;
      lastFrameRef.current = now;
      const target = targetRef.current.length;
      // Content was replaced (regenerate / a fresh streaming message reusing
      // this bubble) — restart the reveal from the beginning.
      const current = lengthRef.current > target ? 0 : lengthRef.current;
      const next = revealStep(current, target, dt);
      lengthRef.current = next;
      setRevealedLength(next);
      if (next < target) {
        rafRef.current = requestAnimationFrame((t) => tickRef.current(t));
      } else {
        rafRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    targetRef.current = fullText;

    const stop = () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };

    // Flush-to-full: settled message, reduced motion, or no rAF (SSR / node).
    // The displayed value (below) already resolves to the full text in these
    // cases, so we only need to halt any in-flight loop. Returning `stop` keeps
    // this effect the single owner of frame cleanup, including on unmount.
    if (!animate || reduceMotion || typeof requestAnimationFrame !== 'function') {
      stop();
      return stop;
    }

    // Content shrank (new / regenerated message): reset the loop cursor so it
    // re-reveals from the start. Pairs with the render-time `revealedLength`
    // reset above — this is the ref half, which the rAF loop reads.
    if (lengthRef.current > fullText.length) {
      lengthRef.current = 0;
    }

    if (lengthRef.current < fullText.length && rafRef.current == null) {
      lastFrameRef.current = performance.now();
      rafRef.current = requestAnimationFrame((t) => tickRef.current(t));
    }

    return stop;
  }, [fullText, animate, reduceMotion]);

  return useMemo(() => {
    // Mirror the effect's flush conditions so the render path never shows a
    // partial slice when smoothing is inactive (settled, reduced motion, or no
    // rAF to ever advance the reveal).
    if (!animate || reduceMotion || typeof requestAnimationFrame !== 'function') {
      return fullText;
    }
    return sliceToSafeBoundary(fullText, Math.min(revealedLength, fullText.length));
  }, [animate, reduceMotion, fullText, revealedLength]);
}
