import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DetachedExecPrimitives,
  DetachedExecResult,
  RunDetachedOptions,
} from '@push/lib/detached-exec-runner';
import type { Env } from './worker-middleware';

// Mock the runtime deps that `review-sandbox-tools` dynamically imports. Mocking
// `./worker-cf-sandbox` also keeps the CF Sandbox SDK's `cloudflare:`-scheme
// imports off this test's graph (the reason the module uses dynamic import).
const dispatchMock = vi.fn();
vi.mock('./worker-cf-sandbox', () => ({ dispatchSandboxRouteInternal: dispatchMock }));

const runDetachedMock = vi.fn();
vi.mock('@push/lib/detached-exec-runner', () => ({
  runDetachedToCompletion: runDetachedMock,
}));

const handleSearchMock = vi.fn(async () => ({ text: 'SEARCH_RESULT' }));
const handleReadFileMock = vi.fn(async () => ({ text: 'READ_RESULT' }));
const handleListDirMock = vi.fn(async () => ({ text: 'LS_RESULT' }));
vi.mock('@/lib/sandbox-read-only-inspection-handlers', () => ({
  handleSearch: handleSearchMock,
  handleReadFile: handleReadFileMock,
  handleListDir: handleListDirMock,
}));

import { resolveToolName } from '@push/lib/tool-registry';
import {
  REVIEW_SANDBOX_TOOLS,
  cleanupReviewSandbox,
  executeReviewSandboxTool,
  provisionReviewSandbox,
  reviewSandboxToolNames,
  runReviewTypecheck,
} from './review-sandbox-tools';

const env = {} as Env;
const jsonRes = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

beforeEach(() => {
  dispatchMock.mockReset();
  runDetachedMock.mockReset();
  handleSearchMock.mockClear();
  handleReadFileMock.mockClear();
  handleListDirMock.mockClear();
});

describe('REVIEW_SANDBOX_TOOLS', () => {
  it('advertises only names the tool registry resolves (drift guard)', () => {
    // The `- Sandbox:` prompt line advertises these names and the detector
    // executes only names that resolve through the registry — an advertised
    // name that doesn't resolve produces calls that silently never run
    // (`tests` vs public name `test`, Codex P2 on PR #1385).
    for (const name of REVIEW_SANDBOX_TOOLS) {
      expect(resolveToolName(name), `advertised name "${name}" must resolve`).toBeTruthy();
    }
  });
});

describe('provisionReviewSandbox', () => {
  it('provisions and returns the sandbox when HEAD matches the reviewed commit', async () => {
    dispatchMock
      .mockResolvedValueOnce(jsonRes({ sandbox_id: 'sb1', owner_token: 'tok1' })) // create
      .mockResolvedValueOnce(jsonRes({ head_sha: 'abc123' })); // diff (verify)
    const sb = await provisionReviewSandbox(env, 'owner/repo', 'feature', 'abc123', 'ghtok');
    expect(sb).toEqual({ sandboxId: 'sb1', ownerToken: 'tok1' });
    expect(dispatchMock).toHaveBeenNthCalledWith(
      1,
      env,
      'create',
      expect.objectContaining({ repo: 'owner/repo', branch: 'feature', github_token: 'ghtok' }),
    );
  });

  it('tears down and returns null when HEAD drifted (branch advanced post-webhook)', async () => {
    dispatchMock
      .mockResolvedValueOnce(jsonRes({ sandbox_id: 'sb1', owner_token: 'tok1' }))
      .mockResolvedValueOnce(jsonRes({ head_sha: 'DIFFERENT' }))
      .mockResolvedValueOnce(jsonRes({ ok: true })); // cleanup
    const sb = await provisionReviewSandbox(env, 'owner/repo', 'feature', 'abc123', 'ghtok');
    expect(sb).toBeNull();
    expect(dispatchMock).toHaveBeenCalledWith(env, 'cleanup', {
      sandbox_id: 'sb1',
      owner_token: 'tok1',
    });
  });

  it('tears down and returns null on an empty workspace (no head_sha — cross-fork/dead ref)', async () => {
    dispatchMock
      .mockResolvedValueOnce(jsonRes({ sandbox_id: 'sb1', owner_token: 'tok1' }))
      .mockResolvedValueOnce(jsonRes({})) // diff: no head_sha
      .mockResolvedValueOnce(jsonRes({ ok: true }));
    expect(
      await provisionReviewSandbox(env, 'owner/repo', 'feature', 'abc123', 'ghtok'),
    ).toBeNull();
    expect(dispatchMock).toHaveBeenCalledWith(env, 'cleanup', {
      sandbox_id: 'sb1',
      owner_token: 'tok1',
    });
  });

  it('returns null when create fails (no verify, no throw)', async () => {
    dispatchMock.mockResolvedValueOnce(jsonRes({ error: 'boom' }, 500));
    expect(
      await provisionReviewSandbox(env, 'owner/repo', 'feature', 'abc123', 'ghtok'),
    ).toBeNull();
    expect(dispatchMock).toHaveBeenCalledTimes(1); // create only
  });

  it('never throws when the route transport throws', async () => {
    dispatchMock.mockRejectedValue(new Error('network down'));
    await expect(
      provisionReviewSandbox(env, 'owner/repo', 'feature', 'abc123', 'ghtok'),
    ).resolves.toBeNull();
  });
});

