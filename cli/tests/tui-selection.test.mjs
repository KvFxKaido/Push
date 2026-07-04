import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractSelectedTranscriptText,
  highlightSelectedTranscriptLine,
  pointFromMouse,
  resolveTuiMouseMode,
} from '../tui-selection.ts';

describe('resolveTuiMouseMode', () => {
  it('defaults to native and accepts app/native aliases', () => {
    assert.equal(resolveTuiMouseMode(undefined), 'native');
    assert.equal(resolveTuiMouseMode('app'), 'app');
    assert.equal(resolveTuiMouseMode('on'), 'app');
    assert.equal(resolveTuiMouseMode('native'), 'native');
    assert.equal(resolveTuiMouseMode('off'), 'native');
  });
});

describe('pointFromMouse', () => {
  const snapshot = {
    top: 3,
    left: 5,
    width: 20,
    height: 3,
    startLine: 10,
    lines: ['hello world', 'second line', 'third'],
  };

  it('maps terminal coordinates into absolute transcript line coordinates', () => {
    assert.deepEqual(pointFromMouse(snapshot, 11, 4), { line: 11, col: 6 });
  });

  it('rejects points outside the transcript unless clamping is requested', () => {
    assert.equal(pointFromMouse(snapshot, 1, 1), null);
    assert.deepEqual(pointFromMouse(snapshot, 1, 1, { clamp: true }), { line: 10, col: 0 });
  });
});

describe('extractSelectedTranscriptText', () => {
  const snapshot = {
    startLine: 10,
    lines: ['hello world', 'second line', 'third'],
  };

  it('extracts a same-line selection in either drag direction', () => {
    const forward = {
      anchor: { line: 10, col: 6 },
      focus: { line: 10, col: 10 },
    };
    const backward = {
      anchor: { line: 10, col: 10 },
      focus: { line: 10, col: 6 },
    };

    assert.equal(extractSelectedTranscriptText(snapshot, forward), 'world');
    assert.equal(extractSelectedTranscriptText(snapshot, backward), 'world');
  });

  it('extracts multi-line visible transcript spans', () => {
    const selection = {
      anchor: { line: 10, col: 6 },
      focus: { line: 11, col: 5 },
    };

    assert.equal(extractSelectedTranscriptText(snapshot, selection), 'world\nsecond');
  });

  it('strips ANSI before copying', () => {
    const selection = {
      anchor: { line: 1, col: 0 },
      focus: { line: 1, col: 4 },
    };

    assert.equal(
      extractSelectedTranscriptText({ startLine: 1, lines: ['\x1b[31mhello\x1b[0m'] }, selection),
      'hello',
    );
  });
});

describe('highlightSelectedTranscriptLine', () => {
  it('wraps the selected range with the supplied highlighter', () => {
    const selection = {
      anchor: { line: 4, col: 6 },
      focus: { line: 4, col: 10 },
    };

    assert.equal(
      highlightSelectedTranscriptLine('hello world', 4, selection, (text) => `<${text}>`),
      'hello <world>',
    );
  });

  it('leaves non-selected lines untouched', () => {
    const selection = {
      anchor: { line: 4, col: 6 },
      focus: { line: 4, col: 10 },
    };

    assert.equal(
      highlightSelectedTranscriptLine('hello world', 5, selection, (text) => `<${text}>`),
      'hello world',
    );
  });
});
