/**
 * Surface-agnostic orchestration for running a command via the detached
 * background-exec primitives and blocking until it finishes — assembling the
 * same `ExecResult` a buffered `exec()` would have returned.
 *
 * Why this exists: buffered `exec()` is capped by the provider's per-call
 * deadline (the CF container wrapper fires at ~140s), so a genuinely long
 * command — a cold `npm install` on a cache miss — can hit the ceiling and
 * fail. Running it detached removes that ceiling: the process is bounded only
 * by the caller's overall budget here, and its output is drained incrementally
 * by cursor so nothing is lost if a poll is slow.
 *
 * The primitives are injected, not imported, so this kernel is independent of
 * the transport (provider class vs. the web `sandbox-client` fetch path) and
 * trivially unit-testable. `sleep`/`now` are injectable for the same reason.
 *
 * Loop-exit discipline (per the repo's "every await in a loop must prove it can
 * exit on terminal conditions" rule): the poll loop terminates on exactly four
 * conditions — the process reports not-running, the overall deadline is exceeded
 * (we interrupt, then return what we have flagged as an error), the abort signal
 * fires (same interrupt-and-return shape, exit 124), or the process record
 * disappears (NOT_FOUND mid-run). There is no happy-path-only await.
 */

import type { ExecResult } from './sandbox-provider';

/**
 * How a detached run reached its terminal state — provenance the exit code
 * alone cannot carry (124 can be a deadline interrupt, a user cancel, or the
 * command's own exit; -1 can be never-started or lost-mid-run, which differ
 * in whether the command may have mutated the workspace).
 */
export type DetachedTerminalReason =
  /** The process exited on its own (exit code may be non-zero or missing). */
  | 'completed'
  /** The abort signal fired; the process was interrupted (or never started). */
  | 'cancelled'
  /** The overall wall-clock budget was exceeded; the process was interrupted. */
  | 'deadline'
  /** Started, then status/record became unreadable — outcome unknown. */
  | 'lost-contact'
  /**
   * The start call failed without confirming whether the process launched.
   * Never produced by this runner (an unstarted run throws); set by transport
   * wrappers that decline to retry an ambiguous start.
   */
  | 'start-unconfirmed';

export interface DetachedExecResult extends ExecResult {
  terminalReason: DetachedTerminalReason;
}

export interface DetachedStartResult {
  processId: string;
}

export interface DetachedStatusResult {
  running: boolean;
  exitCode: number | null;
  /** Workspace git branch after the process finished. Omitted when unavailable/running. */
  branch?: string;
}

export interface DetachedLogsResult {
  stdout: string;
  stderr: string;
  nextCursorStdout: number;
  nextCursorStderr: number;
}

/**
 * The four transport calls the runner drives. A provider or fetch client
 * supplies these; the runner owns only the polling/draining loop.
 */
export interface DetachedExecPrimitives {
  start(command: string, opts: { workdir?: string }): Promise<DetachedStartResult>;
  status(processId: string): Promise<DetachedStatusResult>;
  logs(
    processId: string,
    cursors: { cursorStdout: number; cursorStderr: number },
  ): Promise<DetachedLogsResult>;
  interrupt(processId: string): Promise<void>;
}

