import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { reconcileEntryBlocks } from '../tui-transcript-cache.ts';

// A frameEntry that records how many times each entry was framed, so we can
// assert the cache actually avoids re-framing settled history. Frames N lines
// (default 1) per entry, derived from entry.text.
function makeFramer(counts = new Map()) {
  return {
    counts,
    frameEntry(entry) {
      counts.set(entry, (counts.get(entry) ?? 0) + 1);
      const lineCount = entry.lines ?? 1;
      const lines = Array.from({ length: lineCount }, (_, i) => `${entry.text}#${i}`);
      return { lines, payloadBlocks: entry.payloadBlocks ?? [] };
    },
  };
}

describe('reconcileEntryBlocks', () => {
  it('positions blocks with cumulative start/end lines and totalLines', () => {
    const entries = [
      { text: 'a', lines: 2 },
      { text: 'b', lines: 3 },
      { text: 'c', lines: 1 },
    ];
    const { frameEntry } = makeFramer();
    const { entryBlocks, totalLines } = reconcileEntryBlocks({
      entries,
      sig: 'w80',
      cache: new WeakMap(),
      frameEntry,
    });

    assert.equal(totalLines, 6);
    assert.deepEqual(
      entryBlocks.map((b) => [b.startLine, b.endLine, b.lineCount]),
      [
        [0, 2, 2],
        [2, 5, 3],
        [5, 6, 1],
      ],
    );
  });

  it('reuses cached frames on append — only the new entry is framed', () => {
    const cache = new WeakMap();
    const { counts, frameEntry } = makeFramer();
    const a = { text: 'a' };
    const b = { text: 'b' };

    const first = reconcileEntryBlocks({ entries: [a, b], sig: 's', cache, frameEntry });
    assert.equal(first.reframed, 2);

    // Append c; a and b must hit the cache, only c frames.
    const c = { text: 'c' };
    const second = reconcileEntryBlocks({ entries: [a, b, c], sig: 's', cache, frameEntry });
    assert.equal(second.reframed, 1);
    assert.equal(counts.get(a), 1);
    assert.equal(counts.get(b), 1);
    assert.equal(counts.get(c), 1);
  });

  it('reframes everything when the global sig changes (width / theme / flags)', () => {
    const cache = new WeakMap();
    const { counts, frameEntry } = makeFramer();
    const a = { text: 'a' };
    const b = { text: 'b' };

    reconcileEntryBlocks({ entries: [a, b], sig: 'w80', cache, frameEntry });
    const next = reconcileEntryBlocks({ entries: [a, b], sig: 'w120', cache, frameEntry });

    assert.equal(next.reframed, 2);
    assert.equal(counts.get(a), 2);
    assert.equal(counts.get(b), 2);
  });

  it('reframes only the entry whose cache slot was explicitly dropped', () => {
    // Models the tool_call back-fill: an entry is mutated in place and its slot
    // deleted, so it must reframe while its neighbours stay cached.
    const cache = new WeakMap();
    const { counts, frameEntry } = makeFramer();
    const a = { text: 'a' };
    const toolCall = { text: 'b' };
    const c = { text: 'c' };

    reconcileEntryBlocks({ entries: [a, toolCall, c], sig: 's', cache, frameEntry });
    assert.equal(counts.get(toolCall), 1);

    // In-place mutation + slot drop.
    toolCall.error = true;
    cache.delete(toolCall);

    const after = reconcileEntryBlocks({ entries: [a, toolCall, c], sig: 's', cache, frameEntry });
    assert.equal(after.reframed, 1);
    assert.equal(counts.get(a), 1);
    assert.equal(counts.get(toolCall), 2);
    assert.equal(counts.get(c), 1);
  });

  it('survives front-eviction: surviving entries keep their cached frames', () => {
    const cache = new WeakMap();
    const { counts, frameEntry } = makeFramer();
    const a = { text: 'a' };
    const b = { text: 'b' };
    const c = { text: 'c' };

    reconcileEntryBlocks({ entries: [a, b, c], sig: 's', cache, frameEntry });
    // a evicted (MAX_TRANSCRIPT splice); b, c remain and must not reframe.
    const after = reconcileEntryBlocks({ entries: [b, c], sig: 's', cache, frameEntry });

    assert.equal(after.reframed, 0);
    assert.equal(counts.get(b), 1);
    assert.equal(counts.get(c), 1);
    // Positions recomputed from the new order, not stale.
    assert.deepEqual(
      after.entryBlocks.map((blk) => blk.startLine),
      [0, 1],
    );
  });

  it('carries payloadBlocks through from the framer', () => {
    const cache = new WeakMap();
    const { frameEntry } = makeFramer();
    const entry = { text: 'tool', payloadBlocks: [{ id: 'p1', startLine: 0, endLine: 2 }] };
    const { entryBlocks } = reconcileEntryBlocks({ entries: [entry], sig: 's', cache, frameEntry });
    assert.deepEqual(entryBlocks[0].payloadBlocks, [{ id: 'p1', startLine: 0, endLine: 2 }]);
  });
});
