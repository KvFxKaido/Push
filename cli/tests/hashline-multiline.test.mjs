import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyHashlineEdits, calculateLineHash } from '../hashline.ts';

function makeRef(line, lineNo) {
  return `${lineNo}:${calculateLineHash(line)}`;
}

describe('multi-line replace_line', () => {
  it('replaces one line with multiple lines', () => {
    const content = 'alpha\nbeta\ngamma';
    const ref = makeRef('beta', 2);
    const result = applyHashlineEdits(content, [
      { op: 'replace_line', ref, content: 'beta1\nbeta2\nbeta3' },
    ]);
    assert.equal(result.content, 'alpha\nbeta1\nbeta2\nbeta3\ngamma');
    assert.equal(result.applied[0].op, 'replace_line');
    assert.equal(result.applied[0].line, 2);
    assert.equal(result.applied[0].linesInserted, 3);
  });

  it('single-line replace still works (backward compat)', () => {
    const content = 'alpha\nbeta\ngamma';
    const ref = makeRef('beta', 2);
    const result = applyHashlineEdits(content, [{ op: 'replace_line', ref, content: 'BETA' }]);
    assert.equal(result.content, 'alpha\nBETA\ngamma');
    assert.equal(result.applied[0].linesInserted, 1);
  });
});

describe('multi-line insert_after', () => {
  it('inserts multiple lines after the referenced line', () => {
    const content = 'alpha\nbeta\ngamma';
    const ref = makeRef('alpha', 1);
    const result = applyHashlineEdits(content, [
      { op: 'insert_after', ref, content: 'new1\nnew2' },
    ]);
    assert.equal(result.content, 'alpha\nnew1\nnew2\nbeta\ngamma');
    assert.equal(result.applied[0].op, 'insert_after');
    assert.equal(result.applied[0].line, 2);
    assert.equal(result.applied[0].linesInserted, 2);
  });

  it('single-line insert_after still works', () => {
    const content = 'alpha\nbeta';
    const ref = makeRef('alpha', 1);
    const result = applyHashlineEdits(content, [{ op: 'insert_after', ref, content: 'middle' }]);
    assert.equal(result.content, 'alpha\nmiddle\nbeta');
    assert.equal(result.applied[0].linesInserted, 1);
  });
});

describe('multi-line insert_before', () => {
  it('inserts multiple lines before the referenced line', () => {
    const content = 'alpha\nbeta\ngamma';
    const ref = makeRef('gamma', 3);
    const result = applyHashlineEdits(content, [
      { op: 'insert_before', ref, content: 'pre1\npre2\npre3' },
    ]);
    assert.equal(result.content, 'alpha\nbeta\npre1\npre2\npre3\ngamma');
    assert.equal(result.applied[0].op, 'insert_before');
    assert.equal(result.applied[0].line, 3);
    assert.equal(result.applied[0].linesInserted, 3);
  });

  it('single-line insert_before still works', () => {
    const content = 'alpha\nbeta';
    const ref = makeRef('beta', 2);
    const result = applyHashlineEdits(content, [{ op: 'insert_before', ref, content: 'middle' }]);
    assert.equal(result.content, 'alpha\nmiddle\nbeta');
    assert.equal(result.applied[0].linesInserted, 1);
  });
});

describe('delete_line (unchanged)', () => {
  it('still deletes a single line', () => {
    const content = 'alpha\nbeta\ngamma';
    const ref = makeRef('beta', 2);
    const result = applyHashlineEdits(content, [{ op: 'delete_line', ref }]);
    assert.equal(result.content, 'alpha\ngamma');
    assert.equal(result.applied[0].op, 'delete_line');
    assert.equal(result.applied[0].line, 2);
  });
});

describe('CRLF fidelity', () => {
  it('preserves CRLF style when replacing and inserting lines', () => {
    const replaceRef = makeRef('alpha', 1);
    const replaced = applyHashlineEdits('alpha\r\nbeta\r\n', [
      { op: 'replace_line', ref: replaceRef, content: 'ALPHA' },
    ]);
    assert.equal(replaced.content, 'ALPHA\r\nbeta\r\n');

    const insertRef = makeRef('beta', 2);
    const inserted = applyHashlineEdits('alpha\r\nbeta', [
      { op: 'insert_after', ref: insertRef, content: 'gamma' },
    ]);
    assert.equal(inserted.content, 'alpha\r\nbeta\r\ngamma');
  });
});

describe('trimmed line hashing', () => {
  it('keeps internal whitespace significant', () => {
    // Trim does not collapse internal runs, so spacing inside literals/data stays in the hash.
    assert.notEqual(
      calculateLineHash('label = "a b"', 12),
      calculateLineHash('label = "a  b"', 12),
    );
  });

  it('matches a reindented line via a hash-only ref', () => {
    const content = 'a\n        return 42;\nb';
    const ref = calculateLineHash('  return 42;');
    const result = applyHashlineEdits(content, [{ op: 'delete_line', ref }]);
    assert.equal(result.content, 'a\nb');
  });
});

describe('stale-anchor relocation', () => {
  it('relocates a stale line-qualified anchor and warns', () => {
    const content = 'new1\nnew2\nfiller\ntarget\nafter';
    const ref = `2:${calculateLineHash('target')}`;
    const result = applyHashlineEdits(content, [{ op: 'replace_line', ref, content: 'TARGET' }]);
    assert.equal(result.content, 'new1\nnew2\nfiller\nTARGET\nafter');
    assert.ok(result.warnings.some((w) => w.includes('Relocated')));
  });

  it('throws (strict CLI mode) when a surviving duplicate blocks relocation', () => {
    const content = 'dup\nx\ndup\ny';
    const ref = `4:${calculateLineHash('dup')}`;
    assert.throws(
      () => applyHashlineEdits(content, [{ op: 'replace_line', ref, content: 'Z' }]),
      /multiple other lines/,
    );
  });
});

describe('multi-line sequential edits', () => {
  it('handles replace then insert_after on shifted lines', () => {
    const content = 'line1\nline2\nline3';
    // Replace line1 with two lines, then insert after original line2
    // After replace: "A\nB\nline2\nline3" — line2 is now at index 2
    const ref1 = makeRef('line1', 1);
    const result = applyHashlineEdits(content, [
      { op: 'replace_line', ref: ref1, content: 'A\nB' },
    ]);
    assert.equal(result.content, 'A\nB\nline2\nline3');

    // Now do a second edit pass on the result
    const ref2 = makeRef('line2', 3);
    const result2 = applyHashlineEdits(result.content, [
      { op: 'insert_after', ref: ref2, content: 'C\nD' },
    ]);
    assert.equal(result2.content, 'A\nB\nline2\nC\nD\nline3');
  });
});
