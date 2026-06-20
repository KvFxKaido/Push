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
  execLongRunningInSandbox: vi.fn(),
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
  vi.mocked(sandboxClient.execLongRunningInSandbox).mockReset();
  vi.mocked(sandboxClient.getSandboxEnvironment).mockReset();
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
    // First buffered exec reads instruction files for a `# test:` override
    // (none here), then the config-file detection probe; the actual test run
    // goes through the detached long-running path (live tail, no ceiling).
    vi.mocked(sandboxClient.execInSandbox)
      .mockResolvedValueOnce(ok('')) // override read: no instruction-file override
      .mockResolvedValueOnce(ok('package.json\n')); // detection probe
    vi.mocked(sandboxClient.execLongRunningInSandbox).mockResolvedValueOnce(
      ok('Tests: 5 passed, 0 failed, 5 total\nTest Suites: 1 passed, 1 total\n'),
    );

    const result = await executeSandboxToolCall({ tool: 'sandbox_run_tests', args: {} }, 'sb-run');

    // Detection call: buffered exec, no mutation flag (2nd exec, after the
    // override read).
    expect(sandboxClient.execInSandbox).toHaveBeenNthCalledWith(
      2,
      'sb-run',
      'cd /workspace && ls -1 package.json Cargo.toml go.mod pytest.ini pyproject.toml setup.py 2>/dev/null | head -1',
    );
    // Run call: detached path, mutation flag is always true, even on success.
    expect(sandboxClient.execLongRunningInSandbox).toHaveBeenCalledWith(
      'sb-run',
      'cd /workspace && npm test',
      expect.objectContaining({ markWorkspaceMutated: true }),
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
    // Internally consistent all-pass scenario: exit code 0 and the parsed
    // counts agree. The cargo failure test below pins the parsed-with-failure
    // branch; keeping this scenario clean avoids any ambiguity about whether
    // PASS/FAIL keys off exit code or parsed counts.
    vi.mocked(sandboxClient.execInSandbox)
      .mockResolvedValueOnce(ok('')) // override read: none
      .mockResolvedValueOnce(ok('pyproject.toml\n')); // detection probe
    vi.mocked(sandboxClient.execLongRunningInSandbox).mockResolvedValueOnce(
      ok('3 passed, 0 failed in 0.12s\n', ''),
    );

    const result = await executeSandboxToolCall({ tool: 'sandbox_run_tests', args: {} }, 'sb-py');

    expect(sandboxClient.execLongRunningInSandbox).toHaveBeenCalledWith(
      'sb-py',
      'cd /workspace && pytest -v',
      expect.objectContaining({ markWorkspaceMutated: true }),
    );
    expect(result.text).toContain('✓ Tests PASSED (pytest)');
    const data = result.card?.data as {
      framework: string;
      passed: number;
      failed: number;
    };
    expect(data.framework).toBe('pytest');
    expect(data.passed).toBe(3);
    expect(data.failed).toBe(0);
  });

  it('falls back to npm test when auto-detection finds nothing', async () => {
    vi.mocked(sandboxClient.execInSandbox)
      .mockResolvedValueOnce(ok('')) // override read: none
      .mockResolvedValueOnce(ok('')); // detection probe: nothing detected
    vi.mocked(sandboxClient.execLongRunningInSandbox).mockResolvedValueOnce(
      ok('Tests: 0 passed, 0 failed, 0 total\n'),
    );

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_run_tests', args: {} },
      'sb-fallback',
    );

    expect(sandboxClient.execLongRunningInSandbox).toHaveBeenCalledWith(
      'sb-fallback',
      'cd /workspace && npm test',
      expect.objectContaining({ markWorkspaceMutated: true }),
    );
    const data = result.card?.data as { framework: string };
    expect(data.framework).toBe('npm');
  });

  it('honors a `# test:` override from AGENTS.md over readiness and probing', async () => {
    // The override read (1st buffered exec) returns an AGENTS.md fenced block;
    // it beats both readiness and the config-file probe, and no probe runs.
    const agentsOverride = [
      '===PUSH_VC_FILE===',
      '```bash',
      '# test:',
      'npm run test:cli && npm run test:mcp:github',
      '```',
    ].join('\n');
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValueOnce(ok(agentsOverride));
    vi.mocked(sandboxClient.getSandboxEnvironment).mockReturnValueOnce({
      tools: {},
      readiness: { package_manager: 'npm', test_command: 'npm test' },
    });
    vi.mocked(sandboxClient.execLongRunningInSandbox).mockResolvedValueOnce(
      ok('Tests: 12 passed, 0 failed, 12 total\n'),
    );

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_run_tests', args: {} },
      'sb-override',
    );

    // Only the override read ran on the buffered exec — no `ls` detection probe.
    expect(sandboxClient.execInSandbox).toHaveBeenCalledTimes(1);
    expect(sandboxClient.execLongRunningInSandbox).toHaveBeenCalledWith(
      'sb-override',
      'cd /workspace && npm run test:cli && npm run test:mcp:github',
      expect.objectContaining({ markWorkspaceMutated: true }),
    );
    expect(result.text).toContain('Command: npm run test:cli && npm run test:mcp:github');
  });

  it('honors a `# test:` override from PUSH.md before AGENTS.md', async () => {
    const overrideSources = [
      '===PUSH_VC_FILE===',
      '```bash',
      '# test:',
      'npm run push-test',
      '```',
      '===PUSH_VC_FILE===',
      '```bash',
      '# test:',
      'npm run agents-test',
      '```',
    ].join('\n');
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValueOnce(ok(overrideSources));
    vi.mocked(sandboxClient.getSandboxEnvironment).mockReturnValueOnce({
      tools: {},
      readiness: { package_manager: 'npm', test_command: 'npm test' },
    });
    vi.mocked(sandboxClient.execLongRunningInSandbox).mockResolvedValueOnce(
      ok('Tests: 3 passed, 0 failed, 3 total\n'),
    );

    await executeSandboxToolCall({ tool: 'sandbox_run_tests', args: {} }, 'sb-push');

    expect(sandboxClient.execInSandbox).toHaveBeenCalledWith(
      'sb-push',
      'cd /workspace && for f in PUSH.md AGENTS.md CLAUDE.md GEMINI.md; do if [ -f "$f" ]; then printf "\\n===PUSH_VC_FILE===\\n"; head -c 20000 "$f"; fi; done',
    );
    expect(sandboxClient.execLongRunningInSandbox).toHaveBeenCalledWith(
      'sb-push',
      'cd /workspace && npm run push-test',
      expect.objectContaining({ markWorkspaceMutated: true }),
    );
  });

  it('prefers the readiness-detected test command over the npm test fallback', async () => {
    // No override (1st exec returns nothing), but the sandbox already resolved
    // the real test script — run_tests uses it and skips the config-file probe.
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValueOnce(ok('')); // override read: none
    vi.mocked(sandboxClient.getSandboxEnvironment).mockReturnValueOnce({
      tools: {},
      readiness: { package_manager: 'pnpm', test_command: 'pnpm test' },
    });
    vi.mocked(sandboxClient.execLongRunningInSandbox).mockResolvedValueOnce(
      ok('Tests: 9 passed, 0 failed, 9 total\n'),
    );

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_run_tests', args: {} },
      'sb-readiness',
    );

    // Only the override read ran on the buffered exec — the readiness command
    // short-circuits the config-file detection probe.
    expect(sandboxClient.execInSandbox).toHaveBeenCalledTimes(1);
    expect(sandboxClient.execLongRunningInSandbox).toHaveBeenCalledWith(
      'sb-readiness',
      'cd /workspace && pnpm test',
      expect.objectContaining({ markWorkspaceMutated: true }),
    );
    expect(result.text).toContain('Command: pnpm test');
    const data = result.card?.data as { framework: string; passed: number };
    expect(data.framework).toBe('npm');
    expect(data.passed).toBe(9);
  });

  it('forwards the live-output observer + abort signal to the detached test run', async () => {
    vi.mocked(sandboxClient.execInSandbox)
      .mockResolvedValueOnce(ok('')) // override read: none
      .mockResolvedValueOnce(ok('package.json\n')); // detection probe
    vi.mocked(sandboxClient.execLongRunningInSandbox).mockResolvedValueOnce(
      ok('Tests: 1 passed, 0 failed, 1 total\n'),
    );
    const onExecProgress = vi.fn();
    const abortSignal = new AbortController().signal;

    await executeSandboxToolCall({ tool: 'sandbox_run_tests', args: {} }, 'sb-progress', {
      onExecProgress,
      abortSignal,
    });

    expect(sandboxClient.execLongRunningInSandbox).toHaveBeenCalledWith(
      'sb-progress',
      'cd /workspace && npm test',
      expect.objectContaining({ onProgress: onExecProgress, abortSignal }),
    );
  });

  it('honors an explicit framework arg and parses cargo output on failure', async () => {
    vi.mocked(sandboxClient.execLongRunningInSandbox).mockResolvedValueOnce(
      fail('test result: FAILED. 7 passed; 2 failed; 0 ignored; 0 measured\n', '', 101),
    );

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_run_tests', args: { framework: 'cargo' } },
      'sb-cargo',
    );

    // Explicit framework skips the detection probe — no buffered exec at all.
    expect(sandboxClient.execInSandbox).not.toHaveBeenCalled();
    expect(sandboxClient.execLongRunningInSandbox).toHaveBeenCalledWith(
      'sb-cargo',
      'cd /workspace && cargo test',
      expect.objectContaining({ markWorkspaceMutated: true }),
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
    vi.mocked(sandboxClient.execLongRunningInSandbox).mockResolvedValueOnce(
      ok('custom test runner output\n'),
    );

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_run_tests', args: { framework: 'make check' } },
      'sb-custom',
    );

    expect(sandboxClient.execLongRunningInSandbox).toHaveBeenCalledWith(
      'sb-custom',
      'cd /workspace && make check',
      expect.objectContaining({ markWorkspaceMutated: true }),
    );
    const data = result.card?.data as { framework: string };
    expect(data.framework).toBe('unknown');
  });

  it('marks the card truncated and appends the truncation marker when output exceeds 8000 chars', async () => {
    const big = 'x'.repeat(8500);
    vi.mocked(sandboxClient.execInSandbox)
      .mockResolvedValueOnce(ok('')) // override read: none
      .mockResolvedValueOnce(ok('package.json\n')); // detection probe
    vi.mocked(sandboxClient.execLongRunningInSandbox).mockResolvedValueOnce(ok(big));

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
      .mockResolvedValueOnce(ok('Version 5.4.0\n'));
    // 4. actual type check — now runs on the detached long-running path.
    vi.mocked(sandboxClient.execLongRunningInSandbox).mockResolvedValueOnce(ok('', ''));

    const result = await executeSandboxToolCall({ tool: 'sandbox_check_types', args: {} }, 'sb-ts');

    // No npm install should have fired on this path.
    const calls = vi.mocked(sandboxClient.execInSandbox).mock.calls.map((c) => c[1] as string);
    expect(calls).not.toContain('cd /workspace && npm install');
    // Cache clearing now fires after the final typecheck exec (same
    // rationale as sandbox_run_tests — the typecheck is marked mutated
    // so the file-version/prefetch caches must be invalidated to avoid
    // stale WORKSPACE_CHANGED errors on subsequent edits).
    expect(clearFileVersionCache).toHaveBeenCalledTimes(1);
    expect(clearFileVersionCache).toHaveBeenCalledWith('sb-ts');
    expect(clearPrefetchedEditFileCache).toHaveBeenCalledTimes(1);
    expect(clearPrefetchedEditFileCache).toHaveBeenCalledWith('sb-ts');

    // The actual typecheck runs detached, marked mutated.
    expect(sandboxClient.execLongRunningInSandbox).toHaveBeenCalledWith(
      'sb-ts',
      'cd /workspace && npx tsc --noEmit',
      expect.objectContaining({ markWorkspaceMutated: true }),
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
      // tsc version check
      .mockResolvedValueOnce(ok('Version 5.4.0\n'));
    // Both npm install and the typecheck now run through the detached path, in
    // that order.
    vi.mocked(sandboxClient.execLongRunningInSandbox)
      .mockResolvedValueOnce(ok('added 123 packages\n')) // npm install
      .mockResolvedValueOnce(ok('', '')); // typecheck

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_check_types', args: {} },
      'sb-install',
    );

    // npm install runs detached, with the mutation flag set. The context
    // adapter calls the export with an opts bag (workdir + mutation flag).
    expect(sandboxClient.execLongRunningInSandbox).toHaveBeenCalledWith(
      'sb-install',
      'cd /workspace && npm install',
      expect.objectContaining({ workdir: undefined, markWorkspaceMutated: true }),
    );
    // ...and the typecheck runs detached too.
    expect(sandboxClient.execLongRunningInSandbox).toHaveBeenCalledWith(
      'sb-install',
      'cd /workspace && npx tsc --noEmit',
      expect.objectContaining({ markWorkspaceMutated: true }),
    );
    // Caches cleared twice: once after the npm install, and once after
    // the final typecheck exec (which also marks the workspace mutated).
    expect(clearFileVersionCache).toHaveBeenCalledTimes(2);
    expect(clearFileVersionCache).toHaveBeenCalledWith('sb-install');
    expect(clearPrefetchedEditFileCache).toHaveBeenCalledTimes(2);
    expect(clearPrefetchedEditFileCache).toHaveBeenCalledWith('sb-install');

    expect(result.text).toContain('✓ Type check PASSED (tsc)');
  });

  it('short-circuits with an install-failure message when npm install fails', async () => {
    vi.mocked(sandboxClient.execInSandbox)
      .mockResolvedValueOnce(ok('tsconfig.json\n'))
      .mockResolvedValueOnce(fail('', '', 1));
    // The detached install fails.
    vi.mocked(sandboxClient.execLongRunningInSandbox).mockResolvedValueOnce(
      fail('', 'ENOENT: missing lockfile', 1),
    );

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
      .mockResolvedValueOnce(ok('Version 5.4.0\n'));
    vi.mocked(sandboxClient.execLongRunningInSandbox).mockResolvedValueOnce(ok('', ''));

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_check_types', args: {} },
      'sb-tsapp',
    );

    expect(sandboxClient.execLongRunningInSandbox).toHaveBeenCalledWith(
      'sb-tsapp',
      'cd /workspace && npx tsc --noEmit',
      expect.objectContaining({ markWorkspaceMutated: true }),
    );
    const data = result.card?.data as { tool: string };
    expect(data.tool).toBe('tsc');
  });

  it('routes pyrightconfig.json to pyright and parses pyright error lines', async () => {
    vi.mocked(sandboxClient.execInSandbox)
      .mockResolvedValueOnce(ok('pyrightconfig.json\n'))
      .mockResolvedValueOnce(ok('pyright 1.1.350\n'));
    vi.mocked(sandboxClient.execLongRunningInSandbox).mockResolvedValueOnce(
      fail('src/foo.py:10:5 - error: Argument of type "int" is not assignable\n', '', 1),
    );

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_check_types', args: {} },
      'sb-pyright',
    );

    expect(sandboxClient.execLongRunningInSandbox).toHaveBeenCalledWith(
      'sb-pyright',
      'cd /workspace && pyright',
      expect.objectContaining({ markWorkspaceMutated: true }),
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
      .mockResolvedValueOnce(ok('mypy 1.9.0\n'));
    vi.mocked(sandboxClient.execLongRunningInSandbox).mockResolvedValueOnce(
      ok('Success: no issues found\n'),
    );

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_check_types', args: {} },
      'sb-mypy',
    );

    expect(sandboxClient.execLongRunningInSandbox).toHaveBeenCalledWith(
      'sb-mypy',
      'cd /workspace && mypy',
      expect.objectContaining({ markWorkspaceMutated: true }),
    );
    const data = result.card?.data as { tool: string };
    expect(data.tool).toBe('mypy');
  });

  it('falls back to tsc when no config file matches but package.json mentions typescript', async () => {
    vi.mocked(sandboxClient.execInSandbox)
      // detect — returns nothing
      .mockResolvedValueOnce(ok(''))
      // package.json cat with typescript dep
      .mockResolvedValueOnce(ok('{"devDependencies":{"typescript":"^5.4.0"}}'));
    // actual tsc run — detached path
    vi.mocked(sandboxClient.execLongRunningInSandbox).mockResolvedValueOnce(ok('', ''));

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_check_types', args: {} },
      'sb-tsfallback',
    );

    expect(sandboxClient.execLongRunningInSandbox).toHaveBeenCalledWith(
      'sb-tsfallback',
      'cd /workspace && npx tsc --noEmit',
      expect.objectContaining({ markWorkspaceMutated: true }),
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

  it('forwards the live-output observer + abort signal to the detached typecheck run', async () => {
    vi.mocked(sandboxClient.execInSandbox)
      .mockResolvedValueOnce(ok('tsconfig.json\n'))
      .mockResolvedValueOnce(ok('node_modules\n'))
      .mockResolvedValueOnce(ok('Version 5.4.0\n'));
    vi.mocked(sandboxClient.execLongRunningInSandbox).mockResolvedValueOnce(ok('', ''));
    const onExecProgress = vi.fn();
    const abortSignal = new AbortController().signal;

    await executeSandboxToolCall({ tool: 'sandbox_check_types', args: {} }, 'sb-ts-progress', {
      onExecProgress,
      abortSignal,
    });

    expect(sandboxClient.execLongRunningInSandbox).toHaveBeenCalledWith(
      'sb-ts-progress',
      'cd /workspace && npx tsc --noEmit',
      expect.objectContaining({ onProgress: onExecProgress, abortSignal }),
    );
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
      .mockResolvedValueOnce(ok('Version 5.4.0\n'));
    vi.mocked(sandboxClient.execLongRunningInSandbox).mockResolvedValueOnce(fail(tscOut, '', 1));

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
