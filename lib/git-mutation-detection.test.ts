import { describe, expect, it } from 'vitest';
import { detectBlockedGitCommand } from './git-mutation-detection.ts';

describe('detectBlockedGitCommand — Tier 1 (subcommand block list)', () => {
  it('blocks bare `git commit`', () => {
    expect(detectBlockedGitCommand('git commit -m "fix"')).toBe('git commit');
  });

  it('blocks bare `git push`', () => {
    expect(detectBlockedGitCommand('git push origin main')).toBe('git push');
  });

  it('blocks `git merge`', () => {
    expect(detectBlockedGitCommand('git merge develop')).toBe('git merge');
  });

  it('blocks `git rebase`', () => {
    expect(detectBlockedGitCommand('git rebase main')).toBe('git rebase');
  });

  it('blocks `git cherry-pick`', () => {
    expect(detectBlockedGitCommand('git cherry-pick abc123')).toBe('git cherry-pick');
  });

  it('allows non-mutating git subcommands (status, diff, log)', () => {
    expect(detectBlockedGitCommand('git status')).toBeNull();
    expect(detectBlockedGitCommand('git diff')).toBeNull();
    expect(detectBlockedGitCommand('git log --oneline')).toBeNull();
  });
});

describe('detectBlockedGitCommand — global option bypasses (P2 from PR #562)', () => {
  it('blocks `git -C path commit` (regression: previously bypassed)', () => {
    expect(detectBlockedGitCommand('git -C /some/path commit -m "fix"')).toBe('git commit');
  });

  it('blocks `git --git-dir=.git push` (regression: previously bypassed)', () => {
    expect(detectBlockedGitCommand('git --git-dir=.git push origin main')).toBe('git push');
  });

  it('blocks `git --git-dir .git push` (space form)', () => {
    expect(detectBlockedGitCommand('git --git-dir .git push origin main')).toBe('git push');
  });

  it('blocks `git -c user.name=x commit`', () => {
    expect(detectBlockedGitCommand('git -c user.name=foo commit')).toBe('git commit');
  });

  it('blocks `git --work-tree=. -C path commit` (multiple globals)', () => {
    expect(detectBlockedGitCommand('git --work-tree=. -C path commit')).toBe('git commit');
  });

  it('blocks `git --no-pager push`', () => {
    expect(detectBlockedGitCommand('git --no-pager push')).toBe('git push');
  });

  it('blocks `git -C path checkout -b feature` (option + branch create)', () => {
    expect(detectBlockedGitCommand('git -C path checkout -b feature/foo')).toBe('git checkout -b');
  });

  it('blocks `git --git-dir=.git switch -c feature` (option + branch create)', () => {
    expect(detectBlockedGitCommand('git --git-dir=.git switch -c feature/foo')).toBe(
      'git switch -c',
    );
  });
});

describe('detectBlockedGitCommand — Tier 2 (branch checkout/switch)', () => {
  it('blocks bare `git checkout main`', () => {
    expect(detectBlockedGitCommand('git checkout main')).toBe('git checkout <branch>');
  });

  it('blocks bare `git switch develop`', () => {
    expect(detectBlockedGitCommand('git switch develop')).toBe('git switch <branch>');
  });

  it('blocks `git checkout feat/foo` (regression: slash carve-out removed)', () => {
    // Previously `git checkout` with a slashed operand passed through as
    // "path-like". Now blocked symmetrically so branch swaps go through
    // sandbox_switch_branch.
    expect(detectBlockedGitCommand('git checkout feat/foo')).toBe('git checkout <branch>');
  });

  it('blocks `git checkout src/utils.ts` (single positional ambiguous)', () => {
    // Was passed through under the slash/dot carve-out for file restores;
    // now blocked. Users should use `git checkout -- src/utils.ts`.
    expect(detectBlockedGitCommand('git checkout src/utils.ts')).toBe('git checkout <branch>');
  });

  it('allows `git checkout -- src/utils.ts` (explicit file restore)', () => {
    expect(detectBlockedGitCommand('git checkout -- src/utils.ts')).toBeNull();
  });

  it('allows `git checkout HEAD src/utils.ts` (two-positional file restore)', () => {
    expect(detectBlockedGitCommand('git checkout HEAD src/utils.ts')).toBeNull();
  });

  it('allows ref expressions like `git checkout HEAD~1`', () => {
    expect(detectBlockedGitCommand('git checkout HEAD~1')).toBeNull();
  });

  it('allows `git checkout main~3`', () => {
    expect(detectBlockedGitCommand('git checkout main~3')).toBeNull();
  });

  it('blocks `git checkout` with command substitution', () => {
    expect(detectBlockedGitCommand('git checkout $(echo main)')).toBe('git checkout <branch>');
  });

  it('blocks `git switch feat/foo` (already strict)', () => {
    expect(detectBlockedGitCommand('git switch feat/foo')).toBe('git switch <branch>');
  });
});

describe('detectBlockedGitCommand — list separators and pipelines', () => {
  it('blocks `git push` inside `npm test && git push`', () => {
    expect(detectBlockedGitCommand('npm test && git push origin main')).toBe('git push');
  });

  it('blocks `git commit` inside `git add . ; git commit`', () => {
    expect(detectBlockedGitCommand('git add . ; git commit -m fix')).toBe('git commit');
  });

  it('blocks `git push` inside a pipeline', () => {
    expect(detectBlockedGitCommand('cat log | grep error && git push')).toBe('git push');
  });

  it('blocks `git -C path commit` inside `npm run check && git -C . commit`', () => {
    expect(detectBlockedGitCommand('npm run check && git -C . commit')).toBe('git commit');
  });
});

describe('detectBlockedGitCommand — false-positive prevention', () => {
  // Note: the detection doesn't parse shell quoting, so commands like
  // `echo "use git push later"` would still match. The previous regex
  // had the same blind spot; tightening it is out of scope here
  // because tool-call inputs aren't user shell history.

  it('passes through `gitignore` (not git)', () => {
    expect(detectBlockedGitCommand('cat .gitignore')).toBeNull();
  });

  it('passes through `gitk` (not git per se)', () => {
    expect(detectBlockedGitCommand('gitk --all')).toBeNull();
  });
});
