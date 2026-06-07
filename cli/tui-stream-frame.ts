/**
 * tui-stream-frame.ts — Settle-and-freeze cache for the streaming assistant tail.
 *
 * The in-progress assistant response (`streamBuf`) was reframed from scratch
 * every frame: each token re-split the whole buffer, re-wrapped every line, and
 * re-highlighted every closed code fence. The "model kept typing" thrash —
 * O(message) work per token.
 *
 * This is the streaming half of the OpenTUI ScrollbackSurface idea (the entry
 * half is tui-transcript-cache.ts): commit the settled rows, re-render only the
 * unsettled tail. Mapped onto the assistant framer, "settled" = the largest
 * prefix of `streamBuf` ending at a newline that is NOT inside an open code
 * fence. Everything before that boundary is complete prose lines and *closed*
 * fences — their framing can't change as more tokens arrive — so we frame each
 * newly-settled chunk once and append it to a cache. Only the volatile tail
 * (the current partial line, or the body of a still-open fence) reframes per
 * token.
 *
 * Why a newline-outside-a-fence boundary is a safe freeze point: the assistant
 * framer is line-local everywhere except code fences (prose / heading / bullet /
 * quote / hr / blank each depend only on their own line + width + theme), and a
 * *closed* fence is self-contained between its ``` markers. The only cross-line
 * state is the leading bullet, handled via `firstPrefixConsumed`. (An *open*
 * fence stays in the tail and is still re-highlighted per token — multi-line
 * lexing can't be split safely — but that's one bounded construct, not the whole
 * message.)
 *
 * Precondition: the streaming framer must run with `payloadUI: null` /
 * `entryKey: null` (it does). Per-chunk JSON-fence ordinals would otherwise
 * diverge from a whole-buffer pass; with no entryKey the ordinal only feeds a
 * (null) payload id, so chunked framing is identical to framing the whole buffer.
 *
 * Pure + injectable (`frameChunk`) so the bookkeeping is testable without a
 * terminal — same decomposition as the sibling tui-*.ts helpers.
 */

const FENCE_RE = /^```([A-Za-z0-9_-]+)?\s*$/;

/**
 * Byte index where the settled prefix of `text` ends (== where the volatile
 * tail begins). The settled prefix is every complete line that is not inside an
 * open code fence; an open fence freezes the boundary at its opening ``` line
 * until it closes, and the final line (no trailing newline) is always volatile.
 */
export function streamSettledEnd(text: string): number {
  const lines = text.split('\n');
  let inFence = false;
  let byte = 0;
  let settledEnd = 0;

  // The last element has no trailing newline (it's the in-progress line, or ''
  // when text ends with '\n') — always volatile, so we stop before it.
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) inFence = !inFence;
    byte += line.length + 1; // +1 for the consumed '\n'
    if (!inFence) settledEnd = byte;
  }
  return settledEnd;
}

export interface StreamFrameState {
  /** Frame signature (width / theme / flags); a change invalidates the cache. */
  sig: string;
  /** Byte length of `text` already framed into `settledLines`. */
  settledEnd: number;
  /** Cached framed output lines for the settled prefix. */
  settledLines: string[];
}

export interface StreamFrameResult {
  lines: string[];
  state: StreamFrameState;
}

function freshState(sig: string): StreamFrameState {
  return { sig, settledEnd: 0, settledLines: [] };
}

/**
 * Frame the streaming buffer, reusing the cached settled prefix and reframing
 * only what's new. `frameChunk(src, firstPrefixConsumed)` does the actual
 * framing of a source slice (in tui.ts it calls `renderAssistantEntryLines`);
 * `firstPrefixConsumed` is true for any chunk that isn't the very start of the
 * message, so the leading bullet is emitted exactly once.
 *
 * Resets the cache when the signature changes or the buffer shrank (a new
 * message after the previous one was committed / cleared — `streamBuf` is
 * append-only between resets, so a shorter buffer means a fresh stream).
 */
export function reconcileStreamFrame(opts: {
  text: string;
  sig: string;
  prev: StreamFrameState | null;
  frameChunk: (src: string, firstPrefixConsumed: boolean) => string[];
}): StreamFrameResult {
  const { text, sig, prev, frameChunk } = opts;

  let state = prev && prev.sig === sig && text.length >= prev.settledEnd ? prev : freshState(sig);

  const boundary = streamSettledEnd(text);
  if (boundary > state.settledEnd) {
    const chunk = text.slice(state.settledEnd, boundary);
    // The chunk ends at a newline boundary; that trailing '\n' is the separator
    // to the next chunk/tail — already represented by the gap between array
    // elements — not a blank line. Strip it so framing the chunk standalone
    // doesn't emit a spurious trailing blank (`"a\n".split("\n")` → `["a", ""]`).
    const chunkBody = chunk.endsWith('\n') ? chunk.slice(0, -1) : chunk;
    const newLines = frameChunk(chunkBody, state.settledLines.length > 0);
    state = {
      sig,
      settledEnd: boundary,
      settledLines: state.settledLines.concat(newLines),
    };
  }

  // Always frame the tail, even when empty: a buffer ending in '\n' has a
  // trailing in-progress (empty) line that the framer renders as a blank, which
  // a whole-buffer pass would include. The tail output is never cached.
  const tail = text.slice(state.settledEnd);
  const tailLines = frameChunk(tail, state.settledLines.length > 0);

  return { lines: state.settledLines.concat(tailLines), state };
}
