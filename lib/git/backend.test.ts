import { describe, expect, it, vi } from 'vitest';
import { SandboxPlumbingBackend, type GitExec, type GitExecResult } from './backend.ts';
import { gitWorkingCopyLockScope } from './repo-lock.ts';

const tick = () => new Promise((r) => setTimeout(r, 0));

const ok = (stdout: string): GitExecResult => ({ stdout, stderr: '', exitCode: 0 });
const fail = (stderr = 'fatal: not a git repository'): GitExecResult => ({
  stdout: '',
  stderr,
  exitCode: 128,
});

/** A GitExec that maps `git <args.join(' ')>` to a canned result. */
function fakeExec(table: Record<string, GitExecResult>): GitExec {
  return vi.fn(async (args: string[]) => {
    const key = args.join(' ');
    if (!(key in table)) throw new Error(`unexpected git args: ${key}`);
    return table[key];
  });
}

describe('SandboxPlumbingBackend.currentBranch', () => {
  it('returns the branch name', async () => {
    const backend = new SandboxPlumbingBackend(
      fakeExec({ 'branch --show-current': ok('feature/x\n') }),
    );
    expect(await backend.currentBranch()).toBe('feature/x');
  });

  it('returns the branch name on an unborn branch (no commits yet)', async () => {
    // `git branch --show-current` reports the name even before the first
    // commit, where `rev-parse --abbrev-ref HEAD` would have failed.
    const backend = new SandboxPlumbingBackend(fakeExec({ 'branch --show-current': ok('main\n') }));
    expect(await backend.currentBranch()).toBe('main');
  });

  it('normalizes detached HEAD (empty output) to null', async () => {
    const backend = new SandboxPlumbingBackend(fakeExec({ 'branch --show-current': ok('\n') }));
    expect(await backend.currentBranch()).toBeNull();
  });

  it('returns null on git failure', async () => {
    const backend = new SandboxPlumbingBackend(fakeExec({ 'branch --show-current': fail() }));
    expect(await backend.currentBranch()).toBeNull();
  });
});

describe('SandboxPlumbingBackend.headSha', () => {
  it('returns the full sha by default', async () => {
    const backend = new SandboxPlumbingBackend(
      fakeExec({ 'rev-parse HEAD': ok('0123456789abcdef0123456789abcdef01234567\n') }),
    );
    expect(await backend.headSha()).toBe('0123456789abcdef0123456789abcdef01234567');
  });

  it('returns the short sha when requested', async () => {
    const backend = new SandboxPlumbingBackend(
      fakeExec({ 'rev-parse --short HEAD': ok('0123456\n') }),
    );
    expect(await backend.headSha({ short: true })).toBe('0123456');
  });

  it('returns null on failure', async () => {
    const backend = new SandboxPlumbingBackend(fakeExec({ 'rev-parse HEAD': fail() }));
    expect(await backend.headSha()).toBeNull();
  });
});

describe('SandboxPlumbingBackend.upstreamRef', () => {
  it('returns the upstream ref for the current branch', async () => {
    const backend = new SandboxPlumbingBackend(
      fakeExec({
        'rev-parse --abbrev-ref --symbolic-full-name @{u}': ok('origin/feature/x\n'),
      }),
    );
    expect(await backend.upstreamRef()).toBe('origin/feature/x');
  });

  it('returns null when no upstream is configured', async () => {
    const backend = new SandboxPlumbingBackend(
      fakeExec({ 'rev-parse --abbrev-ref --symbolic-full-name @{u}': fail('no upstream') }),
    );
    expect(await backend.upstreamRef()).toBeNull();
  });
});

