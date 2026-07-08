import { describe, expect, it, vi } from 'vitest';
import type { GitExec, GitExecResult } from './backend.ts';
import {
  computePushPlan,
  computePushPlanFromSource,
  type PushPlanSource,
  ZERO_OID,
} from './push-plan.ts';

const okRes = (stdout: string): GitExecResult => ({ stdout, stderr: '', exitCode: 0 });
const exitRes = (exitCode: number): GitExecResult => ({ stdout: '', stderr: '', exitCode });

/** Build a GitExec from an (args) -> result handler; quiet logs in tests. */
function execFrom(handler: (args: string[]) => GitExecResult): GitExec {
  return vi.fn(async (args: string[]) => handler(args));
}

const silent = () => {};

describe('computePushPlan', () => {
  it('classifies a missing remote branch as a create and leases ZERO_OID', async () => {
    const exec = execFrom((args) => {
      if (args[0] === 'symbolic-ref') return okRes('feature-x');
      if (args[0] === 'rev-parse') return okRes('localsha');
      if (args[0] === 'ls-remote') return okRes(''); // exit 0, empty → branch absent
      return exitRes(1);
    });
    const plan = await computePushPlan(exec, { log: silent });
    expect(plan.move.kind).toBe('create');
    expect(plan.requiresForce).toBe(false);
    expect(plan.leaseEstablished).toBe(true);
    expect(plan.leasedRemoteSha).toBe(ZERO_OID);
  });

  it('classifies an ancestor remote tip as a fast-forward and leases the tip', async () => {
    const exec = execFrom((args) => {
      if (args[0] === 'symbolic-ref') return okRes('feature-x');
      if (args[0] === 'rev-parse') return okRes('localsha');
      if (args[0] === 'ls-remote') return okRes('remotesha\trefs/heads/feature-x');
      if (args[0] === 'merge-base') return exitRes(0); // remote IS an ancestor
      if (args[0] === 'rev-list') return okRes('0\t3'); // behind 0, ahead 3
      return exitRes(1);
    });
    const plan = await computePushPlan(exec, { log: silent });
    expect(plan.move.kind).toBe('fast-forward');
    expect(plan.requiresForce).toBe(false);
    expect(plan.leasedRemoteSha).toBe('remotesha');
    expect(plan.move.ahead).toBe(3);
    expect(plan.move.behind).toBe(0);
  });

  it('uses an explicit push refspec destination for the remote lease', async () => {
    const exec = execFrom((args) => {
      if (args[0] === 'rev-parse') return okRes('localsha');
      if (args[0] === 'ls-remote') {
        expect(args).toEqual(['ls-remote', 'upstream', 'refs/heads/release']);
        return okRes('remotesha\trefs/heads/release');
      }
      if (args[0] === 'merge-base') {
        expect(args).toEqual(['merge-base', '--is-ancestor', 'remotesha', 'HEAD']);
        return exitRes(0);
      }
      if (args[0] === 'rev-list') return okRes('0\t2');
      return exitRes(1);
    });
    const plan = await computePushPlan(exec, {
      remote: 'upstream',
      ref: 'HEAD:refs/heads/release',
      log: silent,
    });
    expect(plan.move.branch).toBe('release');
    expect(plan.move.kind).toBe('fast-forward');
    expect(plan.leasedRemoteSha).toBe('remotesha');
    expect(plan.move.ahead).toBe(2);
  });

  it('classifies a diverged remote as a PROVEN force', async () => {
    const exec = execFrom((args) => {
      if (args[0] === 'symbolic-ref') return okRes('feature-x');
      if (args[0] === 'rev-parse') return okRes('localsha');
      if (args[0] === 'ls-remote') return okRes('remotesha\trefs/heads/feature-x');
      if (args[0] === 'merge-base') return exitRes(1); // NOT an ancestor → diverged
      if (args[0] === 'rev-list') return okRes('2\t4'); // behind 2, ahead 4
      return exitRes(1);
    });
    const plan = await computePushPlan(exec, { log: silent });
    expect(plan.move.kind).toBe('force');
    expect(plan.requiresForce).toBe(true);
    expect(plan.move.behind).toBe(2);
    expect(plan.move.ahead).toBe(4);
  });

  it('classifies an unchanged remote as skip', async () => {
    const exec = execFrom((args) => {
      if (args[0] === 'symbolic-ref') return okRes('feature-x');
      if (args[0] === 'rev-parse') return okRes('samesha');
      if (args[0] === 'ls-remote') return okRes('samesha\trefs/heads/feature-x');
      return exitRes(1);
    });
    const plan = await computePushPlan(exec, { log: silent });
    expect(plan.move.kind).toBe('skip');
    expect(plan.requiresForce).toBe(false);
    expect(plan.leasedRemoteSha).toBe('samesha');
  });

  it('does NOT force when ls-remote fails — unknown, lease unestablished', async () => {
    const exec = execFrom((args) => {
      if (args[0] === 'symbolic-ref') return okRes('feature-x');
      if (args[0] === 'rev-parse') return okRes('localsha');
      if (args[0] === 'ls-remote') return exitRes(128); // network/auth read failure
      return exitRes(1);
    });
    const plan = await computePushPlan(exec, { log: silent });
    expect(plan.move.kind).toBe('unknown');
    expect(plan.requiresForce).toBe(false);
    expect(plan.leaseEstablished).toBe(false);
    expect(plan.leasedRemoteSha).toBeNull();
  });

  it('stays unknown (not force) when the remote tip is not present locally', async () => {
    const exec = execFrom((args) => {
      if (args[0] === 'symbolic-ref') return okRes('feature-x');
      if (args[0] === 'rev-parse') return okRes('localsha');
      if (args[0] === 'ls-remote') return okRes('remotesha\trefs/heads/feature-x');
      if (args[0] === 'merge-base') return exitRes(128); // missing object locally
      return exitRes(1);
    });
    const plan = await computePushPlan(exec, { log: silent });
    expect(plan.move.kind).toBe('unknown');
    expect(plan.requiresForce).toBe(false);
    // Lease is still established (we read the live tip) even though we can't
    // classify ancestry locally.
    expect(plan.leaseEstablished).toBe(true);
    expect(plan.leasedRemoteSha).toBe('remotesha');
  });
});

