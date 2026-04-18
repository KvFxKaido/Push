/**
 * Tests for sandbox tool validation, detection, and execution in sandbox-tools.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mocks must be set up before importing the module under test ----

const { mockRecordWriteFileMetric, mockRecordReadFileMetric } = vi.hoisted(() => ({
  mockRecordWriteFileMetric: vi.fn(),
  mockRecordReadFileMetric: vi.fn(),
}));

// Mock sandbox-client so no real HTTP calls are made.
vi.mock('./sandbox-client', () => ({
  execInSandbox: vi.fn(),
  findReferencesInSandbox: vi.fn(),
  getSandboxEnvironment: vi.fn(),
  readFromSandbox: vi.fn(),
  writeToSandbox: vi.fn(),
  batchWriteToSandbox: vi.fn(),
  getSandboxDiff: vi.fn(),
  listDirectory: vi.fn(),
  downloadFromSandbox: vi.fn(),
}));

// Mock auditor-agent (needed by sandbox_prepare_commit).
vi.mock('./auditor-agent', () => ({
  runAuditor: vi.fn(),
}));

// Partial-mock sandbox-tool-utils: only createGitHubRepo is stubbed so the
// promote_to_github tests don't hit the real fetch. All other exports
// (shellEscape, sanitizeGitOutput, classifyError, formatStructuredError,
// normalizeSandboxPath, etc.) remain the real implementations the dispatcher
// relies on.
vi.mock('./sandbox-tool-utils', async () => {
  const actual =
    await vi.importActual<typeof import('./sandbox-tool-utils')>('./sandbox-tool-utils');
  return {
    ...actual,
    createGitHubRepo: vi.fn(),
  };
});

// Mock github-auth so promote_to_github tests can control token presence.
vi.mock('./github-auth', () => ({
  getActiveGitHubToken: vi.fn(),
}));

vi.mock('./edit-metrics', () => ({
  recordWriteFileMetric: (...args: unknown[]) => mockRecordWriteFileMetric(...args),
  recordReadFileMetric: (...args: unknown[]) => mockRecordReadFileMetric(...args),
}));

// Mock tool-dispatch for extractBareToolJsonObjects.
// We provide a real implementation since the detection tests rely on it.
vi.mock('./tool-dispatch', async () => {
  const actual = await vi.importActual<typeof import('./tool-dispatch')>('./tool-dispatch');
  return {
    extractBareToolJsonObjects: actual.extractBareToolJsonObjects,
  };
});

import { classifyError, validateSandboxToolCall, executeSandboxToolCall } from './sandbox-tools';
import * as sandboxClient from './sandbox-client';
import { runAuditor } from './auditor-agent';
import { createGitHubRepo } from './sandbox-tool-utils';
import { getActiveGitHubToken } from './github-auth';
import { fileLedger } from './file-awareness-ledger';
import { calculateLineHash } from './hashline';

// ---------------------------------------------------------------------------
// 1. Tool validation
// ---------------------------------------------------------------------------

describe('validateSandboxToolCall -- promote_to_github', () => {
  it('accepts required repo_name and defaults optional fields', () => {
    const result = validateSandboxToolCall({
      tool: 'promote_to_github',
      args: { repo_name: 'my-new-repo' },
    });
    expect(result).not.toBeNull();
    expect(result?.tool).toBe('promote_to_github');
    if (result?.tool === 'promote_to_github') {
      expect(result.args.repo_name).toBe('my-new-repo');
      expect(result.args.private).toBeUndefined();
    }
  });

  it('rejects empty repo_name', () => {
    const result = validateSandboxToolCall({
      tool: 'promote_to_github',
      args: { repo_name: '   ' },
    });
    expect(result).toBeNull();
  });
});

describe('validateSandboxToolCall -- sandbox_write_file', () => {
  it('accepts optional expected_version', () => {
    const result = validateSandboxToolCall({
      tool: 'sandbox_write_file',
      args: {
        path: '/workspace/src/example.ts',
        content: 'export const value = 1;',
        expected_version: 'abc123',
      },
    });

    expect(result).not.toBeNull();
    expect(result?.tool).toBe('sandbox_write_file');
    if (result?.tool === 'sandbox_write_file') {
      expect(result.args.expected_version).toBe('abc123');
    }
  });
});

describe('validateSandboxToolCall -- sandbox_edit_range', () => {
  it('accepts normalized range-edit arguments', () => {
    const result = validateSandboxToolCall({
      tool: 'sandbox_edit_range',
      args: {
        path: 'src/app.ts',
        start_line: 10,
        end_line: 12,
        content: 'const x = 1;',
      },
    });

    expect(result).not.toBeNull();
    expect(result?.tool).toBe('sandbox_edit_range');
    if (result?.tool === 'sandbox_edit_range') {
      expect(result.args.path).toBe('/workspace/src/app.ts');
      expect(result.args.start_line).toBe(10);
      expect(result.args.end_line).toBe(12);
      expect(result.args.content).toBe('const x = 1;');
    }
  });

  it('rejects invalid ranges', () => {
    const result = validateSandboxToolCall({
      tool: 'sandbox_edit_range',
      args: {
        path: '/workspace/src/app.ts',
        start_line: 20,
        end_line: 10,
        content: 'const x = 1;',
      },
    });

    expect(result).toBeNull();
  });
});

describe('validateSandboxToolCall -- sandbox_verify_workspace', () => {
  it('accepts empty args', () => {
    const result = validateSandboxToolCall({
      tool: 'sandbox_verify_workspace',
      args: {},
    });

    expect(result).not.toBeNull();
    expect(result?.tool).toBe('sandbox_verify_workspace');
    if (result?.tool === 'sandbox_verify_workspace') {
      expect(result.args).toEqual({});
    }
  });
});

describe('classifyError', () => {
  it('recognizes git guard failures', () => {
    expect(classifyError('git_guard_blocked: direct git push is blocked', 'sandbox_exec')).toEqual({
      type: 'GIT_GUARD_BLOCKED',
      retryable: false,
      message: 'git_guard_blocked: direct git push is blocked',
      detail: 'sandbox_exec',
    });
  });
});

describe('executeSandboxToolCall -- sandbox_verify_workspace', () => {
  beforeEach(() => {
    vi.mocked(sandboxClient.execInSandbox).mockReset();
    vi.mocked(sandboxClient.getSandboxEnvironment).mockReset();
  });

  it('installs missing dependencies, then runs typecheck and tests', async () => {
    vi.mocked(sandboxClient.getSandboxEnvironment).mockReturnValue({
      readiness: {
        package_manager: 'npm',
        dependencies: 'missing',
        typecheck_command: 'npm run typecheck',
        test_command: 'npm test',
      },
    } as never);

    vi.mocked(sandboxClient.execInSandbox)
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'installed', stderr: '', truncated: false })
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'typecheck ok', stderr: '', truncated: false })
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'tests ok', stderr: '', truncated: false });

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_verify_workspace', args: {} },
      'sb-123',
    );

    expect(sandboxClient.execInSandbox).toHaveBeenNthCalledWith(
      1,
      'sb-123',
      'cd /workspace && npm install',
      undefined,
      { markWorkspaceMutated: true },
    );
    expect(sandboxClient.execInSandbox).toHaveBeenNthCalledWith(
      2,
      'sb-123',
      'cd /workspace && npm run typecheck',
      undefined,
      { markWorkspaceMutated: false },
    );
    expect(sandboxClient.execInSandbox).toHaveBeenNthCalledWith(
      3,
      'sb-123',
      'cd /workspace && npm test',
      undefined,
      { markWorkspaceMutated: true },
    );
    expect(result.text).toContain('Workspace verification PASSED');
    expect(result.text).toContain('Install dependencies: npm install');
    expect(result.text).toContain('Typecheck: npm run typecheck');
    expect(result.text).toContain('Test: npm test');
  });

  it('stops on the first failing verification step', async () => {
    vi.mocked(sandboxClient.getSandboxEnvironment).mockReturnValue({
      readiness: {
        package_manager: 'npm',
        dependencies: 'installed',
        typecheck_command: 'npm run typecheck',
        test_command: 'npm test',
      },
    } as never);

    vi.mocked(sandboxClient.execInSandbox).mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'typecheck boom',
      truncated: false,
    });

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_verify_workspace', args: {} },
      'sb-123',
    );

    expect(sandboxClient.execInSandbox).toHaveBeenCalledTimes(1);
    expect(result.text).toContain('Workspace verification FAILED at typecheck');
    expect(result.text).toContain('Output from failed step (Typecheck):');
    expect(result.text).toContain('typecheck boom');
    expect(result.text).toContain('rerun test() or typecheck() directly');
  });
});

describe('executeSandboxToolCall -- stale write handling', () => {
  beforeEach(() => {
    mockRecordWriteFileMetric.mockReset();
    mockRecordReadFileMetric.mockReset();
    vi.mocked(sandboxClient.execInSandbox).mockReset();
    vi.mocked(sandboxClient.readFromSandbox).mockReset();
    vi.mocked(sandboxClient.writeToSandbox).mockReset();
    fileLedger.reset();
  });

  it('reuses cached file version from read when write omits expected_version', async () => {
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: 'export const x = 1;',
      truncated: false,
      version: 'v1',
    });
    vi.mocked(sandboxClient.writeToSandbox).mockResolvedValue({
      ok: false,
      code: 'STALE_FILE',
      error: 'Stale file version',
      expected_version: 'v1',
      current_version: 'v2',
    });

    await executeSandboxToolCall(
      { tool: 'sandbox_read_file', args: { path: '/workspace/src/example.ts' } },
      'sb-123',
    );

    const writeResult = await executeSandboxToolCall(
      {
        tool: 'sandbox_write_file',
        args: { path: '/workspace/src/example.ts', content: 'export const x = 2;' },
      },
      'sb-123',
    );

    expect(sandboxClient.writeToSandbox).toHaveBeenCalledWith(
      'sb-123',
      '/workspace/src/example.ts',
      'export const x = 2;',
      'v1',
    );
    expect(writeResult.text).toContain('Stale write rejected');
    expect(writeResult.text).toContain('Expected version: v1');
    expect(writeResult.text).toContain('Current version: v2');
    expect(fileLedger.getState('/workspace/src/example.ts')?.kind).toBe('stale');
    expect(mockRecordWriteFileMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'stale',
        errorCode: 'STALE_FILE',
        durationMs: expect.any(Number),
      }),
    );
  });

  it('invalidates cached workspace snapshots on workspace-level stale write rejection', async () => {
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: 'export const x = 1;',
      truncated: false,
      version: 'v1',
      workspace_revision: 4,
    });
    vi.mocked(sandboxClient.writeToSandbox).mockResolvedValue({
      ok: false,
      code: 'WORKSPACE_CHANGED',
      error: 'Workspace changed since last read.',
      expected_workspace_revision: 4,
      current_workspace_revision: 5,
    });

    await executeSandboxToolCall(
      { tool: 'sandbox_read_file', args: { path: '/workspace/src/example.ts' } },
      'sb-123',
    );

    const writeResult = await executeSandboxToolCall(
      {
        tool: 'sandbox_write_file',
        args: { path: '/workspace/src/example.ts', content: 'export const x = 2;' },
      },
      'sb-123',
    );

    expect(sandboxClient.writeToSandbox).toHaveBeenCalledWith(
      'sb-123',
      '/workspace/src/example.ts',
      'export const x = 2;',
      'v1',
      4,
    );
    expect(writeResult.text).toContain(
      'Workspace changed before /workspace/src/example.ts could be written.',
    );
    expect(writeResult.text).toContain('Expected workspace revision: 4');
    expect(writeResult.text).toContain('Current workspace revision: 5');
    expect(fileLedger.getState('/workspace/src/example.ts')?.kind).toBe('stale');
    expect(mockRecordWriteFileMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'stale',
        errorCode: 'WORKSPACE_CHANGED',
        durationMs: expect.any(Number),
      }),
    );
  });
});

describe('executeSandboxToolCall -- sandbox_prepare_commit auditor overrides', () => {
  beforeEach(() => {
    vi.mocked(sandboxClient.getSandboxDiff).mockReset();
    vi.mocked(sandboxClient.execInSandbox).mockReset();
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
      truncated: false,
    });
    vi.mocked(runAuditor).mockReset();
  });

  it('passes explicit provider/model overrides to the Auditor', async () => {
    vi.mocked(sandboxClient.getSandboxDiff).mockResolvedValue({
      diff: 'diff --git a/src/app.ts b/src/app.ts\n+console.log("hi");\n',
      truncated: false,
    });
    vi.mocked(runAuditor).mockResolvedValue({
      verdict: 'safe',
      card: {
        verdict: 'safe',
        summary: 'No issues found.',
        risks: [],
        filesReviewed: 1,
      },
    });

    await executeSandboxToolCall(
      { tool: 'sandbox_prepare_commit', args: { message: 'test commit' } },
      'sb-123',
      {
        auditorProviderOverride: 'vertex',
        auditorModelOverride: 'google/gemini-2.5-pro',
      },
    );

    expect(runAuditor).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Function),
      expect.objectContaining({
        source: 'sandbox-prepare-commit',
      }),
      expect.any(Object),
      expect.objectContaining({
        providerOverride: 'vertex',
        modelOverride: 'google/gemini-2.5-pro',
      }),
      expect.any(Array),
    );
  });

  it('blocks commit preparation when the pre-commit hook fails', async () => {
    vi.mocked(sandboxClient.getSandboxDiff).mockResolvedValue({
      diff: 'diff --git a/src/app.ts b/src/app.ts\n+console.log("hi");\n',
      truncated: false,
    });
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({
      stdout: 'lint failed',
      stderr: 'src/app.ts:1 error',
      exitCode: 1,
      truncated: false,
    });

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_prepare_commit', args: { message: 'test commit' } },
      'sb-123',
    );

    expect(runAuditor).not.toHaveBeenCalled();
    expect(result.text).toContain('Commit BLOCKED by pre-commit hook');
    expect(result.card?.type).toBe('audit-verdict');
    if (result.card?.type === 'audit-verdict') {
      expect(result.card.data.summary).toContain('Pre-commit hook failed');
    }
  });

  it('audits the post-hook diff when the pre-commit hook rewrites files', async () => {
    vi.mocked(sandboxClient.getSandboxDiff)
      .mockResolvedValueOnce({
        diff: 'diff --git a/src/app.ts b/src/app.ts\n-console.log("before");\n+console.log("during hook");\n',
        truncated: false,
      })
      .mockResolvedValueOnce({
        diff: 'diff --git a/src/app.ts b/src/app.ts\n-console.log("before");\n+console.log("after hook");\n',
        truncated: false,
      });
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({
      stdout: 'formatted files',
      stderr: '',
      exitCode: 0,
      truncated: false,
    });
    vi.mocked(runAuditor).mockResolvedValue({
      verdict: 'safe',
      card: {
        verdict: 'safe',
        summary: 'No issues found.',
        risks: [],
        filesReviewed: 1,
      },
    });

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_prepare_commit', args: { message: 'test commit' } },
      'sb-123',
    );

    expect(runAuditor).toHaveBeenCalledWith(
      'diff --git a/src/app.ts b/src/app.ts\n-console.log("before");\n+console.log("after hook");\n',
      expect.any(Function),
      expect.objectContaining({
        source: 'sandbox-prepare-commit',
      }),
      expect.objectContaining({
        exitCode: 0,
        output: 'formatted files',
      }),
      expect.any(Object),
      expect.any(Array),
    );
    expect(result.card?.type).toBe('commit-review');
    if (result.card?.type === 'commit-review') {
      expect(result.card.data.diff.diff).toContain('after hook');
      expect(result.card.data.diff.diff).not.toContain('during hook');
    }
  });
});

// ---------------------------------------------------------------------------
// Git/release family characterization — pin behavior for the four tools
// slated for Step 4 extraction (sandbox_diff, sandbox_prepare_commit,
// sandbox_push, promote_to_github). Tests pass at HEAD with no production
// code changes; they're the regression gate for the upcoming extraction.
// ---------------------------------------------------------------------------

describe('executeSandboxToolCall -- sandbox_diff', () => {
  beforeEach(() => {
    vi.mocked(sandboxClient.getSandboxDiff).mockReset();
  });

  it('returns a structured error when getSandboxDiff fails', async () => {
    vi.mocked(sandboxClient.getSandboxDiff).mockResolvedValue({
      error: 'sandbox unreachable',
    });

    const result = await executeSandboxToolCall({ tool: 'sandbox_diff', args: {} }, 'sb-1');

    expect(sandboxClient.getSandboxDiff).toHaveBeenCalledWith('sb-1');
    expect(result.text).toContain('[Tool Error — sandbox_diff]');
    expect(result.text).toContain('sandbox unreachable');
    expect(result.structuredError).toBeDefined();
  });

  it('returns a clean-tree message when there is no diff and no git_status', async () => {
    vi.mocked(sandboxClient.getSandboxDiff).mockResolvedValue({});

    const result = await executeSandboxToolCall({ tool: 'sandbox_diff', args: {} }, 'sb-1');

    expect(result.text).toContain('[Tool Result — sandbox_diff]');
    expect(result.text).toContain('No changes detected.');
    expect(result.text).toContain('The working tree is clean.');
    expect(result.card).toBeUndefined();
  });

  it('includes git status output when no diff but git_status is present', async () => {
    vi.mocked(sandboxClient.getSandboxDiff).mockResolvedValue({
      git_status: ' M src/app.ts',
    });

    const result = await executeSandboxToolCall({ tool: 'sandbox_diff', args: {} }, 'sb-1');

    expect(result.text).toContain('No changes detected.');
    expect(result.text).toContain('git status output:');
    expect(result.text).toContain(' M src/app.ts');
    expect(result.text).not.toContain('The working tree is clean.');
    expect(result.card).toBeUndefined();
  });

  it('returns a diff-preview card with parsed stats for a populated diff', async () => {
    const diff =
      'diff --git a/src/app.ts b/src/app.ts\n+console.log("hi");\n-console.log("bye");\n';
    vi.mocked(sandboxClient.getSandboxDiff).mockResolvedValue({ diff, truncated: false });

    const result = await executeSandboxToolCall({ tool: 'sandbox_diff', args: {} }, 'sb-1');

    expect(result.text).toContain('[Tool Result — sandbox_diff]');
    expect(result.text).toContain('1 file changed, +1 -1');
    expect(result.text).toContain(diff);
    expect(result.card?.type).toBe('diff-preview');
    if (result.card?.type === 'diff-preview') {
      expect(result.card.data).toEqual({
        diff,
        filesChanged: 1,
        additions: 1,
        deletions: 1,
        truncated: false,
      });
    }
  });
});

describe('executeSandboxToolCall -- sandbox_prepare_commit characterization', () => {
  beforeEach(() => {
    vi.mocked(sandboxClient.getSandboxDiff).mockReset();
    vi.mocked(sandboxClient.execInSandbox).mockReset();
    vi.mocked(runAuditor).mockReset();
  });

  it('returns a structured error when the initial getSandboxDiff fails', async () => {
    vi.mocked(sandboxClient.getSandboxDiff).mockResolvedValue({ error: 'diff failed' });

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_prepare_commit', args: { message: 'chore: x' } },
      'sb-1',
    );

    expect(result.text).toContain('[Tool Error — sandbox_prepare_commit]');
    expect(result.text).toContain('diff failed');
    expect(result.structuredError).toBeDefined();
    expect(sandboxClient.execInSandbox).not.toHaveBeenCalled();
    expect(runAuditor).not.toHaveBeenCalled();
  });

  it('returns a no-changes message when the initial diff is empty (with git_status)', async () => {
    vi.mocked(sandboxClient.getSandboxDiff).mockResolvedValue({
      git_status: ' M src/app.ts',
    });

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_prepare_commit', args: { message: 'chore: x' } },
      'sb-1',
    );

    expect(result.text).toContain('[Tool Result — sandbox_prepare_commit]');
    expect(result.text).toContain('No changes to commit.');
    expect(result.text).toContain('git status shows:  M src/app.ts');
    expect(sandboxClient.execInSandbox).not.toHaveBeenCalled();
    expect(runAuditor).not.toHaveBeenCalled();
  });

  it('returns a no-changes message with the clean-tree hint when there is no git_status', async () => {
    vi.mocked(sandboxClient.getSandboxDiff).mockResolvedValue({});

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_prepare_commit', args: { message: 'chore: x' } },
      'sb-1',
    );

    expect(result.text).toContain('No changes to commit.');
    expect(result.text).toContain('Working tree is clean.');
    expect(result.text).not.toContain('git status shows:');
    expect(runAuditor).not.toHaveBeenCalled();
  });

  it('returns a structured error when the post-hook getSandboxDiff fails', async () => {
    vi.mocked(sandboxClient.getSandboxDiff)
      .mockResolvedValueOnce({
        diff: 'diff --git a/src/app.ts b/src/app.ts\n+x\n',
        truncated: false,
      })
      .mockResolvedValueOnce({ error: 'post-hook diff failed' });
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
      truncated: false,
    });

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_prepare_commit', args: { message: 'chore: x' } },
      'sb-1',
    );

    expect(result.text).toContain('[Tool Error — sandbox_prepare_commit]');
    expect(result.text).toContain('post-hook diff failed');
    expect(result.structuredError).toBeDefined();
    expect(runAuditor).not.toHaveBeenCalled();
  });

  it('returns a post-hook no-changes message and surfaces hook output when the hook clears the diff', async () => {
    vi.mocked(sandboxClient.getSandboxDiff)
      .mockResolvedValueOnce({
        diff: 'diff --git a/src/app.ts b/src/app.ts\n+x\n',
        truncated: false,
      })
      .mockResolvedValueOnce({ git_status: '' });
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({
      stdout: 'formatter rewrote files',
      stderr: '',
      exitCode: 0,
      truncated: false,
    });

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_prepare_commit', args: { message: 'chore: x' } },
      'sb-1',
    );

    expect(result.text).toContain('No changes to commit after running the pre-commit hook.');
    expect(result.text).toContain('pre-commit output:');
    expect(result.text).toContain('formatter rewrote files');
    expect(runAuditor).not.toHaveBeenCalled();
  });

  it('returns an audit-verdict card when the Auditor verdict is unsafe', async () => {
    const diff = 'diff --git a/src/app.ts b/src/app.ts\n+danger\n';
    vi.mocked(sandboxClient.getSandboxDiff).mockResolvedValue({ diff, truncated: false });
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
      truncated: false,
    });
    vi.mocked(runAuditor).mockResolvedValue({
      verdict: 'unsafe',
      card: {
        verdict: 'unsafe',
        summary: 'Looks dangerous.',
        risks: [{ level: 'high', description: 'arbitrary exec' }],
        filesReviewed: 1,
      },
    });

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_prepare_commit', args: { message: 'chore: x' } },
      'sb-1',
    );

    expect(result.text).toContain('Commit BLOCKED by Auditor:');
    expect(result.text).toContain('Looks dangerous.');
    expect(result.card?.type).toBe('audit-verdict');
    if (result.card?.type === 'audit-verdict') {
      expect(result.card.data.verdict).toBe('unsafe');
    }
  });

  it('returns a commit-review card with pending status on the safe path', async () => {
    const diff = 'diff --git a/src/app.ts b/src/app.ts\n+ok\n';
    vi.mocked(sandboxClient.getSandboxDiff).mockResolvedValue({ diff, truncated: false });
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
      truncated: false,
    });
    vi.mocked(runAuditor).mockResolvedValue({
      verdict: 'safe',
      card: { verdict: 'safe', summary: 'No issues.', risks: [], filesReviewed: 1 },
    });

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_prepare_commit', args: { message: 'chore: add greeting' } },
      'sb-1',
    );

    expect(result.text).toContain('Ready for review: "chore: add greeting"');
    expect(result.text).toContain('1 file, +1 -0');
    expect(result.text).toContain('Waiting for user approval.');
    expect(result.card?.type).toBe('commit-review');
    if (result.card?.type === 'commit-review') {
      expect(result.card.data.status).toBe('pending');
      expect(result.card.data.commitMessage).toBe('chore: add greeting');
      expect(result.card.data.diff.diff).toBe(diff);
      expect(result.card.data.diff.filesChanged).toBe(1);
      expect(result.card.data.auditVerdict.verdict).toBe('safe');
    }
  });
});

describe('executeSandboxToolCall -- sandbox_push', () => {
  beforeEach(() => {
    vi.mocked(sandboxClient.execInSandbox).mockReset();
  });

  it('reports success and threads markWorkspaceMutated on the exec call', async () => {
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({
      stdout: 'Everything up-to-date',
      stderr: '',
      exitCode: 0,
      truncated: false,
    });

    const result = await executeSandboxToolCall({ tool: 'sandbox_push', args: {} }, 'sb-1');

    expect(sandboxClient.execInSandbox).toHaveBeenCalledTimes(1);
    expect(sandboxClient.execInSandbox).toHaveBeenCalledWith(
      'sb-1',
      'cd /workspace && git push origin HEAD',
      undefined,
      { markWorkspaceMutated: true },
    );
    expect(result.text).toBe('[Tool Result — sandbox_push]\nPushed successfully.');
    expect(result.card).toBeUndefined();
  });

  it('reports failure with stderr when the push exec fails', async () => {
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({
      stdout: '',
      stderr: 'fatal: permission denied',
      exitCode: 128,
      truncated: false,
    });

    const result = await executeSandboxToolCall({ tool: 'sandbox_push', args: {} }, 'sb-1');

    expect(result.text).toContain('[Tool Result — sandbox_push]');
    expect(result.text).toContain('Push failed: fatal: permission denied');
    expect(result.card).toBeUndefined();
  });
});

describe('executeSandboxToolCall -- promote_to_github', () => {
  beforeEach(() => {
    vi.mocked(sandboxClient.execInSandbox).mockReset();
    vi.mocked(createGitHubRepo).mockReset();
    vi.mocked(getActiveGitHubToken).mockReset();
  });

  const makeCreatedRepo = (overrides: Partial<Record<string, unknown>> = {}) => ({
    id: 42,
    name: 'my-repo',
    full_name: 'myuser/my-repo',
    private: true,
    default_branch: 'main',
    html_url: 'https://github.com/myuser/my-repo',
    owner: { login: 'myuser' },
    ...overrides,
  });

  it('rejects an empty repo_name after stripping an owner/ prefix', async () => {
    const result = await executeSandboxToolCall(
      { tool: 'promote_to_github', args: { repo_name: 'myuser/' } },
      'sb-1',
    );

    expect(result.text).toBe('[Tool Error] promote_to_github requires a valid repo_name.');
    expect(createGitHubRepo).not.toHaveBeenCalled();
    expect(sandboxClient.execInSandbox).not.toHaveBeenCalled();
  });

  it('strips an owner/ prefix and passes the trailing name plus private=true default to createGitHubRepo', async () => {
    vi.mocked(createGitHubRepo).mockResolvedValue(makeCreatedRepo());
    vi.mocked(getActiveGitHubToken).mockReturnValue('gho_token');
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({
      stdout: 'main',
      stderr: '',
      exitCode: 0,
      truncated: false,
    });

    await executeSandboxToolCall(
      {
        tool: 'promote_to_github',
        args: { repo_name: 'otheruser/my-repo', description: 'test' },
      },
      'sb-1',
    );

    expect(createGitHubRepo).toHaveBeenCalledWith('my-repo', 'test', true);
  });

  it('returns an auth-missing error when getActiveGitHubToken returns empty after repo creation', async () => {
    vi.mocked(createGitHubRepo).mockResolvedValue(makeCreatedRepo());
    vi.mocked(getActiveGitHubToken).mockReturnValue('');

    const result = await executeSandboxToolCall(
      { tool: 'promote_to_github', args: { repo_name: 'my-repo' } },
      'sb-1',
    );

    expect(result.text).toContain('[Tool Error]');
    expect(result.text).toContain('GitHub auth token missing after repo creation.');
    expect(sandboxClient.execInSandbox).not.toHaveBeenCalled();
  });

  it('reports a remote-config failure with the auth token sanitized out of the error text', async () => {
    vi.mocked(createGitHubRepo).mockResolvedValue(makeCreatedRepo());
    vi.mocked(getActiveGitHubToken).mockReturnValue('gho_secret');
    vi.mocked(sandboxClient.execInSandbox)
      .mockResolvedValueOnce({
        stdout: 'main',
        stderr: '',
        exitCode: 0,
        truncated: false,
      })
      .mockResolvedValueOnce({
        stdout: '',
        stderr: 'fatal: remote write failed with token gho_secret exposed',
        exitCode: 1,
        truncated: false,
      });

    const result = await executeSandboxToolCall(
      { tool: 'promote_to_github', args: { repo_name: 'my-repo' } },
      'sb-1',
    );

    expect(result.text).toContain('[Tool Error]');
    expect(result.text).toContain('Created repo myuser/my-repo');
    expect(result.text).toContain('failed to configure git remote');
    expect(result.text).not.toContain('gho_secret');
    expect(result.text).toContain('***');
  });

  it('reports a push failure (non "no commits yet") with sanitized stderr and leaves pushed false', async () => {
    vi.mocked(createGitHubRepo).mockResolvedValue(makeCreatedRepo());
    vi.mocked(getActiveGitHubToken).mockReturnValue('gho_secret');
    vi.mocked(sandboxClient.execInSandbox)
      .mockResolvedValueOnce({
        stdout: 'main',
        stderr: '',
        exitCode: 0,
        truncated: false,
      })
      .mockResolvedValueOnce({
        stdout: '',
        stderr: '',
        exitCode: 0,
        truncated: false,
      })
      .mockResolvedValueOnce({
        stdout: '',
        stderr: 'fatal: unable to access token gho_secret (403)',
        exitCode: 128,
        truncated: false,
      });

    const result = await executeSandboxToolCall(
      { tool: 'promote_to_github', args: { repo_name: 'my-repo' } },
      'sb-1',
    );

    expect(result.text).toContain('[Tool Error]');
    expect(result.text).toContain('push failed');
    expect(result.text).not.toContain('gho_secret');
    expect(result.promotion).toBeUndefined();
  });

  it('reports a warning and returns pushed=false when the push fails due to no local commits yet', async () => {
    vi.mocked(createGitHubRepo).mockResolvedValue(makeCreatedRepo());
    vi.mocked(getActiveGitHubToken).mockReturnValue('gho_token');
    vi.mocked(sandboxClient.execInSandbox)
      .mockResolvedValueOnce({
        stdout: 'main',
        stderr: '',
        exitCode: 0,
        truncated: false,
      })
      .mockResolvedValueOnce({
        stdout: '',
        stderr: '',
        exitCode: 0,
        truncated: false,
      })
      .mockResolvedValueOnce({
        stdout: '',
        stderr: 'error: src refspec main does not match any',
        exitCode: 1,
        truncated: false,
      });

    const result = await executeSandboxToolCall(
      { tool: 'promote_to_github', args: { repo_name: 'my-repo' } },
      'sb-1',
    );

    expect(result.text).toContain('[Tool Result — promote_to_github]');
    expect(result.text).toContain('Repository created: myuser/my-repo');
    expect(result.text).toContain('Warning:');
    expect(result.text).toContain('no local commits to push yet');
    expect(result.promotion).toBeDefined();
    expect(result.promotion?.pushed).toBe(false);
    expect(result.promotion?.warning).toBeDefined();
    expect(result.promotion?.repo.full_name).toBe('myuser/my-repo');
  });

  it('returns the full promotion shape on the all-success path', async () => {
    vi.mocked(createGitHubRepo).mockResolvedValue(
      makeCreatedRepo({ private: false, html_url: 'https://github.com/myuser/my-repo' }),
    );
    vi.mocked(getActiveGitHubToken).mockReturnValue('gho_token');
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({
      stdout: 'main',
      stderr: '',
      exitCode: 0,
      truncated: false,
    });

    const result = await executeSandboxToolCall(
      { tool: 'promote_to_github', args: { repo_name: 'my-repo', private: false } },
      'sb-1',
    );

    expect(result.text).toContain('[Tool Result — promote_to_github]');
    expect(result.text).toContain('Repository created: myuser/my-repo');
    expect(result.text).toContain('Visibility: public');
    expect(result.text).toContain('Default branch: main');
    expect(result.text).toContain('Push: successful on branch main');
    expect(result.promotion).toEqual({
      repo: {
        id: 42,
        name: 'my-repo',
        full_name: 'myuser/my-repo',
        owner: 'myuser',
        default_branch: 'main',
        private: false,
      },
      pushed: true,
      warning: undefined,
      htmlUrl: 'https://github.com/myuser/my-repo',
    });
  });
});

describe('executeSandboxToolCall -- read metrics', () => {
  beforeEach(() => {
    mockRecordReadFileMetric.mockReset();
    vi.mocked(sandboxClient.readFromSandbox).mockReset();
  });

  it('records full-read payload metrics on success', async () => {
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: 'export const x = 1;',
      truncated: false,
      version: 'v1',
    });

    await executeSandboxToolCall(
      { tool: 'sandbox_read_file', args: { path: '/workspace/src/example.ts' } },
      'sb-123',
    );

    expect(mockRecordReadFileMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'success',
        isRangeRead: false,
        payloadChars: 19,
        truncated: false,
        emptyRange: false,
      }),
    );
  });

  it('records empty range reads for out-of-bounds line windows', async () => {
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: '',
      truncated: false,
      version: 'v1',
      start_line: 999,
      end_line: 1100,
    });

    await executeSandboxToolCall(
      {
        tool: 'sandbox_read_file',
        args: { path: '/workspace/src/example.ts', start_line: 999, end_line: 1100 },
      },
      'sb-123',
    );

    expect(mockRecordReadFileMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'success',
        isRangeRead: true,
        payloadChars: 0,
        truncated: false,
        emptyRange: true,
      }),
    );
  });

  it('records read errors', async () => {
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: '',
      truncated: false,
      error: 'Read failed: no such file',
    } as unknown as sandboxClient.FileReadResult);

    await executeSandboxToolCall(
      { tool: 'sandbox_read_file', args: { path: '/workspace/missing.ts' } },
      'sb-123',
    );

    expect(mockRecordReadFileMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'error',
        isRangeRead: false,
        payloadChars: 0,
        errorCode: 'READ_ERROR',
      }),
    );
  });
});

describe('executeSandboxToolCall -- write metrics', () => {
  beforeEach(() => {
    mockRecordWriteFileMetric.mockReset();
    vi.mocked(sandboxClient.execInSandbox).mockReset();
    vi.mocked(sandboxClient.writeToSandbox).mockReset();
  });

  it('records success metrics for sandbox_write_file', async () => {
    vi.mocked(sandboxClient.writeToSandbox).mockResolvedValue({
      ok: true,
      bytes_written: 10,
      new_version: 'v2',
    });
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({
      stdout: 'M src/example.ts\n',
      stderr: '',
      exitCode: 0,
      truncated: false,
    });

    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_write_file',
        args: { path: '/workspace/src/example.ts', content: 'const x=1;' },
      },
      'sb-123',
    );

    expect(result.text).toContain('Wrote /workspace/src/example.ts');
    expect(mockRecordWriteFileMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'success',
        durationMs: expect.any(Number),
      }),
    );
  });

  it('records non-stale error metrics for sandbox_write_file', async () => {
    vi.mocked(sandboxClient.writeToSandbox).mockResolvedValue({
      ok: false,
      code: 'WRITE_FAILED',
      error: 'disk full',
    });

    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_write_file',
        args: { path: '/workspace/src/example.ts', content: 'const x=1;' },
      },
      'sb-123',
    );

    expect(result.text).toContain('[Tool Error]');
    expect(mockRecordWriteFileMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'error',
        errorCode: 'WRITE_FAILED',
        durationMs: expect.any(Number),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// 8. Edit guard behaviors
// ---------------------------------------------------------------------------

describe('executeSandboxToolCall -- edit guard', () => {
  beforeEach(() => {
    mockRecordWriteFileMetric.mockReset();
    mockRecordReadFileMetric.mockReset();
    vi.mocked(sandboxClient.readFromSandbox).mockReset();
    vi.mocked(sandboxClient.writeToSandbox).mockReset();
    vi.mocked(sandboxClient.execInSandbox).mockReset();
    fileLedger.reset();
  });

  it('blocks write to a file that was never read', async () => {
    // readFromSandbox is called during auto-expand — make it return an error
    // so the auto-expand also fails (not a missing-file error)
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: '',
      truncated: false,
      error: 'permission denied',
    } as unknown as sandboxClient.FileReadResult);

    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_write_file',
        args: { path: '/workspace/src/foo.ts', content: 'new content' },
      },
      'sb-123',
    );

    expect(result.text).toContain('Edit guard');
    expect(result.text).toContain('has not been read yet');
  });

  it('auto-expand allows write after successful auto-read', async () => {
    // File has NOT been read (no ledger entry). The auto-expand will
    // read it, record it, and then the write should succeed.
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: 'existing content\nline 2\n',
      truncated: false,
      version: 'v1',
    });
    vi.mocked(sandboxClient.writeToSandbox).mockResolvedValue({
      ok: true,
      bytes_written: 20,
      new_version: 'v2',
    });
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({
      stdout: 'M src/foo.ts\n',
      stderr: '',
      exitCode: 0,
      truncated: false,
    });

    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_write_file',
        args: { path: '/workspace/src/foo.ts', content: 'updated content' },
      },
      'sb-123',
    );

    expect(result.text).toContain('Wrote /workspace/src/foo.ts');
    expect(result.text).toContain('[POSTCONDITIONS]');
    expect(result.text).toContain('touched files: 1');
    expect(result.text).toContain('- write /workspace/src/foo.ts');
    expect(result.text).not.toContain('"touchedFiles"');
    expect(result.text).not.toContain('Edit guard');
    expect(result.postconditions?.touchedFiles).toEqual([
      expect.objectContaining({
        path: '/workspace/src/foo.ts',
        mutation: 'write',
        versionBefore: 'v1',
        versionAfter: 'v2',
      }),
    ]);
    expect(result.postconditions?.diagnostics?.[0]).toMatchObject({
      scope: 'single-file',
      path: '/workspace/src/foo.ts',
      status: 'clean',
    });
  });

  it('auto-expand allows new-file creation when file does not exist', async () => {
    // Auto-expand read returns a "no such file" error → treated as new file creation
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: '',
      truncated: false,
      error: 'cat: /workspace/src/new.ts: No such file or directory',
    } as unknown as sandboxClient.FileReadResult);
    vi.mocked(sandboxClient.writeToSandbox).mockResolvedValue({
      ok: true,
      bytes_written: 15,
      new_version: 'v1',
    });
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({
      stdout: '?? src/new.ts\n',
      stderr: '',
      exitCode: 0,
      truncated: false,
    });

    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_write_file',
        args: { path: '/workspace/src/new.ts', content: 'brand new file' },
      },
      'sb-123',
    );

    expect(result.text).toContain('Wrote /workspace/src/new.ts');
    expect(result.text).not.toContain('Edit guard');
  });

  it('appends signature hints only when read result is truncated', async () => {
    // Non-truncated read — no signature hint
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: 'export function hello() {}\nexport class Foo {}\n',
      truncated: false,
      version: 'v1',
    });

    const fullResult = await executeSandboxToolCall(
      { tool: 'sandbox_read_file', args: { path: '/workspace/src/full.ts' } },
      'sb-123',
    );
    expect(fullResult.text).not.toContain('[Truncated content contains:');

    // Truncated read — should get signature hint
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: 'export function hello() {}\nexport class Foo {}\n',
      truncated: true,
      truncated_at_line: 3,
      remaining_bytes: 128,
      version: 'v1',
    });

    const truncResult = await executeSandboxToolCall(
      { tool: 'sandbox_read_file', args: { path: '/workspace/src/big.ts' } },
      'sb-123',
    );
    expect(truncResult.text).toContain('[Truncated content contains:');
    expect(truncResult.text).toContain('truncated_at_line: 3');
    expect(truncResult.text).toContain('remaining_bytes: 128');
  });

  it('auto-expand handles empty files correctly (content is empty string)', async () => {
    // Empty file — content is '' which is falsy, but should still be treated
    // as a successful read (the file exists but is empty).
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: '',
      truncated: false,
      version: 'v1',
    });
    vi.mocked(sandboxClient.writeToSandbox).mockResolvedValue({
      ok: true,
      bytes_written: 10,
      new_version: 'v2',
    });
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({
      stdout: 'M src/empty.ts\n',
      stderr: '',
      exitCode: 0,
      truncated: false,
    });

    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_write_file',
        args: { path: '/workspace/src/empty.ts', content: 'new content' },
      },
      'sb-123',
    );

    // Should succeed — the empty file was read, auto-expand should work
    expect(result.text).toContain('Wrote /workspace/src/empty.ts');
    expect(result.text).not.toContain('Edit guard');
  });

  it('keeps edit guard blocked when chunk hydration remains truncated', async () => {
    vi.mocked(sandboxClient.readFromSandbox)
      .mockResolvedValueOnce({
        content: 'minified-start',
        truncated: true,
        version: 'v1',
      } as unknown as sandboxClient.FileReadResult)
      .mockResolvedValueOnce({
        content: 'aaaaaaaaaa',
        truncated: true,
        version: 'v1',
        start_line: 1,
        end_line: 400,
      } as unknown as sandboxClient.FileReadResult);

    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_write_file',
        args: { path: '/workspace/src/big.min.js', content: 'replacement' },
      },
      'sb-123',
    );

    expect(result.text).toContain('Edit guard');
    expect(result.text).toContain('too large to fully load');
    expect(vi.mocked(sandboxClient.writeToSandbox)).not.toHaveBeenCalled();
  });

  it('treats stale ledger entries as hard guard blocks until refreshed', async () => {
    const path = '/workspace/src/stale.ts';
    fileLedger.recordCreation(path);
    fileLedger.markStale(path);

    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: '',
      truncated: false,
      error: 'permission denied',
    } as unknown as sandboxClient.FileReadResult);

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_write_file', args: { path, content: 'updated content' } },
      'sb-123',
    );

    expect(result.text).toContain('Edit guard');
    expect(result.text).toContain('may have changed since your last read');
    expect(vi.mocked(sandboxClient.writeToSandbox)).not.toHaveBeenCalled();
    expect(fileLedger.getMetrics().blockedByStale).toBeGreaterThan(0);
  });
});

describe('sandbox path normalization', () => {
  it('normalizes relative read paths under /workspace', () => {
    const result = validateSandboxToolCall({
      tool: 'sandbox_read_file',
      args: { path: 'app/src/lib/sandbox-tools.ts' },
    });
    expect(result).not.toBeNull();
    expect(result).toEqual({
      tool: 'sandbox_read_file',
      args: {
        path: '/workspace/app/src/lib/sandbox-tools.ts',
        start_line: undefined,
        end_line: undefined,
      },
    });
  });

  it('normalizes relative paths in sandbox_apply_patchset edits', () => {
    const result = validateSandboxToolCall({
      tool: 'sandbox_apply_patchset',
      args: {
        edits: [
          {
            path: 'app/worker.ts',
            ops: [{ op: 'replace_line', ref: 'abc1234', content: 'new line' }],
          },
          { path: 'app/src/lib/providers.ts', ops: [{ op: 'delete_line', ref: 'def5678' }] },
        ],
      },
    });
    expect(result).not.toBeNull();
    expect(result?.tool).toBe('sandbox_apply_patchset');
    if (!result || result.tool !== 'sandbox_apply_patchset') {
      throw new Error('Expected sandbox_apply_patchset tool result');
    }
    expect(result.args.edits[0].path).toBe('/workspace/app/worker.ts');
    expect(result.args.edits[1].path).toBe('/workspace/app/src/lib/providers.ts');
  });

  it('preserves absolute paths in sandbox_apply_patchset edits', () => {
    const result = validateSandboxToolCall({
      tool: 'sandbox_apply_patchset',
      args: {
        edits: [
          {
            path: '/workspace/app/worker.ts',
            ops: [{ op: 'replace_line', ref: 'abc1234', content: 'new line' }],
          },
        ],
      },
    });
    expect(result).not.toBeNull();
    expect(result?.tool).toBe('sandbox_apply_patchset');
    if (!result || result.tool !== 'sandbox_apply_patchset') {
      throw new Error('Expected sandbox_apply_patchset tool result');
    }
    expect(result.args.edits[0].path).toBe('/workspace/app/worker.ts');
  });

  it('accepts line-range entries in sandbox_apply_patchset edits', () => {
    const result = validateSandboxToolCall({
      tool: 'sandbox_apply_patchset',
      args: {
        edits: [
          { path: 'app/worker.ts', start_line: 10, end_line: 12, content: 'replacement block' },
        ],
      },
    });
    expect(result).not.toBeNull();
    expect(result?.tool).toBe('sandbox_apply_patchset');
    if (!result || result.tool !== 'sandbox_apply_patchset') {
      throw new Error('Expected sandbox_apply_patchset tool result');
    }
    expect(result.args.edits[0]).toEqual({
      path: '/workspace/app/worker.ts',
      start_line: 10,
      end_line: 12,
      content: 'replacement block',
    });
  });

  it('filters invalid entries from sandbox_apply_patchset edits', () => {
    const result = validateSandboxToolCall({
      tool: 'sandbox_apply_patchset',
      args: {
        edits: [
          { path: 'app/worker.ts', ops: [{ op: 'replace_line', ref: 'abc1234', content: 'new' }] },
          { path: 123, ops: [] }, // invalid: path is not a string
          { path: 'app/lib.ts' }, // invalid: missing ops
          'not-an-object', // invalid: not an object
        ],
      },
    });
    expect(result).not.toBeNull();
    expect(result?.tool).toBe('sandbox_apply_patchset');
    if (!result || result.tool !== 'sandbox_apply_patchset') {
      throw new Error('Expected sandbox_apply_patchset tool result');
    }
    expect(result.args.edits).toHaveLength(1);
    expect(result.args.edits[0].path).toBe('/workspace/app/worker.ts');
  });

  it('returns null for sandbox_apply_patchset with all invalid edits', () => {
    const result = validateSandboxToolCall({
      tool: 'sandbox_apply_patchset',
      args: {
        edits: [{ path: 123, ops: [] }],
      },
    });
    expect(result).toBeNull();
  });

  it('parses checks and rollbackOnFailure on sandbox_apply_patchset', () => {
    const result = validateSandboxToolCall({
      tool: 'sandbox_apply_patchset',
      args: {
        edits: [
          { path: 'src/foo.ts', ops: [{ op: 'replace_line', ref: 'abc1234', content: 'x' }] },
        ],
        checks: [
          { command: 'npm test', exitCode: 0, timeoutMs: 5000 },
          { command: 'npx tsc --noEmit' },
        ],
        rollbackOnFailure: true,
      },
    });
    expect(result).not.toBeNull();
    if (!result || result.tool !== 'sandbox_apply_patchset') throw new Error('Expected patchset');
    expect(result.args.checks).toHaveLength(2);
    expect(result.args.checks![0]).toEqual({ command: 'npm test', exitCode: 0, timeoutMs: 5000 });
    expect(result.args.checks![1]).toEqual({
      command: 'npx tsc --noEmit',
      exitCode: undefined,
      timeoutMs: undefined,
    });
    expect(result.args.rollbackOnFailure).toBe(true);
  });

  it('clamps check timeoutMs to 1000-30000 range', () => {
    const result = validateSandboxToolCall({
      tool: 'sandbox_apply_patchset',
      args: {
        edits: [
          { path: 'src/foo.ts', ops: [{ op: 'replace_line', ref: 'abc1234', content: 'x' }] },
        ],
        checks: [
          { command: 'npm test', timeoutMs: 100 }, // below min
          { command: 'npm build', timeoutMs: 99999 }, // above max
        ],
      },
    });
    if (!result || result.tool !== 'sandbox_apply_patchset') throw new Error('Expected patchset');
    expect(result.args.checks![0].timeoutMs).toBe(1000);
    expect(result.args.checks![1].timeoutMs).toBe(30000);
  });

  it('accepts snake_case aliases for check fields', () => {
    const result = validateSandboxToolCall({
      tool: 'sandbox_apply_patchset',
      args: {
        edits: [
          { path: 'src/foo.ts', ops: [{ op: 'replace_line', ref: 'abc1234', content: 'x' }] },
        ],
        checks: [{ command: 'npm test', exit_code: 1, timeout_ms: 8000 }],
        rollback_on_failure: true,
      },
    });
    if (!result || result.tool !== 'sandbox_apply_patchset') throw new Error('Expected patchset');
    expect(result.args.checks![0].exitCode).toBe(1);
    expect(result.args.checks![0].timeoutMs).toBe(8000);
    expect(result.args.rollbackOnFailure).toBe(true);
  });

  it('drops checks with empty commands', () => {
    const result = validateSandboxToolCall({
      tool: 'sandbox_apply_patchset',
      args: {
        edits: [
          { path: 'src/foo.ts', ops: [{ op: 'replace_line', ref: 'abc1234', content: 'x' }] },
        ],
        checks: [{ command: '' }, { command: '  ' }],
      },
    });
    if (!result || result.tool !== 'sandbox_apply_patchset') throw new Error('Expected patchset');
    expect(result.args.checks).toBeUndefined();
  });

  it('normalizes relative path in sandbox_read_symbols', () => {
    const result = validateSandboxToolCall({
      tool: 'sandbox_read_symbols',
      args: { path: 'app/src/lib/utils.ts' },
    });
    expect(result).not.toBeNull();
    expect(result?.tool).toBe('sandbox_read_symbols');
    if (!result || result.tool !== 'sandbox_read_symbols') {
      throw new Error('Expected sandbox_read_symbols tool result');
    }
    expect(result.args.path).toBe('/workspace/app/src/lib/utils.ts');
  });

  it('normalizes scope and trims symbol in sandbox_find_references', () => {
    const result = validateSandboxToolCall({
      tool: 'sandbox_find_references',
      args: { symbol: '  getActiveProvider  ', scope: 'app/src/lib' },
    });
    expect(result).not.toBeNull();
    expect(result?.tool).toBe('sandbox_find_references');
    if (!result || result.tool !== 'sandbox_find_references') {
      throw new Error('Expected sandbox_find_references tool result');
    }
    expect(result.args.symbol).toBe('getActiveProvider');
    expect(result.args.scope).toBe('/workspace/app/src/lib');
  });

  it('rejects sandbox_find_references with an empty symbol', () => {
    const result = validateSandboxToolCall({
      tool: 'sandbox_find_references',
      args: { symbol: '   ' },
    });
    expect(result).toBeNull();
  });

  it('normalizes workspace-prefixed exec workdir', async () => {
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
      truncated: false,
    });

    await executeSandboxToolCall(
      { tool: 'sandbox_exec', args: { command: 'pwd', workdir: 'workspace/app' } },
      'sb-123',
    );

    expect(sandboxClient.execInSandbox).toHaveBeenCalledWith('sb-123', 'pwd', '/workspace/app');
  });

  it('formats sandbox_find_references results with relative paths', async () => {
    vi.mocked(sandboxClient.findReferencesInSandbox).mockReset();
    vi.mocked(sandboxClient.findReferencesInSandbox).mockResolvedValue({
      references: [
        {
          file: 'src/lib/auditor-agent.ts',
          line: 14,
          context: "import { getActiveProvider } from './orchestrator'",
          kind: 'import',
        },
        {
          file: '/workspace/src/lib/orchestrator.ts',
          line: 156,
          context: 'const provider = getActiveProvider();',
          kind: 'call',
        },
      ],
      truncated: false,
    });

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_find_references', args: { symbol: 'getActiveProvider', scope: 'src' } },
      'sb-123',
    );

    expect(sandboxClient.findReferencesInSandbox).toHaveBeenCalledWith(
      'sb-123',
      'getActiveProvider',
      '/workspace/src',
      30,
    );
    expect(result.text).toContain('[Tool Result — sandbox_find_references]');
    expect(result.text).toContain('Symbol: getActiveProvider');
    expect(result.text).toContain('Scope: src/');
    expect(result.text).toContain('References: 2 (showing 2)');
    expect(result.text).toContain('import  L  14  src/lib/auditor-agent.ts');
    expect(result.text).toContain('call    L 156  src/lib/orchestrator.ts');
  });

  it('marks previously-read files stale after mutating sandbox_exec', async () => {
    const path = '/workspace/src/stale-after-exec.ts';
    fileLedger.reset();
    vi.mocked(sandboxClient.readFromSandbox).mockReset();
    vi.mocked(sandboxClient.execInSandbox).mockReset();
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: 'export const value = 1;\n',
      truncated: false,
      version: 'v1',
    });
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
      truncated: false,
    });

    await executeSandboxToolCall({ tool: 'sandbox_read_file', args: { path } }, 'sb-123');
    expect(fileLedger.getState(path)?.kind).toBe('fully_read');

    const execResult = await executeSandboxToolCall(
      { tool: 'sandbox_exec', args: { command: 'touch /workspace/.push-write-test' } },
      'sb-123',
    );

    expect(execResult.text).toContain('Marked 1 previously-read file(s) as stale');
    expect(fileLedger.getState(path)?.kind).toBe('stale');
    expect(sandboxClient.execInSandbox).toHaveBeenLastCalledWith(
      'sb-123',
      'touch /workspace/.push-write-test',
      undefined,
      { markWorkspaceMutated: true },
    );
  });

  it('keeps read snapshots intact after read-only sandbox_exec', async () => {
    const path = '/workspace/src/read-only-exec.ts';
    fileLedger.reset();
    vi.mocked(sandboxClient.readFromSandbox).mockReset();
    vi.mocked(sandboxClient.execInSandbox).mockReset();
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: 'export const value = 1;\n',
      truncated: false,
      version: 'v1',
      workspace_revision: 2,
    });
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({
      stdout: '/workspace\n',
      stderr: '',
      exitCode: 0,
      truncated: false,
    });

    await executeSandboxToolCall({ tool: 'sandbox_read_file', args: { path } }, 'sb-123');

    const execResult = await executeSandboxToolCall(
      { tool: 'sandbox_exec', args: { command: 'pwd' } },
      'sb-123',
    );

    expect(execResult.text).not.toContain('Marked 1 previously-read file(s) as stale');
    expect(fileLedger.getState(path)?.kind).toBe('fully_read');
    expect(sandboxClient.execInSandbox).toHaveBeenLastCalledWith('sb-123', 'pwd', undefined);
  });

  it('returns a structured git guard error when direct git mutations are blocked', async () => {
    vi.mocked(sandboxClient.execInSandbox).mockReset();

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_exec', args: { command: 'git push origin main' } },
      'sb-123',
    );

    expect(result.text).toContain('[Tool Blocked — sandbox_exec]');
    expect(result.text).toContain('error_type: GIT_GUARD_BLOCKED');
    expect(result.text).toContain('retryable: false');
    expect(result.structuredError).toEqual({
      type: 'GIT_GUARD_BLOCKED',
      retryable: false,
      message: 'Direct "git push" is blocked',
      detail:
        'Use sandbox_prepare_commit + sandbox_push for the audited flow, or get explicit user approval before retrying with allowDirectGit.',
    });
    expect(sandboxClient.execInSandbox).not.toHaveBeenCalled();
  });
});

describe('sandbox_edit_file large file fallback', () => {
  beforeEach(() => {
    vi.mocked(sandboxClient.readFromSandbox).mockReset();
    vi.mocked(sandboxClient.writeToSandbox).mockReset();
    vi.mocked(sandboxClient.execInSandbox).mockReset();
    fileLedger.reset();
  });

  it('re-reads truncated files in chunks before applying hashline edits', async () => {
    vi.mocked(sandboxClient.readFromSandbox)
      // Auto-expand guard: initial read (truncated)
      .mockResolvedValueOnce({
        content: 'line 1\nline 2',
        truncated: true,
        version: 'v1',
      })
      // Auto-expand guard: readFullFileByChunks first chunk (fits in one chunk → done)
      // The cached result is reused by the edit logic — no duplicate reads
      .mockResolvedValueOnce({
        content: 'line 1\nline 2\n',
        truncated: false,
        version: 'v1',
        start_line: 1,
        end_line: 400,
      });

    vi.mocked(sandboxClient.writeToSandbox).mockResolvedValue({
      ok: true,
      new_version: 'v2',
      bytes_written: 20,
    });
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({
      stdout: 'diff',
      stderr: '',
      exitCode: 0,
      truncated: false,
    });

    const ref = await calculateLineHash('line 1');

    // Post-write verification read-back
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValueOnce({
      content: 'l',
      truncated: false,
      version: 'v2',
    });

    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_edit_file',
        args: {
          path: '/workspace/demo.txt',
          edits: [{ op: 'replace_line', ref, content: 'line one' }],
        },
      },
      'sb-123',
    );

    expect(result.text).toContain('Edited /workspace/demo.txt');
    // Call 2 is the chunk hydration read with line range (cached result reused for edit logic)
    expect(sandboxClient.readFromSandbox).toHaveBeenNthCalledWith(
      2,
      'sb-123',
      '/workspace/demo.txt',
      1,
      400,
    );
    // 3 calls total: guard initial + chunk + post-write verification
    expect(sandboxClient.readFromSandbox).toHaveBeenCalledTimes(3);
  });

  it('blocks sandbox_edit_file when chunk hydration remains truncated', async () => {
    vi.mocked(sandboxClient.readFromSandbox)
      // Auto-expand guard: initial read (truncated)
      .mockResolvedValueOnce({
        content: 'line 1\nline 2',
        truncated: true,
        version: 'v1',
      })
      // Auto-expand guard: chunk hydration (still truncated)
      .mockResolvedValueOnce({
        content: 'line 1\nline 2',
        truncated: true,
        version: 'v1',
        start_line: 1,
        end_line: 400,
      } as unknown as sandboxClient.FileReadResult);

    const ref = await calculateLineHash('line 1');

    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_edit_file',
        args: {
          path: '/workspace/demo.txt',
          edits: [{ op: 'replace_line', ref, content: 'line one' }],
        },
      },
      'sb-123',
    );

    expect(result.text).toContain('[Tool Error — sandbox_edit_file]');
    expect(result.text).toContain('Edit guard');
    expect(vi.mocked(sandboxClient.writeToSandbox)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Version precedence tests — stale expected_version should not override fresh data
// ---------------------------------------------------------------------------

describe('sandbox_edit_file version precedence', () => {
  beforeEach(() => {
    vi.mocked(sandboxClient.readFromSandbox).mockReset();
    vi.mocked(sandboxClient.writeToSandbox).mockReset();
    vi.mocked(sandboxClient.execInSandbox).mockReset();
  });

  it('uses fresh readResult.version instead of stale caller expected_version', async () => {
    // The fresh read returns version 'v3' (current on-disk version).
    // The caller passes expected_version 'v1' (stale from a previous read).
    // The write should use 'v3', not 'v1'.
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: 'hello world',
      truncated: false,
      version: 'v3',
    });
    vi.mocked(sandboxClient.writeToSandbox).mockResolvedValue({
      ok: true,
      new_version: 'v4',
      bytes_written: 11,
    });
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
      truncated: false,
    });

    const ref = await calculateLineHash('hello world');

    await executeSandboxToolCall(
      {
        tool: 'sandbox_edit_file',
        args: {
          path: '/workspace/test.txt',
          edits: [{ op: 'replace_line', ref, content: 'hello universe' }],
          expected_version: 'v1',
        },
      },
      'sb-123',
    );

    // writeToSandbox should be called with 'v3' (fresh), not 'v1' (stale)
    expect(sandboxClient.writeToSandbox).toHaveBeenCalledWith(
      'sb-123',
      '/workspace/test.txt',
      'hello universe',
      'v3',
    );
  });

  it('falls back gracefully when readResult has no version', async () => {
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: 'hello world',
      truncated: false,
      version: undefined as unknown as string,
    });
    vi.mocked(sandboxClient.writeToSandbox).mockResolvedValue({
      ok: true,
      new_version: 'v1',
      bytes_written: 14,
    });
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
      truncated: false,
    });

    const ref = await calculateLineHash('hello world');

    await executeSandboxToolCall(
      {
        tool: 'sandbox_edit_file',
        args: {
          path: '/workspace/test.txt',
          edits: [{ op: 'replace_line', ref, content: 'hello universe' }],
        },
      },
      'sb-123',
    );

    // writeToSandbox should be called with undefined (no version available)
    expect(sandboxClient.writeToSandbox).toHaveBeenCalledWith(
      'sb-123',
      '/workspace/test.txt',
      'hello universe',
      undefined,
    );
  });

  it('marks file stale and reports version details on stale write rejection', async () => {
    const path = '/workspace/test-stale.txt';
    const content = 'hello world\n';
    vi.mocked(sandboxClient.readFromSandbox)
      .mockResolvedValueOnce({
        content,
        truncated: false,
        version: 'v1',
      })
      .mockResolvedValueOnce({
        content,
        truncated: false,
        version: 'v1',
      });
    vi.mocked(sandboxClient.writeToSandbox).mockResolvedValue({
      ok: false,
      code: 'STALE_FILE',
      error: 'Stale file version',
      expected_version: 'v1',
      current_version: 'v2',
    });

    await executeSandboxToolCall({ tool: 'sandbox_read_file', args: { path } }, 'sb-123');

    const ref = await calculateLineHash('hello world');
    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_edit_file',
        args: {
          path,
          edits: [{ op: 'replace_line', ref, content: 'hello universe' }],
        },
      },
      'sb-123',
    );

    expect(result.text).toContain('[Tool Error — sandbox_edit_file]');
    expect(result.text).toContain('Stale write rejected');
    expect(result.text).toContain('Expected version: v1');
    expect(result.text).toContain('Current version: v2');
    expect(result.structuredError?.type).toBe('STALE_FILE');
    expect(fileLedger.getState(path)?.kind).toBe('stale');
  });
});

describe('sandbox_write_file version precedence', () => {
  beforeEach(() => {
    vi.mocked(sandboxClient.readFromSandbox).mockReset();
    vi.mocked(sandboxClient.writeToSandbox).mockReset();
    vi.mocked(sandboxClient.execInSandbox).mockReset();
    mockRecordWriteFileMetric.mockReset();
    mockRecordReadFileMetric.mockReset();
  });

  it('prefers cached version over stale caller expected_version', async () => {
    // Step 1: Read the file to populate the version cache with 'v2'
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: 'original content',
      truncated: false,
      version: 'v2',
    });
    await executeSandboxToolCall(
      { tool: 'sandbox_read_file', args: { path: '/workspace/src/app.ts' } },
      'sb-123',
    );

    // Step 2: Write with a stale expected_version 'v1'
    // The cache has 'v2' which should take precedence
    vi.mocked(sandboxClient.writeToSandbox).mockResolvedValue({
      ok: true,
      new_version: 'v3',
      bytes_written: 15,
    });
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
      truncated: false,
    });

    await executeSandboxToolCall(
      {
        tool: 'sandbox_write_file',
        args: {
          path: '/workspace/src/app.ts',
          content: 'updated content',
          expected_version: 'v1',
        },
      },
      'sb-123',
    );

    // writeToSandbox should be called with 'v2' (cache), not 'v1' (stale caller)
    expect(sandboxClient.writeToSandbox).toHaveBeenCalledWith(
      'sb-123',
      '/workspace/src/app.ts',
      'updated content',
      'v2',
    );
  });

  it('does not report identical-content warning when version actually changes', async () => {
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: 'original content',
      truncated: false,
      version: 'v1',
    });
    vi.mocked(sandboxClient.writeToSandbox).mockResolvedValue({
      ok: true,
      new_version: 'v2',
      bytes_written: 15,
    });
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
      truncated: false,
    });

    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_write_file',
        args: {
          path: '/workspace/src/app.ts',
          content: 'updated content',
        },
      },
      'sb-123',
    );

    expect(result.text).toContain('Wrote /workspace/src/app.ts');
    expect(result.text).not.toContain('Content is identical to the previous version');
  });

  it('falls back to caller expected_version when cache is empty', async () => {
    // Auto-expand read returns the file (edit guard will trigger this for unread files).
    // The auto-expand read purposely returns NO version so the cache stays empty,
    // forcing the code to fall back to the caller's expected_version.
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: 'existing content',
      truncated: false,
      version: undefined as unknown as string,
    });
    vi.mocked(sandboxClient.writeToSandbox).mockResolvedValue({
      ok: true,
      new_version: 'v2',
      bytes_written: 15,
    });
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
      truncated: false,
    });

    await executeSandboxToolCall(
      {
        tool: 'sandbox_write_file',
        args: {
          path: '/workspace/src/fallback-file.ts',
          content: 'new file content',
          expected_version: 'v1',
        },
      },
      'sb-123',
    );

    // writeToSandbox should use 'v1' (caller) since cache has nothing for this path
    expect(sandboxClient.writeToSandbox).toHaveBeenCalledWith(
      'sb-123',
      '/workspace/src/fallback-file.ts',
      'new file content',
      'v1',
    );
  });
});

// ---------------------------------------------------------------------------
// Symbolic edit guard tests — sandbox_edit_file
// ---------------------------------------------------------------------------

describe('sandbox_edit_file symbolic guard', () => {
  beforeEach(() => {
    vi.mocked(sandboxClient.readFromSandbox).mockReset();
    vi.mocked(sandboxClient.writeToSandbox).mockReset();
    vi.mocked(sandboxClient.execInSandbox).mockReset();
    fileLedger.reset();
  });

  it('blocks when guard fails and auto-read also fails', async () => {
    // Auto-expand returns an error — guard should block
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: '',
      truncated: false,
      error: 'permission denied',
    } as sandboxClient.FileReadResult & { error: string });

    const ref = await calculateLineHash('export function hello() {}');

    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_edit_file',
        args: {
          path: '/workspace/src/app.ts',
          edits: [{ op: 'replace_line', ref, content: 'export function hello() { return 1; }' }],
        },
      },
      'sb-123',
    );

    expect(result.text).toContain('[Tool Error — sandbox_edit_file]');
    expect(result.text).toContain('Edit guard');
    expect(vi.mocked(sandboxClient.writeToSandbox)).not.toHaveBeenCalled();
  });

  it('auto-expand populates ledger with symbols and allows edit', async () => {
    // File has a function that the edit touches — auto-expand should discover it
    const fileContent = 'export function hello() {\n  return 0;\n}\n';
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: fileContent,
      truncated: false,
      version: 'v1',
    });
    vi.mocked(sandboxClient.writeToSandbox).mockResolvedValue({
      ok: true,
      new_version: 'v2',
      bytes_written: 50,
    });
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
      truncated: false,
    });

    const ref = await calculateLineHash('export function hello() {');

    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_edit_file',
        args: {
          path: '/workspace/src/app.ts',
          edits: [{ op: 'replace_line', ref, content: 'export function hello() { return 1; }' }],
        },
      },
      'sb-123',
    );

    expect(result.text).toContain('Edited /workspace/src/app.ts');
    // Ledger should now have an entry for the file (from auto-expand + recordCreation)
    expect(fileLedger.hasEntry('/workspace/src/app.ts')).toBe(true);
  });

  it('allows symbolic edits after a full read even when symbol extraction found none', async () => {
    const path = '/workspace/src/plain.ts';
    const fileContent = 'const value = 1;\n';

    vi.mocked(sandboxClient.readFromSandbox)
      // Initial explicit full read by the model
      .mockResolvedValueOnce({
        content: fileContent,
        truncated: false,
        version: 'v1',
      })
      // Fresh read in sandbox_edit_file Step 1
      .mockResolvedValueOnce({
        content: fileContent,
        truncated: false,
        version: 'v1',
      });
    vi.mocked(sandboxClient.writeToSandbox).mockResolvedValue({
      ok: true,
      new_version: 'v2',
      bytes_written: 48,
    });
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
      truncated: false,
    });

    await executeSandboxToolCall({ tool: 'sandbox_read_file', args: { path } }, 'sb-123');

    const ref = await calculateLineHash('const value = 1;');
    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_edit_file',
        args: {
          path,
          edits: [
            { op: 'replace_line', ref, content: 'export function introduced() { return 1; }' },
          ],
        },
      },
      'sb-123',
    );

    expect(result.text).toContain('Edited /workspace/src/plain.ts');
    expect(result.text).not.toContain('Edit guard');
    expect(vi.mocked(sandboxClient.writeToSandbox)).toHaveBeenCalled();
  });

  it('surfaces hash mismatch after auto-expand full read when refs are invalid', async () => {
    // Auto-expand reads the file but the symbol being edited isn't found in it
    // The file contains `functionA` but the edit touches `functionB`
    const fileContent = 'export function functionA() {\n  return 0;\n}\n';
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: fileContent,
      truncated: false,
      version: 'v1',
    });

    // Edit references a symbol not in the file
    const ref = await calculateLineHash('dummy');
    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_edit_file',
        args: {
          path: '/workspace/src/app.ts',
          edits: [
            { op: 'replace_line', ref, content: 'export function functionB() { return 1; }' },
          ],
        },
      },
      'sb-123',
    );

    expect(result.text).toContain('[Tool Error — sandbox_edit_file]');
    expect(result.text).toContain('error_type: EDIT_HASH_MISMATCH');
    expect(vi.mocked(sandboxClient.writeToSandbox)).not.toHaveBeenCalled();
  });

  it('resolves unknown-symbol guard after full auto-expand and proceeds silently', async () => {
    const path = '/workspace/src/app.ts';
    const fileContent = 'const value = 1;\n';
    fileLedger.recordRead(path, {
      startLine: 1,
      endLine: 1,
      truncated: false,
      symbols: [{ name: 'known', kind: 'function', lineRange: { start: 1, end: 1 } }],
    });
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: fileContent,
      truncated: false,
      version: 'v1',
    });
    vi.mocked(sandboxClient.writeToSandbox).mockResolvedValue({
      ok: true,
      new_version: 'v2',
      bytes_written: 16,
    });
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
      truncated: false,
    });

    const ref = await calculateLineHash('const value = 1;');
    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_edit_file',
        args: {
          path,
          edits: [{ op: 'replace_line', ref, content: 'export function madeUp() { return 1; }' }],
        },
      },
      'sb-123',
    );

    expect(result.text).toContain('Edited /workspace/src/app.ts');
    expect(result.text).not.toContain('Symbol guard warning:');
    expect(vi.mocked(sandboxClient.writeToSandbox)).toHaveBeenCalled();
  });

  it('auto-retries stale line-qualified refs by hash when content shifted lines', async () => {
    const path = '/workspace/src/retry.ts';
    // A header line was inserted before the target — content unchanged, line number stale.
    const oldContent = 'const value = 1;\n';
    const latestContent = 'header line\nconst value = 1;\n';

    vi.mocked(sandboxClient.readFromSandbox)
      // Initial explicit read (to satisfy edit guard).
      .mockResolvedValueOnce({ content: oldContent, truncated: false, version: 'v1' })
      // sandbox_edit_file Step 1 read.
      .mockResolvedValueOnce({ content: latestContent, truncated: false, version: 'v2' })
      // Auto-retry re-read.
      .mockResolvedValueOnce({ content: latestContent, truncated: false, version: 'v2' })
      // Post-write verification read-back.
      .mockResolvedValueOnce({ content: 'h', truncated: false, version: 'v3' });
    vi.mocked(sandboxClient.writeToSandbox).mockResolvedValue({
      ok: true,
      new_version: 'v3',
      bytes_written: 30,
    });
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
      truncated: false,
    });

    await executeSandboxToolCall({ tool: 'sandbox_read_file', args: { path } }, 'sb-123');

    const staleHash = await calculateLineHash('const value = 1;');
    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_edit_file',
        args: {
          path,
          edits: [{ op: 'replace_line', ref: `1:${staleHash}`, content: 'const value = 3;' }],
        },
      },
      'sb-123',
    );

    // Hash-only retry finds the content at its new line (2) and applies correctly.
    expect(result.text).toContain('Edited /workspace/src/retry.ts');
    expect(result.text).toContain('Auto-retry succeeded');
    expect(vi.mocked(sandboxClient.writeToSandbox)).toHaveBeenCalledWith(
      'sb-123',
      path,
      'header line\nconst value = 3;\n',
      'v2',
    );
    // 4 calls: initial read + edit read + auto-retry re-read + post-write verification
    expect(vi.mocked(sandboxClient.readFromSandbox)).toHaveBeenCalledTimes(4);
  });

  it('auto-refreshes stale line-qualified refs when the target line changed in place', async () => {
    const path = '/workspace/src/retry-inline.ts';
    const oldContent = 'const value = 1;\n';
    const latestContent = 'const value = 2;\n';

    vi.mocked(sandboxClient.readFromSandbox)
      .mockResolvedValueOnce({ content: oldContent, truncated: false, version: 'v1' })
      .mockResolvedValueOnce({ content: latestContent, truncated: false, version: 'v2' })
      .mockResolvedValueOnce({ content: 'const value = 3;\n', truncated: false, version: 'v3' });
    vi.mocked(sandboxClient.writeToSandbox).mockResolvedValue({
      ok: true,
      new_version: 'v3',
      bytes_written: 17,
    });
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
      truncated: false,
    });

    await executeSandboxToolCall({ tool: 'sandbox_read_file', args: { path } }, 'sb-123');

    const staleHash = await calculateLineHash('const value = 1;');
    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_edit_file',
        args: {
          path,
          edits: [{ op: 'replace_line', ref: `1:${staleHash}`, content: 'const value = 3;' }],
        },
      },
      'sb-123',
    );

    expect(result.text).toContain('Edited /workspace/src/retry-inline.ts');
    expect(result.text).toContain('refreshed 1 stale line-qualified ref');
    expect(vi.mocked(sandboxClient.writeToSandbox)).toHaveBeenCalledWith(
      'sb-123',
      path,
      'const value = 3;\n',
      'v2',
    );
    // 3 calls: initial read + edit read + post-write verification.
    expect(vi.mocked(sandboxClient.readFromSandbox)).toHaveBeenCalledTimes(3);
  });

  it('surfaces refreshed retry hints when stale line-qualified refs still fail', async () => {
    const path = '/workspace/src/retry-fail.ts';
    const originalContent = 'const value = 1;\nconst second = 1;\n';
    const latestContent = 'const value = 2;\n';

    vi.mocked(sandboxClient.readFromSandbox)
      .mockResolvedValueOnce({ content: originalContent, truncated: false, version: 'v1' })
      .mockResolvedValueOnce({ content: latestContent, truncated: false, version: 'v2' })
      .mockResolvedValueOnce({ content: latestContent, truncated: false, version: 'v2' });

    await executeSandboxToolCall({ tool: 'sandbox_read_file', args: { path } }, 'sb-123');

    const staleHash = await calculateLineHash('const value = 1;');
    const missingHash = await calculateLineHash('const second = 1;');
    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_edit_file',
        args: {
          path,
          edits: [
            { op: 'replace_line', ref: `1:${staleHash}`, content: 'const value = 3;' },
            { op: 'replace_line', ref: `2:${missingHash}`, content: 'const second = 3;' },
          ],
        },
      },
      'sb-123',
    );

    const refreshedHash = await calculateLineHash('const value = 2;');
    expect(result.text).toContain('[Tool Error — sandbox_edit_file]');
    expect(result.text).toContain('Retry hints:');
    expect(result.text).toContain(`Same-line retry for "1:${staleHash}": use "1:${refreshedHash}"`);
    expect(result.text).toContain('sandbox_edit_range');
    expect(vi.mocked(sandboxClient.writeToSandbox)).not.toHaveBeenCalled();
  });

  it('surfaces double-replace warnings for successful hashline edits', async () => {
    const path = '/workspace/src/double-replace.ts';
    const fileContent = 'const value = 1;\n';

    vi.mocked(sandboxClient.readFromSandbox)
      .mockResolvedValueOnce({ content: fileContent, truncated: false, version: 'v1' })
      .mockResolvedValueOnce({ content: fileContent, truncated: false, version: 'v1' })
      .mockResolvedValueOnce({ content: 'const value = 3;\n', truncated: false, version: 'v2' });
    vi.mocked(sandboxClient.writeToSandbox).mockResolvedValue({
      ok: true,
      new_version: 'v2',
      bytes_written: 17,
    });
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
      truncated: false,
    });

    await executeSandboxToolCall({ tool: 'sandbox_read_file', args: { path } }, 'sb-123');

    const ref = await calculateLineHash('const value = 1;');
    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_edit_file',
        args: {
          path,
          edits: [
            { op: 'replace_line', ref: `1:${ref}`, content: 'const value = 2;' },
            { op: 'replace_line', ref: `1:${ref}`, content: 'const value = 3;' },
          ],
        },
      },
      'sb-123',
    );

    expect(result.text).toContain('Hashline warnings:');
    expect(result.text).toContain('already replaced by a prior op');
    expect(result.text).toContain('guard warnings: 1');
    expect(vi.mocked(sandboxClient.writeToSandbox)).toHaveBeenCalledWith(
      'sb-123',
      path,
      'const value = 3;\n',
      'v1',
    );
  });
});

describe('sandbox_edit_file truncation-hashline sync guard', () => {
  beforeEach(() => {
    vi.mocked(sandboxClient.readFromSandbox).mockReset();
    vi.mocked(sandboxClient.writeToSandbox).mockReset();
    vi.mocked(sandboxClient.execInSandbox).mockReset();
    fileLedger.reset();
  });

  it('blocks edit when resolved lines fall outside partial_read range', async () => {
    const path = '/workspace/big.ts';
    // File has 6 lines; ledger records lines 1-3 with symbol 'foo'
    const fileContent = 'function foo() {\n  return 1;\n}\nfunction bar() {\n  return 2;\n}';
    fileLedger.recordRead(path, {
      startLine: 1,
      endLine: 3,
      truncated: false,
      symbols: [{ name: 'foo', kind: 'function', lineRange: { start: 1, end: 3 } }],
    });

    // The edit targets line 5 (hash of '  return 2;') — outside the read range [1-3]
    // Edit content declares 'function foo' so symbolic guard passes (known symbol)
    const ref = await calculateLineHash('  return 2;');

    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: fileContent,
      truncated: false,
      version: 'v1',
    });

    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_edit_file',
        args: {
          path,
          edits: [{ op: 'replace_line', ref, content: 'function foo() { return 42; }' }],
        },
      },
      'sb-123',
    );

    expect(result.structuredError?.type).toBe('EDIT_GUARD_BLOCKED');
    expect(result.text).toContain('not read');
    expect(sandboxClient.writeToSandbox).not.toHaveBeenCalled();
  });
});

describe('sandbox_edit_range', () => {
  beforeEach(() => {
    vi.mocked(sandboxClient.readFromSandbox).mockReset();
    vi.mocked(sandboxClient.writeToSandbox).mockReset();
    vi.mocked(sandboxClient.execInSandbox).mockReset();
    fileLedger.reset();
  });

  it('compiles line ranges to hashline ops and applies via sandbox_edit_file', async () => {
    const path = '/workspace/demo.txt';
    const fileContent = 'one\ntwo\nthree\n';

    // Range wrapper pre-reads the file, then primes the prefetch cache so the
    // delegated sandbox_edit_file skips a second read.
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValueOnce({
      content: fileContent,
      truncated: false,
      version: 'v1',
    });
    vi.mocked(sandboxClient.writeToSandbox).mockResolvedValue({
      ok: true,
      bytes_written: 13,
      new_version: 'v2',
    });
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
      truncated: false,
    });

    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_edit_range',
        args: {
          path,
          start_line: 2,
          end_line: 3,
          content: 'dos\ntres',
        },
      },
      'sb-123',
    );

    expect(result.text).toContain('Edited /workspace/demo.txt');
    expect(vi.mocked(sandboxClient.writeToSandbox)).toHaveBeenCalledWith(
      'sb-123',
      path,
      'one\ndos\ntres\n',
      'v1',
    );
  });

  it('returns a tool error for out-of-range line windows', async () => {
    const path = '/workspace/demo.txt';

    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: 'one\ntwo\n',
      truncated: false,
      version: 'v1',
    });

    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_edit_range',
        args: {
          path,
          start_line: 4,
          end_line: 5,
          content: 'x',
        },
      },
      'sb-123',
    );

    expect(result.text).toContain('[Tool Error — sandbox_edit_range]');
    expect(result.text).toContain('Invalid range');
    expect(vi.mocked(sandboxClient.writeToSandbox)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Symbolic edit guard tests — sandbox_apply_patchset
// ---------------------------------------------------------------------------

describe('sandbox_apply_patchset symbolic guard', () => {
  beforeEach(() => {
    vi.mocked(sandboxClient.readFromSandbox).mockReset();
    vi.mocked(sandboxClient.writeToSandbox).mockReset();
    vi.mocked(sandboxClient.execInSandbox).mockReset();
    vi.mocked(sandboxClient.batchWriteToSandbox).mockReset();
    fileLedger.reset();
  });

  it('allows patchset when all files pass guard after auto-expand', async () => {
    const fileContent = 'export function greet() {\n  return "hi";\n}\n';
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: fileContent,
      truncated: false,
      version: 'v1',
    });
    vi.mocked(sandboxClient.batchWriteToSandbox).mockResolvedValue({
      ok: true,
      results: [{ path: '/workspace/src/a.ts', ok: true, new_version: 'v2', bytes_written: 50 }],
    });

    const ref = await calculateLineHash('export function greet() {');

    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_apply_patchset',
        args: {
          edits: [
            {
              path: '/workspace/src/a.ts',
              ops: [
                { op: 'replace_line', ref, content: 'export function greet() { return "hello"; }' },
              ],
            },
          ],
        },
      },
      'sb-123',
    );

    expect(result.text).toContain('patched successfully');
  });

  it('applies line-range patchset edits after compiling them to hashline ops', async () => {
    const path = '/workspace/src/a.ts';
    const fileContent = 'line 1\nline 2\nline 3\nline 4\n';
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: fileContent,
      truncated: false,
      version: 'v1',
    });
    vi.mocked(sandboxClient.batchWriteToSandbox).mockResolvedValue({
      ok: true,
      results: [{ path, ok: true, new_version: 'v2', bytes_written: 27 }],
    });

    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_apply_patchset',
        args: {
          edits: [
            {
              path,
              start_line: 2,
              end_line: 3,
              content: 'dos\ntres',
            },
          ],
        },
      },
      'sb-123',
    );

    expect(result.text).toContain('patched successfully');
    expect(vi.mocked(sandboxClient.batchWriteToSandbox)).toHaveBeenCalledWith('sb-123', [
      {
        path,
        content: 'line 1\ndos\ntres\nline 4\n',
        expected_version: 'v1',
      },
    ]);
  });

  it('surfaces double-replace warnings for successful patchsets', async () => {
    const path = '/workspace/src/a.ts';
    const fileContent = 'const value = 1;\n';
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: fileContent,
      truncated: false,
      version: 'v1',
    });
    vi.mocked(sandboxClient.batchWriteToSandbox).mockResolvedValue({
      ok: true,
      results: [{ path, ok: true, new_version: 'v2', bytes_written: 17 }],
    });

    const ref = await calculateLineHash('const value = 1;');
    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_apply_patchset',
        args: {
          edits: [
            {
              path,
              ops: [
                { op: 'replace_line', ref, content: 'const value = 2;' },
                { op: 'replace_line', ref, content: 'const value = 3;' },
              ],
            },
          ],
        },
      },
      'sb-123',
    );

    expect(result.text).toContain('patched successfully');
    expect(result.text).toContain('Guard warnings:');
    expect(result.text).toContain('already replaced by a prior op');
    expect(result.text).toContain('guard warnings: 1');
  });

  it('surfaces validation mismatch after auto-expand full read when refs are invalid', async () => {
    // File contains functionA but the edit uses an invalid hash ref.
    const fileContent = 'export function functionA() {\n  return 0;\n}\n';
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: fileContent,
      truncated: false,
      version: 'v1',
    });

    const ref = await calculateLineHash('dummy');
    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_apply_patchset',
        args: {
          edits: [
            {
              path: '/workspace/src/a.ts',
              ops: [
                { op: 'replace_line', ref, content: 'export function functionB() { return 1; }' },
              ],
            },
          ],
        },
      },
      'sb-123',
    );

    expect(result.text).toContain('[Tool Error — sandbox_apply_patchset]');
    expect(result.text).toContain('Validation failed');
    expect(result.text).toContain('error_type: EDIT_HASH_MISMATCH');
    expect(result.text).toContain('/workspace/src/a.ts');
    expect(vi.mocked(sandboxClient.batchWriteToSandbox)).not.toHaveBeenCalled();
  });

  it('resolves unknown-symbol guard after full auto-read and proceeds silently', async () => {
    const path = '/workspace/src/a.ts';
    const fileContent = 'const value = 1;\n';
    fileLedger.recordRead(path, {
      startLine: 1,
      endLine: 1,
      truncated: false,
      symbols: [{ name: 'known', kind: 'function', lineRange: { start: 1, end: 1 } }],
    });
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: fileContent,
      truncated: false,
      version: 'v1',
    });
    vi.mocked(sandboxClient.batchWriteToSandbox).mockResolvedValue({
      ok: true,
      results: [{ path, ok: true, new_version: 'v2', bytes_written: 16 }],
    });

    const ref = await calculateLineHash('const value = 1;');
    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_apply_patchset',
        args: {
          edits: [
            {
              path,
              ops: [{ op: 'replace_line', ref, content: 'export function madeUp() { return 1; }' }],
            },
          ],
        },
      },
      'sb-123',
    );

    expect(result.text).toContain('[Tool Result — sandbox_apply_patchset]');
    expect(result.text).toContain('[POSTCONDITIONS]');
    expect(result.text).toContain('diagnostics: 1');
    expect(result.text).not.toContain('"diagnostics"');
    expect(result.text).not.toContain('Guard warnings:');
    expect(result.text).toContain(path);
    expect(vi.mocked(sandboxClient.batchWriteToSandbox)).toHaveBeenCalled();
    expect(result.postconditions?.touchedFiles).toEqual([
      expect.objectContaining({
        path,
        mutation: 'patchset',
        versionBefore: 'v1',
        versionAfter: 'v2',
      }),
    ]);
    expect(result.postconditions?.diagnostics?.[0]).toMatchObject({
      scope: 'project',
      label: 'project typecheck',
      status: 'clean',
    });
  });

  it('blocks patchset when guard auto-expand remains truncated', async () => {
    const line = 'export function greet() {';
    const content = `${line}\n`;

    vi.mocked(sandboxClient.readFromSandbox)
      // Guard auto-read
      .mockResolvedValueOnce({
        content,
        truncated: true,
        version: 'v1',
      })
      // Guard chunk hydration (still truncated)
      .mockResolvedValueOnce({
        content,
        truncated: true,
        version: 'v1',
        start_line: 1,
        end_line: 400,
      } as unknown as sandboxClient.FileReadResult);

    const ref = await calculateLineHash(line);
    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_apply_patchset',
        args: {
          edits: [
            {
              path: '/workspace/src/a.ts',
              ops: [
                { op: 'replace_line', ref, content: 'export function greet() { return "hello"; }' },
              ],
            },
          ],
        },
      },
      'sb-123',
    );

    expect(result.text).toContain('[Tool Error — sandbox_apply_patchset]');
    expect(result.text).toContain('too large to fully load safely');
    expect(vi.mocked(sandboxClient.batchWriteToSandbox)).not.toHaveBeenCalled();
  });

  it('blocks patchset when phase-1 hydration remains truncated after guard pass', async () => {
    const path = '/workspace/src/a.ts';
    const fileContent = 'const value = 1;\n';

    vi.mocked(sandboxClient.readFromSandbox)
      // Pre-read so guard passes without auto-expand
      .mockResolvedValueOnce({
        content: fileContent,
        truncated: false,
        version: 'v1',
      })
      // Phase 1 read in sandbox_apply_patchset
      .mockResolvedValueOnce({
        content: 'const value = 1;',
        truncated: true,
        version: 'v2',
      })
      // Phase 1 chunk hydration (still truncated)
      .mockResolvedValueOnce({
        content: 'const value = 1;',
        truncated: true,
        version: 'v2',
        start_line: 1,
        end_line: 400,
      } as unknown as sandboxClient.FileReadResult);

    await executeSandboxToolCall({ tool: 'sandbox_read_file', args: { path } }, 'sb-123');

    const ref = await calculateLineHash('const value = 1;');
    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_apply_patchset',
        args: {
          edits: [
            {
              path,
              ops: [{ op: 'replace_line', ref, content: 'const value = 2;' }],
            },
          ],
        },
      },
      'sb-123',
    );

    expect(result.text).toContain('[Tool Error — sandbox_apply_patchset]');
    expect(result.text).toContain('too large to fully load safely');
    expect(vi.mocked(sandboxClient.batchWriteToSandbox)).not.toHaveBeenCalled();
  });

  it('returns structured stale error on partial patchset failure and marks file stale', async () => {
    const path = '/workspace/src/a.ts';
    const fileContent = 'const value = 1;\n';
    vi.mocked(sandboxClient.readFromSandbox)
      // Pre-read so guard passes without auto-expand
      .mockResolvedValueOnce({
        content: fileContent,
        truncated: false,
        version: 'v1',
      })
      // Phase 1 read
      .mockResolvedValueOnce({
        content: fileContent,
        truncated: false,
        version: 'v1',
      });
    vi.mocked(sandboxClient.batchWriteToSandbox).mockResolvedValue({
      ok: true,
      results: [
        {
          path,
          ok: false,
          code: 'STALE_FILE',
          expected_version: 'v1',
          current_version: 'v2',
        },
      ],
    });

    await executeSandboxToolCall({ tool: 'sandbox_read_file', args: { path } }, 'sb-123');

    const ref = await calculateLineHash('const value = 1;');
    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_apply_patchset',
        args: {
          edits: [
            {
              path,
              ops: [{ op: 'replace_line', ref, content: 'const value = 2;' }],
            },
          ],
        },
      },
      'sb-123',
    );

    expect(result.text).toContain('[Tool Error — sandbox_apply_patchset] (partial failure)');
    expect(result.text).toContain('stale write rejected (expected=v1 current=v2)');
    expect(result.text).toContain('error_type: STALE_FILE');
    expect(result.structuredError?.type).toBe('STALE_FILE');
    expect(fileLedger.getState(path)?.kind).toBe('stale');
  });

  it('caps patchset structured-error detail when many files fail', async () => {
    const ref = await calculateLineHash('const value = 1;');
    const paths = Array.from({ length: 13 }, (_, idx) => `/workspace/src/f${idx + 1}.ts`);

    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: 'const value = 1;\n',
      truncated: false,
      version: 'v1',
    });
    vi.mocked(sandboxClient.batchWriteToSandbox).mockResolvedValue({
      ok: true,
      results: paths.map((path) => ({
        path,
        ok: false,
        code: 'STALE_FILE',
        expected_version: 'v1',
        current_version: 'v2',
      })),
    });

    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_apply_patchset',
        args: {
          edits: paths.map((path) => ({
            path,
            ops: [{ op: 'replace_line', ref, content: 'const value = 2;' }],
          })),
        },
      },
      'sb-123',
    );

    expect(result.structuredError?.type).toBe('STALE_FILE');
    expect(result.structuredError?.detail).toContain('(+1 more)');
    expect(result.structuredError?.detail?.length ?? 0).toBeLessThanOrEqual(1600);
  });
});

// ---------------------------------------------------------------------------
// sandbox_apply_patchset — batch write fallback/ambiguous-state regression
// ---------------------------------------------------------------------------

describe('sandbox_apply_patchset batch write fallback', () => {
  beforeEach(() => {
    vi.mocked(sandboxClient.readFromSandbox).mockReset();
    vi.mocked(sandboxClient.writeToSandbox).mockReset();
    vi.mocked(sandboxClient.execInSandbox).mockReset();
    vi.mocked(sandboxClient.batchWriteToSandbox).mockReset();
    fileLedger.reset();
  });

  it('falls back to sequential writes on HTTP 404 without workspace revision guard', async () => {
    const fileContent = 'const a = 1;\n';
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: fileContent,
      truncated: false,
      version: 'v1',
    });

    // Batch endpoint returns 404 — endpoint not available
    const err404 = new Error('Not Found') as Error & { statusCode?: number };
    err404.statusCode = 404;
    vi.mocked(sandboxClient.batchWriteToSandbox).mockRejectedValue(err404);

    // Sequential fallback should succeed — no workspace revision passed
    vi.mocked(sandboxClient.writeToSandbox).mockResolvedValue({
      ok: true,
      new_version: 'v2',
      bytes_written: 14,
      workspace_revision: 5,
    });

    const ref = await calculateLineHash('const a = 1;');
    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_apply_patchset',
        args: {
          edits: [
            {
              path: '/workspace/src/a.ts',
              ops: [{ op: 'replace_line', ref, content: 'const a = 2;' }],
            },
          ],
        },
      },
      'sb-123',
    );

    expect(result.text).toContain('patched successfully');
    // Verify sequential write was called WITHOUT workspace revision (4th arg = version, no 5th arg)
    const writeCalls = vi.mocked(sandboxClient.writeToSandbox).mock.calls;
    expect(writeCalls.length).toBe(1);
    expect(writeCalls[0][4]).toBeUndefined(); // no expectedWorkspaceRevision
  });

  it('returns ambiguous-state error on timeout without replaying writes', async () => {
    const fileContent = 'const b = 1;\n';
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: fileContent,
      truncated: false,
      version: 'v1',
    });

    // Batch endpoint times out — no statusCode (timeout throws plain Error)
    vi.mocked(sandboxClient.batchWriteToSandbox).mockRejectedValue(
      new Error('Sandbox batch-write timed out after 60s'),
    );

    const ref = await calculateLineHash('const b = 1;');
    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_apply_patchset',
        args: {
          edits: [
            {
              path: '/workspace/src/a.ts',
              ops: [{ op: 'replace_line', ref, content: 'const b = 2;' }],
            },
          ],
        },
      },
      'sb-123',
    );

    // Should return structured error, NOT fall back to sequential writes
    expect(result.text).toContain('ambiguous state');
    expect(result.text).toContain('error_type: WRITE_FAILED');
    expect(result.structuredError?.type).toBe('WRITE_FAILED');
    expect(result.structuredError?.retryable).toBe(false);
    // Sequential write should NOT have been called
    expect(vi.mocked(sandboxClient.writeToSandbox)).not.toHaveBeenCalled();
    // Ledger should be fully invalidated (all entries stale)
    // — verified indirectly: file was read, so ledger had an entry; after invalidation it should be stale
  });
});

describe('sandbox_search_replace', () => {
  beforeEach(() => {
    vi.mocked(sandboxClient.readFromSandbox).mockReset();
    vi.mocked(sandboxClient.writeToSandbox).mockReset();
    vi.mocked(sandboxClient.execInSandbox).mockReset();
    fileLedger.reset();
  });

  it('finds unique line and replaces matched substring', async () => {
    const path = '/workspace/src/app.ts';
    const fileContent = 'export function foo(x: number): number {\n  return x;\n}\n';
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: fileContent,
      truncated: false,
      version: 'v1',
    });
    vi.mocked(sandboxClient.writeToSandbox).mockResolvedValue({
      ok: true,
      new_version: 'v2',
      bytes_written: 50,
    });
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
      truncated: false,
    });

    // Pre-read so edit guard passes.
    await executeSandboxToolCall({ tool: 'sandbox_read_file', args: { path } }, 'sb-123');

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_search_replace', args: { path, search: 'x: number', replace: 'x: string' } },
      'sb-123',
    );

    expect(result.text).toContain('Edited /workspace/src/app.ts');
    expect(vi.mocked(sandboxClient.writeToSandbox)).toHaveBeenCalledWith(
      'sb-123',
      path,
      'export function foo(x: string): number {\n  return x;\n}\n',
      'v1',
    );
  });

  it('errors when search string matches no lines', async () => {
    const path = '/workspace/src/app.ts';
    const fileContent = 'const a = 1;\n';
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: fileContent,
      truncated: false,
      version: 'v1',
    });

    await executeSandboxToolCall({ tool: 'sandbox_read_file', args: { path } }, 'sb-123');
    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_search_replace',
        args: { path, search: 'not present', replace: 'anything' },
      },
      'sb-123',
    );

    expect(result.text).toContain('[Tool Error — sandbox_search_replace]');
    expect(result.text).toContain('not found');
    expect(result.text).toContain('error_type: EDIT_CONTENT_NOT_FOUND');
    expect(vi.mocked(sandboxClient.writeToSandbox)).not.toHaveBeenCalled();
  });

  it('errors when search string matches multiple lines', async () => {
    const path = '/workspace/src/app.ts';
    const fileContent = 'const a = null;\nconst b = null;\n';
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: fileContent,
      truncated: false,
      version: 'v1',
    });

    await executeSandboxToolCall({ tool: 'sandbox_read_file', args: { path } }, 'sb-123');
    const result = await executeSandboxToolCall(
      { tool: 'sandbox_search_replace', args: { path, search: 'null', replace: 'undefined' } },
      'sb-123',
    );

    expect(result.text).toContain('[Tool Error — sandbox_search_replace]');
    expect(result.text).toContain('Ambiguous');
    expect(result.text).toContain('L1:');
    expect(result.text).toContain('L2:');
    expect(vi.mocked(sandboxClient.writeToSandbox)).not.toHaveBeenCalled();
  });

  it('expands a single-line replace into multiple lines when replace contains newline', async () => {
    const path = '/workspace/src/app.ts';
    const fileContent = 'const x = 1;\n';
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: fileContent,
      truncated: false,
      version: 'v1',
    });
    vi.mocked(sandboxClient.writeToSandbox).mockResolvedValue({
      ok: true,
      new_version: 'v2',
      bytes_written: 30,
    });
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
      truncated: false,
    });

    await executeSandboxToolCall({ tool: 'sandbox_read_file', args: { path } }, 'sb-123');
    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_search_replace',
        args: { path, search: 'const x = 1;', replace: 'const x = 1;\nconst y = 2;' },
      },
      'sb-123',
    );

    expect(result.text).toContain('Edited /workspace/src/app.ts');
    expect(vi.mocked(sandboxClient.writeToSandbox)).toHaveBeenCalledWith(
      'sb-123',
      path,
      'const x = 1;\nconst y = 2;\n',
      'v1',
    );
  });

  it('treats replacement text literally (no $-pattern expansion)', async () => {
    const path = '/workspace/src/app.ts';
    const fileContent = 'const token = "foo";\n';
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: fileContent,
      truncated: false,
      version: 'v1',
    });
    vi.mocked(sandboxClient.writeToSandbox).mockResolvedValue({
      ok: true,
      new_version: 'v2',
      bytes_written: 28,
    });
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
      truncated: false,
    });

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_search_replace', args: { path, search: 'foo', replace: '$1$&$$' } },
      'sb-123',
    );

    expect(result.text).toContain('Edited /workspace/src/app.ts');
    expect(vi.mocked(sandboxClient.writeToSandbox)).toHaveBeenCalledWith(
      'sb-123',
      path,
      'const token = "$1$&$$";\n',
      'v1',
    );
  });

  it('treats newline-terminated multiline searches as literal replacements', async () => {
    const path = '/workspace/src/app.ts';
    const fileContent = 'line1\nline2\nline3';
    vi.mocked(sandboxClient.readFromSandbox)
      .mockResolvedValueOnce({ content: fileContent, truncated: false, version: 'v1' })
      .mockResolvedValueOnce({ content: 'l', truncated: false, version: 'v2' });
    vi.mocked(sandboxClient.writeToSandbox).mockResolvedValue({
      ok: true,
      new_version: 'v2',
      bytes_written: 14,
    });
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
      truncated: false,
    });

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_search_replace', args: { path, search: 'line2\n', replace: 'NEW' } },
      'sb-123',
    );

    expect(result.text).toContain('Edited /workspace/src/app.ts');
    expect(vi.mocked(sandboxClient.writeToSandbox)).toHaveBeenCalledWith(
      'sb-123',
      path,
      'line1\nNEWline3',
      'v1',
    );
  });

  it('reuses prefetched content so delegated edit does not require a second read', async () => {
    const path = '/workspace/src/app.ts';
    const fileContent = 'const x = 1;\n';
    vi.mocked(sandboxClient.readFromSandbox)
      .mockResolvedValueOnce({ content: fileContent, truncated: false, version: 'v1' })
      // Post-write verification read-back (non-critical, won't block edit).
      .mockResolvedValueOnce({ content: 'c', truncated: false, version: 'v2' });
    vi.mocked(sandboxClient.writeToSandbox).mockResolvedValue({
      ok: true,
      new_version: 'v2',
      bytes_written: 12,
    });
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
      truncated: false,
    });

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_search_replace', args: { path, search: 'x = 1', replace: 'x = 2' } },
      'sb-123',
    );

    expect(result.text).toContain('Edited /workspace/src/app.ts');
    // 2 calls: initial search_replace read + post-write verification
    expect(vi.mocked(sandboxClient.readFromSandbox)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(sandboxClient.writeToSandbox)).toHaveBeenCalledWith(
      'sb-123',
      path,
      'const x = 2;\n',
      'v1',
    );
  });

  it('detects encoding mismatch when search contains smart quotes instead of ASCII', async () => {
    const path = '/workspace/src/app.ts';
    // File has ASCII double quotes
    const fileContent = 'const msg = "hello world";\n';
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: fileContent,
      truncated: false,
      version: 'v1',
    });

    await executeSandboxToolCall({ tool: 'sandbox_read_file', args: { path } }, 'sb-123');
    const result = await executeSandboxToolCall(
      // Search uses smart double quotes (U+201C / U+201D) instead of ASCII "
      {
        tool: 'sandbox_search_replace',
        args: { path, search: '\u201chello world\u201d', replace: 'goodbye' },
      },
      'sb-123',
    );

    expect(result.text).toContain('[Tool Error \u2014 sandbox_search_replace]');
    expect(result.text).toContain('Encoding mismatch');
    expect(result.text).toContain('normalization');
    expect(result.structuredError?.type).toBe('EDIT_CONTENT_NOT_FOUND');
    expect(result.structuredError?.retryable).toBe(true);
    expect(vi.mocked(sandboxClient.writeToSandbox)).not.toHaveBeenCalled();
  });

  it('detects encoding mismatch with CP1252 mojibake em-dash', async () => {
    const path = '/workspace/src/app.ts';
    // File has a real em-dash (U+2014)
    const fileContent = 'Does not ping \u2014 just updates UI state\n';
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: fileContent,
      truncated: false,
      version: 'v1',
    });

    await executeSandboxToolCall({ tool: 'sandbox_read_file', args: { path } }, 'sb-123');
    const result = await executeSandboxToolCall(
      // Search uses CP1252 mojibake for em-dash: â€" = U+00E2 U+20AC U+201D
      {
        tool: 'sandbox_search_replace',
        args: { path, search: 'Does not ping \u00e2\u20ac\u201d just updates', replace: 'fixed' },
      },
      'sb-123',
    );

    expect(result.text).toContain('Encoding mismatch');
    expect(result.structuredError?.retryable).toBe(true);
    expect(vi.mocked(sandboxClient.writeToSandbox)).not.toHaveBeenCalled();
  });
});
