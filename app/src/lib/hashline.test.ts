import { describe, it, expect } from 'vitest';
import {
  adaptiveHashDisplayLength,
  calculateLineHash,
  applyHashlineEdits,
  renderAnchoredRange,
  splitEditableLines,
} from './hashline';

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

describe('adaptiveHashDisplayLength', () => {
  it('keeps the default display length for small files', () => {
    const hashes = Array.from({ length: 10 }, (_, idx) => `abcdef${idx.toString(16)}1234`);
    expect(adaptiveHashDisplayLength(hashes)).toBe(7);
  });

  it('extends the display length when 7-char prefixes are too ambiguous', () => {
    const hashes = Array.from({ length: 11 }, (_, idx) => `abcdefg${idx.toString(16)}123`);
    expect(adaptiveHashDisplayLength(hashes)).toBe(8);
  });
});

describe('trimmed line hashing (reindentation resilience)', () => {
  it('ignores leading and trailing whitespace', async () => {
    const canonical = await calculateLineHash('a = foo(b, c)', 12);
    expect(await calculateLineHash('\t  a = foo(b, c)  \r', 12)).toBe(canonical);
  });

  it('keeps internal whitespace significant (string/data content)', async () => {
    // Trim must NOT collapse internal runs, or a change inside a literal/data line
    // (`"a  b"` → `"a b"`) would slip through the stale-anchor check.
    const tight = await calculateLineHash('label = "a b"', 12);
    const spaced = await calculateLineHash('label = "a  b"', 12);
    expect(tight).not.toBe(spaced);
  });

  it('resolves a line-qualified anchor after the line is reindented', async () => {
    const content = 'function f() {\n        return 42;\n}';
    // Anchor captured when the body was indented with 2 spaces, not 8.
    const ref = `2:${await calculateLineHash('  return 42;', 7)}`;

    const result = await applyHashlineEdits(content, [
      { op: 'replace_line', ref, content: '    return 43;' },
    ]);
    expect(result.applied).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.content).toBe('function f() {\n    return 43;\n}');
  });
});

describe('trailing newline as a file property (no phantom line)', () => {
  it('does not show the terminal newline as an editable line', async () => {
    // A newline-terminated file must render exactly its real lines — no phantom
    // empty last line for the model to mistake for a stray blank and delete.
    const view = await renderAnchoredRange('alpha\nbeta\n');
    expect(view.totalLines).toBe(2);
    expect(view.text.split('\n')).toHaveLength(2);
    expect(view.text).toContain('alpha');
    expect(view.text).toContain('beta');
  });

  it('appends past the last line and keeps the terminal newline', async () => {
    const content = 'alpha\nbeta\n';
    const ref = await calculateLineHash('beta', 12);
    const result = await applyHashlineEdits(content, [
      { op: 'insert_after', ref, content: 'gamma' },
    ]);
    expect(result.failed).toBe(0);
    expect(result.content).toBe('alpha\nbeta\ngamma\n');
  });

  it('does not fabricate a trailing newline on a file that never had one', async () => {
    const content = 'alpha\nbeta';
    const ref = await calculateLineHash('beta', 12);
    const result = await applyHashlineEdits(content, [
      { op: 'replace_line', ref, content: 'BETA' },
    ]);
    expect(result.failed).toBe(0);
    expect(result.content).toBe('alpha\nBETA');
  });

  it('preserves the terminal newline through an ordinary line replace', async () => {
    const content = 'alpha\nbeta\n';
    const ref = await calculateLineHash('beta', 12);
    const result = await applyHashlineEdits(content, [
      { op: 'replace_line', ref, content: 'BETA' },
    ]);
    expect(result.content).toBe('alpha\nBETA\n');
  });

  it('yields an empty file (not a lone newline) when every line is deleted', async () => {
    // Deleting all editable lines of a newline-terminated file must produce an
    // empty file — the newline restoration must not leave a stray blank line.
    const content = 'alpha\nbeta\n';
    const refs = await Promise.all([calculateLineHash('alpha', 12), calculateLineHash('beta', 12)]);
    const result = await applyHashlineEdits(
      content,
      refs.map((ref) => ({ op: 'delete_line', ref })),
    );
    expect(result.failed).toBe(0);
    expect(result.content).toBe('');
  });

  it('keeps a surviving blank line (with its newline) when a sibling line is deleted', async () => {
    // `alpha\n\n` = "alpha" + one blank line + terminal newline. Deleting alpha
    // leaves the blank line, so the file is `\n` — NOT empty. (A blank line that
    // survives is content; only deleting *every* line empties the file.)
    const ref = await calculateLineHash('alpha', 12);
    const result = await applyHashlineEdits('alpha\n\n', [{ op: 'delete_line', ref }]);
    expect(result.failed).toBe(0);
    expect(result.content).toBe('\n');
  });

  it('keeps the terminal newline when the only line is replaced with empty content', async () => {
    const ref = await calculateLineHash('alpha', 12);
    const result = await applyHashlineEdits('alpha\n', [{ op: 'replace_line', ref, content: '' }]);
    expect(result.failed).toBe(0);
    expect(result.content).toBe('\n');
  });

  it('preserves a CRLF file ending when editing a different line', async () => {
    // The `\r` rides on each line; editing one line must not disturb the
    // untouched trailing CRLF.
    const ref = await calculateLineHash('alpha', 12);
    const result = await applyHashlineEdits('alpha\r\nbeta\r\n', [
      { op: 'replace_line', ref, content: 'ALPHA' },
    ]);
    expect(result.failed).toBe(0);
    expect(result.content.endsWith('beta\r\n')).toBe(true);
  });
});

