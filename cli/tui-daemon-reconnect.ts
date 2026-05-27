/**
 * tui-daemon-reconnect.ts — Reconnect state machine for the TUI/daemon link.
 *
 * The TUI used to fall back to inline mode the moment the daemon socket
 * closed and never try again for the rest of the session — a one-shot
 * regression that hid every daemon hiccup behind "Daemon disconnected.
 * Falling back to inline mode." This module owns the retry loop instead:
 * exponential backoff capped at `MAX_BACKOFF_MS`, retry attempts run
 * forever (until the TUI exits or the user explicitly stops), and the
 * live `attempt` + `secondsUntilNextRetry` are exposed so the footer
 * chip can render a `reconnect 4s (try 3)` countdown.
 *
 * The state machine is pure — it does not perform connect attempts
 * itself, it just decides *when* the next attempt should fire and what
 * the footer should display. The TUI calls `attemptDaemonReconnect`
 * (which wraps the real socket connect + attach) when the timer the
 * coordinator schedules fires. This keeps every side-effecting bit
 * inside `tui.ts` and lets the coordinator be exercised in tests
 * without spawning a real daemon.
 */

/**
 * Backoff schedule for daemon reconnect attempts (ms).
 *
 * Indices clamp to the last entry once exhausted so retries continue
 * forever at the cap, which matters when the daemon binary has been
 * replaced mid-session and the user is waiting for it to come back —
 * giving up entirely would silently demote the rest of the session to
 * inline mode, the exact regression this whole PR is closing.
 *
 * The schedule starts at 1s rather than 0 so the first retry doesn't
 * race against the same socket-close error that just dropped us; ramps
 * to 30s within seven attempts so a flapping daemon eats minimal CPU.
 */
export const RECONNECT_BACKOFF_MS: readonly number[] = [
  1_000, 2_000, 4_000, 8_000, 16_000, 30_000,
] as const;

/** Convenience: the longest delay in `RECONNECT_BACKOFF_MS`. */
export const MAX_BACKOFF_MS = RECONNECT_BACKOFF_MS[RECONNECT_BACKOFF_MS.length - 1];

/**
 * Pick the next backoff delay (ms) for the given 0-based attempt
 * count. Exported for tests and for the TUI to peek at the next delay
 * without mutating any state.
 */
export function pickBackoffMs(attemptCount: number): number {
  if (attemptCount < 0) return RECONNECT_BACKOFF_MS[0];
  const idx = Math.min(attemptCount, RECONNECT_BACKOFF_MS.length - 1);
  return RECONNECT_BACKOFF_MS[idx];
}

/**
 * The coordinator's external phase. `idle` is the steady state (daemon
 * either connected or we've never tried — in either case no timer is
 * running). `reconnecting` means a timer is armed and `nextRetryAtMs`
 * is the wall-clock when it fires.
 */
export type ReconnectPhase = 'idle' | 'reconnecting';

export interface ReconnectState {
  phase: ReconnectPhase;
  /** 0 before the first failed attempt; bumped each time
   * `recordAttemptResult('fail')` is called. */
  attempts: number;
  /** Wall-clock (ms since epoch) when the next attempt will fire. Null
   * while idle. Used by the footer to render a live countdown. */
  nextRetryAtMs: number | null;
}

/** Initial state — no reconnect in progress. */
export function createReconnectState(): ReconnectState {
  return { phase: 'idle', attempts: 0, nextRetryAtMs: null };
}

/**
 * Plan the next retry given the current state. Returns the new state
 * and the delay (ms) that the caller should pass to its `setTimeout`.
 *
 * Mutates nothing — the TUI assigns the returned state, arms its own
 * timer, and on fire calls `recordAttemptResult` to step the machine
 * forward. Splitting "plan" from "record" keeps the timer itself out
 * of the pure layer so tests don't need to fake timers.
 */
export function planNextRetry(
  state: ReconnectState,
  nowMs: number,
): { next: ReconnectState; delayMs: number } {
  const delayMs = pickBackoffMs(state.attempts);
  return {
    next: {
      phase: 'reconnecting',
      attempts: state.attempts,
      nextRetryAtMs: nowMs + delayMs,
    },
    delayMs,
  };
}

/**
 * Record the outcome of an attempt. On success the state resets to
 * idle (the next disconnect starts fresh from 1s). On failure the
 * attempt count bumps but the caller is responsible for calling
 * `planNextRetry` again to arm the next timer — splitting the two so
 * the caller can decide whether to keep retrying without the state
 * machine forcing it (a future "stop retrying" affordance can call
 * `cancelReconnect` between the result and the next plan).
 */
export function recordAttemptResult(
  state: ReconnectState,
  outcome: 'success' | 'fail',
): ReconnectState {
  if (outcome === 'success') {
    return { phase: 'idle', attempts: 0, nextRetryAtMs: null };
  }
  return {
    phase: 'reconnecting',
    attempts: state.attempts + 1,
    nextRetryAtMs: null,
  };
}

/**
 * Cancel any pending retry. Returns to the idle state without resetting
 * the attempt count, so a subsequent re-arm continues the backoff
 * progression rather than restarting from 1s.
 *
 * Used when the daemon comes back via an unrelated path (e.g. another
 * connect attempt succeeds outside the retry loop) — we want to drop
 * the timer but not pretend the disconnect never happened.
 */
export function cancelReconnect(state: ReconnectState): ReconnectState {
  return { phase: 'idle', attempts: state.attempts, nextRetryAtMs: null };
}

/**
 * Compute the seconds-until-next-retry value the footer chip displays.
 * Reads the wall-clock from `nowMs` rather than `Date.now()` so the
 * frame ticker can pass a single timestamp and unit tests can drive
 * the countdown deterministically.
 *
 * Clamped to non-negative so a fired-but-not-yet-resolved retry shows
 * `0s` instead of negative numbers if the frame happens to render in
 * the gap between the timer firing and the attempt completing.
 */
export function secondsUntilNextRetry(state: ReconnectState, nowMs: number): number {
  if (state.phase !== 'reconnecting' || state.nextRetryAtMs === null) return 0;
  const remaining = state.nextRetryAtMs - nowMs;
  if (remaining <= 0) return 0;
  return Math.ceil(remaining / 1000);
}