export interface RunDetachedOptions {
  workdir?: string;
  /** Overall wall-clock budget for the whole run. Default 10 minutes. */
  overallTimeoutMs?: number;
  /**
   * Delay between status/log polls. A number polls at a fixed cadence; an
   * array ramps through its entries and then repeats the last one — so short
   * commands resolve within the fast early polls while long runs settle to
   * the final cadence. Default [250, 500, 1000, 1500].
   */
  pollIntervalMs?: number | readonly number[];
  /**
   * Cooperative cancel. If already aborted, the run resolves exit-124 WITHOUT
   * starting the process (it does not throw — a throw means "never started,
   * fall back to buffered exec", which would re-run a command the user just
   * cancelled). Once started, an abort interrupts the process, drains the log
   * tail, and resolves exit-124. Checked once per poll iteration, so cancel
   * latency is bounded by the current poll delay.
   */
  abortSignal?: AbortSignal;
  /**
   * Cap on accumulated output per stream, in UTF-16 code units (≈ bytes for
   * ASCII-heavy tool output). When exceeded the HEAD is dropped — for long
   * runs the tail holds the failure — and the result is flagged `truncated`.
   * `onProgress` always receives full chunks; only accumulation is capped.
   * Default 256k per stream.
   */
  maxAccumulatedChars?: number;
  /** Called with each incremental chunk as it's drained (live progress). */
  onProgress?: (chunk: { stdout: string; stderr: string }) => void;
  /** Injectable for tests; defaults to real timers. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const DEFAULT_OVERALL_TIMEOUT_MS = 600_000;
const DEFAULT_POLL_SCHEDULE_MS: readonly number[] = [250, 500, 1000, 1500];
const DEFAULT_MAX_ACCUMULATED_CHARS = 256_000;
// Drain-round bounds. After a CONFIRMED stop the buffer is finite, so the
// generous bound only guards pathology. After a best-effort interrupt (abort/
// deadline) or a status failure the process may still be running and writing —
// an unbounded cursor drain against a chatty survivor would never terminate
// (the kill is `.catch(() => {})`-swallowed), so those paths get a tight bound
// and accept losing the true tail.
const CONFIRMED_STOP_DRAIN_ROUNDS = 500;
const UNCONFIRMED_DRAIN_ROUNDS = 25;

function isNotFound(err: unknown): boolean {
  const code = (err as { statusCode?: number; code?: string } | null | undefined) ?? {};
  return code.statusCode === 404 || code.code === 'NOT_FOUND';
}

/**
 * Start `command` detached and poll until it exits, returning the accumulated
 * output as an `ExecResult`. The promise rejects only if `start` itself fails
 * (e.g. the backend lacks background routes) — that's the signal callers use to
 * fall back to buffered exec. Once started, terminal conditions resolve rather
 * than throw, so the caller always gets a result.
 */
export async function runDetachedToCompletion(
  primitives: DetachedExecPrimitives,
  command: string,
  options: RunDetachedOptions = {},
): Promise<DetachedExecResult> {
  const overallTimeoutMs = options.overallTimeoutMs ?? DEFAULT_OVERALL_TIMEOUT_MS;
  // An empty schedule array would index to `undefined` and turn the poll loop
  // into a tight spin — treat it as "use the default".
  const pollSchedule =
    typeof options.pollIntervalMs === 'number'
      ? options.pollIntervalMs
      : options.pollIntervalMs && options.pollIntervalMs.length > 0
        ? options.pollIntervalMs
        : DEFAULT_POLL_SCHEDULE_MS;
  const pollDelayMs = (iteration: number): number =>
    typeof pollSchedule === 'number'
      ? pollSchedule
      : pollSchedule[Math.min(iteration, pollSchedule.length - 1)];
  const maxAccumulatedChars = options.maxAccumulatedChars ?? DEFAULT_MAX_ACCUMULATED_CHARS;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = options.now ?? (() => Date.now());

  // A pre-aborted run must not start at all — and must NOT throw, since a
  // throw means "never started → fall back to buffered exec", which would
  // run a command the user just cancelled.
  if (options.abortSignal?.aborted) {
    return {
      stdout: '',
      stderr: '',
      exitCode: 124,
      truncated: false,
      error: 'command was cancelled before it started',
      terminalReason: 'cancelled',
    };
  }

  // Contract: this function throws ONLY if the command never started. Every
  // post-start outcome (clean exit, abnormal exit, lost contact, deadline,
  // cancel) resolves to an ExecResult. That lets the caller treat a throw
  // unambiguously as "start failed → fall back to buffered exec" without risk
  // of re-running a command that is already executing detached.
  const { processId } = await primitives.start(command, { workdir: options.workdir });

  const deadline = now() + overallTimeoutMs;
  let cursorStdout = 0;
  let cursorStderr = 0;
  let stdout = '';
  let stderr = '';
  let truncatedHead = false;

  // Keep the accumulated tail within the cap, dropping from the head. Trim on
  // a surrogate-pair boundary so the kept tail never starts mid-codepoint.
  const appendCapped = (acc: string, chunk: string): string => {
    const joined = acc + chunk;
    if (joined.length <= maxAccumulatedChars) return joined;
    truncatedHead = true;
    let from = joined.length - maxAccumulatedChars;
    const code = joined.charCodeAt(from);
    if (code >= 0xdc00 && code <= 0xdfff) from++;
    return joined.slice(from);
  };

  const drain = async (): Promise<void> => {
    const slice = await primitives.logs(processId, { cursorStdout, cursorStderr });
    // Advance cursors BEFORE consuming the slice: if a consumer throws, a
    // stale cursor would re-read and re-append the same slice on every later
    // poll (duplicated output until the cap). Advancing first loses at most
    // this one slice; it never duplicates.
    cursorStdout = slice.nextCursorStdout;
    cursorStderr = slice.nextCursorStderr;
    if (slice.stdout) {
      stdout = appendCapped(stdout, slice.stdout);
      try {
        options.onProgress?.({ stdout: slice.stdout, stderr: '' });
      } catch {
        // progress is best-effort; a throwing listener must not affect the run
      }
    }
    if (slice.stderr) {
      stderr = appendCapped(stderr, slice.stderr);
      try {
        options.onProgress?.({ stdout: '', stderr: slice.stderr });
      } catch {
        // progress is best-effort; a throwing listener must not affect the run
      }
    }
  };

  // Drain repeatedly until no new bytes arrive or the round bound is hit.
  // Each `logs` read is capped (the worker returns at most one cap-sized
  // slice per call), so a single `drain()` can leave a large final burst
  // unread. The bound matters on the interrupt/lost-contact paths: there the
  // process may have survived a swallowed kill and still be writing, and an
  // unbounded cursor-following loop against it would never terminate. Used on
  // the terminal paths; the per-poll mid-run drain stays single-shot to keep
  // the loop responsive.
  const drainToEnd = async (maxRounds: number): Promise<void> => {
    for (let round = 0; round < maxRounds; round++) {
      const beforeStdout = cursorStdout;
      const beforeStderr = cursorStderr;
      try {
        await drain();
      } catch {
        return; // lost contact draining the tail — keep what we have
      }
      if (cursorStdout === beforeStdout && cursorStderr === beforeStderr) return;
    }
  };

  // Build the terminal result for a process that is no longer running. A
  // finished process with no exit code terminated abnormally (killed/errored
  // before the runtime recorded a code) — surface that as a failure rather
  // than masking it as exit 0, since callers gate on `exitCode !== 0`. Reads
  // the current accumulated stdout/stderr at call time.
  const finishedResult = (st: DetachedStatusResult): DetachedExecResult =>
    st.exitCode == null
      ? {
          stdout,
          stderr,
          exitCode: -1,
          truncated: truncatedHead,
          error: 'background process ended without an exit code (killed or errored)',
          terminalReason: 'completed',
          ...(st.branch ? { branch: st.branch } : {}),
        }
      : {
          stdout,
          stderr,
          exitCode: st.exitCode,
          truncated: truncatedHead,
          terminalReason: 'completed',
          ...(st.branch ? { branch: st.branch } : {}),
        };

  for (let iteration = 0; ; iteration++) {
    if (options.abortSignal?.aborted) {
      // User cancel. The process may have JUST finished — prefer the real
      // result over a synthetic 124 (same re-check the deadline path does).
      const finalStatus = await primitives.status(processId).catch(() => null);
      if (finalStatus && !finalStatus.running) {
        await drainToEnd(CONFIRMED_STOP_DRAIN_ROUNDS);
        return finishedResult(finalStatus);
      }
      await primitives.interrupt(processId).catch(() => {});
      await drainToEnd(UNCONFIRMED_DRAIN_ROUNDS);
      return {
        stdout,
        stderr,
        exitCode: 124, // mirror shell `timeout`/SIGTERM convention, same as the deadline path
        truncated: truncatedHead,
        error: 'command was cancelled and interrupted',
        terminalReason: 'cancelled',
      };
    }

    let st: DetachedStatusResult;
    try {
      st = await primitives.status(processId);
    } catch (err) {
      // Any status failure mid-run resolves to a failure result rather than
      // throwing — the command already started, so re-running it via the
      // caller's start-failure fallback would duplicate work and orphan the
      // detached process. A NOT_FOUND means the record was reclaimed; any
      // other persistent error (retries already exhausted in the transport)
      // means we've lost contact and can't determine the outcome. Both are
      // failures the caller surfaces, not restarts.
      await drainToEnd(UNCONFIRMED_DRAIN_ROUNDS);
      return {
        stdout,
        stderr,
        exitCode: -1,
        truncated: truncatedHead,
        error: isNotFound(err)
          ? 'background process record disappeared before completion'
          : `lost contact with background process: ${err instanceof Error ? err.message : String(err)}`,
        terminalReason: 'lost-contact',
      };
    }

    if (!st.running) {
      // Process stopped — fully catch up on any final burst before returning.
      await drainToEnd(CONFIRMED_STOP_DRAIN_ROUNDS);
      return finishedResult(st);
    }

    // Mid-run: one bounded slice per poll keeps the loop responsive. A log-fetch
    // failure must NOT escape the loop — `status` is the authoritative terminal
    // signal, so swallow drain errors (losing at most a partial slice; the next
    // poll re-reads from the same cursor) and continue. Otherwise a transient
    // 404/504 on getProcessLogs would reject the whole run or be misread by the
    // caller's start-failure fallback as "backend lacks routes" and re-run it.
    await drain().catch(() => {});

    if (now() >= deadline) {
      // The process may have finished in the window between the status read
      // above and now. Re-check before declaring a timeout so a command that
      // completed right at the boundary isn't mislabeled exit 124.
      const finalStatus = await primitives.status(processId).catch(() => null);
      if (finalStatus && !finalStatus.running) {
        await drainToEnd(CONFIRMED_STOP_DRAIN_ROUNDS);
        return finishedResult(finalStatus);
      }
      await primitives.interrupt(processId).catch(() => {});
      await drainToEnd(UNCONFIRMED_DRAIN_ROUNDS);
      return {
        stdout,
        stderr,
        exitCode: 124, // mirror shell `timeout`'s exit code for a killed command
        truncated: truncatedHead,
        error: `command exceeded ${overallTimeoutMs}ms overall deadline and was interrupted`,
        terminalReason: 'deadline',
      };
    }

    await sleep(pollDelayMs(iteration));
  }
}
