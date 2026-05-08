import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeToolCall } from '../tools.ts';

let workspace;
const SAVED_ENV = {};

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'push-tool-policy-'));
  await fs.writeFile(path.join(workspace, 'a.txt'), 'hello\n');
  for (const key of ['PUSH_DISABLED_TOOLS', 'PUSH_ALWAYS_ALLOW']) {
    SAVED_ENV[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
  for (const key of ['PUSH_DISABLED_TOOLS', 'PUSH_ALWAYS_ALLOW']) {
    if (SAVED_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED_ENV[key];
  }
});

describe('disabledTools', () => {
  it('blocks a disabled tool with a TOOL_DISABLED structured error', async () => {
    const result = await executeToolCall(
      { tool: 'read_file', args: { path: 'a.txt' } },
      workspace,
      {
        disabledTools: ['read_file'],
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.structuredError?.code, 'TOOL_DISABLED');
    assert.match(result.text, /disabled by user config/);
  });

  it('lets non-listed tools through', async () => {
    const result = await executeToolCall(
      { tool: 'read_file', args: { path: 'a.txt' } },
      workspace,
      {
        disabledTools: ['exec'],
      },
    );
    assert.equal(result.ok, true);
    assert.match(result.text, /hello/);
  });

  it('falls back to PUSH_DISABLED_TOOLS env when option is omitted', async () => {
    process.env.PUSH_DISABLED_TOOLS = 'read_file,write_file';
    const result = await executeToolCall(
      { tool: 'read_file', args: { path: 'a.txt' } },
      workspace,
      {},
    );
    assert.equal(result.ok, false);
    assert.equal(result.structuredError?.code, 'TOOL_DISABLED');
  });

  it('explicit empty disabledTools array overrides env (opt-out)', async () => {
    process.env.PUSH_DISABLED_TOOLS = 'read_file';
    const result = await executeToolCall(
      { tool: 'read_file', args: { path: 'a.txt' } },
      workspace,
      {
        disabledTools: [],
      },
    );
    assert.equal(result.ok, true);
  });

  it('normalizes the artifact <-> create_artifact alias both ways', async () => {
    // User disables canonical name; model emits the alias.
    const aliasCall = await executeToolCall({ tool: 'artifact', args: {} }, workspace, {
      disabledTools: ['create_artifact'],
    });
    assert.equal(aliasCall.structuredError?.code, 'TOOL_DISABLED');

    // User disables the alias; model emits the canonical name.
    const canonicalCall = await executeToolCall({ tool: 'create_artifact', args: {} }, workspace, {
      disabledTools: ['artifact'],
    });
    assert.equal(canonicalCall.structuredError?.code, 'TOOL_DISABLED');
  });
});

describe('alwaysAllow', () => {
  it('lets exec bypass approval when listed', async () => {
    let approvalCalled = false;
    const result = await executeToolCall(
      { tool: 'exec', args: { command: 'rm -rf /tmp/__push_nonexistent_target__' } },
      workspace,
      {
        approvalFn: async () => {
          approvalCalled = true;
          return false;
        },
        execMode: 'auto',
        alwaysAllow: ['exec'],
      },
    );
    assert.equal(
      approvalCalled,
      false,
      'approvalFn should not be invoked when alwaysAllow covers exec',
    );
    // The command runs but its outcome doesn't matter — we only assert that
    // the gate didn't deny it via the approval path.
    assert.notEqual(result.structuredError?.code, 'APPROVAL_DENIED');
    assert.notEqual(result.structuredError?.code, 'APPROVAL_REQUIRED');
  });

  it('does not bypass headless --allow-exec safety gate', async () => {
    const result = await executeToolCall(
      { tool: 'exec', args: { command: 'echo hi' } },
      workspace,
      {
        // No approvalFn (headless), no allowExec, alwaysAllow on exec.
        // The headless gate must still block — alwaysAllow only waives
        // approval prompts, not the non-interactive safety check.
        execMode: 'auto',
        alwaysAllow: ['exec'],
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.structuredError?.code, 'EXEC_DISABLED');
  });

  it('does not affect tools other than the listed name', async () => {
    let approvalCalled = false;
    const result = await executeToolCall(
      { tool: 'exec', args: { command: 'rm -rf /tmp/__push_nonexistent_target__' } },
      workspace,
      {
        approvalFn: async () => {
          approvalCalled = true;
          return false;
        },
        execMode: 'auto',
        alwaysAllow: ['exec_start'],
      },
    );
    assert.equal(approvalCalled, true, 'exec should still prompt when only exec_start is allowed');
    assert.equal(result.ok, false);
    assert.equal(result.structuredError?.code, 'APPROVAL_DENIED');
  });

  it('falls back to PUSH_ALWAYS_ALLOW env when option is omitted', async () => {
    process.env.PUSH_ALWAYS_ALLOW = 'exec';
    let approvalCalled = false;
    const result = await executeToolCall(
      { tool: 'exec', args: { command: 'rm -rf /tmp/__push_nonexistent_target__' } },
      workspace,
      {
        approvalFn: async () => {
          approvalCalled = true;
          return false;
        },
        execMode: 'auto',
      },
    );
    assert.equal(approvalCalled, false);
    assert.notEqual(result.structuredError?.code, 'APPROVAL_DENIED');
  });
});
