import { describe, expect, it, vi } from 'vitest';
import type { GitExec, GitExecResult } from './backend.ts';
import { computePushedDiff } from './pushed-diff.ts';

const okRes = (stdout: string): GitExecResult => ({ stdout, stderr: '', exitCode: 0 });
const failRes = (): GitExecResult => ({ stdout: '', stderr: '', exitCode: 1 });

/** Build a GitExec from a (joinedArgs) -> result map; unmatched args fail. */
function execFrom(handler: (args: string[]) => GitExecResult): GitExec {
  return vi.fn(async (args: string[]) => handler(args));
}

describe('computePushedDiff', () => {
  // The pushed diff is the per-commit PATCH SERIES (`git log -p`), not the net
  // tree diff — so the gates see secrets added then removed across commits.
  it('uses the fully-qualified remote-tracking ref as the base for the destination', async () => {
    // Fully qualified (refs/remotes/origin/feat), never the bare `origin/feat`
    // shorthand, so a local `refs/heads/origin/feat` decoy cannot shadow it and
    // collapse the audited base onto an attacker-chosen commit.
    const exec = execFrom((args) => {
      if (args[0] === 'symbolic-ref') return okRes('feat');
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/feat'))
        return okRes('origin/feat');
      if (args[0] === 'log') {
        expect(args).toEqual(['log', '-p', '--no-color', 'refs/remotes/origin/feat..HEAD']);
        return okRes('THE PATCHES');
      }
      return failRes();
    });
    expect(await computePushedDiff(exec)).toBe('THE PATCHES');
  });

  it('does not let a bare origin/<branch> (local decoy) resolve as the base', async () => {
    // The only ref this must accept is the fully-qualified remote-tracking one.
    // A stub that resolves the bare `origin/feat` (a local decoy) but NOT
    // `refs/remotes/origin/feat` must fall through to whole-history, never audit
    // an empty `origin/feat..HEAD` range.
    const exec = execFrom((args) => {
      if (args[0] === 'symbolic-ref') return okRes('feat');
      if (args[0] === 'rev-parse' && args[args.length - 1] === 'origin/feat')
        return okRes('decoyhead'); // local decoy resolves, but we must not use it
      if (args[0] === 'rev-parse') return failRes(); // refs/remotes/origin/feat absent
      if (args[0] === 'log') {
        expect(args).toEqual(['log', '-p', '--no-color', 'HEAD']); // whole history, not decoy..HEAD
        return okRes('FULL');
      }
      return failRes();
    });
    expect(await computePushedDiff(exec)).toBe('FULL');
  });

  it('ignores an upstream that is not the pushed destination', async () => {
    const exec = execFrom((args) => {
      if (args[0] === 'symbolic-ref') return okRes('feature-x');
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/feature-x'))
        return okRes('feature-x');
      if (args[0] === 'log') {
        expect(args[3]).toBe('refs/remotes/origin/feature-x..HEAD');
        return okRes('D2');
      }
      return failRes();
    });
    expect(await computePushedDiff(exec)).toBe('D2');
  });

  it('honors an explicit push remote and refspec', async () => {
    const exec = execFrom((args) => {
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/upstream/release'))
        return okRes('upstream/release');
      if (args[0] === 'log') {
        expect(args).toEqual(['log', '-p', '--no-color', 'refs/remotes/upstream/release..HEAD']);
        return okRes('D3');
      }
      return failRes();
    });
    expect(
      await computePushedDiff(exec, { remote: 'upstream', ref: 'HEAD:refs/heads/release' }),
    ).toBe('D3');
  });

  it('falls back to the merge-base with origin/HEAD for a new branch', async () => {
    const exec = execFrom((args) => {
      if (args[0] === 'symbolic-ref') return okRes('brand-new');
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/brand-new'))
        return failRes();
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/HEAD'))
        return okRes('origin/HEAD');
      if (args[0] === 'merge-base') return okRes('abc123');
      if (args[0] === 'log') {
        expect(args[3]).toBe('abc123..HEAD');
        return okRes('D3');
      }
      return failRes();
    });
    expect(await computePushedDiff(exec)).toBe('D3');
  });

  it('prefers the default branch remote-tracking ref over origin/HEAD for a new branch', async () => {
    // The #2 fix: JGit clones omit refs/remotes/origin/HEAD, so a new-branch
    // push must fork off the known default branch's remote ref instead of
    // dropping to a whole-history scan.
    const verified: string[] = [];
    const exec = execFrom((args) => {
      if (args[0] === 'symbolic-ref') return okRes('feature/new');
      if (args[0] === 'rev-parse') {
        const ref = args[args.length - 1];
        verified.push(ref);
        if (ref === 'refs/remotes/origin/main') return okRes('mainsha');
        return failRes(); // no origin/feature/new, and origin/HEAD never consulted
      }
      if (args[0] === 'merge-base') {
        expect(args).toEqual(['merge-base', 'refs/remotes/origin/main', 'HEAD']);
        return okRes('forkpt');
      }
      if (args[0] === 'log') {
        expect(args[3]).toBe('forkpt..HEAD');
        return okRes('SINCE FORK');
      }
      return failRes();
    });
    expect(await computePushedDiff(exec, { defaultBranch: 'main' })).toBe('SINCE FORK');
    // Resolved the default-branch ref; never needed to consult origin/HEAD.
    expect(verified).toContain('refs/remotes/origin/main');
    expect(verified).not.toContain('refs/remotes/origin/HEAD');
  });

  it('scans the whole history when the remote has no baseline (promote)', async () => {
    const exec = execFrom((args) => {
      if (args[0] === 'symbolic-ref') return okRes('lonely');
      if (args[0] === 'log') {
        // No baseline → log the ref's entire history (no `..range`).
        expect(args).toEqual(['log', '-p', '--no-color', 'HEAD']);
        return okRes('FULL HISTORY');
      }
      return failRes(); // no upstream, no origin/<branch>, no origin/HEAD
    });
    expect(await computePushedDiff(exec)).toBe('FULL HISTORY');
  });

  it('returns null when the log command itself fails', async () => {
    const exec = execFrom((args) => {
      if (args[0] === 'symbolic-ref') return okRes('main');
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/main'))
        return okRes('origin/main');
      if (args[0] === 'log') return failRes();
      return failRes();
    });
    expect(await computePushedDiff(exec)).toBeNull();
  });

  it('returns an empty string (not null) when there is nothing to push', async () => {
    const exec = execFrom((args) => {
      if (args[0] === 'symbolic-ref') return okRes('main');
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/main'))
        return okRes('origin/main');
      if (args[0] === 'log') return okRes('');
      return failRes();
    });
    expect(await computePushedDiff(exec)).toBe('');
  });
});
