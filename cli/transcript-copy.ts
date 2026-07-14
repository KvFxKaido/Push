/**
 * Semantic copy for the TUI transcript.
 *
 * The TUI runs in the alternate screen with mouse tracking on, so the terminal
 * routes drags to us rather than performing a native selection. Most terminals
 * still offer Shift+drag as an escape hatch, but what that yields is a *screen
 * rectangle* — gutters, line numbers, wrap artifacts, and chrome included. What
 * a user actually wants is the assistant's answer, or a diff, or a tool result:
 * the row's CONTENT, not its pixels.
 *
 * So copy is resolved from the transcript row — the same declared structure the
 * renderer draws from (`docs/decisions/Tool Render Payload — Cards Are Declared,
 * Not Sniffed.md`). A tool row copies its diff or its card, not the ANSI that
 * happened to be painted for it.
 *
 * The clipboard write itself is OSC 52 (`osc52Copy`), which was already written
 * and unit-tested in `tui-renderer.ts` and — until this module — had zero
 * production callers.
 */

import type { EditDiff } from '../lib/edit-diff.js';
import { formatToolCard } from './tool-card-format.js';
import type { DaemonTranscriptRow } from './daemon-transcript-mirror.js';
import { isToolCardPayload } from '../lib/tool-cards.js';

/**
 * Ceiling on a single clipboard payload, in UTF-8 BYTES of source text.
 *
 * OSC 52 is one escape sequence carrying base64 on the wire, and terminals cap
 * what they will accept — xterm's default `maxClipboard` is ~100KB — and an
 * oversized sequence is dropped ON THE FLOOR: no error, no partial write. So an
 * unreported cap looks exactly like a successful copy.
 *
 * Bytes, not `String#length`. `osc52Copy` encodes UTF-8 before base64, so a
 * character is 1–4 bytes and base64 adds 4/3 on top. Capping by string length
 * (the first version of this, caught by Codex on #1474) means 64k CJK
 * characters — 192KB of UTF-8, ~256KB of base64 — sail past the check with
 * `truncated: false`, blow the terminal's ceiling, get silently dropped, and
 * the status line cheerfully reports a successful copy. Exactly the silent cap
 * this constant exists to prevent.
 *
 * 48KB of source → ~64KB of base64, comfortably inside a 100KB ceiling.
 */
export const MAX_COPY_BYTES = 48_000;

export interface CopyPayload {
  /** The text to place on the clipboard. Already truncated to MAX_COPY_CHARS. */
  text: string;
  /** True when the source exceeded MAX_COPY_CHARS and `text` is a prefix. */
  truncated: boolean;
  /** Human label for the status line — "response", "diff", "CI Status", … */
  label: string;
}

/**
 * Split an EditDiff's flat line list back into hunks.
 *
 * `EditDiff` encodes hunk boundaries IMPLICITLY: its own doc comment says "a
 * jump in line numbers between consecutive entries means skipped context". So a
 * new hunk starts wherever the old- or new-file line number is not exactly one
 * past the previous line's.
 */
interface CopyHunk {
  oldStart: number;
  newStart: number;
  lines: EditDiff['lines'];
}

function toHunks(diff: EditDiff): CopyHunk[] {
  const hunks: CopyHunk[] = [];
  let current: CopyHunk | null = null;
  let expectedOld: number | null = null;
  let expectedNew: number | null = null;

  for (const line of diff.lines) {
    const contiguous =
      current !== null &&
      (line.oldLine === undefined || expectedOld === null || line.oldLine === expectedOld) &&
      (line.newLine === undefined || expectedNew === null || line.newLine === expectedNew);

    if (!contiguous) {
      current = {
        // A hunk that opens on an `add` has no old line; unified diffs still
        // need a start, and the line before the insertion point is the anchor.
        oldStart: line.oldLine ?? Math.max(1, (expectedOld ?? 1) as number),
        newStart: line.newLine ?? Math.max(1, (expectedNew ?? 1) as number),
        lines: [],
      };
      hunks.push(current);
    }
    current!.lines.push(line);
    if (line.oldLine !== undefined) expectedOld = line.oldLine + 1;
    if (line.newLine !== undefined) expectedNew = line.newLine + 1;
  }
  return hunks;
}

/**
 * Render an EditDiff back to a REAL unified diff — `@@` headers and all.
 *
 * The first version of this emitted `---`/`+++` plus bare `+`/`-` lines and no
 * hunk headers. `git apply` rejects that outright ("No valid patches in input"),
 * so the paste-into-a-patch flow this whole function exists for did not work —
 * caught by Codex on #1474 after I asserted it in the PR body without ever
 * running `git apply` on the output. The line numbers were already on every
 * `EditDiffLine`; only the headers were missing.
 */
