import { describe, expect, it, vi } from 'vitest';
import { createSandboxGitBackend } from './git-backend';
import type { ExecResult } from './sandbox-client';

const okResult = (stdout: string): ExecResult =>
  ({ stdout, stderr: '', exitCode: 0, truncated: false }) as ExecResult;
type SandboxExecMock = (
  sandboxId: string,
  command: string,
  workdir?: string,
  options?: { markWorkspaceMutated?: boolean; suppressWorkspaceMutationSignal?: boolean },
) => Promise<ExecResult>;

describe('createSandboxGitBackend', () => {
  it('shell-escapes each argv token into the git command', async () => {
    const execFn = vi.fn(async () => okResult('## main\n'));
    const backend = createSandboxGitBackend('sb-1', execFn);

    await backend.status();

    // Reads pass no `mutates` hint, so the executor is called with the
    // (sandboxId, command, workdir=undefined, options=undefined) shape.
    expect(execFn).toHaveBeenCalledWith(
      'sb-1',
      "git 'status' '--porcelain' '-b'",
      undefined,
      undefined,
    );
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

  it('injects GitHub auth transiently for networked git operations only', async () => {
    const execFn = vi.fn<SandboxExecMock>(async () => okResult(''));
    const backend = createSandboxGitBackend('sb-1', execFn, {
      getGitHubToken: () => 'ghs_secret',
    });

    await backend.push();

    const pushCommand = String(execFn.mock.calls[0][1]);
    expect(pushCommand).toContain("'http.https://github.com/.extraheader=AUTHORIZATION: basic ");
    expect(pushCommand).toContain("'push' 'origin' 'HEAD'");
    expect(pushCommand).not.toContain('ghs_secret');

    execFn.mockClear();
    await backend.status();
    expect(execFn).toHaveBeenCalledWith(
      'sb-1',
      "git 'status' '--porcelain' '-b'",
      undefined,
      undefined,
    );
  });
});