describe('splitEditableLines', () => {
  it('treats the empty file as a single empty line with no newline', () => {
    expect(splitEditableLines('')).toEqual({ lines: [''], trailingNewline: false });
  });

  it('treats a file with no terminal newline as bare', () => {
    expect(splitEditableLines('alpha')).toEqual({ lines: ['alpha'], trailingNewline: false });
    expect(splitEditableLines('alpha\nbeta')).toEqual({
      lines: ['alpha', 'beta'],
      trailingNewline: false,
    });
  });

  it('pulls a terminal newline into the flag, leaving no phantom line', () => {
    expect(splitEditableLines('alpha\n')).toEqual({ lines: ['alpha'], trailingNewline: true });
    expect(splitEditableLines('alpha\nbeta\n')).toEqual({
      lines: ['alpha', 'beta'],
      trailingNewline: true,
    });
  });

  it('keeps the CRLF carriage return on the line (byte-preserving)', () => {
    expect(splitEditableLines('alpha\r\nbeta\r\n')).toEqual({
      lines: ['alpha\r', 'beta\r'],
      trailingNewline: true,
    });
  });

  it('keeps an intentional trailing blank line distinct from the phantom', () => {
    // `'a\n\n'` is line "a" + one blank line + terminal newline → two lines.
    expect(splitEditableLines('a\n\n')).toEqual({ lines: ['a', ''], trailingNewline: true });
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

    const result = await applyHashlineEdits(content, [{ op: 'delete_line', ref: ref10 }]);
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
    expect(result1.errors[0]).toContain('"1:');
    expect(result1.errors[0]).toContain('"3:');

    // The error message should suggest line-qualified refs for disambiguation
    // Since both lines have identical content, even 12-char hashes will be the same,
    // so the only way to disambiguate is via line number
    expect(result1.errors[0]).toContain('2 matches');
  });

  it('suggests a refreshed same-line ref for stale line-qualified edits', async () => {
    // The anchored content is absent from the file, so relocation finds nothing
    // and we fall back to the refreshed same-line suggestion.
    const content = 'before\nafter';
    const staleRef = `2:${await calculateLineHash('a line that does not exist', 7)}`;

    const result = await applyHashlineEdits(content, [
      { op: 'replace_line', ref: staleRef, content: 'updated' },
    ]);

    expect(result.failed).toBe(1);
    expect(result.errors[0]).toContain('Stale line-qualified ref');
    expect(result.errors[0]).toContain('Retry with "2:');
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

describe('bounded auto-relocation of stale line-qualified anchors', () => {
  it('relocates a stale anchor to the nearby line its content moved to', async () => {
    // Anchor captured "target" at line 2; two lines were prepended, so it is now line 4.
    const content = 'new1\nnew2\nfiller\ntarget\nafter';
    const ref = `2:${await calculateLineHash('target', 7)}`;

    const result = await applyHashlineEdits(content, [
      { op: 'replace_line', ref, content: 'TARGET' },
    ]);
    expect(result.applied).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.content).toBe('new1\nnew2\nfiller\nTARGET\nafter');
    expect(result.warnings.some((w) => w.includes('Relocated') && w.includes('line 4'))).toBe(true);
  });

  it('refuses to relocate when a surviving duplicate makes the content non-unique', async () => {
    // The line-qualified ref was the only disambiguator among duplicate lines;
    // relocating onto a surviving copy would silently edit the wrong line.
    const content = 'dup\nx\ndup\ny';
    // ref claims line 4 but hashes "dup", which still appears at lines 1 and 3
    const ref = `4:${await calculateLineHash('dup', 7)}`;

    const result = await applyHashlineEdits(content, [{ op: 'replace_line', ref, content: 'Z' }]);
    expect(result.applied).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors[0]).toContain('multiple other lines');
    expect(result.errors[0]).toContain('"1:');
    expect(result.errors[0]).toContain('"3:');
  });

  it('relocates across a distance only when the content is globally unique', async () => {
    // "anchor" is unique and shifted 3 lines down → safe to relocate.
    const content = 'h0\nh1\nh2\nanchor\ntail';
    const ref = `1:${await calculateLineHash('anchor', 7)}`;
    const result = await applyHashlineEdits(content, [{ op: 'delete_line', ref }]);
    expect(result.applied).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.content).toBe('h0\nh1\nh2\ntail');
  });

  it('relocates when deletion before the target makes the old line number out of range', async () => {
    // Anchor captured "target" at line 10; two lines above it were deleted, so
    // the file now has only 8 lines and the content sits nearby at line 8.
    const content = ['line1', 'line2', 'line3', 'line4', 'line5', 'line6', 'line7', 'target'].join(
      '\n',
    );
    const ref = `10:${await calculateLineHash('target', 7)}`;

    const result = await applyHashlineEdits(content, [
      { op: 'replace_line', ref, content: 'TARGET' },
    ]);

    expect(result.applied).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.content).toBe('line1\nline2\nline3\nline4\nline5\nline6\nline7\nTARGET');
    expect(result.warningDetails).toEqual([
      expect.objectContaining({ code: 'stale_ref_relocated' }),
    ]);
  });

  it('does not relocate when the matching content is outside the window', async () => {
    const body = Array.from({ length: 59 }, (_, i) => `line${i}`);
    const content = [...body, 'ANCHOR'].join('\n'); // ANCHOR sits at line 60
    const ref = `1:${await calculateLineHash('ANCHOR', 7)}`; // 59 lines away from line 1

    const result = await applyHashlineEdits(content, [{ op: 'replace_line', ref, content: 'X' }]);
    expect(result.failed).toBe(1);
    expect(result.errors[0]).toContain('Stale line-qualified ref');
    expect(result.errors[0]).toContain('Retry with "1:');
  });
});

