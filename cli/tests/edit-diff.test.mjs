/**
 * edit-diff.test.mjs — computeEditDiff structured line diff.
 *
 * Walks the text-edit boundary cases the repo's self-review checklist
 * calls out (empty file, trailing-newline variants, all-content-deleted,
 * EOF edits, CRLF) plus the diff-specific shapes: hunk gaps, adjacent
 * regions, caps/truncation, and the wire-shape guard `isEditDiff`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  EDIT_DIFF_MAX_LINE_CHARS,
  computeEditDiff,
  isEditDiff,
  overEditDiffLineBudget,
  renderEditDiffText,
} from '../../lib/edit-diff.ts';

describe('computeEditDiff: basic shapes', () => {
  it('one-line replace yields del+add with context and correct numbers', () => {
    const before = 'a\nb\nc\nd\ne\n';
    const after = 'a\nb\nC\nd\ne\n';
    const diff = computeEditDiff('f.txt', before, after);
    assert.ok(diff);
    assert.equal(diff.path, 'f.txt');
    assert.equal(diff.adds, 1);
    assert.equal(diff.dels, 1);
    assert.deepEqual(
      diff.lines.map((l) => [l.kind, l.oldLine ?? null, l.newLine ?? null, l.text]),
      [
        ['ctx', 1, 1, 'a'],
        ['ctx', 2, 2, 'b'],
        ['del', 3, null, 'c'],
        ['add', null, 3, 'C'],
        ['ctx', 4, 4, 'd'],
        ['ctx', 5, 5, 'e'],
      ],
    );
  });

  it('pure insertion yields only add lines (plus context)', () => {
    const diff = computeEditDiff('f.txt', 'a\nb\n', 'a\nX\nb\n');
    assert.ok(diff);
    assert.equal(diff.adds, 1);
    assert.equal(diff.dels, 0);
    assert.deepEqual(
      diff.lines.map((l) => [l.kind, l.newLine ?? l.oldLine, l.text]),
      [
        ['ctx', 1, 'a'],
        ['add', 2, 'X'],
        ['ctx', 3, 'b'], // old line 2, shifted to new line 3 by the insert
      ],
    );
  });

  it('pure deletion yields only del lines (plus context)', () => {
    const diff = computeEditDiff('f.txt', 'a\nX\nb\n', 'a\nb\n');
    assert.ok(diff);
    assert.equal(diff.adds, 0);
    assert.equal(diff.dels, 1);
    assert.deepEqual(
      diff.lines.map((l) => [l.kind, l.text]),
      [
        ['ctx', 'a'],
        ['del', 'X'],
        ['ctx', 'b'],
      ],
    );
  });

  it('edit on the last line (EOF) keeps numbering intact', () => {
    const diff = computeEditDiff('f.txt', 'a\nb\nend', 'a\nb\nEND');
    assert.ok(diff);
    const del = diff.lines.find((l) => l.kind === 'del');
    const add = diff.lines.find((l) => l.kind === 'add');
    assert.equal(del.oldLine, 3);
    assert.equal(add.newLine, 3);
  });
});

describe('computeEditDiff: boundary cases', () => {
  it('identical content returns null', () => {
    assert.equal(computeEditDiff('f.txt', 'a\nb\n', 'a\nb\n'), null);
  });

  it('newline-at-EOF-only change returns null (not a renderable edit)', () => {
    assert.equal(computeEditDiff('f.txt', 'a\nb', 'a\nb\n'), null);
  });

  it('new file (empty before) is pure additions', () => {
    const diff = computeEditDiff('f.txt', '', 'a\nb\n');
    assert.ok(diff);
    assert.equal(diff.adds, 2);
    assert.equal(diff.dels, 0);
    assert.deepEqual(
      diff.lines.map((l) => [l.kind, l.newLine, l.text]),
      [
        ['add', 1, 'a'],
        ['add', 2, 'b'],
      ],
    );
  });

  it('all content deleted is pure deletions, no phantom empty add', () => {
    const diff = computeEditDiff('f.txt', 'a\nb\n', '');
    assert.ok(diff);
    assert.equal(diff.adds, 0);
    assert.equal(diff.dels, 2);
    assert.ok(diff.lines.every((l) => l.kind !== 'add'));
  });

  it('single line without trailing newline diffs cleanly', () => {
    const diff = computeEditDiff('f.txt', 'old', 'new');
    assert.ok(diff);
    assert.deepEqual(
      diff.lines.map((l) => [l.kind, l.text]),
      [
        ['del', 'old'],
        ['add', 'new'],
      ],
    );
  });

  it('CRLF-only line change still registers, with \\r scrubbed for display', () => {
    const diff = computeEditDiff('f.txt', 'a\r\nb\r\n', 'a\r\nB\r\n');
    assert.ok(diff);
    const add = diff.lines.find((l) => l.kind === 'add');
    assert.equal(add.text, 'B'); // no trailing \r in display text
  });

  it('expands tabs and strips control chars in display text', () => {
    const diff = computeEditDiff('f.txt', 'a\n', 'a\n\txy\n');
    assert.ok(diff);
    const add = diff.lines.find((l) => l.kind === 'add');
    assert.equal(add.text, '  xy');
  });

  it('strips C1 controls and zero-width/bidi marks (terminal spoofing hardening)', () => {
    // U+009B is a one-byte CSI some terminals honor like ESC[; U+202E
    // (RLO) visually reorders following text; U+200B is invisible. Same
    // strip set as the citation sanitizer (cli/citation-format.ts).
    const hostile = 'safe\u009b31mred\u202eevil\u200bhidden\ufeff';
    const diff = computeEditDiff('f.txt', 'a\n', `a\n${hostile}\n`);
    assert.ok(diff);
    const add = diff.lines.find((l) => l.kind === 'add');
    assert.equal(add.text, 'safe31mredevilhidden');
  });
});

describe('computeEditDiff: hunks, adjacency, caps', () => {
  it('two distant edits produce a line-number gap between hunks', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n');
    const after = before.replace('line2', 'LINE2').replace('line18', 'LINE18');
    const diff = computeEditDiff('f.txt', before, after);
    assert.ok(diff);
    const numbers = diff.lines.map((l) => l.newLine ?? l.oldLine);
    // Context radius is 2, so nothing between line 5 and line 15 is emitted.
    assert.ok(!numbers.includes(10));
    assert.equal(diff.adds, 2);
    assert.equal(diff.dels, 2);
  });

  it('regions one matching line apart do not emit duplicate rows', () => {
    // Changes on lines 2 and 4, separated by matching line 3 — the first
    // region's trailing context must stop before the second region's del.
    const diff = computeEditDiff('f.txt', 'a\nb\nc\nd\ne\n', 'a\nB\nc\nD\ne\n');
    assert.ok(diff);
    const rendered = diff.lines.map((l) => `${l.kind}:${l.oldLine ?? ''}:${l.newLine ?? ''}`);
    assert.equal(new Set(rendered).size, rendered.length, `duplicate rows in ${rendered}`);
    assert.equal(diff.lines.filter((l) => l.kind === 'del').length, 2);
    assert.equal(diff.lines.filter((l) => l.kind === 'add').length, 2);
  });

  it('caps emitted lines and flags truncation while keeping full counts', () => {
    const before = Array.from({ length: 60 }, (_, i) => `old${i}`).join('\n');
    const after = Array.from({ length: 60 }, (_, i) => `new${i}`).join('\n');
    const diff = computeEditDiff('f.txt', before, after, { maxLines: 10 });
    assert.ok(diff);
    assert.equal(diff.lines.length, 10);
    assert.equal(diff.truncated, true);
    assert.equal(diff.adds, 60);
    assert.equal(diff.dels, 60);
  });

  it('cuts overlong lines and flags textTruncated', () => {
    const long = 'x'.repeat(EDIT_DIFF_MAX_LINE_CHARS + 50);
    const diff = computeEditDiff('f.txt', 'a\n', `a\n${long}\n`);
    assert.ok(diff);
    const add = diff.lines.find((l) => l.kind === 'add');
    assert.equal(add.text.length, EDIT_DIFF_MAX_LINE_CHARS);
    assert.equal(add.textTruncated, true);
  });

  it('overEditDiffLineBudget flags oversized inputs (and computeEditDiff skips them)', () => {
    const huge = 'x\n'.repeat(40_001);
    assert.equal(overEditDiffLineBudget(huge, 'a\n'), true);
    assert.equal(overEditDiffLineBudget('a\n', 'b\n'), false);
    assert.equal(computeEditDiff('f.txt', huge, 'a\n'), null);
  });
});

describe('renderEditDiffText', () => {
  it('renders the model-visible text form with markers and hunk separators', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n');
    const after = before.replace('line2', 'LINE2').replace('line18', 'LINE18');
    const diff = computeEditDiff('f.txt', before, after);
    assert.equal(
      renderEditDiffText(diff),
      [
        '1  | line1',
        '2 -| line2',
        '2 +| LINE2',
        '3  | line3',
        '4  | line4',
        '---',
        '16  | line16',
        '17  | line17',
        '18 -| line18',
        '18 +| LINE18',
        '19  | line19',
        '20  | line20',
      ].join('\n'),
    );
  });

  it('emits no gap marker inside an unbalanced replace (5 lines → 2)', () => {
    // Del rows carry old-file numbers (2..6) and the following add rows
    // restart at new-file 2 — a single-cursor gap heuristic comparing the
    // two coordinate systems could emit a spurious separator here.
    const before = 'a\nx1\nx2\nx3\nx4\nx5\nb\n';
    const after = 'a\ny1\ny2\nb\n';
    const diff = computeEditDiff('f.txt', before, after);
    const text = renderEditDiffText(diff);
    assert.ok(!text.includes('---'), text);
    assert.ok(!text.includes('truncated'), text);
  });

  it('emits a gap marker after a deletion-heavy hunk when lines are skipped', () => {
    // Hunk 1 deletes old 2..7 (new-file cursor stays low); hunk 2 edits
    // further down. The gap is only visible in old-file coordinates —
    // this pins that the tracker watches both.
    const lines = Array.from({ length: 16 }, (_, i) => `line${i + 1}`);
    const before = `${lines.join('\n')}\n`;
    const afterLines = ['line1', ...lines.slice(7)]; // drop old 2..7
    afterLines[afterLines.length - 2] = 'LINE15'; // edit old line 15
    const after = `${afterLines.join('\n')}\n`;
    const diff = computeEditDiff('f.txt', before, after);
    const text = renderEditDiffText(diff);
    assert.equal(text.split('\n').filter((l) => l === '---').length, 1, text);
  });

  it('caps output at maxLines and appends the totals trailer', () => {
    const diff = computeEditDiff('f.txt', '', 'a\nb\nc\nd\n');
    const text = renderEditDiffText(diff, { maxLines: 2 });
    assert.deepEqual(text.split('\n'), ['1 +| a', '2 +| b', '... (diff truncated; totals: +4 -0)']);
  });
});

describe('isEditDiff', () => {
  it('accepts a computed diff round-tripped through JSON', () => {
    const diff = computeEditDiff('f.txt', 'a\n', 'b\n');
    assert.equal(isEditDiff(JSON.parse(JSON.stringify(diff))), true);
  });

  it('rejects wrong shapes', () => {
    assert.equal(isEditDiff(null), false);
    assert.equal(isEditDiff({}), false);
    assert.equal(
      isEditDiff({ path: 'f', adds: 1, dels: 0, lines: [{ kind: 'nope', text: '' }] }),
      false,
    );
    assert.equal(
      isEditDiff({ path: 'f', adds: 1, dels: 0, lines: [{ kind: 'add', text: 1 }] }),
      false,
    );
    assert.equal(isEditDiff({ path: '', adds: 0, dels: 0, lines: [] }), false);
  });
});