describe('executeReviewSandboxTool', () => {
  const sb = { sandboxId: 'sb1', ownerToken: 'tok1' };
  const commands = { typecheck: 'npm run typecheck', tests: 'npm test' };
  const noTestCommands = { typecheck: 'npm run typecheck', tests: null };

  it('routes search/read/ls to the redacting inspection handlers', async () => {
    expect(
      (
        await executeReviewSandboxTool(
          env,
          sb,
          {
            tool: 'sandbox_search',
            args: { query: 'x' },
          } as never,
          commands,
        )
      ).text,
    ).toBe('SEARCH_RESULT');
    expect(handleSearchMock).toHaveBeenCalledTimes(1);
    expect(
      (
        await executeReviewSandboxTool(
          env,
          sb,
          {
            tool: 'sandbox_read_file',
            args: { path: 'a.ts' },
          } as never,
          commands,
        )
      ).text,
    ).toBe('READ_RESULT');
    expect(handleReadFileMock).toHaveBeenCalledTimes(1);
    expect(
      (
        await executeReviewSandboxTool(
          env,
          sb,
          { tool: 'sandbox_list_dir', args: {} } as never,
          commands,
        )
      ).text,
    ).toBe('LS_RESULT');
    expect(handleListDirMock).toHaveBeenCalledTimes(1);
  });

  it('rejects non-allowlisted exec/verification tools without touching the sandbox', async () => {
    for (const call of [
      { tool: 'sandbox_exec', args: { command: 'rm -rf /' } },
      { tool: 'sandbox_verify_workspace', args: {} },
    ]) {
      const r = await executeReviewSandboxTool(env, sb, call as never, noTestCommands);
      expect(r.text).toContain('not available in automated PR review');
      // The advertised list is availability-narrowed: no test command → no `tests`.
      expect(r.text).toContain(reviewSandboxToolNames(false));
      expect(r.text).not.toContain('tests');
    }
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(handleSearchMock).not.toHaveBeenCalled();
    expect(runDetachedMock).not.toHaveBeenCalled();
  });

  it('returns a model-readable error for sandbox_run_tests when the repo has no test command', async () => {
    const r = await executeReviewSandboxTool(
      env,
      sb,
      { tool: 'sandbox_run_tests', args: {} } as never,
      noTestCommands,
    );
    expect(r.text).toContain('no test command');
    expect(r.verification).toBeUndefined();
    expect(runDetachedMock).not.toHaveBeenCalled();
  });

  it('routes sandbox_run_tests through the detached runner with the base-ref test command', async () => {
    runDetachedMock.mockResolvedValueOnce({
      stdout: '12 passed',
      stderr: '',
      exitCode: 0,
      truncated: false,
      terminalReason: 'completed',
    } satisfies DetachedExecResult);

    const r = await executeReviewSandboxTool(
      env,
      sb,
      { tool: 'sandbox_run_tests', args: { framework: 'ignored' } } as never,
      commands,
    );

    expect(runDetachedMock).toHaveBeenCalledWith(
      expect.anything(),
      'cd /workspace && npm test',
      expect.objectContaining({ workdir: '/workspace' }),
    );
    expect(r.text).toContain('[Tool Result — tests]');
    expect(r.text).toContain('Result: PASS');
    expect(r.verification).toEqual({ kind: 'tests', pass: true });
  });

  it('reports fail (verification metadata included) on a non-zero test exit', async () => {
    runDetachedMock.mockResolvedValueOnce({
      stdout: '1 failed',
      stderr: '',
      exitCode: 1,
      truncated: false,
      terminalReason: 'completed',
    } satisfies DetachedExecResult);

    const r = await executeReviewSandboxTool(
      env,
      sb,
      { tool: 'sandbox_run_tests', args: {} } as never,
      commands,
    );
    expect(r.text).toContain('Result: FAIL');
    expect(r.verification).toEqual({ kind: 'tests', pass: false });
  });

  it('routes sandbox_check_types through the detached runner and reports pass on exit 0', async () => {
    dispatchMock
      .mockResolvedValueOnce(jsonRes({ process_id: 'pid1' }))
      .mockResolvedValueOnce(jsonRes({ running: false, exit_code: 0, branch: 'main' }))
      .mockResolvedValueOnce(
        jsonRes({
          stdout: 'chunk',
          stderr: '',
          next_cursor_stdout: 5,
          next_cursor_stderr: 0,
        }),
      )
      .mockResolvedValueOnce(jsonRes({ ok: true }));
    runDetachedMock.mockImplementationOnce(
      async (
        primitives: DetachedExecPrimitives,
        command: string,
        options: RunDetachedOptions,
      ): Promise<DetachedExecResult> => {
        expect(command).toBe('cd /workspace && npm run typecheck');
        expect(options.workdir).toBe('/workspace');
        expect(options.overallTimeoutMs).toBe(480_000);
        await expect(primitives.start(command, { workdir: options.workdir })).resolves.toEqual({
          processId: 'pid1',
        });
        await expect(primitives.status('pid1')).resolves.toEqual({
          running: false,
          exitCode: 0,
          branch: 'main',
        });
        await expect(
          primitives.logs('pid1', { cursorStdout: 2, cursorStderr: 3 }),
        ).resolves.toEqual({
          stdout: 'chunk',
          stderr: '',
          nextCursorStdout: 5,
          nextCursorStderr: 0,
        });
        await expect(primitives.interrupt('pid1')).resolves.toBeUndefined();
        return {
          stdout: 'typecheck passed',
          stderr: '',
          exitCode: 0,
          truncated: false,
          terminalReason: 'completed',
        };
      },
    );

    const r = await executeReviewSandboxTool(
      env,
      sb,
      { tool: 'sandbox_check_types', args: {} } as never,
      commands,
    );

    expect(r.text).toContain('[Tool Result — typecheck]');
    expect(r.text).toContain('Exit code: 0');
    expect(r.text).toContain('Result: PASS');
    expect(r.text).toContain('typecheck passed');
    expect(dispatchMock).toHaveBeenNthCalledWith(1, env, 'exec-start', {
      sandbox_id: 'sb1',
      owner_token: 'tok1',
      command: 'cd /workspace && npm run typecheck',
      workdir: '/workspace',
    });
    expect(dispatchMock).toHaveBeenNthCalledWith(2, env, 'exec-status', {
      sandbox_id: 'sb1',
      owner_token: 'tok1',
      process_id: 'pid1',
    });
    expect(dispatchMock).toHaveBeenNthCalledWith(3, env, 'exec-logs', {
      sandbox_id: 'sb1',
      owner_token: 'tok1',
      process_id: 'pid1',
      cursor_stdout: 2,
      cursor_stderr: 3,
    });
    expect(dispatchMock).toHaveBeenNthCalledWith(4, env, 'exec-kill', {
      sandbox_id: 'sb1',
      owner_token: 'tok1',
      process_id: 'pid1',
    });
  });

  it('reports fail on a non-zero typecheck exit', async () => {
    runDetachedMock.mockResolvedValueOnce({
      stdout: 'src/a.ts(1,1): error TS2322',
      stderr: '',
      exitCode: 2,
      truncated: false,
      terminalReason: 'completed',
    } satisfies DetachedExecResult);

    const r = await runReviewTypecheck(env, sb, 'npm run typecheck');

    expect(r.text).toContain('Exit code: 2');
    expect(r.text).toContain('Result: FAIL');
    expect(r.text).toContain('error TS2322');
    expect(r.verification).toEqual({ kind: 'typecheck', pass: false });
  });

  it('never throws when detached exec transport fails before start confirmation', async () => {
    dispatchMock.mockRejectedValueOnce(new Error('transport down'));
    runDetachedMock.mockImplementationOnce(
      async (primitives: DetachedExecPrimitives, command: string, options: RunDetachedOptions) => {
        await primitives.start(command, { workdir: options.workdir });
      },
    );

    const r = await runReviewTypecheck(env, sb, 'npm run typecheck');

    expect(r.text).toContain('Exit code: -1');
    expect(r.text).toContain('Result: FAIL');
    expect(r.text).toContain('transport down');
    expect(r.verification).toEqual({ kind: 'typecheck', pass: false });
  });
});

describe('cleanupReviewSandbox', () => {
  it('calls the cleanup route with the owner token', async () => {
    dispatchMock.mockResolvedValue(jsonRes({ ok: true }));
    await cleanupReviewSandbox(env, { sandboxId: 'sb1', ownerToken: 'tok1' });
    expect(dispatchMock).toHaveBeenCalledWith(env, 'cleanup', {
      sandbox_id: 'sb1',
      owner_token: 'tok1',
    });
  });

  it('never throws when cleanup fails', async () => {
    dispatchMock.mockRejectedValue(new Error('gone'));
    await expect(
      cleanupReviewSandbox(env, { sandboxId: 'sb1', ownerToken: 'tok1' }),
    ).resolves.toBeUndefined();
  });
});
