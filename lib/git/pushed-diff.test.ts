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
  it('uses origin/<branch> as the base for the default push destination', async () => {
    const exec = execFrom((args) => {
      if (args[0] === 'symbolic-ref') return okRes('feat');
      if (args[0] === 'rev-parse' && args.includes('origin/feat')) return okRes('origin/feat');
      if (args[0] === 'log') {
        expect(args).toEqual(['log', '-p', '--no-color', 'origin/feat..HEAD']);
        return okRes('THE PATCHES');
      }
      return failRes();
    });
    expect(await computePushedDiff(exec)).toBe('THE PATCHES');
  });

  it('ignores an upstream that is not the pushed destination', async () => {
    const exec = execFrom((args) => {
      if (args[0] === 'symbolic-ref') return okRes('feature-x');
      if (args[0] === 'rev-parse' && args.includes('origin/feature-x')) return okRes('feature-x');
      if (args[0] === 'log') {
        expect(args[3]).toBe('origin/feature-x..HEAD');
        return okRes('D2');
      }
      return failRes();
    });
    expect(await computePushedDiff(exec)).toBe('D2');
  });

  it('honors an explicit push remote and refspec', async () => {
    const exec = execFrom((args) => {
      if (args[0] === 'rev-parse' && args.includes('upstream/release'))
        return okRes('upstream/release');
      if (args[0] === 'log') {
        expect(args).toEqual(['log', '-p', '--no-color', 'upstream/release..HEAD']);
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
      if (args[0] === 'rev-parse' && args.includes('origin/brand-new')) return failRes();
      if (args[0] === 'rev-parse' && args.includes('origin/HEAD')) return okRes('origin/HEAD');
      if (args[0] === 'merge-base') return okRes('abc123');
      if (args[0] === 'log') {
        expect(args[3]).toBe('abc123..HEAD');
        return okRes('D3');
      }
      return failRes();
    });
    expect(await computePushedDiff(exec)).toBe('D3');
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
      if (args[0] === 'rev-parse' && args.includes('origin/main')) return okRes('origin/main');
      if (args[0] === 'log') return failRes();
      return failRes();
    });
    expect(await computePushedDiff(exec)).toBeNull();
  });

  it('returns an empty string (not null) when there is nothing to push', async () => {
    const exec = execFrom((args) => {
      if (args[0] === 'symbolic-ref') return okRes('main');
      if (args[0] === 'rev-parse' && args.includes('origin/main')) return okRes('origin/main');
      if (args[0] === 'log') return okRes('');
      return failRes();
    });
    expect(await computePushedDiff(exec)).toBe('');
  });
});
