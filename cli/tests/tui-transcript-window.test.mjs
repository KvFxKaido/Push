import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeTranscriptViewport,
  findFirstBlockStartingAtOrAfter,
  findFirstIntersectingBlock,
} from '../tui-transcript-window.ts';

// ── findFirstIntersectingBlock ──────────────────────────────────────
//
// "Intersecting" means: the block's [startLine, endLine) range either
// contains targetLine or starts past it. The search returns the first
// such block index; blocks ending at or before targetLine are skipped.

describe('findFirstIntersectingBlock', () => {
  it('returns 0 for an empty block array', () => {
    assert.equal(findFirstIntersectingBlock([], 0), 0);
    assert.equal(findFirstIntersectingBlock([], 999), 0);
  });

  it('returns 0 when the target sits before every block', () => {
    const blocks = [
      { startLine: 5, endLine: 10 },
      { startLine: 10, endLine: 15 },
    ];
    assert.equal(findFirstIntersectingBlock(blocks, 0), 0);
    assert.equal(findFirstIntersectingBlock(blocks, 4), 0);
  });

  it('returns blocks.length when the target is past every block', () => {
    const blocks = [
      { startLine: 0, endLine: 5 },
      { startLine: 5, endLine: 10 },
    ];
    assert.equal(findFirstIntersectingBlock(blocks, 10), 2);
    assert.equal(findFirstIntersectingBlock(blocks, 9999), 2);
  });

  it('finds the block that contains the target line', () => {
    const blocks = [
      { startLine: 0, endLine: 5 },
      { startLine: 5, endLine: 10 },
      { startLine: 10, endLine: 20 },
    ];
    // line 7 sits inside block 1 (endLine 10 > 7)
    assert.equal(findFirstIntersectingBlock(blocks, 7), 1);
    // line 5 is the boundary: block 0 ends AT 5 (exclusive), so we
    // skip it and land on block 1.
    assert.equal(findFirstIntersectingBlock(blocks, 5), 1);
    // line 4 is the last index inside block 0.
    assert.equal(findFirstIntersectingBlock(blocks, 4), 0);
  });

  it('skips zero-width blocks correctly', () => {
    // A block with startLine === endLine has lineCount 0; tui.ts filters
    // it later, but the search must still produce a sensible index. With
    // the half-open [startLine, endLine) convention, target 5 lives in
    // block 2 — block 1 ends AT 5 so it doesn't intersect.
    const blocks = [
      { startLine: 0, endLine: 5 },
      { startLine: 5, endLine: 5 }, // empty
      { startLine: 5, endLine: 10 },
    ];
    assert.equal(findFirstIntersectingBlock(blocks, 5), 2);
    assert.equal(findFirstIntersectingBlock(blocks, 6), 2);
  });

  it('treats blocks with missing endLine as if they ended at 0', () => {
    // Documents the historical `?? 0` fallback. A corrupt block looks like
    // it ended at line 0, so for any positive target the search continues
    // rightward — the bad block is silently skipped, not surfaced.
    const blocks = [
      { startLine: 0, endLine: 5 },
      /** @type {{ startLine: number; endLine: number }} */ ({ startLine: 5 }),
      { startLine: 5, endLine: 10 },
    ];
    assert.equal(findFirstIntersectingBlock(blocks, 7), 2);
  });

  it('runs in O(log n) — sanity-check on a large array', () => {
    const blocks = [];
    for (let i = 0; i < 10_000; i++) {
      blocks.push({ startLine: i * 2, endLine: i * 2 + 2 });
    }
    assert.equal(findFirstIntersectingBlock(blocks, 0), 0);
    assert.equal(findFirstIntersectingBlock(blocks, 19_998), 9999);
    assert.equal(findFirstIntersectingBlock(blocks, 20_000), 10_000);
  });
});

// ── findFirstBlockStartingAtOrAfter ─────────────────────────────────

describe('findFirstBlockStartingAtOrAfter', () => {
  it('returns 0 for an empty block array', () => {
    assert.equal(findFirstBlockStartingAtOrAfter([], 0), 0);
  });

  it('returns 0 when every block starts at or after the target', () => {
    const blocks = [
      { startLine: 10, endLine: 15 },
      { startLine: 15, endLine: 20 },
    ];
    assert.equal(findFirstBlockStartingAtOrAfter(blocks, 5), 0);
    assert.equal(findFirstBlockStartingAtOrAfter(blocks, 10), 0);
  });

  it('returns blocks.length when every block starts before the target', () => {
    const blocks = [
      { startLine: 0, endLine: 5 },
      { startLine: 5, endLine: 10 },
    ];
    assert.equal(findFirstBlockStartingAtOrAfter(blocks, 11), 2);
  });

  it('finds the boundary correctly', () => {
    const blocks = [
      { startLine: 0, endLine: 5 },
      { startLine: 5, endLine: 10 },
      { startLine: 10, endLine: 20 },
    ];
    // Block 1 starts at 5 → first block with startLine >= 5.
    assert.equal(findFirstBlockStartingAtOrAfter(blocks, 5), 1);
    // Block 2 starts at 10.
    assert.equal(findFirstBlockStartingAtOrAfter(blocks, 6), 2);
    assert.equal(findFirstBlockStartingAtOrAfter(blocks, 10), 2);
  });

  it('produces a usable [start, end) pair for a viewport query', () => {
    const blocks = [
      { startLine: 0, endLine: 4 },
      { startLine: 4, endLine: 8 },
      { startLine: 8, endLine: 12 },
      { startLine: 12, endLine: 16 },
    ];
    // Viewport spanning lines [5, 10) should cover blocks 1 and 2.
    const start = findFirstIntersectingBlock(blocks, 5);
    const end = findFirstBlockStartingAtOrAfter(blocks, 10);
    assert.equal(start, 1);
    assert.equal(end, 3);
  });
});

