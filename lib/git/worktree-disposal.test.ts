import { describe, expect, it } from 'vitest';
import { decideWorktreeDisposal } from './worktree-disposal.ts';

describe('decideWorktreeDisposal', () => {
  it('removes a clean area with no session commits', () => {
    expect(
      decideWorktreeDisposal({ dirty: false, commitsAhead: 0, unpushedCommits: null }),
    ).toEqual({ action: 'remove', reason: 'clean' });
  });

  it('keeps a dirty area regardless of commit state', () => {
    expect(decideWorktreeDisposal({ dirty: true, commitsAhead: 0, unpushedCommits: 0 })).toEqual({
      action: 'keep',
      reason: 'dirty',
    });
  });

  it('dirty wins over fully-pushed (commit-first is the actionable reason)', () => {
    expect(decideWorktreeDisposal({ dirty: true, commitsAhead: 3, unpushedCommits: 0 })).toEqual({
      action: 'keep',
      reason: 'dirty',
    });
  });

  it('keeps a never-pushed branch with local commits (null falls back to commitsAhead)', () => {
    expect(
      decideWorktreeDisposal({ dirty: false, commitsAhead: 2, unpushedCommits: null }),
    ).toEqual({ action: 'keep', reason: 'unpushed' });
  });

  it('keeps a branch with commits ahead of its remote ref', () => {
    expect(decideWorktreeDisposal({ dirty: false, commitsAhead: 5, unpushedCommits: 2 })).toEqual({
      action: 'keep',
      reason: 'unpushed',
    });
  });

  it('removes a clean, fully-pushed branch even with commits beyond base (Gap A)', () => {
    // commitsAhead > 0 but every commit is on the remote → recoverable → remove.
    expect(decideWorktreeDisposal({ dirty: false, commitsAhead: 4, unpushedCommits: 0 })).toEqual({
      action: 'remove',
      reason: 'fully-pushed',
    });
  });

  it('reason distinguishes clean (no commits) from fully-pushed (pushed commits)', () => {
    expect(
      decideWorktreeDisposal({ dirty: false, commitsAhead: 0, unpushedCommits: 0 }).reason,
    ).toBe('clean');
    expect(
      decideWorktreeDisposal({ dirty: false, commitsAhead: 1, unpushedCommits: 0 }).reason,
    ).toBe('fully-pushed');
  });
});
