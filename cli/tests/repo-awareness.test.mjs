/**
 * Unit tests for parseGitStatus. This parser is the single source of truth
 * for dirty-file counts and branch/ahead/behind parsing across CLI and app,
 * so the exotic porcelain codes (rename/copy/conflict/combined/detached) need
 * explicit coverage — the original implementation only handled M/A/D/??.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseGitStatus } from '../../lib/repo-awareness.js';

describe('parseGitStatus — header parsing', () => {
  it('parses branch + upstream', () => {
    const info = parseGitStatus('## main...origin/main\n');
    assert.equal(info.branch, 'main');
    assert.equal(info.ahead, 0);
    assert.equal(info.behind, 0);
    assert.equal(info.detached, false);
  });

  it('parses ahead/behind counts', () => {
    const info = parseGitStatus('## feat/x...origin/feat/x [ahead 2, behind 1]\n');
    assert.equal(info.branch, 'feat/x');
    assert.equal(info.ahead, 2);
    assert.equal(info.behind, 1);
  });

  it('parses ahead-only', () => {
    const info = parseGitStatus('## main...origin/main [ahead 3]\n');
    assert.equal(info.ahead, 3);
    assert.equal(info.behind, 0);
  });

  it('parses behind-only', () => {
    const info = parseGitStatus('## main...origin/main [behind 5]\n');
    assert.equal(info.ahead, 0);
    assert.equal(info.behind, 5);
  });

  it('handles a local branch with no upstream', () => {
    const info = parseGitStatus('## local-only\n');
    assert.equal(info.branch, 'local-only');
    assert.equal(info.detached, false);
  });

  it('flags detached HEAD', () => {
    const info = parseGitStatus('## HEAD (no branch)\n');
    assert.equal(info.detached, true);
    assert.equal(info.branch, '(detached)');
  });

  it('handles initial commit (No commits yet)', () => {
    const info = parseGitStatus('## No commits yet on main\n');
    assert.equal(info.detached, false);
    assert.equal(info.branch, '(no commits)');
  });
});

describe('parseGitStatus — status codes', () => {
  it('classifies basic M/A/D/??', () => {
    const out = ['## main', ' M src/a.ts', 'A  src/b.ts', ' D src/c.ts', '?? src/d.ts'].join('\n');
    const info = parseGitStatus(out);
    assert.deepEqual(info.modified, ['src/a.ts']);
    assert.deepEqual(info.added, ['src/b.ts']);
    assert.deepEqual(info.deleted, ['src/c.ts']);
    assert.deepEqual(info.untracked, ['src/d.ts']);
  });

  it('classifies combined staged+unstaged modifications (MM) once', () => {
    const info = parseGitStatus('## main\nMM src/a.ts\n');
    assert.deepEqual(info.modified, ['src/a.ts']);
    assert.equal(info.added.length, 0);
  });

  it('classifies AM (added then modified) as added, not both', () => {
    const info = parseGitStatus('## main\nAM src/a.ts\n');
    // A has priority over M per classification order (delete > add > modify).
    assert.deepEqual(info.added, ['src/a.ts']);
    assert.equal(info.modified.length, 0);
  });

  it('classifies MD (modified then deleted) as deleted', () => {
    const info = parseGitStatus('## main\nMD src/a.ts\n');
    assert.deepEqual(info.deleted, ['src/a.ts']);
    assert.equal(info.modified.length, 0);
  });

  it('classifies renames and surfaces the new path', () => {
    const info = parseGitStatus('## main\nR  old.ts -> new.ts\n');
    assert.deepEqual(info.renamed, ['new.ts']);
    assert.equal(info.modified.length, 0);
  });

  it('classifies copies and surfaces the new path', () => {
    const info = parseGitStatus('## main\nC  src/a.ts -> src/b.ts\n');
    assert.deepEqual(info.copied, ['src/b.ts']);
  });

  it('classifies merge conflicts (UU)', () => {
    const info = parseGitStatus('## main\nUU src/a.ts\n');
    assert.deepEqual(info.conflicted, ['src/a.ts']);
    assert.equal(info.modified.length, 0);
  });

  it('classifies conflict variants (AA, DD, AU, UA, UD, DU)', () => {
    const out = [
      '## main',
      'AA one.ts',
      'DD two.ts',
      'AU three.ts',
      'UA four.ts',
      'UD five.ts',
      'DU six.ts',
    ].join('\n');
    const info = parseGitStatus(out);
    assert.deepEqual(info.conflicted.sort(), [
      'five.ts',
      'four.ts',
      'one.ts',
      'six.ts',
      'three.ts',
      'two.ts',
    ]);
  });

  it('handles mixed dirty states without losing entries', () => {
    const out = [
      '## main...origin/main [ahead 1]',
      ' M src/a.ts',
      'MM src/b.ts',
      'R  old.ts -> new.ts',
      'UU src/c.ts',
      '?? untracked.ts',
    ].join('\n');
    const info = parseGitStatus(out);
    const dirty =
      info.modified.length +
      info.added.length +
      info.deleted.length +
      info.renamed.length +
      info.copied.length +
      info.conflicted.length +
      info.untracked.length;
    assert.equal(dirty, 5);
    assert.equal(info.ahead, 1);
  });

  it('ignores empty and short lines defensively', () => {
    const info = parseGitStatus('## main\n\nM\n M file.ts\n');
    assert.deepEqual(info.modified, ['file.ts']);
  });
});
