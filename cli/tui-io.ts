/**
 * The TUI's IO + process seam (Phase 0 of the TUI Decomposition track — see
 * `docs/decisions/TUI Decomposition - Testability Seam and Daemon Session
 * Controller.md`).
 *
 * `runTUI` historically reached for `process.stdin` / `process.stdout` /
 * `process.stderr` directly and registered `SIGTERM` / `SIGHUP` /
 * `uncaughtException` handlers + called `process.exit` inline. That made the
 * 6,500-line closure impossible to drive headlessly: there was no way to feed
 * keystrokes, capture output, or stop the process from killing the test runner.
 *
 * This module is the indirection. Production passes nothing and gets
 * {@link createDefaultTuiIo} (identical behavior to before). A test harness
 * passes its own `TuiIo` — a fake stdin to feed keystrokes, a capture stdout,
 * and no-op signal/exit hooks so the closure can't register real process
 * handlers or terminate the runner.
 *
 * Scope is deliberately small: just the process-surface seam. Higher-level
 * collaborators (the daemon client factory, config/session loaders) are
 * injected separately via `options.deps`.
 */

/**
 * Process signals + the uncaught-exception channel the TUI wires for cleanup.
 * `SIGINT` is only registered transiently during terminal handoff
 * (`tui-handoff.ts`): raw mode normally swallows Ctrl+C, but while an external
 * child owns the cooked-mode terminal, SIGINT reaches the whole process group
 * and the TUI must ignore it so only the child dies.
 */
export type TuiProcessSignal = 'SIGTERM' | 'SIGHUP' | 'SIGINT' | 'uncaughtException';

/**
 * The minimal stdin surface the closure uses. Intentionally structural (not
 * `NodeJS.ReadStream`) so a fake `EventEmitter`-backed stream satisfies it.
 * `setRawMode` is only ever called behind an `isTTY` guard, so a non-TTY fake
 * can omit it in practice — it's optional here to match.
 */
export interface TuiStdin {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  resume: () => unknown;
  setEncoding: (encoding: BufferEncoding | null) => unknown;
  pause: () => unknown;
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  removeListener: (event: string, listener: (...args: unknown[]) => void) => unknown;
}

/**
 * The stdout surface the closure uses. `on`/`removeListener` are REQUIRED, not
 * optional: `runTUI` wires (and tears down) a `'resize'` listener
 * unconditionally, so a `TuiIo` implementor that omits them would crash. The
 * type contract must match that usage.
 */
export interface TuiStdout {
  write: (chunk: string) => unknown;
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  removeListener: (event: string, listener: (...args: unknown[]) => void) => unknown;
}

/** stderr is write-only — the closure never wires events on it. */
export interface TuiWriteStream {
  write: (chunk: string) => unknown;
}

export interface TuiIo {
  stdin: TuiStdin;
  stdout: TuiStdout;
  stderr: TuiWriteStream;
  /** Terminate the process. No-op under a headless harness. */
  exit: (code: number) => void;
  /** Register a process-level signal/uncaught handler. No-op headless. */
  addSignalHandler: (signal: TuiProcessSignal, handler: (...args: unknown[]) => void) => void;
  /** Remove a previously registered handler. No-op headless. */
  removeSignalHandler: (signal: TuiProcessSignal, handler: (...args: unknown[]) => void) => void;
}

/**
 * Production IO: the real `process` streams + handlers. Behavior is identical
 * to the inline `process.*` calls this replaced, so `runTUI()` with no
 * `options.io` is unchanged.
 */
export function createDefaultTuiIo(): TuiIo {
  return {
    stdin: process.stdin as unknown as TuiStdin,
    stdout: process.stdout as unknown as TuiStdout,
    stderr: process.stderr as unknown as TuiWriteStream,
    exit: (code) => process.exit(code),
    addSignalHandler: (signal, handler) => {
      process.on(signal, handler as (...args: unknown[]) => void);
    },
    removeSignalHandler: (signal, handler) => {
      process.removeListener(signal, handler as (...args: unknown[]) => void);
    },
  };
}
