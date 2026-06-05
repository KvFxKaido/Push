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
 * exit on terminal conditions" rule): the poll loop terminates on exactly three
 * conditions — the process reports not-running, the overall deadline is exceeded
 * (we interrupt, then return what we have flagged as an error), or the process
 * record disappears (NOT_FOUND mid-run). There is no happy-path-only await.
 */

import type { ExecResult } from './sandbox-provider';

export interface DetachedStartResult {
  processId: string;
}

export interface DetachedStatusResult {
  running: boolean;
  exitCode: number | null;
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
  /** Delay between status/log polls. Default 1500ms. */
  pollIntervalMs?: number;
  /** Called with each incremental chunk as it's drained (live progress). */
  onProgress?: (chunk: { stdout: string; stderr: string }) => void;
  /** Injectable for tests; defaults to real timers. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const DEFAULT_OVERALL_TIMEOUT_MS = 600_000;
const DEFAULT_POLL_INTERVAL_MS = 1500;

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
): Promise<ExecResult> {
  const overallTimeoutMs = options.overallTimeoutMs ?? DEFAULT_OVERALL_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = options.now ?? (() => Date.now());

  // `start` failures propagate — the caller distinguishes "backend has no
  // background routes" (fall back) from other errors.
  const { processId } = await primitives.start(command, { workdir: options.workdir });

  const deadline = now() + overallTimeoutMs;
  let cursorStdout = 0;
  let cursorStderr = 0;
  let stdout = '';
  let stderr = '';

  const drain = async (): Promise<void> => {
    const slice = await primitives.logs(processId, { cursorStdout, cursorStderr });
    if (slice.stdout) {
      stdout += slice.stdout;
      options.onProgress?.({ stdout: slice.stdout, stderr: '' });
    }
    if (slice.stderr) {
      stderr += slice.stderr;
      options.onProgress?.({ stdout: '', stderr: slice.stderr });
    }
    cursorStdout = slice.nextCursorStdout;
    cursorStderr = slice.nextCursorStderr;
  };

  // Build the terminal result for a process that is no longer running. A
  // finished process with no exit code terminated abnormally (killed/errored
  // before the runtime recorded a code) — surface that as a failure rather
  // than masking it as exit 0, since callers gate on `exitCode !== 0`. Reads
  // the current accumulated stdout/stderr at call time.
  const finishedResult = (st: DetachedStatusResult): ExecResult =>
    st.exitCode == null
      ? {
          stdout,
          stderr,
          exitCode: -1,
          truncated: false,
          error: 'background process ended without an exit code (killed or errored)',
        }
      : { stdout, stderr, exitCode: st.exitCode, truncated: false };

  for (;;) {
    let st: DetachedStatusResult;
    try {
      st = await primitives.status(processId);
    } catch (err) {
      if (isNotFound(err)) {
        // The process record vanished mid-run (reclaimed/evicted). Drain
        // whatever logs remain reachable, then report it as a failure the
        // caller can distinguish from a clean exit.
        await drain().catch(() => {});
        return {
          stdout,
          stderr,
          exitCode: -1,
          truncated: false,
          error: 'background process record disappeared before completion',
        };
      }
      throw err;
    }

    // A log-fetch failure must NOT escape the loop: `status` above is the
    // authoritative terminal signal, so swallow drain errors (losing at most a
    // partial slice — the next poll re-reads from the same cursor) and let the
    // loop continue. Otherwise a transient 404/504 on getProcessLogs would
    // either reject the whole run or be misread by the caller's start-failure
    // fallback as "backend lacks background routes" and re-run the command.
    await drain().catch(() => {});

    if (!st.running) {
      return finishedResult(st);
    }

    if (now() >= deadline) {
      // The process may have finished in the window between the status read
      // above and now. Re-check before declaring a timeout so a command that
      // completed right at the boundary isn't mislabeled exit 124.
      const finalStatus = await primitives.status(processId).catch(() => null);
      await drain().catch(() => {});
      if (finalStatus && !finalStatus.running) {
        return finishedResult(finalStatus);
      }
      await primitives.interrupt(processId).catch(() => {});
      await drain().catch(() => {});
      return {
        stdout,
        stderr,
        exitCode: 124, // mirror shell `timeout`'s exit code for a killed command
        truncated: false,
        error: `command exceeded ${overallTimeoutMs}ms overall deadline and was interrupted`,
      };
    }

    await sleep(pollIntervalMs);
  }
}
