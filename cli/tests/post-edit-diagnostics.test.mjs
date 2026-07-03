import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_POST_EDIT_DIAGNOSTICS_BUDGET_MS,
  POST_EDIT_DIAGNOSTICS_ENV_VAR,
  resetPostEditDiagnosticsState,
  resolvePostEditDiagnosticsEnabled,
  runPostEditDiagnostics,
} from '../post-edit-diagnostics.ts';

// Fake runner factory: returns a runner that yields the given results in
// sequence (last one repeats) and records its calls.
function makeRunner(results) {
  const calls = [];
  const runner = async (workspaceRoot, specificPath, opts) => {
    calls.push({ workspaceRoot, specificPath, opts });
    const result = results[Math.min(calls.length - 1, results.length - 1)];
    return result;
  };
  return { runner, calls };
}

const CLEAN_TS = { diagnostics: [], projectType: 'typescript' };

function diag(overrides = {}) {
  return {
    file: 'src/a.ts',
    line: 1,
    col: 1,
    severity: 'error',
    message: 'boom',
    code: 'TS0000',
    ...overrides,
  };
}

describe('resolvePostEditDiagnosticsEnabled', () => {
  it('defaults on', () => {
    assert.equal(resolvePostEditDiagnosticsEnabled({}), true);
    assert.equal(resolvePostEditDiagnosticsEnabled({ env: '' }), true);
    assert.equal(resolvePostEditDiagnosticsEnabled({ env: 'garbage' }), true);
  });

  it('env can disable and enable', () => {
    assert.equal(resolvePostEditDiagnosticsEnabled({ env: '0' }), false);
    assert.equal(resolvePostEditDiagnosticsEnabled({ env: 'false' }), false);
    assert.equal(resolvePostEditDiagnosticsEnabled({ env: 'off' }), false);
    assert.equal(resolvePostEditDiagnosticsEnabled({ env: '1' }), true);
    assert.equal(resolvePostEditDiagnosticsEnabled({ env: 'true' }), true);
  });

  it('explicit wins over env in both directions', () => {
    assert.equal(resolvePostEditDiagnosticsEnabled({ explicit: false, env: '1' }), false);
    assert.equal(resolvePostEditDiagnosticsEnabled({ explicit: true, env: '0' }), true);
  });
});

