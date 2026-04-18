/**
 * Characterization tests for the daemon-side role-capability gate
 * (Architecture Remediation Plan §CLI Runtime Parity Gap 2).
 *
 * The invariant these tests pin:
 *
 *   makeDaemonExplorerToolExec refuses any tool whose required
 *   capabilities are not granted to the Explorer role, via the shared
 *   capability table in `lib/capabilities.ts`. This mirrors the web
 *   runtime's ROLE_CAPABILITY_DENIED gate at
 *   `app/src/lib/web-tool-execution-runtime.ts:147`, giving both
 *   surfaces one source of truth.
 *
 * The file `makeDaemonExplorerToolExec` block in
 * `daemon-integration.test.mjs` already pins the happy path (real file
 * reads, mutation refusal, malformed-call fallback). This file adds the
 * Gap-2-specific pins:
 *
 *   - Capability-table entries for CLI-native tool names exist.
 *   - Explorer is refused for each CLI-native mutation tool.
 *   - exec_poll and exec_list_sessions are now denied to Explorer
 *     (behavior change from the prior READ_ONLY_TOOLS gate).
 *   - Read-allowed CLI-native tools (list_dir, git_status, git_diff)
 *     reach the underlying executor.
 *   - Denial emits a structured log line tagged with
 *     ROLE_CAPABILITY_DENIED so logs and dashboards can grep the same
 *     way on web and CLI.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { makeDaemonExplorerToolExec } from '../pushd.ts';
import { TOOL_CAPABILITIES, roleCanUseTool, ROLE_CAPABILITIES } from '../../lib/capabilities.ts';
import { READ_ONLY_TOOLS } from '../tools.ts';

// ---------------------------------------------------------------------------
// Capability-table coverage for CLI-native names
// ---------------------------------------------------------------------------

describe('TOOL_CAPABILITIES — CLI-native entries exist for every case arm in cli/tools.ts', () => {
  const expected = {
    list_dir: ['repo:read'],
    read_symbols: ['repo:read'],
    read_symbol: ['repo:read'],
    git_status: ['repo:read'],
    git_diff: ['repo:read'],
    git_commit: ['git:commit'],
    lsp_diagnostics: ['repo:read'],
    save_memory: ['scratchpad'],
    write_file: ['repo:write'],
    edit_file: ['repo:write'],
    undo_edit: ['repo:write'],
    exec: ['sandbox:exec'],
    exec_start: ['sandbox:exec'],
    exec_poll: ['sandbox:exec'],
    exec_write: ['sandbox:exec'],
    exec_stop: ['sandbox:exec'],
    exec_list_sessions: ['sandbox:exec'],
  };

  for (const [tool, caps] of Object.entries(expected)) {
    it(`${tool} -> ${caps.join(', ')}`, () => {
      assert.deepEqual(TOOL_CAPABILITIES[tool], caps);
    });
  }

  it('reuses existing shared entries for names that overlap web (no duplicate entries)', () => {
    // Names that are already in the shared table and intentionally not
    // re-added under a CLI-native section. If any of these drift, the
    // CLI dispatch may diverge from the web source of truth.
    assert.deepEqual(TOOL_CAPABILITIES.read_file, ['repo:read']);
    assert.deepEqual(TOOL_CAPABILITIES.search_files, ['repo:read']);
    assert.deepEqual(TOOL_CAPABILITIES.web_search, ['web:search']);
    assert.deepEqual(TOOL_CAPABILITIES.ask_user, ['user:ask']);
  });
});

// ---------------------------------------------------------------------------
// Explorer role vs. CLI-native names
// ---------------------------------------------------------------------------

describe('roleCanUseTool(explorer, ...) matrix for CLI-native names', () => {
  it('allows read tools that only require repo:read', () => {
    assert.equal(roleCanUseTool('explorer', 'read_file'), true);
    assert.equal(roleCanUseTool('explorer', 'list_dir'), true);
    assert.equal(roleCanUseTool('explorer', 'search_files'), true);
    assert.equal(roleCanUseTool('explorer', 'read_symbols'), true);
    assert.equal(roleCanUseTool('explorer', 'read_symbol'), true);
    assert.equal(roleCanUseTool('explorer', 'git_status'), true);
    assert.equal(roleCanUseTool('explorer', 'git_diff'), true);
    assert.equal(roleCanUseTool('explorer', 'lsp_diagnostics'), true);
  });

  it('refuses mutation tools (repo:write not granted)', () => {
    assert.equal(roleCanUseTool('explorer', 'write_file'), false);
    assert.equal(roleCanUseTool('explorer', 'edit_file'), false);
    assert.equal(roleCanUseTool('explorer', 'undo_edit'), false);
  });

  it('refuses git_commit (git:commit not granted)', () => {
    assert.equal(roleCanUseTool('explorer', 'git_commit'), false);
  });

  it('refuses the entire exec family (sandbox:exec not granted) — behavior change for exec_poll/exec_list_sessions', () => {
    // The prior READ_ONLY_TOOLS gate admitted exec_poll and
    // exec_list_sessions for Explorer. Under the shared table these
    // require sandbox:exec (option a from the Gap 2 scoping: coherent
    // with the exec family, functionally safe because Explorer cannot
    // start the session it would be polling).
    assert.equal(roleCanUseTool('explorer', 'exec'), false);
    assert.equal(roleCanUseTool('explorer', 'exec_start'), false);
    assert.equal(roleCanUseTool('explorer', 'exec_poll'), false);
    assert.equal(roleCanUseTool('explorer', 'exec_write'), false);
    assert.equal(roleCanUseTool('explorer', 'exec_stop'), false);
    assert.equal(roleCanUseTool('explorer', 'exec_list_sessions'), false);
  });

  it('refuses save_memory (scratchpad not granted)', () => {
    assert.equal(roleCanUseTool('explorer', 'save_memory'), false);
  });

  it('every READ_ONLY_TOOLS entry has a TOOL_CAPABILITIES mapping (drift detector)', () => {
    // READ_ONLY_TOOLS is retained in cli/tools.ts for a purpose
    // distinct from Explorer's capability grant — deep-reviewer-agent
    // uses it to bucket detected tool calls into readOnly/mutating
    // slots. But every name in the set must still have a shared-table
    // capability mapping, otherwise `roleCanUseTool` would fail-open
    // on unknown names and silently regress Explorer's grant for any
    // new addition.
    for (const tool of READ_ONLY_TOOLS) {
      assert.ok(
        TOOL_CAPABILITIES[tool] !== undefined,
        `READ_ONLY_TOOLS contains "${tool}" but TOOL_CAPABILITIES has no entry — drift risk`,
      );
    }
  });

  it('exec_poll and exec_list_sessions are intentionally denied to Explorer despite READ_ONLY_TOOLS membership', () => {
    // Dedicated pin for the Gap 2 behavior change: these two names
    // remain in READ_ONLY_TOOLS because deep-reviewer-agent treats
    // them as read-verbs over exec-family objects, but they are no
    // longer advertised to the Explorer model and no longer callable
    // by Explorer at the capability gate. See READ_ONLY_TOOL_PROTOCOL
    // divergence note in cli/tools.ts and the sync test in
    // daemon-integration.test.mjs for the prompt-side enforcement.
    for (const tool of ['exec_poll', 'exec_list_sessions']) {
      assert.ok(
        READ_ONLY_TOOLS.has(tool),
        `${tool} should remain in READ_ONLY_TOOLS for deep-reviewer bucketing`,
      );
      assert.equal(
        roleCanUseTool('explorer', tool),
        false,
        `${tool} must be denied to Explorer per the shared capability table`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// makeDaemonExplorerToolExec refusal behavior (end-to-end through the
// real executor factory, not just the pure capability check)
// ---------------------------------------------------------------------------

function stubEntry(workspaceRoot) {
  return { state: { cwd: workspaceRoot, eventSeq: 0 }, sessionId: 'sess_test_gap2' };
}

describe('makeDaemonExplorerToolExec — Gap 2 refusal behavior', () => {
  it('refuses write_file (repo:write not granted) and never writes the file', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-gap2-write-'));
    try {
      const entry = stubEntry(workspaceRoot);
      const abortController = new AbortController();
      const toolExec = makeDaemonExplorerToolExec({
        entry,
        signal: abortController.signal,
      });

      const result = await toolExec(
        {
          source: 'cli',
          call: { tool: 'write_file', args: { path: 'leaked.txt', content: 'x' } },
        },
        { round: 1 },
      );

      assert.equal(typeof result.resultText, 'string');
      assert.ok(
        result.resultText.includes('write_file'),
        `denial should name the refused tool, got ${JSON.stringify(result.resultText)}`,
      );
      assert.ok(result.resultText.toLowerCase().includes('not available'));
      await assert.rejects(
        fs.access(path.join(workspaceRoot, 'leaked.txt')),
        /ENOENT/,
        'denial must not touch the filesystem',
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('refuses exec_start (sandbox:exec not granted)', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-gap2-exec-'));
    try {
      const entry = stubEntry(workspaceRoot);
      const abortController = new AbortController();
      const toolExec = makeDaemonExplorerToolExec({
        entry,
        signal: abortController.signal,
      });

      const result = await toolExec(
        { source: 'cli', call: { tool: 'exec_start', args: { command: 'ls' } } },
        { round: 1 },
      );

      assert.ok(result.resultText.includes('exec_start'));
      assert.ok(result.resultText.toLowerCase().includes('not available'));
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('refuses exec_poll — behavior change from READ_ONLY_TOOLS gate', async () => {
    // Pre-Gap-2, exec_poll was in READ_ONLY_TOOLS and Explorer could
    // call it. Under the shared table it requires sandbox:exec and is
    // refused. This test pins that behavior change so a future
    // "simplify" or "restore" regression breaks here, visibly.
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-gap2-poll-'));
    try {
      const entry = stubEntry(workspaceRoot);
      const abortController = new AbortController();
      const toolExec = makeDaemonExplorerToolExec({
        entry,
        signal: abortController.signal,
      });

      const result = await toolExec(
        { source: 'cli', call: { tool: 'exec_poll', args: { session_id: 'nonexistent' } } },
        { round: 1 },
      );

      assert.ok(result.resultText.includes('exec_poll'));
      assert.ok(result.resultText.toLowerCase().includes('not available'));
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('emits a structured console.warn log tagged with ROLE_CAPABILITY_DENIED on refusal', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-gap2-log-'));
    try {
      const entry = stubEntry(workspaceRoot);
      const abortController = new AbortController();
      const toolExec = makeDaemonExplorerToolExec({
        entry,
        signal: abortController.signal,
      });

      const calls = [];
      const originalWarn = console.warn;
      console.warn = (...args) => {
        calls.push(args);
      };
      try {
        await toolExec(
          { source: 'cli', call: { tool: 'write_file', args: { path: 'x', content: 'y' } } },
          { round: 1 },
        );
      } finally {
        console.warn = originalWarn;
      }

      assert.equal(calls.length, 1, `expected exactly one console.warn call, got ${calls.length}`);
      const [message] = calls[0];
      assert.equal(typeof message, 'string');
      const parsed = JSON.parse(message);
      assert.equal(parsed.event, 'role_capability_denied');
      assert.equal(parsed.type, 'ROLE_CAPABILITY_DENIED');
      assert.equal(parsed.role, 'explorer');
      assert.equal(parsed.tool, 'write_file');
      assert.deepEqual(parsed.required, ['repo:write']);
      // granted is a snapshot of ROLE_CAPABILITIES.explorer — compare
      // as sets so order changes in the grant don't break the test.
      assert.deepEqual(new Set(parsed.granted), new Set(ROLE_CAPABILITIES.explorer));
      assert.equal(parsed.sessionId, 'sess_test_gap2');
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('does NOT emit the structured log on an allowed read tool', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-gap2-noisy-'));
    try {
      await fs.writeFile(path.join(workspaceRoot, 'ok.txt'), 'ok', 'utf8');
      const entry = stubEntry(workspaceRoot);
      const abortController = new AbortController();
      const toolExec = makeDaemonExplorerToolExec({
        entry,
        signal: abortController.signal,
      });

      const calls = [];
      const originalWarn = console.warn;
      console.warn = (...args) => {
        calls.push(args);
      };
      try {
        const result = await toolExec(
          { source: 'cli', call: { tool: 'read_file', args: { path: 'ok.txt' } } },
          { round: 1 },
        );
        assert.ok(result.resultText.includes('ok'));
      } finally {
        console.warn = originalWarn;
      }

      assert.equal(calls.length, 0, 'allowed tool calls should not emit denial logs');
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('read-side CLI-native tools still reach the executor (list_dir returns directory contents)', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-gap2-readok-'));
    try {
      await fs.writeFile(path.join(workspaceRoot, 'alpha.md'), 'a', 'utf8');
      await fs.writeFile(path.join(workspaceRoot, 'beta.md'), 'b', 'utf8');
      const entry = stubEntry(workspaceRoot);
      const abortController = new AbortController();
      const toolExec = makeDaemonExplorerToolExec({
        entry,
        signal: abortController.signal,
      });

      const result = await toolExec(
        { source: 'cli', call: { tool: 'list_dir', args: { path: '.' } } },
        { round: 1 },
      );

      assert.ok(
        result.resultText.includes('alpha.md') && result.resultText.includes('beta.md'),
        `list_dir should have reached the real executor; got ${JSON.stringify(result.resultText)}`,
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('refuses an unmapped tool name (fail-closed on unknown, PR #331 Copilot finding)', async () => {
    // Regression pin: roleCanUseTool is fail-open on unknown tools by
    // design (forward-compat), but the daemon Explorer gate composes
    // `isCapabilityMapped` to fail-closed. If a future dispatchable
    // tool is added without a TOOL_CAPABILITIES entry, Explorer must
    // refuse it at the gate rather than slip through.
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-gap2-unmapped-'));
    try {
      const entry = stubEntry(workspaceRoot);
      const abortController = new AbortController();
      const toolExec = makeDaemonExplorerToolExec({
        entry,
        signal: abortController.signal,
      });

      const result = await toolExec(
        { source: 'cli', call: { tool: 'totally_unmapped_future_tool', args: {} } },
        { round: 1 },
      );

      assert.ok(result.resultText.includes('totally_unmapped_future_tool'));
      assert.ok(result.resultText.toLowerCase().includes('not available'));
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('refuses prototype-key tool names without crashing (Codex P1 on PR #331)', async () => {
    // Regression pin: before `getToolCapabilities` used `Object.hasOwn`,
    // a model emitting `{"tool": "__proto__", ...}` would crash the
    // delegation loop (`required.every is not a function`), and
    // `{"tool": "toString", ...}` would silently be granted access
    // because the prototype function's `.length === 0` triggered
    // `roleCanUseTool`'s fail-open branch. Both paths are closed now:
    // `isCapabilityMapped` returns false for every prototype key, so
    // the daemon Explorer gate refuses with the normal denial
    // resultText.
    const prototypeKeys = [
      '__proto__',
      'constructor',
      'toString',
      'valueOf',
      'hasOwnProperty',
      'isPrototypeOf',
    ];
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-gap2-proto-'));
    try {
      const entry = stubEntry(workspaceRoot);
      const abortController = new AbortController();
      const toolExec = makeDaemonExplorerToolExec({
        entry,
        signal: abortController.signal,
      });

      for (const key of prototypeKeys) {
        const result = await toolExec(
          { source: 'cli', call: { tool: key, args: {} } },
          { round: 1 },
        );
        assert.equal(
          typeof result.resultText,
          'string',
          `prototype-key "${key}" should return a denial resultText, not crash`,
        );
        assert.ok(
          result.resultText.toLowerCase().includes('not available'),
          `prototype-key "${key}" should be denied; got ${JSON.stringify(result.resultText)}`,
        );
      }
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('denial resultText preserves the pre-Gap-2 phrasing (does not name delegate_coder)', async () => {
    // Regression pin for the Copilot PR #284 finding: the denial must
    // NOT name delegate_coder as a tool the Explorer can call
    // (delegation is an RPC, not a tool emission path).
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-gap2-phrasing-'));
    try {
      const entry = stubEntry(workspaceRoot);
      const abortController = new AbortController();
      const toolExec = makeDaemonExplorerToolExec({
        entry,
        signal: abortController.signal,
      });

      const result = await toolExec(
        {
          source: 'cli',
          call: { tool: 'write_file', args: { path: 'x', content: 'y' } },
        },
        { round: 1 },
      );

      assert.ok(
        !result.resultText.includes('delegate_coder'),
        `denial must not name delegate_coder as a tool; got ${JSON.stringify(result.resultText)}`,
      );
      assert.ok(
        result.resultText.toLowerCase().includes('read-only'),
        'denial should reinforce Explorer is read-only',
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
