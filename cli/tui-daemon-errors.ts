/**
 * tui-daemon-errors.ts — Structured spawn/crash error surfacing.
 *
 * `cli/tui.ts` used to render daemon spawn failures as raw
 * `Could not start pushd (${err.message}).` lines and crash/wedge
 * paths as "Daemon disconnected. Falling back to inline mode." with
 * no PID, exit code, or log tail. Users were left to crack open
 * `~/.push/run/pushd.log` manually to diagnose anything.
 *
 * This module is the pure layer of the fix:
 *
 *   - `classifyDaemonSpawnError(err)` maps an exception from the spawn
 *     path to a structured `{ code, headline, hint? }` triple. The
 *     headline is the one-line transcript entry; the hint is an
 *     optional follow-up line that tells the user what to do next.
 *     Falls back to a generic "unknown" classification when the error
 *     doesn't match any known pattern, so the surface degrades to
 *     today's behaviour rather than swallowing the error entirely.
 *
 *   - `formatPushdLogTail(raw)` slices the last N lines off a log
 *     blob and wraps them in a transcript-ready text block. The TUI
 *     calls `readPushdLogTail(logPath)` from the spawn-failure and
 *     disconnect paths to fetch + format in one step.
 *
 * The TUI wires these into the actual error-rendering sites; the
 * helpers themselves don't touch any TUI state so the unit tests
 * can pin every branch without spawning a process.
 */

import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

/**
 * Bytes to read from the tail of `pushd.log` per call. `pushd.log`
 * appends indefinitely (no rotation today — see
 * `cli/cli.ts:readLogTail`), so reading the whole file would allocate
 * megabytes of buffer the moment the user hit a spawn failure on a
 * long-running install. 16KB is well over a typical "last 12 lines"
 * worth of log output and small enough that the worst case is cheap.
 */
const LOG_TAIL_CHUNK_BYTES = 16 * 1024;

/**
 * Structured result of `classifyDaemonSpawnError`. The TUI renders
 * `headline` as a `warning` transcript entry and, if `hint` is set,
 * follows with a second entry containing the actionable next step.
 *
 * `code` is the machine-readable classification — used by tests + log
 * forwarders that want to distinguish "permission denied" from
 * "binary missing" without parsing the headline.
 */
export interface ClassifiedDaemonError {
  code:
    | 'EACCES'
    | 'EADDRINUSE'
    | 'ENOENT'
    | 'TSX_LOADER_MISSING'
    | 'NODE_OOM'
    | 'EPERM'
    | 'EMFILE'
    | 'UNKNOWN';
  headline: string;
  hint?: string;
}

