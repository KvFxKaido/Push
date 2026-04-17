import { describe, expect, it, vi } from 'vitest';
import {
  handleCheckTypes,
  handleRunTests,
  handleVerifyWorkspace,
  type VerificationHandlerContext,
} from './sandbox-verification-handlers';
import type { ExecResult, SandboxEnvironment } from './sandbox-client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ok = (stdout = '', stderr = ''): ExecResult => ({
  stdout,
  stderr,
  exitCode: 0,
  truncated: false,
});

const fail = (stdout = '', stderr = '', exitCode = 1): ExecResult => ({
  stdout,
  stderr,
  exitCode,
  truncated: false,
});

type ExecArgs = Parameters<VerificationHandlerContext['execInSandbox']>;

/**
 * Build a context whose `execInSandbox` returns queued results in order.
 * Extra calls fall through to an "empty ok" sentinel so tests don't explode
 * on a missing queue entry while still surfacing unexpected extra calls
 * via `calls.length`.
 */
function makeContext(
  results: ExecResult[],
  environment: SandboxEnvironment | null = null,
): VerificationHandlerContext & {
  calls: ExecArgs[];
  clearFileVersionCache: ReturnType<typeof vi.fn>;
  clearPrefetchedEditFileCache: ReturnType<typeof vi.fn>;
} {
  const calls: ExecArgs[] = [];
  const queue = [...results];
  const clearFileVersionCache = vi.fn();
  const clearPrefetchedEditFileCache = vi.fn();
  return {
    sandboxId: 'sb-1',
    execInSandbox: vi.fn(async (...args: ExecArgs) => {
      calls.push(args);
      return queue.shift() ?? ok();
    }),
    getSandboxEnvironment: vi.fn(() => environment),
    clearFileVersionCache,
    clearPrefetchedEditFileCache,
    calls,
  };
}

// ---------------------------------------------------------------------------
// handleRunTests
// ---------------------------------------------------------------------------

describe('handleRunTests — framework resolution', () => {
  it('maps explicit "vitest" framework to `npm test`', async () => {
    const ctx = makeContext([ok('Tests: 3 passed, 0 failed, 3 total')]);
    const result = await handleRunTests(ctx, { framework: 'vitest' });
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.calls[0][1]).toBe('cd /workspace && npm test');
    expect(result.card?.type).toBe('test-results');
    if (result.card?.type === 'test-results') {
      expect(result.card.data.framework).toBe('npm');
      expect(result.card.data.passed).toBe(3);
      expect(result.card.data.failed).toBe(0);
    }
  });

  it('maps explicit "pytest" framework to `pytest -v`', async () => {
    const ctx = makeContext([ok('1 passed, 0 failed')]);
    const result = await handleRunTests(ctx, { framework: 'pytest' });
    expect(ctx.calls[0][1]).toBe('cd /workspace && pytest -v');
    if (result.card?.type === 'test-results') expect(result.card.data.framework).toBe('pytest');
  });

  it('falls back to the raw framework string and flags it unknown', async () => {
    const ctx = makeContext([ok('')]);
    await handleRunTests(ctx, { framework: 'zig build test' });
    expect(ctx.calls[0][1]).toBe('cd /workspace && zig build test');
  });

  it('auto-detects package.json → npm', async () => {
    const ctx = makeContext([ok('package.json\n'), ok('Tests: 2 passed, 1 failed, 3 total')]);
    await handleRunTests(ctx, {});
    expect(ctx.calls).toHaveLength(2);
    expect(ctx.calls[0][1]).toMatch(/ls -1 package.json Cargo.toml/);
    expect(ctx.calls[1][1]).toBe('cd /workspace && npm test');
  });

  it('auto-detects Cargo.toml → cargo test', async () => {
    const ctx = makeContext([ok('Cargo.toml\n'), ok('test result: ok. 4 passed; 0 failed')]);
    const result = await handleRunTests(ctx, {});
    expect(ctx.calls[1][1]).toBe('cd /workspace && cargo test');
    if (result.card?.type === 'test-results') {
      expect(result.card.data.framework).toBe('cargo');
      expect(result.card.data.passed).toBe(4);
    }
  });

  it('auto-detects go.mod → go test', async () => {
    const ctx = makeContext([
      ok('go.mod\n'),
      ok('ok   mypkg/a   0.12s\nok   mypkg/b   0.04s\nFAIL mypkg/c   0.01s'),
    ]);
    const result = await handleRunTests(ctx, {});
    expect(ctx.calls[1][1]).toBe('cd /workspace && go test ./...');
    if (result.card?.type === 'test-results') {
      expect(result.card.data.framework).toBe('go');
      expect(result.card.data.passed).toBe(2);
      expect(result.card.data.failed).toBe(1);
    }
  });

  it('falls back to `npm test` when detection turns up nothing', async () => {
    const ctx = makeContext([ok(''), ok('Tests: 0 passed, 0 failed, 0 total')]);
    await handleRunTests(ctx, {});
    expect(ctx.calls[1][1]).toBe('cd /workspace && npm test');
  });

  it('captures the skipped-count when present', async () => {
    const ctx = makeContext([ok('Tests: 5 passed, 1 failed, 6 total\n2 skipped')]);
    const result = await handleRunTests(ctx, { framework: 'npm' });
    if (result.card?.type === 'test-results') {
      expect(result.card.data.skipped).toBe(2);
      expect(result.card.data.total).toBe(8);
    }
  });

  it('marks output truncated past 8000 chars and clears both caches', async () => {
    const huge = 'x'.repeat(8500);
    const ctx = makeContext([ok(huge)]);
    const result = await handleRunTests(ctx, { framework: 'npm' });
    if (result.card?.type === 'test-results') {
      expect(result.card.data.truncated).toBe(true);
      expect(result.card.data.output.length).toBeLessThan(huge.length + 100);
    }
    expect(ctx.clearFileVersionCache).toHaveBeenCalledWith('sb-1');
    expect(ctx.clearPrefetchedEditFileCache).toHaveBeenCalledWith('sb-1');
  });

  it('threads markWorkspaceMutated: true on the test-exec call', async () => {
    const ctx = makeContext([ok('')]);
    await handleRunTests(ctx, { framework: 'npm' });
    expect(ctx.calls[0][3]).toEqual({ markWorkspaceMutated: true });
  });
});