describe('runPostEditDiagnostics', () => {
  beforeEach(() => resetPostEditDiagnosticsState());

  it('skips when disabled by env without calling the runner', async () => {
    const { runner, calls } = makeRunner([CLEAN_TS]);
    const outcome = await runPostEditDiagnostics('/ws/a', '/ws/a/src/a.ts', {
      env: { [POST_EDIT_DIAGNOSTICS_ENV_VAR]: '0' },
      runner,
    });
    assert.deepEqual(outcome, { note: null, meta: null });
    assert.equal(calls.length, 0);
  });

  it('skips non-checkable extensions without calling the runner', async () => {
    const { runner, calls } = makeRunner([CLEAN_TS]);
    const outcome = await runPostEditDiagnostics('/ws/a', '/ws/a/README.md', {
      env: {},
      runner,
    });
    assert.deepEqual(outcome, { note: null, meta: null });
    assert.equal(calls.length, 0);
  });

  it('appends a clean confirmation with counts in meta', async () => {
    const { runner, calls } = makeRunner([CLEAN_TS]);
    const outcome = await runPostEditDiagnostics('/ws/a', '/ws/a/src/a.ts', {
      env: {},
      runner,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].specificPath, '/ws/a/src/a.ts');
    assert.equal(calls[0].opts.timeoutMs, DEFAULT_POST_EDIT_DIAGNOSTICS_BUDGET_MS);
    assert.ok(outcome.note.includes('Diagnostics: clean (typescript'));
    assert.ok(outcome.note.includes('src/a.ts'));
    assert.equal(outcome.meta.ran, true);
    assert.equal(outcome.meta.errors, 0);
    assert.equal(outcome.meta.warnings, 0);
  });

  it('formats findings errors-first with counts', async () => {
    const { runner } = makeRunner([
      {
        projectType: 'typescript',
        diagnostics: [
          diag({ severity: 'warning', line: 2, message: 'unused', code: 'TS6133' }),
          diag({ severity: 'error', line: 9, message: 'not assignable', code: 'TS2322' }),
        ],
      },
    ]);
    const outcome = await runPostEditDiagnostics('/ws/a', '/ws/a/src/a.ts', {
      env: {},
      runner,
    });
    assert.ok(outcome.note.includes('1 error(s), 1 warning(s)'));
    const errorIdx = outcome.note.indexOf('[error]');
    const warningIdx = outcome.note.indexOf('[warning]');
    assert.ok(errorIdx !== -1 && warningIdx !== -1 && errorIdx < warningIdx, 'errors sort first');
    assert.equal(outcome.meta.errors, 1);
    assert.equal(outcome.meta.warnings, 1);
  });

  it('caps reported findings and points at lsp_diagnostics for the rest', async () => {
    const many = Array.from({ length: 25 }, (_, i) => diag({ line: i + 1 }));
    const { runner } = makeRunner([{ projectType: 'typescript', diagnostics: many }]);
    const outcome = await runPostEditDiagnostics('/ws/a', '/ws/a/src/a.ts', {
      env: {},
      runner,
    });
    assert.ok(outcome.note.includes('(+5 more — run lsp_diagnostics for the full list)'));
  });

  it('disables the workspace after a budget-exceeded run and notes it once', async () => {
    const timeout = {
      projectType: 'typescript',
      diagnostics: [],
      error: { code: 'DIAGNOSTIC_TIMEOUT', message: 'killed', retryable: false },
    };
    const { runner, calls } = makeRunner([timeout, CLEAN_TS]);

    const first = await runPostEditDiagnostics('/ws/slow', '/ws/slow/a.ts', {
      env: {},
      runner,
      budgetMs: 50,
    });
    assert.ok(first.note.includes('disabled'), 'model gets a one-time disable note');
    assert.ok(first.note.includes('50ms'));
    assert.equal(first.meta.ran, false);
    assert.equal(first.meta.reason, 'budget_exceeded');

    const second = await runPostEditDiagnostics('/ws/slow', '/ws/slow/b.ts', {
      env: {},
      runner,
      budgetMs: 50,
    });
    assert.deepEqual(second, { note: null, meta: null });
    assert.equal(calls.length, 1, 'runner not called again after disable');
  });

  it('disables silently on unsupported project / missing checker', async () => {
    for (const code of ['UNSUPPORTED_PROJECT_TYPE', 'DIAGNOSTIC_TOOL_NOT_FOUND']) {
      resetPostEditDiagnosticsState();
      const errored = {
        projectType: null,
        diagnostics: [],
        error: { code, message: 'nope', retryable: false },
      };
      const { runner, calls } = makeRunner([errored, CLEAN_TS]);
      const first = await runPostEditDiagnostics('/ws/x', '/ws/x/a.ts', { env: {}, runner });
      assert.deepEqual(first, { note: null, meta: null }, `${code} produces no note`);
      const second = await runPostEditDiagnostics('/ws/x', '/ws/x/b.ts', { env: {}, runner });
      assert.deepEqual(second, { note: null, meta: null });
      assert.equal(calls.length, 1, `${code} disables the workspace`);
    }
  });

  it('keeps trying after a transient failure', async () => {
    const transient = {
      projectType: 'typescript',
      diagnostics: [],
      error: { code: 'DIAGNOSTIC_FAILED', message: 'flake', retryable: true },
    };
    const { runner, calls } = makeRunner([transient, CLEAN_TS]);
    const first = await runPostEditDiagnostics('/ws/t', '/ws/t/a.ts', { env: {}, runner });
    assert.deepEqual(first, { note: null, meta: null });
    const second = await runPostEditDiagnostics('/ws/t', '/ws/t/a.ts', { env: {}, runner });
    assert.equal(calls.length, 2, 'transient failures do not disable');
    assert.ok(second.note.includes('Diagnostics: clean'));
  });

  it('scopes the adaptive disable per workspace', async () => {
    const timeout = {
      projectType: 'typescript',
      diagnostics: [],
      error: { code: 'DIAGNOSTIC_TIMEOUT', message: 'killed', retryable: false },
    };
    const slow = makeRunner([timeout]);
    await runPostEditDiagnostics('/ws/one', '/ws/one/a.ts', { env: {}, runner: slow.runner });

    const fast = makeRunner([CLEAN_TS]);
    const other = await runPostEditDiagnostics('/ws/two', '/ws/two/a.ts', {
      env: {},
      runner: fast.runner,
    });
    assert.equal(fast.calls.length, 1, 'other workspace unaffected');
    assert.ok(other.note.includes('Diagnostics: clean'));
  });

  it('suppresses a vacuous note when the checker cannot cover the file', async () => {
    // A .py edit in a workspace whose marker resolved to typescript: tsc ran,
    // the file filter matched nothing — "clean" would be a false confirmation.
    const { runner, calls } = makeRunner([CLEAN_TS]);
    const outcome = await runPostEditDiagnostics('/ws/mixed', '/ws/mixed/tool.py', {
      env: {},
      runner,
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(outcome, { note: null, meta: null });
  });

  it('never throws when the runner throws', async () => {
    const runner = async () => {
      throw new Error('kaboom');
    };
    const outcome = await runPostEditDiagnostics('/ws/throw', '/ws/throw/a.ts', {
      env: {},
      runner,
    });
    assert.deepEqual(outcome, { note: null, meta: null });
  });
});

describe('write_file / edit_file integration', () => {
  beforeEach(() => resetPostEditDiagnosticsState());

  it('write_file in a markerless workspace appends no diagnostics note', async () => {
    const { executeToolCall } = await import('../tools.ts');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'push-postedit-'));
    try {
      const result = await executeToolCall(
        { tool: 'write_file', args: { path: 'a.ts', content: 'const x = 1;\n' } },
        root,
        { role: 'coder' },
      );
      assert.equal(result.ok, true);
      // No project marker → checker disables silently; the write result is
      // exactly the pre-existing shape.
      assert.ok(!result.text.includes('Diagnostics'));
      assert.equal(result.meta.diagnostics, undefined);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('write_file honors the env opt-out', async () => {
    const { executeToolCall } = await import('../tools.ts');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'push-postedit-off-'));
    const prior = process.env[POST_EDIT_DIAGNOSTICS_ENV_VAR];
    process.env[POST_EDIT_DIAGNOSTICS_ENV_VAR] = '0';
    try {
      // Even with a project marker present, the opt-out skips the checker.
      await fs.writeFile(
        path.join(root, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }),
      );
      const result = await executeToolCall(
        { tool: 'write_file', args: { path: 'a.ts', content: 'const x: string = 42;\n' } },
        root,
        { role: 'coder' },
      );
      assert.equal(result.ok, true);
      assert.ok(!result.text.includes('Diagnostics'));
    } finally {
      if (prior === undefined) delete process.env[POST_EDIT_DIAGNOSTICS_ENV_VAR];
      else process.env[POST_EDIT_DIAGNOSTICS_ENV_VAR] = prior;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
