import { describe, expect, it, vi } from 'vitest';
import { PushGit, composePrePushGates } from './push-git.ts';
import type { GitBackend, GitWriteResult } from './backend.ts';

const writeOk = (stdout = ''): GitWriteResult => ({ ok: true, stdout, stderr: '', exitCode: 0 });
const writeFail = (stderr = 'boom'): GitWriteResult => ({
  ok: false,
  stdout: '',
  stderr,
  exitCode: 1,
});

function fakeBackend(overrides: Partial<GitBackend> = {}): GitBackend {
  return {
    // Default: run the task directly (an unscoped backend's behavior). Tests
    // that assert gate+write atomicity override this with a recording wrapper.
    runExclusive: async (task) => task(),
    currentBranch: async () => 'main',
    upstreamRef: async () => 'origin/main',
    remoteUrl: async () => 'https://github.com/owner/repo.git',
    headSha: async () => 'abc1234',
    status: async () => null,
    createBranch: async () => writeOk(),
    switchBranch: async () => writeOk(),
    commit: async () => writeOk('committed'),
    push: async () => writeOk(),
    ...overrides,
  };
}

describe('PushGit.commit', () => {
  it('commits directly when no gate is injected', async () => {
    const commit = vi.fn(async () => writeOk('done'));
    const pg = new PushGit({ backend: fakeBackend({ commit }) });
    const res = await pg.commit({ message: 'msg' });
    expect(res).toEqual({ ok: true, blocked: false, result: writeOk('done') });
    expect(commit).toHaveBeenCalledWith('msg', { addArgs: undefined }, { alreadyLocked: true });
  });

  it('runs the gate then commits when it passes', async () => {
    const preCommit = vi.fn(async () => ({ ok: true }));
    const commit = vi.fn(async () => writeOk());
    const pg = new PushGit({ backend: fakeBackend({ commit }), preCommit });
    const res = await pg.commit({ message: 'm' });
    expect(preCommit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
    expect(res.ok).toBe(true);
  });

  it('blocks without committing when the gate denies', async () => {
    const preCommit = vi.fn(async () => ({ ok: false, reason: 'UNSAFE' }));
    const commit = vi.fn(async () => writeOk());
    const pg = new PushGit({ backend: fakeBackend({ commit }), preCommit });
    const res = await pg.commit({ message: 'm' });
    expect(res).toEqual({ ok: false, blocked: true, reason: 'UNSAFE' });
    expect(commit).not.toHaveBeenCalled();
  });

  it('fail-safe blocks (no commit) when the gate throws', async () => {
    const preCommit = vi.fn(async () => {
      throw new Error('auditor crashed');
    });
    const commit = vi.fn(async () => writeOk());
    const pg = new PushGit({ backend: fakeBackend({ commit }), preCommit });
    const res = await pg.commit({ message: 'm' });
    expect(res.ok).toBe(false);
    expect(res.blocked).toBe(true);
    expect(res.reason).toContain('auditor crashed');
    expect(commit).not.toHaveBeenCalled();
  });

  it('reports a failed commit (gate passed, git failed)', async () => {
    const pg = new PushGit({
      backend: fakeBackend({ commit: async () => writeFail('nothing to commit') }),
    });
    const res = await pg.commit({ message: 'm' });
    expect(res.ok).toBe(false);
    expect(res.blocked).toBe(false);
    expect(res.result?.stderr).toContain('nothing to commit');
  });

  it('forwards addArgs to the backend', async () => {
    const commit = vi.fn(async () => writeOk());
    const pg = new PushGit({ backend: fakeBackend({ commit }) });
    await pg.commit({ message: 'm', addArgs: ['-A', '--', '.', ':!.push'] });
    expect(commit).toHaveBeenCalledWith(
      'm',
      { addArgs: ['-A', '--', '.', ':!.push'] },
      { alreadyLocked: true },
    );
  });
});

describe('PushGit.validateActiveBranch', () => {
  it('reports inSync when the sandbox HEAD matches the expected branch', async () => {
    const pg = new PushGit({ backend: fakeBackend({ currentBranch: async () => 'feat/x' }) });
    expect(await pg.validateActiveBranch('feat/x')).toEqual({
      inSync: true,
      expected: 'feat/x',
      actual: 'feat/x',
    });
  });

  it('reports a mismatch (does not enforce) when HEAD has drifted', async () => {
    const pg = new PushGit({ backend: fakeBackend({ currentBranch: async () => 'other' }) });
    expect(await pg.validateActiveBranch('feat/x')).toEqual({
      inSync: false,
      expected: 'feat/x',
      actual: 'other',
    });
  });

  it('normalizes whitespace on the expected branch before comparing', async () => {
    const pg = new PushGit({ backend: fakeBackend({ currentBranch: async () => 'feat/x' }) });
    const res = await pg.validateActiveBranch('  feat/x\n');
    expect(res.inSync).toBe(true);
    expect(res.expected).toBe('feat/x');
  });

  it('treats a detached / unreadable HEAD (null) as out of sync', async () => {
    const pg = new PushGit({ backend: fakeBackend({ currentBranch: async () => null }) });
    const res = await pg.validateActiveBranch('feat/x');
    expect(res.inSync).toBe(false);
    expect(res.actual).toBeNull();
  });
});

describe('PushGit write delegation', () => {
  it('delegates branch + push writes to the backend', async () => {
    const createBranch = vi.fn(async () => writeOk());
    const switchBranch = vi.fn(async () => writeOk());
    const push = vi.fn(async () => writeOk());
    const pg = new PushGit({ backend: fakeBackend({ createBranch, switchBranch, push }) });
    await pg.createBranch('feat/x', 'main');
    await pg.switchBranch('feat/x');
    await pg.push({ setUpstream: true, ref: 'feat/x' });
    expect(createBranch).toHaveBeenCalledWith('feat/x', 'main');
    expect(switchBranch).toHaveBeenCalledWith('feat/x');
    expect(push).toHaveBeenCalledWith(
      { setUpstream: true, ref: 'feat/x' },
      { alreadyLocked: true },
    );
  });
});

describe('PushGit.push gate', () => {
  it('pushes directly when no gate is injected', async () => {
    const push = vi.fn(async () => writeOk());
    const pg = new PushGit({ backend: fakeBackend({ push }) });
    const res = await pg.push();
    expect(res.ok).toBe(true);
    expect(push).toHaveBeenCalledOnce();
  });

  it('runs the gate then pushes when it passes, forwarding the push opts', async () => {
    const prePush = vi.fn(async () => ({ ok: true }));
    const push = vi.fn(async () => writeOk());
    const pg = new PushGit({ backend: fakeBackend({ push }), prePush });
    const res = await pg.push({ setUpstream: true, ref: 'feat/x' });
    expect(prePush).toHaveBeenCalledOnce();
    // The gate must see the push opts so it can inspect the real destination.
    expect(prePush).toHaveBeenCalledWith({ setUpstream: true, ref: 'feat/x' });
    expect(push).toHaveBeenCalledWith(
      { setUpstream: true, ref: 'feat/x' },
      { alreadyLocked: true },
    );
    expect(res.ok).toBe(true);
  });

  it('blocks without pushing when the gate denies', async () => {
    const prePush = vi.fn(async () => ({ ok: false, reason: 'secret found' }));
    const push = vi.fn(async () => writeOk());
    const pg = new PushGit({ backend: fakeBackend({ push }), prePush });
    const res = await pg.push();
    expect(res.ok).toBe(false);
    expect(res.blocked).toBe(true);
    expect(res.stderr).toBe('secret found');
    expect(push).not.toHaveBeenCalled();
  });

  it('fail-safe blocks (no push) when the gate throws', async () => {
    const prePush = vi.fn(async () => {
      throw new Error('gate crashed');
    });
    const push = vi.fn(async () => writeOk());
    const pg = new PushGit({ backend: fakeBackend({ push }), prePush });
    const res = await pg.push();
    expect(res.ok).toBe(false);
    expect(res.blocked).toBe(true);
    expect(res.stderr).toContain('gate crashed');
    expect(push).not.toHaveBeenCalled();
  });

  it('runs the gate and the push inside one runExclusive critical section', async () => {
    // Record the order of: entering the section, the gate, and the push. The
    // gate and push must both fall between section-enter and section-exit so a
    // concurrent executor can't move HEAD between the audit and the push.
    const order: string[] = [];
    const runExclusive = vi.fn(async (task: () => Promise<unknown>) => {
      order.push('enter');
      const result = await task();
      order.push('exit');
      return result;
    });
    const prePush = vi.fn(async () => {
      order.push('gate');
      return { ok: true };
    });
    const push = vi.fn(async () => {
      order.push('push');
      return writeOk();
    });
    const pg = new PushGit({ backend: fakeBackend({ runExclusive, push }), prePush });
    await pg.push();
    expect(order).toEqual(['enter', 'gate', 'push', 'exit']);
  });

  it('blocks inside the critical section without pushing when the gate denies', async () => {
    const order: string[] = [];
    const runExclusive = vi.fn(async (task: () => Promise<unknown>) => {
      order.push('enter');
      const result = await task();
      order.push('exit');
      return result;
    });
    const prePush = vi.fn(async () => ({ ok: false, reason: 'secret found' }));
    const push = vi.fn(async () => writeOk());
    const pg = new PushGit({ backend: fakeBackend({ runExclusive, push }), prePush });
    const res = await pg.push();
    expect(res.blocked).toBe(true);
    expect(push).not.toHaveBeenCalled();
    // The section still opened and closed cleanly around the denied gate.
    expect(order).toEqual(['enter', 'exit']);
  });
});

describe('composePrePushGates', () => {
  it('returns undefined when no gate is supplied', () => {
    expect(composePrePushGates([undefined, undefined])).toBeUndefined();
    expect(composePrePushGates([])).toBeUndefined();
  });

  it('unwraps the single active gate', async () => {
    const gate = vi.fn(async () => ({ ok: true }));
    expect(composePrePushGates([undefined, gate])).toBe(gate);
  });

  it('passes only when every gate passes, forwarding opts to each', async () => {
    const a = vi.fn(async () => ({ ok: true }));
    const b = vi.fn(async () => ({ ok: true }));
    const composed = composePrePushGates([a, b])!;
    expect(await composed({ ref: 'feat/x' })).toEqual({ ok: true });
    expect(a).toHaveBeenCalledWith({ ref: 'feat/x' });
    expect(b).toHaveBeenCalledWith({ ref: 'feat/x' });
  });

  it('short-circuits on the first denial, in order (safety-first)', async () => {
    const first = vi.fn(async () => ({ ok: false, reason: 'protect main' }));
    const second = vi.fn(async () => ({ ok: true }));
    const composed = composePrePushGates([first, second])!;
    const verdict = await composed();
    expect(verdict).toEqual({ ok: false, reason: 'protect main' });
    expect(first).toHaveBeenCalledOnce();
    // The later gate never runs once an earlier one denies.
    expect(second).not.toHaveBeenCalled();
  });

  it('propagates a throw to the caller (PushGit.push then fail-safe blocks)', async () => {
    const first = vi.fn(async () => {
      throw new Error('boom');
    });
    const second = vi.fn(async () => ({ ok: true }));
    const composed = composePrePushGates([first, second])!;
    await expect(composed()).rejects.toThrow('boom');
    expect(second).not.toHaveBeenCalled();
  });
});
