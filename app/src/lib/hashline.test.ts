import { describe, it, expect } from 'vitest';
import { calculateLineHash, applyHashlineEdits } from './hashline';

describe('calculateLineHash', () => {
  it('returns 7 chars by default', async () => {
    const hash = await calculateLineHash('hello');
    expect(hash).toHaveLength(7);
  });

  it('returns longer hashes when requested', async () => {
    const h7 = await calculateLineHash('hello', 7);
    const h10 = await calculateLineHash('hello', 10);
    const h12 = await calculateLineHash('hello', 12);
    expect(h7).toHaveLength(7);
    expect(h10).toHaveLength(10);
    expect(h12).toHaveLength(12);
    expect(h10.startsWith(h7)).toBe(true);
    expect(h12.startsWith(h10)).toBe(true);
  });

  it('clamps length to 7–12 range', async () => {
    const hShort = await calculateLineHash('hello', 3);
    const hLong = await calculateLineHash('hello', 20);
    expect(hShort).toHaveLength(7);
    expect(hLong).toHaveLength(12);
  });
});

describe('applyHashlineEdits with longer refs (8–12 chars)', () => {
  it('matches successfully with an 8-char ref', async () => {
    const content = 'alpha\nbeta\ngamma';
    const ref8 = await calculateLineHash('beta', 8);
    expect(ref8).toHaveLength(8);

    const result = await applyHashlineEdits(content, [
      { op: 'replace_line', ref: ref8, content: 'BETA' },
    ]);
    expect(result.applied).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.content).toBe('alpha\nBETA\ngamma');
  });

  it('matches successfully with a 10-char ref', async () => {
    const content = 'line1\nline2\nline3';
    const ref10 = await calculateLineHash('line2', 10);
    expect(ref10).toHaveLength(10);

    const result = await applyHashlineEdits(content, [
      { op: 'delete_line', ref: ref10 },
    ]);
    expect(result.applied).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.content).toBe('line1\nline3');
  });

  it('matches successfully with a 12-char ref', async () => {
    const content = 'foo\nbar\nbaz';
    const ref12 = await calculateLineHash('bar', 12);
    expect(ref12).toHaveLength(12);

    const result = await applyHashlineEdits(content, [
      { op: 'insert_after', ref: ref12, content: 'inserted' },
    ]);
    expect(result.applied).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.content).toBe('foo\nbar\ninserted\nbaz');
  });

  it('insert_before works with longer ref', async () => {
    const content = 'aaa\nbbb\nccc';
    const ref9 = await calculateLineHash('bbb', 9);
    expect(ref9).toHaveLength(9);

    const result = await applyHashlineEdits(content, [
      { op: 'insert_before', ref: ref9, content: 'before-bbb' },
    ]);
    expect(result.applied).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.content).toBe('aaa\nbefore-bbb\nbbb\nccc');
  });
});

describe('ambiguous 7-char ref → diagnostic → retry with longer ref', () => {
  it('reports ambiguity for 7-char ref on duplicate lines, then succeeds with longer ref', async () => {
    // Two lines with identical trimmed content produce the same 7-char hash
    const content = 'duplicate\nunique\nduplicate';
    const ref7 = await calculateLineHash('duplicate', 7);

    // First attempt with 7-char ref should fail as ambiguous
    const result1 = await applyHashlineEdits(content, [
      { op: 'replace_line', ref: ref7, content: 'REPLACED' },
    ]);
    expect(result1.failed).toBe(1);
    expect(result1.applied).toBe(0);
    expect(result1.errors[0]).toContain('ambiguous');
    expect(result1.errors[0]).toContain('line-qualified ref');

    // The error message should suggest line-qualified refs for disambiguation
    // Since both lines have identical content, even 12-char hashes will be the same,
    // so the only way to disambiguate is via line number
    expect(result1.errors[0]).toContain('2 matches');
  });

  it('disambiguates lines that differ only in whitespace with longer ref', async () => {
    // Lines that differ in whitespace but have different trimmed content
    const content = 'return x;\n  return y;\nreturn z;';
    // Using a longer ref to target a specific line
    const ref10_x = await calculateLineHash('return x;', 10);
    const result = await applyHashlineEdits(content, [
      { op: 'replace_line', ref: ref10_x, content: 'return newX;' },
    ]);
    expect(result.applied).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.content).toBe('return newX;\n  return y;\nreturn z;');
  });

  it('handles mixed ref lengths in a single edit batch', async () => {
    const content = 'aaa\nbbb\nccc\nddd';
    const ref7 = await calculateLineHash('aaa', 7);
    const ref10 = await calculateLineHash('ccc', 10);

    const result = await applyHashlineEdits(content, [
      { op: 'replace_line', ref: ref7, content: 'AAA' },
      { op: 'replace_line', ref: ref10, content: 'CCC' },
    ]);
    expect(result.applied).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.content).toBe('AAA\nbbb\nCCC\nddd');
  });
});