// ---------------------------------------------------------------------------
// handleCheckTypes
// ---------------------------------------------------------------------------

describe('handleCheckTypes — detection & tool routing', () => {
  it('returns a "no type checker" message when nothing is detected', async () => {
    const ctx = makeContext([ok(''), ok('')]);
    const result = await handleCheckTypes(ctx);
    expect(result.text).toContain('No type checker detected');
    expect(result.card).toBeUndefined();
  });

  it('skips `npm install` when node_modules is already present', async () => {
    const ctx = makeContext([
      ok('tsconfig.json\n'),
      ok('node_modules'),
      ok('Version 5.4.0'),
      ok(''),
    ]);
    await handleCheckTypes(ctx);
    const commands = ctx.calls.map((c) => c[1]);
    expect(commands).not.toContain('cd /workspace && npm install');
    expect(commands).toContain('cd /workspace && npx tsc --noEmit');
  });

  it('runs `npm install` and clears caches when node_modules is missing', async () => {
    const ctx = makeContext([
      ok('tsconfig.json\n'),
      fail('', 'no such file'),
      ok(''),
      ok('Version 5.4.0'),
      ok(''),
    ]);
    await handleCheckTypes(ctx);
    const commands = ctx.calls.map((c) => c[1]);
    expect(commands).toContain('cd /workspace && npm install');
    expect(ctx.clearFileVersionCache).toHaveBeenCalled();
    expect(ctx.clearPrefetchedEditFileCache).toHaveBeenCalled();
  });

  it('returns an install-failure message and aborts when `npm install` fails', async () => {
    const ctx = makeContext([
      ok('tsconfig.json\n'),
      fail('', 'missing'),
      fail('', 'EACCES: permission denied'),
    ]);
    const result = await handleCheckTypes(ctx);
    expect(result.text).toContain('Failed to install dependencies');
    expect(result.text).toContain('EACCES');
    expect(ctx.calls).toHaveLength(3);
  });

  it('parses tsc errors and derives the error count from the summary line', async () => {
    const tscOutput = [
      "src/a.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.",
      "src/a.ts(12,7): error TS2339: Property 'x' does not exist on type 'Y'.",
      'Found 2 errors in 1 file.',
    ].join('\n');
    const ctx = makeContext([
      ok('tsconfig.json\n'),
      ok('node_modules'),
      ok('Version 5.4.0'),
      fail(tscOutput, '', 1),
    ]);
    const result = await handleCheckTypes(ctx);
    if (result.card?.type === 'type-check') {
      expect(result.card.data.tool).toBe('tsc');
      expect(result.card.data.errorCount).toBe(2);
      expect(result.card.data.errors).toHaveLength(2);
      expect(result.card.data.errors[0]).toMatchObject({
        file: 'src/a.ts',
        line: 10,
        column: 5,
        code: 'TS2322',
      });
    }
  });

  it('parses pyright output when pyrightconfig.json is detected', async () => {
    const ctx = makeContext([
      ok('pyrightconfig.json\n'),
      ok('pyright 1.1.350'),
      fail('src/a.py:4:10 - error: Cannot infer type\nsrc/a.py:6:2 - warning: Unused', '', 1),
    ]);
    const result = await handleCheckTypes(ctx);
    if (result.card?.type === 'type-check') {
      expect(result.card.data.tool).toBe('pyright');
      expect(result.card.data.errorCount).toBe(1);
      expect(result.card.data.warningCount).toBe(1);
    }
  });

  it('parses mypy output when mypy.ini is detected', async () => {
    const ctx = makeContext([
      ok('mypy.ini\n'),
      ok('mypy 1.8.0'),
      fail('src/a.py:3: error: Incompatible return value type', '', 1),
    ]);
    const result = await handleCheckTypes(ctx);
    if (result.card?.type === 'type-check') {
      expect(result.card.data.tool).toBe('mypy');
      expect(result.card.data.errorCount).toBe(1);
    }
  });

  it('falls back to tsc via package.json when no config file is detected', async () => {
    const ctx = makeContext([
      ok(''), // detection returns nothing
      ok('{"devDependencies":{"typescript":"5.4.0"}}'),
      ok(''),
    ]);
    await handleCheckTypes(ctx);
    expect(ctx.calls.at(-1)?.[1]).toBe('cd /workspace && npx tsc --noEmit');
  });
});