function errorCode(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const c = (err as { code?: unknown }).code;
  return typeof c === 'string' ? c : null;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Map a spawn-path exception to a structured classification.
 *
 * Recognised today:
 *   - `EACCES` (errno-style code): socket directory or pidfile path
 *     refused the write. Hint: chmod 700 the run directory.
 *   - `EADDRINUSE`: another pushd is already on the socket. Hint:
 *     check the existing one or remove the stale socket file.
 *   - `ENOENT`: a path the daemon tried to read/write doesn't exist.
 *     Most often the run dir wasn't created — the spawn path should
 *     mkdir it, so seeing this means the parent path (~/.push) is
 *     also missing. Hint: ensure HOME is set and writable.
 *   - `EPERM`: permission denied (broader than EACCES — e.g. trying
 *     to delete a pid file owned by another user). Hint: chown the
 *     run dir.
 *   - `EMFILE`: ran out of file descriptors. Hint: raise ulimit.
 *   - "tsx" reference in the message: the .ts source was launched
 *     without the tsx loader. Hint: use the npm-installed binary.
 *   - "out of memory" / "heap" reference: Node OOM. Hint: raise
 *     `--max-old-space-size` or close other heavy processes.
 *
 * Everything else lands in `UNKNOWN` with the raw message preserved.
 */
export function classifyDaemonSpawnError(err: unknown): ClassifiedDaemonError {
  const code = errorCode(err);
  const message = errorMessage(err);

  if (code === 'EACCES') {
    return {
      code: 'EACCES',
      headline: `pushd spawn failed (EACCES — permission denied): ${message}`,
      hint: 'Check that ~/.push/run is owned by your user with mode 700, then retry.',
    };
  }
  if (code === 'EADDRINUSE') {
    return {
      code: 'EADDRINUSE',
      headline: `pushd spawn failed (EADDRINUSE — socket already bound): ${message}`,
      hint: 'Another pushd may already be running. Run `push daemon status` or remove the stale socket at ~/.push/run/pushd.sock.',
    };
  }
  if (code === 'ENOENT') {
    return {
      code: 'ENOENT',
      headline: `pushd spawn failed (ENOENT — path missing): ${message}`,
      hint: 'Ensure $HOME is set and writable; ~/.push will be re-created on next launch.',
    };
  }
  if (code === 'EPERM') {
    return {
      code: 'EPERM',
      headline: `pushd spawn failed (EPERM — operation not permitted): ${message}`,
      hint: 'A pushd directory or file is owned by a different user. chown -R "$USER" ~/.push and retry.',
    };
  }
  if (code === 'EMFILE') {
    return {
      code: 'EMFILE',
      headline: `pushd spawn failed (EMFILE — too many open files): ${message}`,
      hint: 'Raise the file-descriptor ulimit (e.g. `ulimit -n 4096`) or close other processes holding sockets.',
    };
  }
  // Substring matchers for cases that don't expose a clean errno.
  if (/\btsx\b/i.test(message) && /(not found|cannot find|MODULE_NOT_FOUND)/i.test(message)) {
    return {
      code: 'TSX_LOADER_MISSING',
      headline: `pushd spawn failed: tsx loader is required for TypeScript source but not installed.`,
      hint: 'Install dependencies with `npm install` from the repo root, or run the built binary instead of the .ts source.',
    };
  }
  if (/out of memory|heap out of memory|JavaScript heap/i.test(message)) {
    return {
      code: 'NODE_OOM',
      headline: `pushd spawn failed: Node ran out of memory.`,
      hint: 'Raise the heap with `NODE_OPTIONS="--max-old-space-size=4096"` or close other heavy processes.',
    };
  }
  return {
    code: 'UNKNOWN',
    headline: `Could not start pushd: ${message}`,
  };
}

/**
 * Default number of log lines to surface in the transcript.
 * Twelve fits comfortably in a single screenful while still showing
 * enough context to spot a stack-trace header + the lines around
 * the failure. Tunable via the `maxLines` option.
 */
export const DEFAULT_LOG_TAIL_LINES = 12;

/**
 * Default per-line character cap. Pushd log lines that exceed this
 * are truncated with an ellipsis so a single multi-megabyte JSON
 * dump doesn't blow up the transcript. Tunable via `maxLineChars`.
 */
export const DEFAULT_LOG_TAIL_LINE_CHARS = 200;

export interface FormatLogTailOptions {
  maxLines?: number;
  maxLineChars?: number;
}

/**
 * Pure formatter: take a string of log content and produce the
 * transcript text the TUI renders under "Daemon log (last N lines):".
 * Trims trailing blanks, truncates over-long lines, and returns the
 * empty string when there's nothing to render (callers short-circuit
 * on `!tail` instead of pattern-matching a sentinel — the previous
 * "Daemon log is empty." sentinel emitted noise from direct callers
 * that forgot to filter it).
 *
 * Options are clamped to sensible minimums so a `maxLines: 0` doesn't
 * silently expand to the whole log (`Array.slice(-0)` returns
 * everything, the opposite of what callers intend) and `maxLineChars`
 * never drives the truncation math negative (copilot review on PR
 * #667).
 *
 * Exported separately from the I/O helper so tests can pin the
 * formatting rules without touching the filesystem.
 */
export function formatPushdLogTail(raw: string, opts: FormatLogTailOptions = {}): string {
  const maxLines = Math.max(1, opts.maxLines ?? DEFAULT_LOG_TAIL_LINES);
  // 2 is the minimum at which truncation still produces visible
  // content: one char + the ellipsis.
  const maxLineChars = Math.max(2, opts.maxLineChars ?? DEFAULT_LOG_TAIL_LINE_CHARS);
  if (!raw || !raw.trim()) return '';
  const lines = raw.split('\n');
  // Drop trailing blank entries (file ends with `\n`).
  while (lines.length > 0 && lines[lines.length - 1].length === 0) {
    lines.pop();
  }
  if (lines.length === 0) return '';
  const tail = lines.slice(-maxLines).map((line) => {
    if (line.length <= maxLineChars) return line;
    return `${line.slice(0, maxLineChars - 1)}…`;
  });
  const truncatedNote =
    lines.length > maxLines ? ` (${lines.length - maxLines} earlier lines elided)` : '';
  return `Daemon log (last ${tail.length} lines)${truncatedNote}:\n${tail.join('\n')}`;
}

/**
 * I/O helper: read the trailing bytes of the daemon log and return the
 * formatted tail. Reads only the last `LOG_TAIL_CHUNK_BYTES` so a
 * runaway daemon log doesn't OOM the TUI while it's trying to surface
 * a diagnostic — mirrors the bounded-tail pattern in
 * `cli/cli.ts:readLogTail` (codex / copilot review on PR #667).
 *
 * Returns:
 *   - `null` when the file is missing or unreadable, OR when the
 *     formatted tail is empty (the log file exists but contains no
 *     content). Callers short-circuit on `!result` instead of having
 *     to pattern-match a sentinel.
 *   - the formatted tail string otherwise.
 *
 * If the chunk starts mid-line (i.e. the daemon log is larger than
 * the chunk), the first line of the read window can be truncated.
 * That's acceptable because `formatPushdLogTail`'s `slice(-maxLines)`
 * drops it as long as the chunk holds more than `maxLines` newlines —
 * which it always does in practice (16KB / 200 chars per line ≫ 12
 * lines).
 */
export async function readPushdLogTail(
  logPath: string,
  opts: FormatLogTailOptions = {},
): Promise<string | null> {
  let handle: FileHandle | undefined;
  try {
    const stat = await fs.stat(logPath);
    if (stat.size === 0) return null;
    const start = Math.max(0, stat.size - LOG_TAIL_CHUNK_BYTES);
    const length = Math.min(stat.size, LOG_TAIL_CHUNK_BYTES);
    handle = await fs.open(logPath, 'r');
    const { bytesRead, buffer } = await handle.read(Buffer.alloc(length), 0, length, start);
    const raw = buffer.toString('utf8', 0, bytesRead);
    const formatted = formatPushdLogTail(raw, opts);
    return formatted.length > 0 ? formatted : null;
  } catch {
    return null;
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        /* best-effort */
      }
    }
  }
}
