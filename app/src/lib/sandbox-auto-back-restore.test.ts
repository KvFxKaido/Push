import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./sandbox-client', () => ({
  execInSandbox: vi.fn(),
}));

import { execInSandbox } from './sandbox-client';
import { applyAutoBackRestore, detectAutoBackRestore } from './sandbox-auto-back-restore';

const SHA = 'abcdef1234567890abcdef1234567890abcdef12';
const SUMMARY = '3 files changed, 40 insertions(+), 2 deletions(-)';
const silent = { log: () => {} };

type ExecReply = { stdout?: string; stderr?: string; exitCode?: number; error?: string };

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

describe('detectAutoBackRestore', () => {
  beforeEach(() => vi.mocked(execInSandbox).mockReset());

  it('guards missing and invalid inputs before touching the sandbox', async () => {
    expect(await detectAutoBackRestore(null, 'feature/x', silent)).toEqual({
      available: false,
      reason: 'no_sandbox',
    });
    expect(await detectAutoBackRestore('sb-1', '  ', silent)).toEqual({
      available: false,
      reason: 'no_branch',
    });
    expect(await detectAutoBackRestore('sb-1', 'bad branch', silent)).toEqual({
      available: false,
      reason: 'invalid_branch',
    });
    expect(execInSandbox).not.toHaveBeenCalled();
  });

  it('reports unavailable when the backup ref is missing', async () => {
    dispatch((cmd) => (cmd.includes('git fetch --no-tags') ? { stdout: 'NONE\n' } : {}));
    expect(await detectAutoBackRestore('sb-1', 'feature/x', silent)).toEqual({
      available: false,
      reason: 'none',
    });
    expect(String(vi.mocked(execInSandbox).mock.calls[0]?.[1])).toContain(
      'git fetch --no-tags origin "draft/auto/feature/x"',
    );
  });

  it('reports unavailable when the backup tree matches HEAD', async () => {
    dispatch((cmd) => (cmd.includes('rev-parse') ? { stdout: 'NOCHANGES\n' } : {}));
    expect(await detectAutoBackRestore('sb-1', 'feature/x', silent)).toEqual({
      available: false,
      reason: 'nochanges',
    });
  });

  it('reports unavailable when the workspace probe fails', async () => {
    dispatch((cmd) => (cmd.includes('cd /workspace') ? { stdout: 'ERR\n' } : {}));
    expect(await detectAutoBackRestore('sb-1', 'feature/x', silent)).toEqual({
      available: false,
      reason: 'err',
    });
  });

  it('parses an available backup sha and shortstat summary', async () => {
    dispatch((cmd) =>
      cmd.includes('git diff --shortstat') ? { stdout: `BACKUP ${SHA}\n ${SUMMARY}\n` } : {},
    );
    expect(await detectAutoBackRestore('sb-1', 'feature/x', silent)).toEqual({
      available: true,
      sha: SHA,
      summary: SUMMARY,
    });
  });
});

describe('applyAutoBackRestore', () => {
  beforeEach(() => vi.mocked(execInSandbox).mockReset());

  it('guards missing and invalid inputs before touching the sandbox', async () => {
    expect(await applyAutoBackRestore(null, 'feature/x', silent)).toEqual({
      status: 'failed',
      reason: 'no_sandbox',
    });
    expect(await applyAutoBackRestore('sb-1', '  ', silent)).toEqual({
      status: 'failed',
      reason: 'no_branch',
    });
    expect(await applyAutoBackRestore('sb-1', 'bad branch', silent)).toEqual({
      status: 'failed',
      reason: 'invalid_branch',
    });
    expect(execInSandbox).not.toHaveBeenCalled();
  });

  it('returns skipped-dirty when the working tree is not clean', async () => {
    dispatch((cmd) => (cmd.includes('git status --porcelain') ? { stdout: 'DIRTY\n' } : {}));
    expect(await applyAutoBackRestore('sb-1', 'feature/x', silent)).toEqual({
      status: 'skipped-dirty',
    });
    const command = String(vi.mocked(execInSandbox).mock.calls[0]?.[1]);
    expect(command.indexOf('git status --porcelain')).toBeLessThan(
      command.indexOf('git read-tree -u --reset "$backup"'),
    );
  });

  it('parses a successful restore sha', async () => {
    dispatch((cmd) =>
      cmd.includes('git read-tree -u --reset') ? { stdout: `RESTORED ${SHA}\n` } : {},
    );
    expect(await applyAutoBackRestore('sb-1', 'feature/x', silent)).toEqual({
      status: 'restored',
      sha: SHA,
    });
    expect(String(vi.mocked(execInSandbox).mock.calls[0]?.[1])).toContain(
      'git reset --mixed -q HEAD',
    );
  });

  it('returns a typed failure when the backup ref cannot be fetched', async () => {
    dispatch((cmd) => (cmd.includes('git fetch --no-tags') ? { stdout: 'FETCH_FAILED\n' } : {}));
    expect(await applyAutoBackRestore('sb-1', 'feature/x', silent)).toEqual({
      status: 'failed',
      reason: 'FETCH_FAILED',
    });
  });

  it('returns a typed failure when restore fails', async () => {
    dispatch((cmd) => (cmd.includes('read-tree') ? { stdout: 'RESTORE_FAILED\n' } : {}));
    expect(await applyAutoBackRestore('sb-1', 'feature/x', silent)).toEqual({
      status: 'failed',
      reason: 'RESTORE_FAILED',
    });
  });
});