// ---------------------------------------------------------------------------
// handleVerifyWorkspace
// ---------------------------------------------------------------------------

function envWith(
  readiness: Partial<NonNullable<SandboxEnvironment['readiness']>> | null,
): SandboxEnvironment {
  return {
    tools: {},
    readiness: readiness === null ? undefined : { ...readiness },
  };
}

describe('handleVerifyWorkspace — step assembly', () => {
  it('returns a hint when no steps can be inferred', async () => {
    const ctx = makeContext([], envWith(null));
    const result = await handleVerifyWorkspace(ctx);
    expect(result.text).toContain('No install, typecheck, or test command could be inferred');
    expect(ctx.calls).toHaveLength(0);
  });

  it('surfaces the "could not infer install" warning when deps are missing and package manager is unknown', async () => {
    const ctx = makeContext([], envWith({ dependencies: 'missing', test_command: 'custom-test' }));
    const result = await handleVerifyWorkspace(ctx);
    // The test step still runs because test_command is present, so the warning
    // appears as a Warning line rather than as the sole hint.
    expect(result.text).toContain(
      'Warning: Dependencies appear to be missing, but no install command could be inferred.',
    );
  });

  it('runs install → typecheck → test and reports PASSED when all succeed', async () => {
    const ctx = makeContext(
      [ok('installed'), ok('no errors'), ok('all green')],
      envWith({
        package_manager: 'npm',
        dependencies: 'missing',
        typecheck_command: 'npm run typecheck',
        test_command: 'npm test',
      }),
    );
    const result = await handleVerifyWorkspace(ctx);
    expect(ctx.calls).toHaveLength(3);
    expect(ctx.calls[0][1]).toBe('cd /workspace && npm install');
    expect(ctx.calls[1][1]).toBe('cd /workspace && npm run typecheck');
    expect(ctx.calls[2][1]).toBe('cd /workspace && npm test');
    expect(result.text).toContain('Workspace verification PASSED');
    // install + test mark workspace mutated → two cache clears (one each).
    expect(ctx.clearFileVersionCache).toHaveBeenCalledTimes(2);
    expect(ctx.clearPrefetchedEditFileCache).toHaveBeenCalledTimes(2);
  });

  it('threads the mutation flag per step (typecheck is read-only)', async () => {
    const ctx = makeContext(
      [ok(''), ok('')],
      envWith({
        typecheck_command: 'tsc --noEmit',
        test_command: 'vitest run',
      }),
    );
    await handleVerifyWorkspace(ctx);
    expect(ctx.calls[0][3]).toEqual({ markWorkspaceMutated: false });
    expect(ctx.calls[1][3]).toEqual({ markWorkspaceMutated: true });
  });

  it('stops at the first failing step and reports FAILED with output', async () => {
    const ctx = makeContext(
      [fail('tsc errored', 'TS2322: bad', 1)],
      envWith({
        typecheck_command: 'tsc --noEmit',
        test_command: 'vitest run',
      }),
    );
    const result = await handleVerifyWorkspace(ctx);
    expect(ctx.calls).toHaveLength(1);
    expect(result.text).toContain('Workspace verification FAILED at typecheck');
    expect(result.text).toContain('TS2322');
    expect(result.text).toContain('Tip: rerun test() or typecheck() directly');
  });

  it('omits the rerun tip when the failing step is the install step', async () => {
    const ctx = makeContext(
      [fail('', 'npm ERR!', 1)],
      envWith({ package_manager: 'pnpm', dependencies: 'missing' }),
    );
    const result = await handleVerifyWorkspace(ctx);
    expect(ctx.calls[0][1]).toBe('cd /workspace && pnpm install');
    expect(result.text).toContain('Workspace verification FAILED at install');
    expect(result.text).not.toContain('Tip: rerun test() or typecheck()');
  });

  it('truncates failed-step output past 4000 characters', async () => {
    const giant = 'y'.repeat(4500);
    const ctx = makeContext([fail(giant, '', 1)], envWith({ test_command: 'npm test' }));
    const result = await handleVerifyWorkspace(ctx);
    expect(result.text).toContain('[output truncated]');
  });

  it.each([
    ['npm', 'npm install'],
    ['yarn', 'yarn install'],
    ['pnpm', 'pnpm install'],
    ['bun', 'bun install'],
  ])('infers `%s install` from readiness.package_manager=%s', async (pm, expected) => {
    const ctx = makeContext([ok('')], envWith({ dependencies: 'missing', package_manager: pm }));
    await handleVerifyWorkspace(ctx);
    expect(ctx.calls[0][1]).toBe(`cd /workspace && ${expected}`);
  });
});