describe('SandboxPlumbingBackend.remoteUrl', () => {
  it('returns origin url by default', async () => {
    const backend = new SandboxPlumbingBackend(
      fakeExec({ 'remote get-url origin': ok('https://github.com/owner/repo.git\n') }),
    );
    expect(await backend.remoteUrl()).toBe('https://github.com/owner/repo.git');
  });

  it('resolves a named remote', async () => {
    const backend = new SandboxPlumbingBackend(
      fakeExec({ 'remote get-url upstream': ok('git@github.com:other/repo.git\n') }),
    );
    expect(await backend.remoteUrl('upstream')).toBe('git@github.com:other/repo.git');
  });

  it('returns the push URL when requested', async () => {
    const backend = new SandboxPlumbingBackend(
      fakeExec({
        'remote get-url --push origin': ok('https://github.com/push-destination/repo.git\n'),
      }),
    );
    expect(await backend.remoteUrl('origin', { push: true })).toBe(
      'https://github.com/push-destination/repo.git',
    );
  });

  it('returns null when the remote is unset / unreadable', async () => {
    const backend = new SandboxPlumbingBackend(
      fakeExec({ 'remote get-url origin': fail('No such remote') }),
    );
    expect(await backend.remoteUrl()).toBeNull();
  });
});

describe('SandboxPlumbingBackend.status', () => {
  it('parses porcelain -b into typed status', async () => {
    const backend = new SandboxPlumbingBackend(
      fakeExec({ 'status --porcelain -b': ok('## main...origin/main [ahead 1]\n M file.ts\n') }),
    );
    const status = await backend.status();
    expect(status?.branch).toBe('main');
    expect(status?.ahead).toBe(1);
    expect(status?.unstaged).toBe(1);
    expect(status?.entries).toHaveLength(1);
  });

  it('returns null on failure', async () => {
    const backend = new SandboxPlumbingBackend(fakeExec({ 'status --porcelain -b': fail() }));
    expect(await backend.status()).toBeNull();
  });
});

