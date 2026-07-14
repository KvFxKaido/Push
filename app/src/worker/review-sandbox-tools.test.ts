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
  runReviewSetup,
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
  const commands = { typecheck: 'npm run typecheck', tests: 'npm test', setup: 'npm install' };
  const noTestCommands = { typecheck: 'npm run typecheck', tests: null, setup: 'npm install' };

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
    expect(r.verification).toEqual({ kind: 'tests', status: 'pass' });
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
    expect(r.verification).toEqual({ kind: 'tests', status: 'fail' });
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
    expect(r.verification).toEqual({ kind: 'typecheck', status: 'fail' });
  });

  it('never throws when detached exec transport fails before start confirmation — and records NO verdict', async () => {
    dispatchMock.mockRejectedValueOnce(new Error('transport down'));
    runDetachedMock.mockImplementationOnce(
      async (primitives: DetachedExecPrimitives, command: string, options: RunDetachedOptions) => {
        await primitives.start(command, { workdir: options.workdir });
      },
    );

    const r = await runReviewTypecheck(env, sb, 'npm run typecheck');

    expect(r.text).toContain('Exit code: -1');
    expect(r.text).toContain('Result: DID NOT COMPLETE');
    expect(r.text).toContain('transport down');
    expect(r.text).toContain('unverified');
    // Environment outcome, not a verifier verdict — recording 'fail' here would
    // paint the check-run "typecheck failed" over a sandbox problem. But it is
    // NOT `not_run` either: the model invoked the verifier, so bank 'blocked' and
    // carry the reason, or the check run blames the model for our outage.
    expect(r.verification?.status).toBe('blocked');
    expect(r.verification?.kind).toBe('typecheck');
    expect(r.verification?.reason).toContain('did not complete');
  });

  it("records 'blocked' (not a verdict, not not_run) when the command hits the overall deadline (exit 124)", async () => {
    runDetachedMock.mockResolvedValueOnce({
      stdout: 'partial output',
      stderr: '',
      exitCode: 124,
      truncated: false,
      terminalReason: 'deadline',
      error: 'command exceeded 480000ms overall deadline and was interrupted',
    } satisfies DetachedExecResult);

    const r = await executeReviewSandboxTool(
      env,
      sb,
      { tool: 'sandbox_run_tests', args: {} } as never,
      commands,
    );

    expect(r.text).toContain('Result: DID NOT COMPLETE');
    expect(r.text).toContain('NOT a tests failure');
    expect(r.verification?.status).toBe('blocked');
    expect(r.verification?.reason).toContain('timed out');
  });

  it("records 'blocked' when the process died without an exit code (completed, exit -1)", async () => {
    runDetachedMock.mockResolvedValueOnce({
      stdout: '',
      stderr: '',
      exitCode: -1,
      truncated: false,
      terminalReason: 'completed',
      error: 'background process ended without an exit code (killed or errored)',
    } satisfies DetachedExecResult);

    const r = await runReviewTypecheck(env, sb, 'npm run typecheck');

    expect(r.text).toContain('Result: DID NOT COMPLETE');
    expect(r.verification?.status).toBe('blocked');
    expect(r.verification?.reason).toContain('did not complete');
  });
});

