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

export function useSmoothStreamedText(fullText: string, animate: boolean): string {
  const [revealedLength, setRevealedLength] = useState(fullText.length);
  const [reduceMotion, setReduceMotion] = useState(prefersReducedMotion);

  // Refs hold the live values the rAF loop reads, so the loop callback stays
  // stable (no per-token re-subscription) while always seeing the latest target.
  const lengthRef = useRef(fullText.length);
  const targetRef = useRef(fullText);
  const rafRef = useRef<number | null>(null);
  const lastFrameRef = useRef(0);

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
    // cases, so we only need to halt any in-flight loop.
    if (!animate || reduceMotion || typeof requestAnimationFrame !== 'function') {
      stop();
      return;
    }

    // Reset the cursor if the content shrank (new / regenerated message) so we
    // don't briefly paint stale characters before the loop catches up.
    if (lengthRef.current > fullText.length) {
      lengthRef.current = 0;
    }

    if (lengthRef.current < fullText.length && rafRef.current == null) {
      lastFrameRef.current = performance.now();
      rafRef.current = requestAnimationFrame((t) => tickRef.current(t));
    }

    return stop;
  }, [fullText, animate, reduceMotion]);

  // Cancel any pending frame on unmount.
  useEffect(
    () => () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  return useMemo(() => {
    if (!animate || reduceMotion) return fullText;
    return fullText.slice(0, Math.min(revealedLength, fullText.length));
  }, [animate, reduceMotion, fullText, revealedLength]);
}
