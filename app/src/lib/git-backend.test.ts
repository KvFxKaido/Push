import { describe, expect, it, vi } from 'vitest';
import { createSandboxGitBackend } from './git-backend';
import type { ExecResult } from './sandbox-client';

const okResult = (stdout: string): ExecResult =>
  ({ stdout, stderr: '', exitCode: 0, truncated: false }) as ExecResult;

describe('createSandboxGitBackend', () => {
  it('shell-escapes each argv token into the git command', async () => {
    const execFn = vi.fn(async () => okResult('## main\n'));
    const backend = createSandboxGitBackend('sb-1', execFn);

    await backend.status();

    expect(execFn).toHaveBeenCalledWith('sb-1', "git 'status' '--porcelain' '-b'");
  });

  it('resolves reads to null when the executor throws (transport error)', async () => {
    const execFn = vi.fn(async () => {
      throw new Error('network down');
    });
    const backend = createSandboxGitBackend('sb-1', execFn);

    await expect(backend.currentBranch()).resolves.toBeNull();
    await expect(backend.status()).resolves.toBeNull();
    await expect(backend.headSha()).resolves.toBeNull();
  });
});