describe('per-call deadlines on the detached primitives', () => {
  const sb = { sandboxId: 'sb1', ownerToken: 'tok1' };

  /** Run a verifier just to capture the primitives it builds. */
  async function capturePrimitives(): Promise<DetachedExecPrimitives> {
    let captured: DetachedExecPrimitives | undefined;
    runDetachedMock.mockImplementationOnce(
      async (primitives: DetachedExecPrimitives): Promise<DetachedExecResult> => {
        captured = primitives;
        return {
          stdout: '',
          stderr: '',
          exitCode: 0,
          truncated: false,
          terminalReason: 'completed',
        };
      },
    );
    await runReviewTypecheck(env, sb, 'npm run typecheck');
    if (!captured) throw new Error('runner never received primitives');
    return captured;
  }

  it('a hung status poll rejects after bounded retries instead of stalling forever', async () => {
    vi.useFakeTimers();
    try {
      let statusCalls = 0;
      dispatchMock.mockImplementation(async (_env: unknown, route: string) => {
        if (route === 'exec-status') {
          statusCalls++;
          return new Promise<never>(() => {}); // control plane hang
        }
        return jsonRes({});
      });
      const primitives = await capturePrimitives();

      const pending = primitives.status('pid1');
      const rejection = expect(pending).rejects.toThrow(/exec-status did not respond within/);
      // 3 attempts × 30s per-call deadline, run back-to-back.
      await vi.advanceTimersByTimeAsync(90_000);
      await rejection;
      expect(statusCalls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a slow first status poll recovers on retry', async () => {
    vi.useFakeTimers();
    try {
      let statusCalls = 0;
      dispatchMock.mockImplementation(async (_env: unknown, route: string) => {
        if (route === 'exec-status') {
          statusCalls++;
          if (statusCalls === 1) return new Promise<never>(() => {});
          return jsonRes({ running: false, exit_code: 0 });
        }
        return jsonRes({});
      });
      const primitives = await capturePrimitives();

      const pending = primitives.status('pid1');
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(pending).resolves.toEqual({ running: false, exitCode: 0 });
      expect(statusCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a hung exec-start rejects after its deadline (no retry — a retried start could double-spawn)', async () => {
    vi.useFakeTimers();
    try {
      let startCalls = 0;
      dispatchMock.mockImplementation(async (_env: unknown, route: string) => {
        if (route === 'exec-start') {
          startCalls++;
          return new Promise<never>(() => {});
        }
        return jsonRes({});
      });
      const primitives = await capturePrimitives();

      const pending = primitives.start('npm test', { workdir: '/workspace' });
      const rejection = expect(pending).rejects.toThrow(/exec-start did not respond within/);
      await vi.advanceTimersByTimeAsync(60_000);
      await rejection;
      expect(startCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('environment setup before verifiers', () => {
  const sb = { sandboxId: 'sb1', ownerToken: 'tok1' };
  const commands = { typecheck: 'npm run typecheck', tests: 'npm test', setup: 'npm install' };

  it('verifiers await ensureSetup; inspection tools never trigger it', async () => {
    const ensureSetup = vi.fn(async () => ({ ok: true, text: '' }));
    runDetachedMock.mockResolvedValueOnce({
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
      truncated: false,
      terminalReason: 'completed',
    } satisfies DetachedExecResult);

    await executeReviewSandboxTool(
      env,
      sb,
      { tool: 'sandbox_search', args: { query: 'x' } } as never,
      commands,
      ensureSetup,
    );
    expect(ensureSetup).not.toHaveBeenCalled();

    const r = await executeReviewSandboxTool(
      env,
      sb,
      { tool: 'sandbox_check_types', args: {} } as never,
      commands,
      ensureSetup,
    );
    expect(ensureSetup).toHaveBeenCalledTimes(1);
    expect(r.verification).toEqual({ kind: 'typecheck', status: 'pass' });
  });

  it("a failed setup short-circuits the verifier and banks 'blocked' against the invoked kind", async () => {
    const ensureSetup = vi.fn(async () => ({
      ok: false,
      text: 'Environment setup failed (exit 1): npm ERR! network down',
    }));

    const r = await executeReviewSandboxTool(
      env,
      sb,
      { tool: 'sandbox_run_tests', args: {} } as never,
      commands,
      ensureSetup,
    );
    // The verifier never ran: environment outcome, not a verifier fail. But the
    // model DID invoke it, so this must not degrade to `not_run` — that is the
    // state the check run reports as "the reviewer did not run typecheck/tests",
    // which blamed the model for an install failure and left its (unreliable)
    // narration as the only account of the cause.
    expect(runDetachedMock).not.toHaveBeenCalled();
    expect(r.verification).toEqual({
      kind: 'tests',
      status: 'blocked',
      reason: 'Environment setup failed (exit 1): npm ERR! network down',
    });
    expect(r.text).toContain('Environment setup failed');
    expect(r.text).toContain('note the review as unverified');
  });

  it('carries the setup failure TAIL into the blocked reason, flattened and capped', async () => {
    // The real cause is at the END of an install log, so the reason keeps the tail.
    const noise = Array.from({ length: 200 }, (_, i) => `line ${i} of install noise`).join('\n');
    const ensureSetup = vi.fn(async () => ({
      ok: false,
      text: `${noise}\nERR_PNPM_UNSUPPORTED_ENGINE  the real cause`,
    }));

    const r = await executeReviewSandboxTool(
      env,
      sb,
      { tool: 'sandbox_check_types', args: {} } as never,
      commands,
      ensureSetup,
    );

    expect(r.verification?.status).toBe('blocked');
    expect(r.verification?.reason).toContain('the real cause');
    expect(r.verification?.reason).not.toContain('\n');
    expect((r.verification?.reason ?? '').length).toBeLessThanOrEqual(401);
  });

  it('marks progress after the setup gate settles — pass AND fail — and never for inspection tools', async () => {
    const touch = vi.fn();
    const okSetup = vi.fn(async () => ({ ok: true, text: '' }));
    runDetachedMock.mockResolvedValueOnce({
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
      truncated: false,
      terminalReason: 'completed',
    } satisfies DetachedExecResult);

    await executeReviewSandboxTool(
      env,
      sb,
      { tool: 'sandbox_check_types', args: {} } as never,
      commands,
      okSetup,
      touch,
    );
    // The verifier's deadline must be measured from the install's END: without
    // this mark, setup (600s) + verifier (480s) overruns the review's 15-min
    // no-progress budget with nothing in between.
    expect(touch).toHaveBeenCalledTimes(1);

    const failedSetup = vi.fn(async () => ({ ok: false, text: 'Environment setup failed' }));
    await executeReviewSandboxTool(
      env,
      sb,
      { tool: 'sandbox_run_tests', args: {} } as never,
      commands,
      failedSetup,
      touch,
    );
    expect(touch).toHaveBeenCalledTimes(2);

    await executeReviewSandboxTool(
      env,
      sb,
      { tool: 'sandbox_search', args: { query: 'x' } } as never,
      commands,
      okSetup,
      touch,
    );
    expect(touch).toHaveBeenCalledTimes(2);
  });

  it('the default setup command is conditional and package-manager-aware', async () => {
    const { REVIEW_DEFAULT_SETUP_COMMAND } = await import('./review-sandbox-tools');
    // No-op guard on warm sandboxes / non-Node repos.
    expect(REVIEW_DEFAULT_SETUP_COMMAND).toContain('[ -f package.json ] && [ ! -d node_modules ]');
    // Lockfile-detected installer, npm as the final fallback only.
    expect(REVIEW_DEFAULT_SETUP_COMMAND).toContain('pnpm-lock.yaml');
    expect(REVIEW_DEFAULT_SETUP_COMMAND).toContain('yarn.lock');
    expect(REVIEW_DEFAULT_SETUP_COMMAND).toContain('bun install');
    expect(REVIEW_DEFAULT_SETUP_COMMAND).toMatch(/else npm install/);
  });

  it('runReviewSetup reports ok on exit 0 and reduced detail on failure', async () => {
    runDetachedMock.mockResolvedValueOnce({
      stdout: 'added 120 packages',
      stderr: '',
      exitCode: 0,
      truncated: false,
      terminalReason: 'completed',
    } satisfies DetachedExecResult);
    await expect(runReviewSetup(env, sb, 'npm install')).resolves.toEqual({ ok: true, text: '' });

    runDetachedMock.mockResolvedValueOnce({
      stdout: '',
      stderr: 'npm ERR! ERESOLVE',
      exitCode: 1,
      truncated: false,
      terminalReason: 'completed',
    } satisfies DetachedExecResult);
    const failed = await runReviewSetup(env, sb, 'npm install');
    expect(failed.ok).toBe(false);
    expect(failed.text).toContain('exit 1');
    expect(failed.text).toContain('ERESOLVE');
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
