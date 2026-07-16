/**
 * Monotonic elapsed-time measurement.
 *
 * `Date.now()` is the WALL clock — it can step backward (NTP correction, VM
 * resume, WSL2 host-clock skew), so `Date.now() - start` can go negative or
 * wildly wrong when the clock jumps mid-operation. `performance.now()` is
 * monotonic and immune to those steps, which is what you want for measuring how
 * long something took. Use this for any user-facing duration (tool cards,
 * run-event `durationMs`) instead of subtracting two `Date.now()` reads.
 */

/**
 * Start a monotonic timer. Returns a function that yields whole milliseconds
 * elapsed since the call, never negative.
 */
export function startElapsedMs(): () => number {
  const start = performance.now();
  return () => Math.max(0, Math.round(performance.now() - start));
}
