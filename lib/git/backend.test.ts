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
