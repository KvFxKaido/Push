import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { shouldFullRedraw } from '../tui-render-frame.ts';

// Baseline: a stable previous frame that matches the current dimensions
// and layout, with no overlays in play. Use as the starting point for each
// transition test — flip exactly one field to isolate what triggers a
// full redraw.
const STABLE_META = Object.freeze({
  rows: 40,
  cols: 120,
  layoutKey: '40x120:0:1',
  hadOverlay: false,
  tooSmall: false,
  initialized: true,
});

const stableInputs = () => ({
  prev: STABLE_META,
  rows: 40,
  cols: 120,
  layoutKey: '40x120:0:1',
  dirtyAll: false,
  overlayActive: false,
});

describe('shouldFullRedraw', () => {
  it('returns false on a steady-state frame (no changes, no overlays)', () => {
    // The whole point of the partial-redraw path: when nothing material
    // changed and no overlay is in play, only the regions in `dirty`
    // need to repaint. Regression here would mean we always full-clear,
    // which is what the predicate exists to prevent.
    assert.equal(shouldFullRedraw(stableInputs()), false);
  });

  it('forces full redraw on the first frame (initialized=false)', () => {
    const opts = stableInputs();
    opts.prev = { ...STABLE_META, initialized: false };
    assert.equal(shouldFullRedraw(opts), true);
  });

  it('forces full redraw when the previous frame bailed out as tooSmall', () => {
    // When the terminal was below the min-size threshold, we wrote a
    // single error message and skipped layout — the screen state is
    // unknown, so the next sized-up frame has to repaint everything.
    const opts = stableInputs();
    opts.prev = { ...STABLE_META, tooSmall: true };
    assert.equal(shouldFullRedraw(opts), true);
  });

  it('forces full redraw when rows changed', () => {
    const opts = stableInputs();
    opts.rows = 41;
    assert.equal(shouldFullRedraw(opts), true);
  });

  it('forces full redraw when cols changed', () => {
    const opts = stableInputs();
    opts.cols = 121;
    assert.equal(shouldFullRedraw(opts), true);
  });

  it('forces full redraw when the layout key changed (composer grew)', () => {
    // Same dimensions, but the composer expanded from 1 to 3 lines —
    // every region below the composer has shifted, so partial repaint
    // would leave stale content. The layoutKey carries that signal.
    const opts = stableInputs();
    opts.layoutKey = '40x120:0:3';
    assert.equal(shouldFullRedraw(opts), true);
  });

  it('forces full redraw when an overlay was just dismissed', () => {
    // prev.hadOverlay means last frame painted a modal box. Even if the
    // overlay is gone now, the regions it covered need a clean repaint
    // to clear the modal's pixels.
    const opts = stableInputs();
    opts.prev = { ...STABLE_META, hadOverlay: true };
    opts.overlayActive = false;
    assert.equal(shouldFullRedraw(opts), true);
  });

  it('forces full redraw when an overlay is currently active', () => {
    // Even if nothing else changed, the modal needs to draw over a
    // freshly-painted background so the underlying region content
    // doesn't bleed through gaps in the modal box.
    const opts = stableInputs();
    opts.overlayActive = true;
    assert.equal(shouldFullRedraw(opts), true);
  });

  it('forces full redraw when caller set dirty=all (e.g. from onResize)', () => {
    const opts = stableInputs();
    opts.dirtyAll = true;
    assert.equal(shouldFullRedraw(opts), true);
  });

  it('overlay-to-overlay transition: still a full redraw', () => {
    // Closing one modal and opening another in the same frame: prev
    // hadOverlay AND overlayActive — both flags fire, predicate
    // collapses to true.
    const opts = stableInputs();
    opts.prev = { ...STABLE_META, hadOverlay: true };
    opts.overlayActive = true;
    assert.equal(shouldFullRedraw(opts), true);
  });

  it('does not full-redraw on a same-dim, same-layout follow-up frame', () => {
    // Sanity check against the inverse of the above transitions: with
    // every "trigger" flag off, the predicate must allow the partial
    // path. Without this, the partial-redraw branch is dead code.
    const meta = {
      rows: 40,
      cols: 120,
      layoutKey: '40x120:1:2',
      hadOverlay: false,
      tooSmall: false,
      initialized: true,
    };
    assert.equal(
      shouldFullRedraw({
        prev: meta,
        rows: 40,
        cols: 120,
        layoutKey: '40x120:1:2',
        dirtyAll: false,
        overlayActive: false,
      }),
      false,
    );
  });
});
