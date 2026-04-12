import { describe, expect, it } from 'vitest';
import { detectAiCommentPatterns, formatCommentCheckBlock } from './comment-check';

function diffWithAddedLines(path: string, addedLines: string[]): string {
  const header = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -0,0 +${addedLines.length} @@`,
  ];
  return [...header, ...addedLines.map((l) => `+${l}`), ''].join('\n');
}

describe('detectAiCommentPatterns', () => {
  it('flags operation-narration comments', () => {
    const diff = diffWithAddedLines('src/foo.ts', [
      '// added validation',
      '// removed legacy branch',
      '// Updated: switched to new API',
      'const x = 1;',
    ]);

    const findings = detectAiCommentPatterns(diff);

    expect(findings).toHaveLength(3);
    expect(findings.every((f) => f.kind === 'operation-narration')).toBe(true);
    expect(findings[0].path).toBe('src/foo.ts');
  });

  it('allows legitimate attribution comments', () => {
    const diff = diffWithAddedLines('src/foo.ts', [
      '// added by alice for GH-123',
      '// removed by bob to fix race',
    ]);

    expect(detectAiCommentPatterns(diff)).toEqual([]);
  });

  it('flags meta-artifact markers', () => {
    const diff = diffWithAddedLines('src/foo.ts', [
      '// --- begin new code',
      '// [AI] refactor boundary',
      '// claude: please review',
    ]);

    const findings = detectAiCommentPatterns(diff);

    expect(findings).toHaveLength(3);
    expect(findings.every((f) => f.kind === 'meta-artifact')).toBe(true);
  });

  it('flags trivial docblocks', () => {
    const diff = diffWithAddedLines('src/foo.ts', [
      '// This function returns the user id',
      '// function to compute the sum',
      '// helper method to parse tokens',
    ]);

    const findings = detectAiCommentPatterns(diff);

    expect(findings).toHaveLength(3);
    expect(findings.every((f) => f.kind === 'trivial-docblock')).toBe(true);
  });

  it('supports python-style # comments', () => {
    const diff = diffWithAddedLines('src/foo.py', ['# added validation', '# New: parse flags']);

    const findings = detectAiCommentPatterns(diff);

    expect(findings).toHaveLength(2);
    expect(findings[0].path).toBe('src/foo.py');
  });

  it('ignores shebangs and preprocessor directives', () => {
    const diff = diffWithAddedLines('src/foo.sh', [
      '#!/usr/bin/env bash',
      '#include <stdio.h>',
      '#define FOO 1',
      '#pragma once',
    ]);

    expect(detectAiCommentPatterns(diff)).toEqual([]);
  });

  it('ignores inline trailing comments on code lines', () => {
    const diff = diffWithAddedLines('src/foo.ts', [
      'const x = 1; // added new constant',
      'doThing(); // removed old call',
    ]);

    // Inline comments are out of scope — they produce too many false positives
    // and are much more likely to be legitimate.
    expect(detectAiCommentPatterns(diff)).toEqual([]);
  });

  it('only considers added lines, not context or deletions', () => {
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,3 +1,3 @@',
      ' // added validation', // context — should NOT be flagged
      '-// removed something', // deletion — should NOT be flagged
      '+// added logging', // addition — should be flagged
    ].join('\n');

    const findings = detectAiCommentPatterns(diff);

    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe('// added logging');
  });

  it('tracks file path across multi-file diffs', () => {
    const diffA = diffWithAddedLines('a.ts', ['// added foo']);
    const diffB = diffWithAddedLines('b.ts', ['// removed bar']);

    const findings = detectAiCommentPatterns(diffA + diffB);

    expect(findings).toHaveLength(2);
    expect(findings[0].path).toBe('a.ts');
    expect(findings[1].path).toBe('b.ts');
  });

  it('respects maxFindings cap', () => {
    const lines = Array.from({ length: 50 }, () => '// added thing');
    const diff = diffWithAddedLines('src/foo.ts', lines);

    expect(detectAiCommentPatterns(diff, { maxFindings: 5 })).toHaveLength(5);
  });

  it('does not flag ordinary intent-explaining comments', () => {
    const diff = diffWithAddedLines('src/foo.ts', [
      '// Fall back to the legacy path when the feature flag is off.',
      '// We intentionally swallow this error — the caller retries.',
      '// Order matters: sort before dedupe so duplicates are adjacent.',
    ]);

    expect(detectAiCommentPatterns(diff)).toEqual([]);
  });
});

describe('formatCommentCheckBlock', () => {
  it('returns empty string when there are no findings', () => {
    expect(formatCommentCheckBlock([])).toBe('');
  });

  it('renders a block with the count and each finding', () => {
    const block = formatCommentCheckBlock([
      {
        path: 'src/foo.ts',
        line: '// added validation',
        kind: 'operation-narration',
        reason: 'Comment narrates a code operation instead of explaining intent.',
      },
    ]);

    expect(block).toContain('[COMMENT CHECK]');
    expect(block).toContain('1 added comment(s)');
    expect(block).toContain('src/foo.ts');
    expect(block).toContain('// added validation');
    expect(block).toContain('[/COMMENT CHECK]');
  });
});
