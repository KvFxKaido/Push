/**
 * Characterization tests for the verification tool family in sandbox-tools.ts:
 *   - sandbox_run_tests
 *   - sandbox_check_types
 *
 * These tests pin the current observable behavior of each tool — exact command
 * sequences, mutation flags on execInSandbox, cache-invalidation side effects,
 * card shapes, and user-visible text. They exist so that the upcoming extraction
 * of the verification family into its own handler module (architecture
 * remediation step 4) can be validated as behavior-preserving.
 *
 * This file is intentionally separate from sandbox-tools.test.ts so that the
 * partial module mocks for the file-version / edit-ops caches do not leak into
 * the much larger edit-family test suite.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mocks must be set up before importing the module under test ----

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

// Mock auditor-agent (pulled in transitively by sandbox-tools module load).
vi.mock('./auditor-agent', () => ({
  runAuditor: vi.fn(),
}));

vi.mock('./edit-metrics', () => ({
  recordWriteFileMetric: vi.fn(),
  recordReadFileMetric: vi.fn(),
}));

// Provide a real tool-dispatch since other code paths rely on it.
vi.mock('./tool-dispatch', async () => {
  const actual = await vi.importActual<typeof import('./tool-dispatch')>('./tool-dispatch');
  return {
    extractBareToolJsonObjects: actual.extractBareToolJsonObjects,
  };
});

// Partial-mock the two cache modules so we can observe the cache-invalidation
// side effects without disturbing the rest of their exports (which sandbox-tools
// imports for unrelated reasons).
vi.mock('./sandbox-file-version-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sandbox-file-version-cache')>();
  return {
    ...actual,
    clearFileVersionCache: vi.fn(),
  };
});

vi.mock('./sandbox-edit-ops', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sandbox-edit-ops')>();
  return {
    ...actual,
    clearPrefetchedEditFileCache: vi.fn(),
  };
});

import { executeSandboxToolCall } from './sandbox-tools';
import * as sandboxClient from './sandbox-client';
import { clearFileVersionCache } from './sandbox-file-version-cache';
import { clearPrefetchedEditFileCache } from './sandbox-edit-ops';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type ExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
};

const ok = (stdout = '', stderr = ''): ExecResult => ({
  exitCode: 0,
  stdout,
  stderr,
  truncated: false,
});

const fail = (stdout = '', stderr = '', exitCode = 1): ExecResult => ({
  exitCode,
  stdout,
  stderr,
  truncated: false,
});

function resetMocks() {
  vi.mocked(sandboxClient.execInSandbox).mockReset();
  vi.mocked(clearFileVersionCache).mockReset();
  vi.mocked(clearPrefetchedEditFileCache).mockReset();
}

// ---------------------------------------------------------------------------
// sandbox_run_tests
// ---------------------------------------------------------------------------

describe('executeSandboxToolCall -- sandbox_run_tests', () => {
  beforeEach(() => {
    resetMocks();
  });

  it('auto-detects npm from package.json and runs npm test with mutation flag + cache clear', async () => {
    vi.mocked(sandboxClient.execInSandbox)
      // 1. detection probe
      .mockResolvedValueOnce(ok('package.json\n'))
      // 2. actual test run — jest-style output
      .mockResolvedValueOnce(
        ok('Tests: 5 passed, 0 failed, 5 total\nTest Suites: 1 passed, 1 total\n'),
      );

    const result = await executeSandboxToolCall({ tool: 'sandbox_run_tests', args: {} }, 'sb-run');

    // Detection call: no mutation flag
    expect(sandboxClient.execInSandbox).toHaveBeenNthCalledWith(
      1,
      'sb-run',
      'cd /workspace && ls -1 package.json Cargo.toml go.mod pytest.ini pyproject.toml setup.py 2>/dev/null | head -1',
    );
    // Exec call: mutation flag is always true, even on success.
    expect(sandboxClient.execInSandbox).toHaveBeenNthCalledWith(
      2,
      'sb-run',
      'cd /workspace && npm test',
      undefined,
      { markWorkspaceMutated: true },
    );
    // Caches are always cleared after a test run.
    expect(clearFileVersionCache).toHaveBeenCalledWith('sb-run');
    expect(clearPrefetchedEditFileCache).toHaveBeenCalledWith('sb-run');

    expect(result.text).toContain('[Tool Result — sandbox_run_tests]');
    expect(result.text).toContain('✓ Tests PASSED (npm)');
    expect(result.text).toContain('Command: npm test');
    expect(result.text).toContain('Results: 5 passed, 0 failed');

    expect(result.card).toBeDefined();
    expect(result.card?.type).toBe('test-results');
    const data = result.card?.data as {
      framework: string;
      passed: number;
      failed: number;
      total: number;
      exitCode: number;
      truncated: boolean;
    };
    expect(data.framework).toBe('npm');
    expect(data.passed).toBe(5);
    expect(data.failed).toBe(0);
    expect(data.total).toBe(5);
    expect(data.exitCode).toBe(0);
    expect(data.truncated).toBe(false);
  });

  it('auto-detects pytest from pyproject.toml and parses pytest-style output', async () => {
    vi.mocked(sandboxClient.execInSandbox)
      .mockResolvedValueOnce(ok('pyproject.toml\n'))
      .mockResolvedValueOnce(ok('3 passed, 1 failed in 0.12s\n', ''));

    const result = await executeSandboxToolCall({ tool: 'sandbox_run_tests', args: {} }, 'sb-py');

    expect(sandboxClient.execInSandbox).toHaveBeenNthCalledWith(
      2,
      'sb-py',
      'cd /workspace && pytest -v',
      undefined,
      { markWorkspaceMutated: true },
    );
    expect(result.text).toContain('✓ Tests PASSED (pytest)');
    const data = result.card?.data as {
      framework: string;
      passed: number;
      failed: number;
    };
    expect(data.framework).toBe('pytest');
    expect(data.passed).toBe(3);
    expect(data.failed).toBe(1);
  });

  it('falls back to npm test when auto-detection finds nothing', async () => {
    vi.mocked(sandboxClient.execInSandbox)
      .mockResolvedValueOnce(ok('')) // nothing detected
      .mockResolvedValueOnce(ok('Tests: 0 passed, 0 failed, 0 total\n'));

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_run_tests', args: {} },
      'sb-fallback',
    );

    expect(sandboxClient.execInSandbox).toHaveBeenNthCalledWith(
      2,
      'sb-fallback',
      'cd /workspace && npm test',
      undefined,
      { markWorkspaceMutated: true },
    );
    const data = result.card?.data as { framework: string };
    expect(data.framework).toBe('npm');
  });

  it('honors an explicit framework arg and parses cargo output on failure', async () => {
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValueOnce(
      fail('test result: FAILED. 7 passed; 2 failed; 0 ignored; 0 measured\n', '', 101),
    );

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_run_tests', args: { framework: 'cargo' } },
      'sb-cargo',
    );

    // Explicit framework skips the detection probe — exec happens on the first call.
    expect(sandboxClient.execInSandbox).toHaveBeenCalledTimes(1);
    expect(sandboxClient.execInSandbox).toHaveBeenNthCalledWith(
      1,
      'sb-cargo',
      'cd /workspace && cargo test',
      undefined,
      { markWorkspaceMutated: true },
    );
    // Cache still cleared even on failure.
    expect(clearFileVersionCache).toHaveBeenCalledWith('sb-cargo');
    expect(clearPrefetchedEditFileCache).toHaveBeenCalledWith('sb-cargo');

    expect(result.text).toContain('✗ Tests FAILED (cargo)');
    const data = result.card?.data as {
      framework: string;
      passed: number;
      failed: number;
      exitCode: number;
    };
    expect(data.framework).toBe('cargo');
    expect(data.passed).toBe(7);
    expect(data.failed).toBe(2);
    expect(data.exitCode).toBe(101);
  });

  it('treats an unrecognized framework arg as a literal command with framework=unknown', async () => {
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValueOnce(ok('custom test runner output\n'));

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_run_tests', args: { framework: 'make check' } },
      'sb-custom',
    );

    expect(sandboxClient.execInSandbox).toHaveBeenNthCalledWith(
      1,
      'sb-custom',
      'cd /workspace && make check',
      undefined,
      { markWorkspaceMutated: true },
    );
    const data = result.card?.data as { framework: string };
    expect(data.framework).toBe('unknown');
  });

  it('marks the card truncated and appends the truncation marker when output exceeds 8000 chars', async () => {
    const big = 'x'.repeat(8500);
    vi.mocked(sandboxClient.execInSandbox)
      .mockResolvedValueOnce(ok('package.json\n'))
      .mockResolvedValueOnce(ok(big));

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_run_tests', args: {} },
      'sb-trunc',
    );

    const data = result.card?.data as { truncated: boolean; output: string };
    expect(data.truncated).toBe(true);
    expect(data.output).toContain('[...output truncated]');
    expect(data.output.length).toBeLessThanOrEqual(8000 + '[...output truncated]'.length + 8);
  });
});

// ---------------------------------------------------------------------------
// sandbox_check_types
// ---------------------------------------------------------------------------

describe('executeSandboxToolCall -- sandbox_check_types', () => {
  beforeEach(() => {
    resetMocks();
  });

  it('runs npx tsc --noEmit when tsconfig.json is detected and node_modules is present', async () => {
    vi.mocked(sandboxClient.execInSandbox)
      // 1. detect
      .mockResolvedValueOnce(ok('tsconfig.json\n'))
      // 2. node_modules probe — present
      .mockResolvedValueOnce(ok('node_modules\n'))
      // 3. tsc version check
      .mockResolvedValueOnce(ok('Version 5.4.0\n'))
      // 4. actual type check
      .mockResolvedValueOnce(ok('', ''));

    const result = await executeSandboxToolCall({ tool: 'sandbox_check_types', args: {} }, 'sb-ts');

    // No npm install should have fired — so no cache clear either.
    const calls = vi.mocked(sandboxClient.execInSandbox).mock.calls.map((c) => c[1] as string);
    expect(calls).not.toContain('cd /workspace && npm install');
    expect(clearFileVersionCache).not.toHaveBeenCalled();
    expect(clearPrefetchedEditFileCache).not.toHaveBeenCalled();

    // The actual typecheck exec call is marked mutated (matches current behavior).
    expect(sandboxClient.execInSandbox).toHaveBeenLastCalledWith(
      'sb-ts',
      'cd /workspace && npx tsc --noEmit',
      undefined,
      { markWorkspaceMutated: true },
    );

    expect(result.text).toContain('[Tool Result — sandbox_check_types]');
    expect(result.text).toContain('✓ Type check PASSED (tsc)');
    expect(result.text).toContain('Command: npx tsc --noEmit');

    const data = result.card?.data as {
      tool: string;
      errorCount: number;
      warningCount: number;
      exitCode: number;
    };
    expect(result.card?.type).toBe('type-check');
    expect(data.tool).toBe('tsc');
    expect(data.errorCount).toBe(0);
    expect(data.warningCount).toBe(0);
    expect(data.exitCode).toBe(0);
  });

  it('installs dependencies first (with mutation flag + cache clear) when node_modules is missing', async () => {
    vi.mocked(sandboxClient.execInSandbox)
      // detect
      .mockResolvedValueOnce(ok('tsconfig.json\n'))
      // node_modules probe — missing
      .mockResolvedValueOnce(fail('', 'No such file', 1))
      // npm install succeeds
      .mockResolvedValueOnce(ok('added 123 packages\n'))
      // tsc version check
      .mockResolvedValueOnce(ok('Version 5.4.0\n'))
      // actual type check
      .mockResolvedValueOnce(ok('', ''));

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_check_types', args: {} },
      'sb-install',
    );

    // npm install runs with mutation flag set
    expect(sandboxClient.execInSandbox).toHaveBeenNthCalledWith(
      3,
      'sb-install',
      'cd /workspace && npm install',
      undefined,
      { markWorkspaceMutated: true },
    );
    // Caches cleared once after the install
    expect(clearFileVersionCache).toHaveBeenCalledTimes(1);
    expect(clearFileVersionCache).toHaveBeenCalledWith('sb-install');
    expect(clearPrefetchedEditFileCache).toHaveBeenCalledTimes(1);
    expect(clearPrefetchedEditFileCache).toHaveBeenCalledWith('sb-install');

    expect(result.text).toContain('✓ Type check PASSED (tsc)');
  });

  it('short-circuits with an install-failure message when npm install fails', async () => {
    vi.mocked(sandboxClient.execInSandbox)
      .mockResolvedValueOnce(ok('tsconfig.json\n'))
      .mockResolvedValueOnce(fail('', '', 1))
      .mockResolvedValueOnce(fail('', 'ENOENT: missing lockfile', 1));

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_check_types', args: {} },
      'sb-noinstall',
    );

    expect(result.text).toContain('Failed to install dependencies');
    expect(result.text).toContain('ENOENT: missing lockfile');
    // No card emitted on early return.
    expect(result.card).toBeUndefined();
    // Cache clearing must not fire when install itself failed.
    expect(clearFileVersionCache).not.toHaveBeenCalled();
    expect(clearPrefetchedEditFileCache).not.toHaveBeenCalled();
  });

  it('recognizes tsconfig.app.json as a TypeScript project', async () => {
    vi.mocked(sandboxClient.execInSandbox)
      .mockResolvedValueOnce(ok('tsconfig.app.json\n'))
      .mockResolvedValueOnce(ok('node_modules\n'))
      .mockResolvedValueOnce(ok('Version 5.4.0\n'))
      .mockResolvedValueOnce(ok('', ''));

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_check_types', args: {} },
      'sb-tsapp',
    );

    expect(sandboxClient.execInSandbox).toHaveBeenLastCalledWith(
      'sb-tsapp',
      'cd /workspace && npx tsc --noEmit',
      undefined,
      { markWorkspaceMutated: true },
    );
    const data = result.card?.data as { tool: string };
    expect(data.tool).toBe('tsc');
  });

  it('routes pyrightconfig.json to pyright and parses pyright error lines', async () => {
    vi.mocked(sandboxClient.execInSandbox)
      .mockResolvedValueOnce(ok('pyrightconfig.json\n'))
      .mockResolvedValueOnce(ok('pyright 1.1.350\n'))
      .mockResolvedValueOnce(
        fail('src/foo.py:10:5 - error: Argument of type "int" is not assignable\n', '', 1),
      );

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_check_types', args: {} },
      'sb-pyright',
    );

    expect(sandboxClient.execInSandbox).toHaveBeenLastCalledWith(
      'sb-pyright',
      'cd /workspace && pyright',
      undefined,
      { markWorkspaceMutated: true },
    );
    expect(result.text).toContain('✗ Type check FAILED (pyright)');
    const data = result.card?.data as {
      tool: string;
      errorCount: number;
      errors: Array<{
        file: string;
        line: number;
        column: number;
        message: string;
      }>;
    };
    expect(data.tool).toBe('pyright');
    expect(data.errorCount).toBe(1);
    expect(data.errors).toHaveLength(1);
    expect(data.errors[0]).toMatchObject({
      file: 'src/foo.py',
      line: 10,
      column: 5,
    });
    expect(data.errors[0].message).toContain('Argument of type');
  });

  it('routes mypy.ini to mypy and runs the bare `mypy` command', async () => {
    vi.mocked(sandboxClient.execInSandbox)
      .mockResolvedValueOnce(ok('mypy.ini\n'))
      .mockResolvedValueOnce(ok('mypy 1.9.0\n'))
      .mockResolvedValueOnce(ok('Success: no issues found\n'));

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_check_types', args: {} },
      'sb-mypy',
    );

    expect(sandboxClient.execInSandbox).toHaveBeenLastCalledWith(
      'sb-mypy',
      'cd /workspace && mypy',
      undefined,
      { markWorkspaceMutated: true },
    );
    const data = result.card?.data as { tool: string };
    expect(data.tool).toBe('mypy');
  });

  it('falls back to tsc when no config file matches but package.json mentions typescript', async () => {
    vi.mocked(sandboxClient.execInSandbox)
      // detect — returns nothing
      .mockResolvedValueOnce(ok(''))
      // package.json cat with typescript dep
      .mockResolvedValueOnce(ok('{"devDependencies":{"typescript":"^5.4.0"}}'))
      // actual tsc run
      .mockResolvedValueOnce(ok('', ''));

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_check_types', args: {} },
      'sb-tsfallback',
    );

    expect(sandboxClient.execInSandbox).toHaveBeenLastCalledWith(
      'sb-tsfallback',
      'cd /workspace && npx tsc --noEmit',
      undefined,
      { markWorkspaceMutated: true },
    );
    const data = result.card?.data as { tool: string };
    expect(data.tool).toBe('tsc');
  });

  it('returns the "No type checker detected" message when nothing matches', async () => {
    vi.mocked(sandboxClient.execInSandbox)
      // detect — nothing
      .mockResolvedValueOnce(ok(''))
      // package.json cat — no typescript dep
      .mockResolvedValueOnce(ok('{"dependencies":{"lodash":"^4"}}'));

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_check_types', args: {} },
      'sb-none',
    );

    expect(result.text).toContain('No type checker detected');
    expect(result.text).toContain('TypeScript (tsc), Pyright, mypy');
    expect(result.card).toBeUndefined();
    // No exec beyond the two probes.
    expect(sandboxClient.execInSandbox).toHaveBeenCalledTimes(2);
  });

  it('parses multiple tsc errors into the card up to the per-call limit', async () => {
    const tscOut = [
      'src/a.ts(10,5): error TS2322: Type "string" is not assignable to type "number".',
      'src/b.ts(22,12): error TS2345: Argument of type "X" is not assignable.',
      'src/c.ts(3,1): warning TS6133: "foo" is declared but its value is never read.',
      'Found 2 errors in 2 files.',
    ].join('\n');

    vi.mocked(sandboxClient.execInSandbox)
      .mockResolvedValueOnce(ok('tsconfig.json\n'))
      .mockResolvedValueOnce(ok('node_modules\n'))
      .mockResolvedValueOnce(ok('Version 5.4.0\n'))
      .mockResolvedValueOnce(fail(tscOut, '', 1));

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_check_types', args: {} },
      'sb-tserr',
    );

    expect(result.text).toContain('✗ Type check FAILED (tsc)');
    expect(result.text).toContain('Found: 2 errors, 1 warning');

    const data = result.card?.data as {
      errorCount: number;
      warningCount: number;
      errors: Array<{
        file: string;
        line: number;
        column: number;
        code?: string;
      }>;
    };
    expect(data.errorCount).toBe(2);
    expect(data.warningCount).toBe(1);
    expect(data.errors).toHaveLength(3);
    expect(data.errors[0]).toMatchObject({
      file: 'src/a.ts',
      line: 10,
      column: 5,
      code: 'TS2322',
    });
    expect(data.errors[2]).toMatchObject({
      file: 'src/c.ts',
      line: 3,
      column: 1,
      code: 'TS6133',
    });
  });
});
