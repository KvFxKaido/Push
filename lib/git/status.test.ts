import { describe, expect, it } from 'vitest';
import { parseGitStatusInfo } from './status.ts';

describe('parseGitStatusInfo', () => {
  it('parses branch, ahead/behind, and entries with staged/unstaged counts', () => {
    const stdout = [
      '## main...origin/main [ahead 2, behind 1]',
      'M  staged.ts',
      ' M unstaged.ts',
      'MM both.ts',
      'A  added.ts',
      '?? new.ts',
    ].join('\n');

    const info = parseGitStatusInfo(stdout);

    expect(info.branch).toBe('main');
    expect(info.detached).toBe(false);
    expect(info.ahead).toBe(2);
    expect(info.behind).toBe(1);
    expect(info.hasUpstream).toBe(true);
    expect(info.statusLine).toBe('main...origin/main [ahead 2, behind 1]');
    expect(info.entries).toHaveLength(5);
    // staged = entries with non-space X (excludes ??): staged.ts, both.ts, added.ts
    expect(info.staged).toBe(3);
    // unstaged = entries with non-space Y (excludes ??): unstaged.ts, both.ts
    expect(info.unstaged).toBe(2);
    // category arrays still come through from the base parser.
    expect(info.added).toEqual(['added.ts']);
    expect(info.untracked).toEqual(['new.ts']);
  });

  it('surfaces the post-arrow path for renames in entries', () => {
    const info = parseGitStatusInfo('## main\nR  old.ts -> new.ts');
    expect(info.entries[0].path).toBe('new.ts');
    expect(info.entries[0].raw).toBe('R  old.ts -> new.ts');
    expect(info.renamed).toEqual(['new.ts']);
  });

  it('reports hasUpstream=false for a never-pushed branch (ahead 0 is meaningless there)', () => {
    const info = parseGitStatusInfo('## feat/local-only\n M file.ts');
    expect(info.branch).toBe('feat/local-only');
    expect(info.hasUpstream).toBe(false);
    expect(info.ahead).toBe(0);
  });

  it('marks detached HEAD and empty status', () => {
    const detached = parseGitStatusInfo('## HEAD (no branch)');
    expect(detached.detached).toBe(true);
    expect(detached.branch).toBe('(detached)');
    expect(detached.entries).toEqual([]);
    expect(detached.staged).toBe(0);
    expect(detached.unstaged).toBe(0);
  });

  it('handles a clean tree with only a header line', () => {
    const info = parseGitStatusInfo('## main...origin/main');
    expect(info.branch).toBe('main');
    expect(info.entries).toEqual([]);
    expect(info.statusLine).toBe('main...origin/main');
  });
});
