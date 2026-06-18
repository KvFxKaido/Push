import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./sandbox-client', () => ({
  execInSandbox: vi.fn(),
}));

import { execInSandbox } from './sandbox-client';
import { backUpWorkingTree, autoBackRef } from './sandbox-auto-back';

const SHA = 'abcdef1234567890abcdef1234567890abcdef12';
const silent = { log: () => {} };

type ExecReply = { stdout?: string; stderr?: string; exitCode?: number; error?: string };

// Dispatch the mocked sandbox exec by command content. The three commands the
// primitive issues are distinguishable: capture has `commit-tree`, the
// secret-scan diff has `git diff`, the push has `origin` (the backend shell-
// escapes each argv token, so the literal `git push` substring isn't present).
function dispatch(handler: (command: string) => ExecReply) {
  vi.mocked(execInSandbox).mockImplementation(async (_id, command) => {
    const r = handler(String(command ?? ''));
    return {
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
      exitCode: r.exitCode ?? 0,
      truncated: false,
      error: r.error,
    };
  });
}

function pushCalls() {
  return vi.mocked(execInSandbox).mock.calls.filter(([, c]) => String(c).includes('origin'));
}

describe('backUpWorkingTree', () => {
  beforeEach(() => vi.mocked(execInSandbox).mockReset());

  it('builds a stable per-branch backup ref', () => {
    expect(autoBackRef('feature/x')).toBe('draft/auto/feature/x');
  });

  it('skips when there is no sandbox or no branch (no exec)', async () => {
    expect((await backUpWorkingTree(null, 'main', silent)).status).toBe('skipped');
    expect((await backUpWorkingTree('sb-1', '  ', silent)).status).toBe('skipped');
    expect(execInSandbox).not.toHaveBeenCalled();
  });

  it('is a no-op when the working tree is clean (no push)', async () => {
    dispatch((cmd) => (cmd.includes('commit-tree') ? { stdout: 'CLEAN' } : {}));
    const result = await backUpWorkingTree('sb-1', 'feature/x', silent);
    expect(result).toEqual({ status: 'clean' });
    expect(pushCalls()).toHaveLength(0);
  });

  it('captures + force-pushes the backup commit to the per-branch ref', async () => {
    dispatch((cmd) => {
      if (cmd.includes('commit-tree')) return { stdout: `COMMIT ${SHA}` };
      if (cmd.includes('git diff')) return { stdout: 'diff --git a/x b/x\n+ a clean line\n' };
      if (cmd.includes('origin')) return { stdout: '' };
      return {};
    });
    const result = await backUpWorkingTree('sb-1', 'feature/x', silent);
    expect(result).toEqual({ status: 'backed-up', ref: 'draft/auto/feature/x', sha: SHA });
    // Force refspec to the stable ref.
    expect(String(pushCalls()[0]?.[1])).toContain(`+${SHA}:refs/heads/draft/auto/feature/x`);
  });

  it('blocks (does not push) when the backup content contains a secret', async () => {
    dispatch((cmd) => {
      if (cmd.includes('commit-tree')) return { stdout: `COMMIT ${SHA}` };
      // Untracked .env with an AWS key — the scan must catch it before the push.
      if (cmd.includes('git diff'))
        return { stdout: 'diff --git a/.env b/.env\n+AWS_KEY=AKIAIOSFODNN7EXAMPLE\n' };
      return {};
    });
    const result = await backUpWorkingTree('sb-1', 'feature/x', silent);
    expect(result.status).toBe('blocked');
    expect(pushCalls()).toHaveLength(0);
  });

  it('returns a typed failure when capture produces no commit', async () => {
    dispatch((cmd) => (cmd.includes('commit-tree') ? { stdout: 'ERR write-tree' } : {}));
    const result = await backUpWorkingTree('sb-1', 'feature/x', silent);
    expect(result.status).toBe('failed');
    expect(pushCalls()).toHaveLength(0);
  });

  it('returns a typed failure when the push itself fails', async () => {
    dispatch((cmd) => {
      if (cmd.includes('commit-tree')) return { stdout: `COMMIT ${SHA}` };
      if (cmd.includes('git diff')) return { stdout: '' };
      if (cmd.includes('origin')) return { stdout: '', stderr: 'remote rejected', exitCode: 1 };
      return {};
    });
    const result = await backUpWorkingTree('sb-1', 'feature/x', silent);
    expect(result.status).toBe('failed');
  });
});