describe('batched edits: same-line replace + insert_after', () => {
  it('replace_line then insert_after with the same line-qualified ref', async () => {
    const content = 'line1\nline2\nline3';
    const ref2 = '2:' + await calculateLineHash('line2', 7);

    const result = await applyHashlineEdits(content, [
      { op: 'replace_line', ref: ref2, content: 'REPLACED' },
      { op: 'insert_after', ref: ref2, content: 'INSERTED' },
    ]);
    expect(result.applied).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.content).toBe('line1\nREPLACED\nINSERTED\nline3');
  });

  it('replace_line then insert_before with the same line-qualified ref', async () => {
    const content = 'line1\nline2\nline3';
    const ref2 = '2:' + await calculateLineHash('line2', 7);

    const result = await applyHashlineEdits(content, [
      { op: 'replace_line', ref: ref2, content: 'REPLACED' },
      { op: 'insert_before', ref: ref2, content: 'INSERTED' },
    ]);
    expect(result.applied).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.content).toBe('line1\nINSERTED\nREPLACED\nline3');
  });

  it('insert_after shifts later line-qualified refs correctly', async () => {
    const content = 'aaa\nbbb\nccc\nddd';
    const refB = '2:' + await calculateLineHash('bbb', 7);
    const refD = '4:' + await calculateLineHash('ddd', 7);

    const result = await applyHashlineEdits(content, [
      { op: 'insert_after', ref: refB, content: 'NEW' },
      { op: 'replace_line', ref: refD, content: 'DDD' },
    ]);
    expect(result.applied).toBe(2);
    expect(result.failed).toBe(0);
    // insert_after bbb adds NEW at position 3, shifting ddd from idx 3 to idx 4
    expect(result.content).toBe('aaa\nbbb\nNEW\nccc\nDDD');
  });

  it('delete_line shifts later line-qualified refs correctly', async () => {
    const content = 'aaa\nbbb\nccc\nddd';
    const refB = '2:' + await calculateLineHash('bbb', 7);
    const refD = '4:' + await calculateLineHash('ddd', 7);

    const result = await applyHashlineEdits(content, [
      { op: 'delete_line', ref: refB },
      { op: 'replace_line', ref: refD, content: 'DDD' },
    ]);
    expect(result.applied).toBe(2);
    expect(result.failed).toBe(0);
    // delete bbb shifts ccc to idx 1, ddd to idx 2
    expect(result.content).toBe('aaa\nccc\nDDD');
  });

  it('multiple ops on same line: replace + two inserts', async () => {
    const content = 'before\ntarget\nafter';
    const ref = '2:' + await calculateLineHash('target', 7);

    const result = await applyHashlineEdits(content, [
      { op: 'replace_line', ref, content: 'REPLACED' },
      { op: 'insert_before', ref, content: 'PRE' },
      { op: 'insert_after', ref, content: 'POST' },
    ]);
    expect(result.applied).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.content).toBe('before\nPRE\nREPLACED\nPOST\nafter');
  });

  it('multiple insert_after on same line preserve order', async () => {
    const content = 'A\nB\nC';
    const ref = '2:' + await calculateLineHash('B', 7);

    const result = await applyHashlineEdits(content, [
      { op: 'insert_after', ref, content: 'X' },
      { op: 'insert_after', ref, content: 'Y' },
      { op: 'insert_after', ref, content: 'Z' },
    ]);
    expect(result.applied).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.content).toBe('A\nB\nX\nY\nZ\nC');
  });

  it('rejects duplicate delete_line on the same line', async () => {
    const content = 'A\nB\nC';
    const ref = '2:' + await calculateLineHash('B', 7);

    const result = await applyHashlineEdits(content, [
      { op: 'delete_line', ref },
      { op: 'delete_line', ref },
    ]);
    expect(result.applied).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors[0]).toContain('already deleted');
    expect(result.content).toBe('A\nC');
  });

  it('rejects replace_line targeting a line deleted earlier in batch', async () => {
    const content = 'A\nB\nC';
    const ref = '2:' + await calculateLineHash('B', 7);

    const result = await applyHashlineEdits(content, [
      { op: 'delete_line', ref },
      { op: 'replace_line', ref, content: 'NEW' },
    ]);
    expect(result.applied).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors[0]).toContain('already deleted');
    expect(result.content).toBe('A\nC');
  });

  it('rejects insert_after targeting a line deleted earlier in batch', async () => {
    const content = 'A\nB\nC';
    const ref = '2:' + await calculateLineHash('B', 7);

    const result = await applyHashlineEdits(content, [
      { op: 'delete_line', ref },
      { op: 'insert_after', ref, content: 'NEW' },
    ]);
    expect(result.applied).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors[0]).toContain('already deleted');
    expect(result.content).toBe('A\nC');
  });
});
