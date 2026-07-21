import { describe, expect, it } from 'vitest';
import { normalizeBranchInput } from './branch-input.ts';

describe('normalizeBranchInput', () => {
  it('passes plain branch names through (trimmed)', () => {
    expect(normalizeBranchInput('feature/widget')).toBe('feature/widget');
    expect(normalizeBranchInput('  main \n')).toBe('main');
  });

  it('strips remote-tracking spellings copied from `git branch -a`', () => {
    expect(normalizeBranchInput('origin/feature/widget')).toBe('feature/widget');
    expect(normalizeBranchInput('remotes/origin/feature/widget')).toBe('feature/widget');
    expect(normalizeBranchInput('refs/remotes/origin/feature/widget')).toBe('feature/widget');
    expect(normalizeBranchInput('refs/heads/feature/widget')).toBe('feature/widget');
  });

  it('strips only one prefix layer', () => {
    expect(normalizeBranchInput('origin/origin/x')).toBe('origin/x');
  });

  it('leaves a bare prefix (nothing after it) untouched for validation to reject', () => {
    // Ends with '/' → isInvalidGitRef refuses it downstream; normalizing it to
    // an empty string would produce a worse error.
    expect(normalizeBranchInput('origin/')).toBe('origin/');
    expect(normalizeBranchInput('refs/heads/')).toBe('refs/heads/');
  });
});
