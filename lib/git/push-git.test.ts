import { describe, expect, it, vi } from 'vitest';
import { PushGit } from './push-git.ts';
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
    currentBranch: async () => 'main',
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
    expect(commit).toHaveBeenCalledWith('msg', { addArgs: undefined });
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
    expect(commit).toHaveBeenCalledWith('m', { addArgs: ['-A', '--', '.', ':!.push'] });
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
    expect(push).toHaveBeenCalledWith({ setUpstream: true, ref: 'feat/x' });
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

  it('runs the gate then pushes when it passes', async () => {
    const prePush = vi.fn(async () => ({ ok: true }));
    const push = vi.fn(async () => writeOk());
    const pg = new PushGit({ backend: fakeBackend({ push }), prePush });
    const res = await pg.push({ setUpstream: true, ref: 'feat/x' });
    expect(prePush).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledWith({ setUpstream: true, ref: 'feat/x' });
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
});
