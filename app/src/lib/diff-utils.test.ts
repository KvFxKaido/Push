import { describe, expect, it } from 'vitest';
import { chunkDiffByFile, classifyFilePath } from './diff-utils';

function makeAddedFileDiff(path: string, addedContent: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -0,0 +1 @@',
    `+${addedContent}`,
    '',
  ].join('\n');
}

describe('chunkDiffByFile', () => {
  it('keeps a truncated prefix of the first oversized file instead of dropping it', () => {
    const hugeProductionDiff = makeAddedFileDiff('src/huge.ts', 'x'.repeat(1_000));
    const smallTestDiff = makeAddedFileDiff('src/huge.test.ts', 'test');

    const result = chunkDiffByFile(hugeProductionDiff + smallTestDiff, 300, classifyFilePath);

    expect(result).toContain('diff --git a/src/huge.ts b/src/huge.ts');
    expect(result).toContain('[Largest file truncated to fit budget]');
    expect(result).toContain('[1 file(s) omitted due to size limit: src/huge.test.ts]');
    expect(result).not.toContain('diff --git a/src/huge.test.ts b/src/huge.test.ts');
  });
});
