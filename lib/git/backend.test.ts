import { describe, expect, it, vi } from 'vitest';
import { SandboxPlumbingBackend, type GitExec, type GitExecResult } from './backend.ts';

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

  it('switchBranch falls back to a depth-1 fetch then retries the switch', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce(fail('invalid reference')) // first switch
      .mockResolvedValueOnce(ok('')) // fetch
      .mockResolvedValueOnce(ok("Switched to branch 'x'")); // retry switch
    const backend = new SandboxPlumbingBackend(exec as unknown as GitExec);
    const res = await backend.switchBranch('x');
    expect(res.ok).toBe(true);
    expect(exec).toHaveBeenNthCalledWith(1, ['switch', 'x'], { mutates: true });
    expect(exec).toHaveBeenNthCalledWith(
      2,
      ['fetch', '--depth=1', 'origin', 'x:refs/remotes/origin/x'],
      { mutates: true },
    );
    expect(exec).toHaveBeenNthCalledWith(3, ['switch', 'x'], { mutates: true });
  });

  it('switchBranch surfaces the fetch failure when the fallback fetch fails', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce(fail('no local ref'))
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