// Sources without a native `--is-ancestor` (JGit) fall back to comparing the
// merge-base. That fallback must not report a proven force from an ambiguous
// null merge-base (unrelated histories vs. a transient bridge/JGit read error).
describe('computePushPlanFromSource — ancestry fallback (no isAncestor)', () => {
  function nativeLikeSource(overrides: Partial<PushPlanSource>): PushPlanSource {
    return {
      currentBranch: async () => 'feature-x',
      verifyRef: async (ref) => (ref === 'HEAD' ? 'localsha' : ref),
      mergeBase: async () => null,
      logPatch: async () => '',
      lsRemoteHead: async () => ({ ok: true, sha: 'remotesha' }),
      // no isAncestor / revListLeftRightCount — the native shape
      ...overrides,
    };
  }

  it('fast-forwards when the merge-base equals the remote tip', async () => {
    const source = nativeLikeSource({
      verifyRef: async (ref) => (ref === 'HEAD' ? 'localsha' : 'remotesha'),
      mergeBase: async () => 'remotesha', // remote tip is the base → ancestor
    });
    const plan = await computePushPlanFromSource(source, { log: silent });
    expect(plan.move.kind).toBe('fast-forward');
    expect(plan.requiresForce).toBe(false);
  });

  it('stays unknown (NOT force) when the merge-base read returns null', async () => {
    // Native `mergeBase` maps a thrown bridge/JGit error to null, and this
    // branch is only reached with the remote tip present locally, so an
    // ambiguous null must not be reported as a proven divergence.
    const source = nativeLikeSource({
      verifyRef: async (ref) => (ref === 'HEAD' ? 'localsha' : 'remotesha'),
      mergeBase: async () => null,
    });
    const plan = await computePushPlanFromSource(source, { log: silent });
    expect(plan.move.kind).toBe('unknown');
    expect(plan.requiresForce).toBe(false);
    // The live tip was still read, so the lease is pinnable.
    expect(plan.leaseEstablished).toBe(true);
    expect(plan.leasedRemoteSha).toBe('remotesha');
  });
});