function diffToText(diff: EditDiff): string {
  const out = [`--- a/${diff.path}`, `+++ b/${diff.path}`];
  for (const hunk of toHunks(diff)) {
    const oldCount = hunk.lines.filter((l) => l.kind === 'ctx' || l.kind === 'del').length;
    const newCount = hunk.lines.filter((l) => l.kind === 'ctx' || l.kind === 'add').length;
    out.push(`@@ -${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount} @@`);
    for (const line of hunk.lines) {
      const marker = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
      out.push(`${marker}${line.text}`);
    }
  }
  return out.join('\n');
}

/**
 * Flatten a declared tool card to plain text. Mirrors what the TUI paints
 * (`formatToolCard`) rather than inventing a second vocabulary — if the card
 * renders as a section, it copies as one.
 */
function cardToText(card: NonNullable<DaemonTranscriptRow['card']>): string {
  const display = formatToolCard(card);
  const lines = [display.title];
  for (const row of display.rows) lines.push(`${row.label}: ${row.value}`);
  for (const line of display.bodyLines ?? []) lines.push(line.text);
  return lines.join('\n');
}

/**
 * The text a row means, as opposed to the text it draws.
 *
 * Tool rows prefer their STRUCTURE (diff, then card) over their prose, because
 * a diff you can paste into `git apply` beats a summary of one. Everything else
 * is already text.
 */
export function copyTextForRow(row: DaemonTranscriptRow): { text: string; label: string } {
  if (row.kind === 'tool') {
    if (row.diff) {
      return { text: diffToText(row.diff), label: row.diff.truncated ? 'partial diff' : 'diff' };
    }
    if (isToolCardPayload(row.card)) {
      const display = formatToolCard(row.card);
      return { text: cardToText(row.card), label: display.title };
    }
    if (row.resultPreview) return { text: row.resultPreview, label: row.toolName ?? 'tool result' };
  }
  return { text: row.text, label: row.kind === 'message' ? 'response' : row.kind };
}

/**
 * The last row worth copying — the most recent thing the assistant PRODUCED.
 *
 * Message rows are not the only such thing, and treating them as the only such
 * thing was a real bug: the first version of this filtered `kind !== 'message'`,
 * which made every diff/card branch of `copyTextForRow` above **unreachable
 * from the production command**. Ctrl+O on a turn that ended in an edit would
 * copy an older message, or report nothing at all — while the unit tests stayed
 * green, because they called `copyTextForRow` directly. Codex and the Push
 * reviewer both caught it independently on #1474.
 *
 * So the candidate set is "assistant output", not "assistant prose":
 *  - `message` (any non-user role) — the answer
 *  - `tool` (settled) — the diff or the card IS the output for an edit turn
 *  - `review` — a verdict is output too
 *
 * Still excluded, deliberately:
 *  - `user` — their own input, which they already have
 *  - `tool_prose` — narration ABOUT a call, not the result of one
 *  - `status` — our own chrome, including the "Copied…" line this very command
 *    appends (copying that back would be a fine way to make Ctrl+O idempotent
 *    in the worst sense)
 *  - `pending` — output still streaming; copying a half-written answer is worse
 *    than saying there is nothing to copy yet
 */
const COPYABLE_KINDS = new Set<DaemonTranscriptRow['kind']>(['message', 'tool', 'review']);

export function lastCopyableRow(rows: readonly DaemonTranscriptRow[]): DaemonTranscriptRow | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (!row) continue;
    if (!COPYABLE_KINDS.has(row.kind)) continue;
    if (row.role === 'user') continue;
    if (row.pending) continue;
    if (copyTextForRow(row).text.trim().length === 0) continue;
    return row;
  }
  return null;
}

/**
 * Apply the OSC 52 ceiling, reporting rather than hiding the cut.
 *
 * Slices by CODE POINT, not by UTF-16 index: `String#slice` at a byte-derived
 * offset can land between a surrogate pair and emit a lone half, which base64s
 * fine and pastes as U+FFFD.
 */
export function boundCopyText(text: string, label: string): CopyPayload {
  if (Buffer.byteLength(text, 'utf8') <= MAX_COPY_BYTES) {
    return { text, truncated: false, label };
  }
  let used = 0;
  let out = '';
  for (const codePoint of text) {
    const size = Buffer.byteLength(codePoint, 'utf8');
    if (used + size > MAX_COPY_BYTES) break;
    out += codePoint;
    used += size;
  }
  return { text: out, truncated: true, label };
}

/** Resolve the payload for "copy the last response". Null when there is nothing to copy. */
export function copyLastResponse(rows: readonly DaemonTranscriptRow[]): CopyPayload | null {
  const row = lastCopyableRow(rows);
  if (!row) return null;
  const { text, label } = copyTextForRow(row);
  if (text.trim().length === 0) return null;
  return boundCopyText(text, label);
}