describe('resolvedLines in edit results', () => {
  it('returns 1-indexed line numbers of successfully resolved targets', async () => {
    const content = 'aaa\nbbb\nccc\nddd';
    const refB = '2:' + (await calculateLineHash('bbb', 7));
    const refD = '4:' + (await calculateLineHash('ddd', 7));

    const result = await applyHashlineEdits(content, [
      { op: 'replace_line', ref: refB, content: 'BBB' },
      { op: 'replace_line', ref: refD, content: 'DDD' },
    ]);
    expect(result.applied).toBe(2);
    expect(result.resolvedLines).toEqual([2, 4]);
  });

  it('excludes failed edits from resolvedLines', async () => {
    const content = 'aaa\nbbb\nccc';
    const refA = '1:' + (await calculateLineHash('aaa', 7));
    const badRef = '2:' + 'badhash';

    const result = await applyHashlineEdits(content, [
      { op: 'replace_line', ref: refA, content: 'AAA' },
      { op: 'replace_line', ref: badRef, content: 'BBB' },
    ]);
    expect(result.applied).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.resolvedLines).toEqual([1]);
  });

  it('returns empty resolvedLines when all edits fail', async () => {
    const content = 'aaa\nbbb';
    const result = await applyHashlineEdits(content, [
      { op: 'replace_line', ref: 'badhash', content: 'X' },
    ]);
    expect(result.failed).toBe(1);
    expect(result.resolvedLines).toEqual([]);
  });
});

describe('batched edits: same-line replace + insert_after', () => {
  it('replace_line then insert_after with the same line-qualified ref', async () => {
    const content = 'line1\nline2\nline3';
    const ref2 = '2:' + (await calculateLineHash('line2', 7));

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
    const ref2 = '2:' + (await calculateLineHash('line2', 7));

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
    const refB = '2:' + (await calculateLineHash('bbb', 7));
    const refD = '4:' + (await calculateLineHash('ddd', 7));

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
    const refB = '2:' + (await calculateLineHash('bbb', 7));
    const refD = '4:' + (await calculateLineHash('ddd', 7));

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
    const ref = '2:' + (await calculateLineHash('target', 7));

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
    const ref = '2:' + (await calculateLineHash('B', 7));

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
    const ref = '2:' + (await calculateLineHash('B', 7));

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
    const ref = '2:' + (await calculateLineHash('B', 7));

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
    const ref = '2:' + (await calculateLineHash('B', 7));

    const result = await applyHashlineEdits(content, [
      { op: 'delete_line', ref },
      { op: 'insert_after', ref, content: 'NEW' },
    ]);
    expect(result.applied).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors[0]).toContain('already deleted');
    expect(result.content).toBe('A\nC');
  });

  it('warns when replace_line targets the same original line twice', async () => {
    const content = 'A\nB\nC';
    const ref = '2:' + (await calculateLineHash('B', 7));

    const result = await applyHashlineEdits(content, [
      { op: 'replace_line', ref, content: 'B1' },
      { op: 'replace_line', ref, content: 'B2' },
    ]);

    expect(result.applied).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('already replaced by a prior op');
    expect(result.content).toBe('A\nB2\nC');
  });
});
