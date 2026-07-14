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
 * Ceiling on a single clipboard payload, in characters of source text.
 *
 * OSC 52 is a single escape sequence carrying base64 on the wire, and terminals
 * cap what they will accept — xterm's default `maxClipboard` is ~100KB and an
 * oversized sequence is dropped ON THE FLOOR, with no error and no partial
 * write. So a naive "copy the whole transcript" would appear to succeed and
 * silently copy nothing.
 *
 * We therefore cap the SOURCE at a size whose base64 (4/3 + overhead) stays
 * well inside that budget, and — per CLAUDE.md's no-silent-caps rule — the
 * caller must tell the user when the cap bit. Truncation returns a flag rather
 * than being swallowed here.
 */
export const MAX_COPY_CHARS = 64_000;

export interface CopyPayload {
  /** The text to place on the clipboard. Already truncated to MAX_COPY_CHARS. */
  text: string;
  /** True when the source exceeded MAX_COPY_CHARS and `text` is a prefix. */
  truncated: boolean;
  /** Human label for the status line — "response", "diff", "CI Status", … */
  label: string;
}

/** Render an EditDiff back to unified-diff text — the form you can paste into a patch. */
function diffToText(diff: EditDiff): string {
  const header = `--- a/${diff.path}\n+++ b/${diff.path}`;
  const body = diff.lines
    .map((line) => {
      const marker = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
      return `${marker}${line.text}`;
    })
    .join('\n');
  const note = diff.truncated ? '\n[diff truncated for display — copy is partial]' : '';
  return `${header}\n${body}${note}`;
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
    if (row.diff) return { text: diffToText(row.diff), label: 'diff' };
    if (isToolCardPayload(row.card)) {
      const display = formatToolCard(row.card);
      return { text: cardToText(row.card), label: display.title };
    }
    if (row.resultPreview) return { text: row.resultPreview, label: row.toolName ?? 'tool result' };
  }
  return { text: row.text, label: row.kind === 'message' ? 'response' : row.kind };
}

/**
 * The last row worth copying — the assistant's most recent answer.
 *
 * Deliberately skips `tool_prose` (narration ABOUT a tool call, not an answer),
 * status rows, and the user's own input. Returns null when the transcript holds
 * no assistant message yet, which the caller must report rather than silently
 * copying nothing.
 */
export function lastAssistantRow(rows: readonly DaemonTranscriptRow[]): DaemonTranscriptRow | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (!row) continue;
    if (row.kind !== 'message') continue;
    if (row.role === 'user') continue;
    if (row.pending) continue;
    if (row.text.trim().length === 0) continue;
    return row;
  }
  return null;
}

/** Apply the OSC 52 ceiling, reporting rather than hiding the cut. */
export function boundCopyText(text: string, label: string): CopyPayload {
  if (text.length <= MAX_COPY_CHARS) return { text, truncated: false, label };
  return { text: text.slice(0, MAX_COPY_CHARS), truncated: true, label };
}

/** Resolve the payload for "copy the last response". Null when there is nothing to copy. */
export function copyLastResponse(rows: readonly DaemonTranscriptRow[]): CopyPayload | null {
  const row = lastAssistantRow(rows);
  if (!row) return null;
  const { text, label } = copyTextForRow(row);
  if (text.trim().length === 0) return null;
  return boundCopyText(text, label);
}
