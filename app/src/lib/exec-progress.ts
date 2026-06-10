/**
 * Live tail for long-running sandbox exec output.
 *
 * Folds streamed stdout/stderr chunks (from the detached exec runner's
 * `onProgress`) into the latest displayable line and emits it, throttled —
 * the chat layer points `onTail` at the agent status bar's `detail` slot so a
 * ten-minute test run reads as `Running command · ✓ 113 passed (2m 14s)`
 * instead of a silent spinner.
 *
 * Display semantics, deliberately simple:
 * - The tail is the last NON-EMPTY line of the combined stream, where a
 *   carriage return counts as a line break (progress bars rewrite frames via
 *   `\r`; treating CR as a break shows their latest frame).
 * - ANSI escapes are stripped (test runners color their output).
 * - The rolling buffer carries a trailing partial line across chunks, so a
 *   line split by a poll boundary still renders whole once completed.
 * - Emission is throttled and deduped. The tool result card is the
 *   authoritative final output, so a missed last update is harmless — no
 *   trailing flush timer to manage or leak.
 */

export interface ExecProgressTailOptions {
  onTail: (line: string) => void;
  /** Minimum ms between emissions. Default 500. */
  throttleMs?: number;
  /** Max characters of the displayed line (ellipsized past this). Default 96. */
  maxChars?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

// CSI escape sequences — colors, cursor movement, erase-line.
// eslint-disable-next-line no-control-regex -- matching the ESC byte is the point
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
// Rolling-buffer cap: only the tail is ever displayed, so anything beyond a
// few KB of recent output is dead weight.
const BUFFER_CAP = 4096;

export function createExecProgressTail(
  options: ExecProgressTailOptions,
): (chunk: { stdout: string; stderr: string }) => void {
  const throttleMs = options.throttleMs ?? 500;
  const maxChars = options.maxChars ?? 96;
  const now = options.now ?? Date.now;
  let buffer = '';
  let lastEmitAt = 0;
  let lastEmitted = '';

  return (chunk) => {
    const text = `${chunk.stdout ?? ''}${chunk.stderr ?? ''}`;
    if (!text) return;
    buffer = (buffer + text).slice(-BUFFER_CAP);

    const segments = buffer.replace(ANSI_RE, '').split(/\r\n|\n|\r/);
    let line = '';
    for (let i = segments.length - 1; i >= 0; i--) {
      const candidate = segments[i].trim();
      if (candidate) {
        line = candidate;
        break;
      }
    }
    if (!line) return;
    if (line.length > maxChars) line = `${line.slice(0, maxChars - 1)}…`;

    // Dedupe first (an unchanged tail never restarts the throttle window),
    // then throttle.
    if (line === lastEmitted) return;
    const ts = now();
    if (ts - lastEmitAt < throttleMs) return;
    lastEmitAt = ts;
    lastEmitted = line;
    options.onTail(line);
  };
}
