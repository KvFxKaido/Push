import { describe, expect, it } from 'vitest';
import { sanitizeNativeDiff } from './native-diff';

/**
 * The sensitive-path boundary is what stops a native diff from rendering
 * secrets the tool path hides. These cases are the ones a source-side-only,
 * `\S+`-shaped header match silently lets through.
 */
describe('sanitizeNativeDiff header parsing', () => {
  it('hides a rename whose destination is sensitive', () => {
    const diff =
      'diff --git a/safe.txt b/.env\n' +
      'rename from safe.txt\nrename to .env\n' +
      '--- a/safe.txt\n+++ b/.env\n@@ -1 +1 @@\n-x\n+plain config body\n';

    const result = sanitizeNativeDiff({ diff, truncated: false });

    expect(result.diff).not.toContain('plain config body');
    expect(result.diff).toContain('1 sensitive file diff hidden');
  });

  it('hides a C-quoted sensitive path', () => {
    const diff =
      'diff --git "a/my dir/.env" "b/my dir/.env"\n' +
      '--- "a/my dir/.env"\n+++ "b/my dir/.env"\n@@ -0,0 +1 @@\n+plain config body\n';

    const result = sanitizeNativeDiff({ diff, truncated: false });

    expect(result.diff).not.toContain('plain config body');
    expect(result.diff).toContain('1 sensitive file diff hidden');
  });

  it('fails closed on a header it cannot parse', () => {
    const diff = 'diff --git garbled-header-with-no-operands\n+plain config body\n';

    const result = sanitizeNativeDiff({ diff, truncated: false });

    expect(result.diff).not.toContain('plain config body');
    expect(result.diff).toContain('1 sensitive file diff hidden');
  });

  it('keeps an ordinary file with spaces in its quoted path', () => {
    const diff =
      'diff --git "a/src/my file.ts" "b/src/my file.ts"\n' +
      '--- "a/src/my file.ts"\n+++ "b/src/my file.ts"\n@@ -1 +1 @@\n+export const ok = 1;\n';

    const result = sanitizeNativeDiff({ diff, truncated: false });

    expect(result.diff).toContain('export const ok = 1;');
    expect(result.diff).not.toContain('sensitive file diff hidden');
  });

  it('unquotes porcelain status paths before matching', () => {
    const result = sanitizeNativeDiff({
      diff: '',
      truncated: false,
      git_status: '## main\n M src/a.ts\n?? "my dir/.env"',
    });

    expect(result.git_status).toContain('src/a.ts');
    expect(result.git_status).not.toContain('.env');
  });
});
