/**
 * tui-transcript-cache.ts — Per-entry framed-line reconciler for the transcript.
 *
 * Framing a transcript entry (word-wrap + syntax highlight + payload layout) is
 * the expensive part of a redraw. The naive cache keyed on a global version
 * counter was busted on *every* append, so committing one message reframed the
 * entire history — O(transcript) work per message, the "scrollback becomes soup"
 * cost. This reconciler frames each entry once and reuses the result keyed by
 * entry *identity* (a WeakMap): appending an entry is a single cache miss while
 * all prior entries hit. A global `sig` (width / theme / payload-expansion flags)
 * invalidates everything at once when layout-affecting state changes — the only
 * time the whole history legitimately must reflow.
 *
 * Inspired by OpenTUI's ScrollbackSurface "commit settled rows, re-render only
 * the unsettled tail" model, mapped onto Push's alt-screen viewport: a committed
 * entry is "settled" and framed once; only new/changed entries do work.
 *
 * Invariant — entries are immutable after they're pushed, with ONE exception: a
 * `tool_call` entry is back-filled with its result (error/duration/preview) when
 * the tool finishes. That single in-place mutation must drop its cache slot
 * (`cache.delete(entry)`) so it reframes; identity alone can't observe the edit.
 * Everything else relies on append = new object = miss.
 *
 * Pure + injectable (`frameEntry`) so it's testable without a terminal — same
 * decomposition as tui-transcript-window.ts / tui-render-frame.ts.
 */

export interface FramedBlock {
  readonly lineCount: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly lines: string[];
  readonly payloadBlocks: unknown[];
}

interface CacheSlot {
  sig: string;
  lines: string[];
  payloadBlocks: unknown[];
}

export interface ReconcileResult {
  readonly entryBlocks: FramedBlock[];
  readonly totalLines: number;
  /** Entries (re)framed this pass; 0 means a pure cache hit. For tests / obs. */
  readonly reframed: number;
}

/**
 * Reconcile the transcript into positioned, framed blocks, reusing cached frames
 * by entry identity. `frameEntry` does the actual (expensive) framing and is
 * only invoked on a miss or when the global `sig` changed since the entry was
 * last framed.
 */
export function reconcileEntryBlocks<E extends object>(opts: {
  entries: readonly E[];
  sig: string;
  cache: WeakMap<E, CacheSlot>;
  frameEntry: (entry: E, index: number) => { lines: string[]; payloadBlocks: unknown[] };
}): ReconcileResult {
  const { entries, sig, cache, frameEntry } = opts;
  const entryBlocks: FramedBlock[] = [];
  let totalLines = 0;
  let reframed = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    let slot = cache.get(entry);
    if (!slot || slot.sig !== sig) {
      const framed = frameEntry(entry, i);
      slot = { sig, lines: framed.lines, payloadBlocks: framed.payloadBlocks };
      cache.set(entry, slot);
      reframed++;
    }
    const startLine = totalLines;
    const endLine = startLine + slot.lines.length;
    entryBlocks.push({
      lineCount: slot.lines.length,
      startLine,
      endLine,
      lines: slot.lines,
      payloadBlocks: slot.payloadBlocks,
    });
    totalLines = endLine;
  }

  return { entryBlocks, totalLines, reframed };
}