describe('SandboxPlumbingBackend writes', () => {
  it('createBranch runs an atomic checkout -b (mutating), optionally from a ref', async () => {
    const exec = vi.fn(async () => ok(''));
    const backend = new SandboxPlumbingBackend(exec);
    await backend.createBranch('feat/x');
    expect(exec).toHaveBeenCalledWith(['checkout', '-b', 'feat/x'], { mutates: true });
    await backend.createBranch('feat/x', 'main');
    expect(exec).toHaveBeenLastCalledWith(['checkout', '-b', 'feat/x', 'main'], { mutates: true });
  });

  it('switchBranch falls back to refspec widening + depth-1 fetch, then retries the switch', async () => {
    // Single-branch clone shape: remote.origin.fetch covers only main, so the
    // fallback must widen it before fetching — a fetched remote-tracking ref
    // outside the refspec is invisible to `git switch`'s create-from-remote
    // guess ("fatal: invalid reference").
    const exec = vi
      .fn()
      .mockResolvedValueOnce(fail('invalid reference')) // first switch
      .mockResolvedValueOnce(ok('+refs/heads/main:refs/remotes/origin/main\n')) // config --get-all
      .mockResolvedValueOnce(ok('')) // config --add (widen)
      .mockResolvedValueOnce(ok('')) // fetch
      .mockResolvedValueOnce(ok("Switched to branch 'x'")); // retry switch
    const backend = new SandboxPlumbingBackend(exec as unknown as GitExec);
    const res = await backend.switchBranch('x');
    expect(res.ok).toBe(true);
    expect(exec).toHaveBeenNthCalledWith(1, ['switch', 'x'], { mutates: true });
    expect(exec).toHaveBeenNthCalledWith(2, ['config', '--get-all', 'remote.origin.fetch']);
    expect(exec).toHaveBeenNthCalledWith(
      3,
      ['config', '--add', 'remote.origin.fetch', '+refs/heads/x:refs/remotes/origin/x'],
      { mutates: true },
    );
    expect(exec).toHaveBeenNthCalledWith(
      4,
      ['fetch', '--depth=1', 'origin', 'x:refs/remotes/origin/x'],
      { mutates: true },
    );
    expect(exec).toHaveBeenNthCalledWith(5, ['switch', 'x'], { mutates: true });
  });

  it('switchBranch skips widening when the refspec already covers all heads', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce(fail('invalid reference')) // first switch
      .mockResolvedValueOnce(ok('+refs/heads/*:refs/remotes/origin/*\n')) // config --get-all
      .mockResolvedValueOnce(ok('')) // fetch
      .mockResolvedValueOnce(ok("Switched to branch 'x'")); // retry switch
    const backend = new SandboxPlumbingBackend(exec as unknown as GitExec);
    const res = await backend.switchBranch('x');
    expect(res.ok).toBe(true);
    const calls = (exec.mock.calls as unknown as [string[]][]).map(([args]) => args.join(' '));
    expect(calls).not.toContain(
      'config --add remote.origin.fetch +refs/heads/x:refs/remotes/origin/x',
    );
    expect(calls).toContain('fetch --depth=1 origin x:refs/remotes/origin/x');
  });

  it('switchBranch skips widening when the branch-specific refspec is already present', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce(fail('invalid reference')) // first switch
      .mockResolvedValueOnce(
        ok('+refs/heads/main:refs/remotes/origin/main\n+refs/heads/x:refs/remotes/origin/x\n'),
      ) // config --get-all
      .mockResolvedValueOnce(ok('')) // fetch
      .mockResolvedValueOnce(ok("Switched to branch 'x'")); // retry switch
    const backend = new SandboxPlumbingBackend(exec as unknown as GitExec);
    const res = await backend.switchBranch('x');
    expect(res.ok).toBe(true);
    expect(exec).toHaveBeenCalledTimes(4);
  });

  it('switchBranch skips widening when the remote has no fetch refspec at all', async () => {
    // No `origin` configured: adding a refspec would manufacture config for a
    // remote that doesn't exist. The fallback fetch surfaces the real error.
    const exec = vi
      .fn()
      .mockResolvedValueOnce(fail('invalid reference')) // first switch
      .mockResolvedValueOnce(fail('')) // config --get-all (no such key)
      .mockResolvedValueOnce(fail("fatal: 'origin' does not appear to be a git repository")); // fetch
    const backend = new SandboxPlumbingBackend(exec as unknown as GitExec);
    const res = await backend.switchBranch('x');
    expect(res.ok).toBe(false);
    expect(res.stderr).toContain('origin');
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it('switchBranch surfaces the fetch failure when the fallback fetch fails', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce(fail('no local ref'))
      .mockResolvedValueOnce(fail('')) // config --get-all
      .mockResolvedValueOnce(fail('fetch failed'));
    const backend = new SandboxPlumbingBackend(exec as unknown as GitExec);
    const res = await backend.switchBranch('x');
    expect(res.ok).toBe(false);
    expect(res.stderr).toContain('fetch failed');
  });

  it('commit stages then commits; honors custom addArgs', async () => {
    const exec = vi.fn(async () => ok('committed'));
    const backend = new SandboxPlumbingBackend(exec);
    await backend.commit('msg');
    expect(exec).toHaveBeenNthCalledWith(1, ['add', '-A'], { mutates: true });
    expect(exec).toHaveBeenNthCalledWith(2, ['commit', '-m', 'msg'], { mutates: true });
    exec.mockClear();
    await backend.commit('m2', { addArgs: ['-A', '--', '.', ':!.push'] });
    expect(exec).toHaveBeenNthCalledWith(1, ['add', '-A', '--', '.', ':!.push'], { mutates: true });
  });

  it('commit returns the staging failure without committing', async () => {
    const exec = vi.fn().mockResolvedValueOnce(fail('add failed'));
    const backend = new SandboxPlumbingBackend(exec as unknown as GitExec);
    const res = await backend.commit('msg');
    expect(res.ok).toBe(false);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('push defaults to origin HEAD and supports setUpstream', async () => {
    const exec = vi.fn(async () => ok(''));
    const backend = new SandboxPlumbingBackend(exec);
    await backend.push();
    expect(exec).toHaveBeenCalledWith(['push', 'origin', 'HEAD'], { mutates: true });
    await backend.push({ setUpstream: true, ref: 'feat/x' });
    expect(exec).toHaveBeenLastCalledWith(['push', '-u', 'origin', 'feat/x'], { mutates: true });
  });
});

describe('SandboxPlumbingBackend write serialization', () => {
  /**
   * An exec that records the joined args of every call in order and blocks the
   * very first call on a gate, so we can hold one write open and observe
   * whether a second write's git ops start before the first releases.
   */
  function gatedExec() {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const exec = vi.fn(async (args: string[]) => {
      order.push(args.join(' '));
      if (calls++ === 0) await firstGate;
      return ok('');
    });
    return { exec: exec as unknown as GitExec, order, releaseFirst };
  }

  it('serializes concurrent writes under a lockScope — the commit add+commit is indivisible', async () => {
    const { exec, order, releaseFirst } = gatedExec();
    const backend = new SandboxPlumbingBackend(exec, {
      lockScope: gitWorkingCopyLockScope('wc-serialized'),
    });

    const a = backend.commit('A');
    const b = backend.commit('B');
    await tick();
    // commit A holds the lock, blocked on its own `add`. commit B must not have
    // touched git yet — no interleaving between A's stage and A's commit.
    expect(order).toEqual(['add -A']);

    releaseFirst();
    await Promise.all([a, b]);
    // Strict A-then-B ordering: A fully completes before B begins.
    expect(order).toEqual(['add -A', 'commit -m A', 'add -A', 'commit -m B']);
  });

  it('does not serialize without a lockScope — writes interleave as before', async () => {
    const { exec, order, releaseFirst } = gatedExec();
    const backend = new SandboxPlumbingBackend(exec);

    const a = backend.commit('A');
    const b = backend.commit('B');
    await tick();
    // With no lock, commit B runs to completion (add + commit) while commit A
    // is still blocked on its own `add` — B's whole operation slips between A's
    // stage and A's commit. That interleaving is the race the lock prevents.
    expect(order).toEqual(['add -A', 'add -A', 'commit -m B']);

    releaseFirst();
    await Promise.all([a, b]);
    // Full sequence: A's commit lands last, after B already finished — the
    // mirror image of the serialized test's grouped A-then-B ordering.
    expect(order).toEqual(['add -A', 'add -A', 'commit -m B', 'commit -m A']);
  });

  it('runs writes on different working copies concurrently', async () => {
    const { exec, order, releaseFirst } = gatedExec();
    const backendA = new SandboxPlumbingBackend(exec, {
      lockScope: gitWorkingCopyLockScope('wc-a'),
    });
    const backendB = new SandboxPlumbingBackend(exec, {
      lockScope: gitWorkingCopyLockScope('wc-b'),
    });

    const a = backendA.commit('A');
    const b = backendB.commit('B');
    await tick();
    // Distinct working copies don't share a lane, so B proceeds while A is held.
    expect(order.filter((o) => o === 'add -A')).toHaveLength(2);

    releaseFirst();
    await Promise.all([a, b]);
  });

  it('runs an { alreadyLocked } write inline inside a held section (no self-deadlock)', async () => {
    const exec = vi.fn(async () => ok(''));
    const backend = new SandboxPlumbingBackend(exec, {
      lockScope: gitWorkingCopyLockScope('wc-already-locked'),
    });
    // Hold the lock and run a commit that's told it's already locked. The lock
    // is non-reentrant, so without the flag this nested acquire would deadlock;
    // completing proves the flag bypasses re-acquisition.
    const result = await backend.runExclusive(() =>
      backend.commit('inside', undefined, { alreadyLocked: true }),
    );
    expect(result.ok).toBe(true);
    expect(exec).toHaveBeenNthCalledWith(1, ['add', '-A'], { mutates: true });
    expect(exec).toHaveBeenNthCalledWith(2, ['commit', '-m', 'inside'], { mutates: true });
  });
});