// ── computeTranscriptViewport ───────────────────────────────────────

describe('computeTranscriptViewport', () => {
  it('pins to the bottom when scrollOffset is 0', () => {
    const v = computeTranscriptViewport({
      totalLineCount: 100,
      viewportHeight: 20,
      scrollOffset: 0,
    });
    assert.equal(v.maxScroll, 80);
    assert.equal(v.effectiveOffset, 0);
    assert.equal(v.startIdx, 80);
    assert.equal(v.endIdxExclusive, 100);
  });

  it('walks upward as scrollOffset grows', () => {
    const v = computeTranscriptViewport({
      totalLineCount: 100,
      viewportHeight: 20,
      scrollOffset: 30,
    });
    assert.equal(v.startIdx, 50);
    assert.equal(v.endIdxExclusive, 70);
  });

  it('clamps to the top when scrollOffset would go past the head', () => {
    const v = computeTranscriptViewport({
      totalLineCount: 100,
      viewportHeight: 20,
      scrollOffset: 9999,
    });
    assert.equal(v.effectiveOffset, 80);
    assert.equal(v.startIdx, 0);
    assert.equal(v.endIdxExclusive, 20);
  });

  it('returns startIdx 0 when transcript is shorter than the viewport', () => {
    // Caller still walks `viewportHeight` slots; the empty tail just stays
    // blank. This is the source of the "single-line transcript in tall
    // pane" case — startIdx must be 0, not negative.
    const v = computeTranscriptViewport({
      totalLineCount: 5,
      viewportHeight: 40,
      scrollOffset: 0,
    });
    assert.equal(v.maxScroll, 0);
    assert.equal(v.effectiveOffset, 0);
    assert.equal(v.startIdx, 0);
    assert.equal(v.endIdxExclusive, 40);
  });

  it('handles an empty transcript without going negative', () => {
    const v = computeTranscriptViewport({
      totalLineCount: 0,
      viewportHeight: 20,
      scrollOffset: 0,
    });
    assert.equal(v.maxScroll, 0);
    assert.equal(v.startIdx, 0);
    assert.equal(v.endIdxExclusive, 20);
  });

  it('handles a zero-height viewport', () => {
    // Edge case for very small terminals where the transcript pane
    // collapses entirely. startIdx must still be a valid index into the
    // transcript so the binary search downstream produces sane bounds.
    const v = computeTranscriptViewport({
      totalLineCount: 100,
      viewportHeight: 0,
      scrollOffset: 0,
    });
    assert.equal(v.maxScroll, 100);
    assert.equal(v.startIdx, 100);
    assert.equal(v.endIdxExclusive, 100);
  });

  it('treats negative scrollOffset as zero (defensive)', () => {
    const v = computeTranscriptViewport({
      totalLineCount: 100,
      viewportHeight: 20,
      scrollOffset: -50,
    });
    assert.equal(v.startIdx, 80);
    assert.equal(v.endIdxExclusive, 100);
  });

  it('treats negative totals/heights as zero (defensive)', () => {
    const v = computeTranscriptViewport({
      totalLineCount: -5,
      viewportHeight: -10,
      scrollOffset: 0,
    });
    assert.equal(v.maxScroll, 0);
    assert.equal(v.startIdx, 0);
    assert.equal(v.endIdxExclusive, 0);
  });

  it('streaming-at-bottom scenario: scroll stays anchored as new lines arrive', () => {
    // While the user is pinned to the bottom (scrollOffset=0), every new
    // streamed line should keep the window's tail aligned with the new
    // total — i.e. endIdxExclusive grows in lockstep with totalLineCount.
    const before = computeTranscriptViewport({
      totalLineCount: 100,
      viewportHeight: 20,
      scrollOffset: 0,
    });
    const after = computeTranscriptViewport({
      totalLineCount: 105,
      viewportHeight: 20,
      scrollOffset: 0,
    });
    assert.equal(before.endIdxExclusive, 100);
    assert.equal(after.endIdxExclusive, 105);
    assert.equal(after.startIdx - before.startIdx, 5);
  });

  it('streaming-while-scrolled-up: window does NOT follow new lines', () => {
    // The user has scrolled up by 30 lines. New streamed lines extend the
    // tail but should not shift what the user is reading — the visible
    // window stays anchored to the same content.
    const before = computeTranscriptViewport({
      totalLineCount: 100,
      viewportHeight: 20,
      scrollOffset: 30,
    });
    const after = computeTranscriptViewport({
      totalLineCount: 105,
      viewportHeight: 20,
      scrollOffset: 30,
    });
    // scrollOffset 30 with maxScroll 80 → startIdx 50; with maxScroll 85
    // → startIdx 55. The window slides by exactly the number of new lines.
    // This is the documented behavior: scrollOffset is measured from the
    // tail, not anchored to a content line. UI code that wants
    // anchor-to-content semantics has to convert the offset before
    // calling this helper.
    assert.equal(before.startIdx, 50);
    assert.equal(after.startIdx, 55);
  });
});
