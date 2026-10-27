// CLI MCP client (docs/decisions/CLI MCP Client — Governed Attach.md). Drives a
// real stdio MCP server (fixtures/fake-mcp-server.mjs) through the production
// entry points: `executeToolCall` for the governance gates, and
// `runLeadKernelTurn` for advertising + dispatch from a model's tool call.
import { strict as assert } from 'node:assert';
import { after, afterEach, before, describe, it } from 'node:test';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  McpRegistry,
  closeMcpRegistry,
  expandEnvRefs,
  mcpToolMatches,
  mcpToolName,
} from '../mcp-client.ts';
import { executeToolCall, isReadOnlyToolCall } from '../tools.ts';
import { runLeadKernelTurn } from '../lead-turn.ts';
import { PROVIDER_CONFIGS } from '../provider.ts';
import { makeSessionId } from '../session-store.ts';
import { roleCanUseTool, isCapabilityMapped } from '../../lib/capabilities.ts';
import { canListenOnLoopback } from './test-environment.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));
const FAKE = { command: process.execPath, args: [FIXTURE] };
const ECHO = 'mcp__fake_srv__echo';

function captureStderr() {
  const lines = [];
  const original = console.error;
  console.error = (line) => lines.push(String(line));
  return {
    lines,
    events: () =>
      lines.flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      }),
    restore: () => {
      console.error = original;
    },
  };
}

describe('MCP naming and patterns', () => {
  it('namespaces and sanitizes to [A-Za-z0-9_], capped at 64 chars', () => {
    assert.equal(
      mcpToolName('cloudflare-docs', 'search.docs'),
      'mcp__cloudflare_docs__search_docs',
    );
    const long = mcpToolName('server', 'x'.repeat(100));
    assert.equal(long.length, 64);
    assert.match(long, /^[A-Za-z0-9_]+$/);
    assert.notEqual(long, mcpToolName('server', `${'x'.repeat(99)}y`), 'truncation stays unique');
  });

  it('matches exact names and trailing-* prefixes only', () => {
    assert.ok(mcpToolMatches(ECHO, [ECHO]));
    assert.ok(mcpToolMatches(ECHO, ['mcp__fake_srv__*']));
    assert.ok(mcpToolMatches(ECHO, ['*']));
    assert.ok(!mcpToolMatches(ECHO, ['mcp__fake_srv__ech']));
    assert.ok(!mcpToolMatches(ECHO, ['mcp__other__*', '']));
  });

  it('expands ${VAR} and ${VAR:-default}, reporting unset references', () => {
    const env = { A: 'one' };
    assert.deepEqual(expandEnvRefs('Bearer ${A}', env), { value: 'Bearer one', missing: [] });
    assert.deepEqual(expandEnvRefs('${B:-dflt}', env), { value: 'dflt', missing: [] });
    assert.deepEqual(expandEnvRefs('Bearer ${B}', env).missing, ['B']);
  });
});

describe('MCP capability mapping', () => {
  it('maps every mcp__ name to mcp:call: lead roles in local-daemon only, read-only roles fail closed', () => {
    assert.ok(isCapabilityMapped(ECHO), 'mapped, so the Explorer gate denies instead of passing');
    assert.ok(roleCanUseTool('coder', ECHO, 'local-daemon'));
    assert.ok(roleCanUseTool('orchestrator', ECHO, 'local-daemon'));
    for (const role of ['explorer', 'reviewer', 'auditor']) {
      assert.ok(!roleCanUseTool(role, ECHO, 'local-daemon'), role);
    }
    // CLI-only: no role holds it on the cloud surface.
    assert.ok(!roleCanUseTool('orchestrator', ECHO, 'cloud'));
    assert.ok(!roleCanUseTool('coder', ECHO, 'cloud'));
  });

  it('never classifies an MCP call as read-only, whatever the server claims', () => {
    assert.equal(isReadOnlyToolCall({ tool: ECHO, args: {} }), false);
  });
});

describe('MCP registry over stdio', () => {
  let registry;
  let workspace;
  const savedSecret = process.env.PUSH_MCP_TEST_SECRET;
  const savedAllow = process.env.PUSH_MCP_ALLOW;

  before(async () => {
    // Set in the PARENT: the child must not inherit it (SDK default env only).
    process.env.PUSH_MCP_TEST_SECRET = 'parent-only-secret';
    delete process.env.PUSH_MCP_ALLOW;
    const cap = captureStderr();
    try {
      registry = await McpRegistry.connect({
        'fake-srv': { ...FAKE, env: { FAKE_EXTRA: 'from-config' } },
        broken: { command: process.execPath, args: ['-e', 'process.exit(3)'] },
        unset: {
          type: 'http',
          url: 'https://example.invalid/mcp',
          headers: { Authorization: 'Bearer ${PUSH_MCP_TEST_UNSET_VAR}' },
        },
        off: { ...FAKE, disabled: true },
      });
    } finally {
      cap.restore();
    }
    const events = cap.events();
    assert.ok(
      events.some(
        (e) => e.event === 'mcp_server_connected' && e.server === 'fake-srv' && e.tools === 3,
      ),
    );
    assert.ok(events.some((e) => e.event === 'mcp_server_connect_failed' && e.server === 'broken'));
    assert.ok(
      events.some(
        (e) =>
          e.event === 'mcp_server_config_invalid' &&
          e.server === 'unset' &&
          /PUSH_MCP_TEST_UNSET_VAR/.test(e.reason),
      ),
    );
    assert.ok(!events.some((e) => e.server === 'off'), 'disabled server is never touched');
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'push-mcp-'));
  });

  after(async () => {
    await registry?.close();
    if (savedSecret === undefined) delete process.env.PUSH_MCP_TEST_SECRET;
    else process.env.PUSH_MCP_TEST_SECRET = savedSecret;
    if (savedAllow === undefined) delete process.env.PUSH_MCP_ALLOW;
    else process.env.PUSH_MCP_ALLOW = savedAllow;
    await fs.rm(workspace, { recursive: true, force: true });
  });

  const exec = (call, options = {}) =>
    executeToolCall(call, workspace, { role: 'coder', mcp: registry, ...options });

  it('lists tools under namespaced names with normalized schemas', () => {
    assert.deepEqual(registry.tools.map((t) => t.name).sort(), [
      'mcp__fake_srv__echo',
      'mcp__fake_srv__env_probe',
      'mcp__fake_srv__fail',
    ]);
    const [schema] = registry.toolSchemas().filter((s) => s.name === ECHO);
    assert.deepEqual(schema.input_schema.required, ['text']);
    assert.equal(schema.input_schema.additionalProperties, false);
    assert.match(
      schema.description,
      /^\[MCP · fake-srv · server says read-only\] Echo the text back\. Second line/,
    );
  });

  it('blocks headless calls that are not allowlisted, and logs it', async () => {
    const cap = captureStderr();
    let result;
    try {
      result = await exec({ tool: ECHO, args: { text: 'hi' } });
    } finally {
      cap.restore();
    }
    assert.equal(result.ok, false);
    assert.equal(result.structuredError.code, 'MCP_DISABLED');
    assert.ok(cap.events().some((e) => e.event === 'mcp_tool_blocked' && e.tool === ECHO));
  });

  it('runs headless when allowlisted (option, env, or prefix)', async () => {
    const viaOption = await exec(
      { tool: ECHO, args: { text: 'hi' } },
      { mcpAllow: ['mcp__fake_srv__*'] },
    );
    assert.equal(viaOption.ok, true, viaOption.text);
    assert.equal(viaOption.text, 'echo: hi');
    process.env.PUSH_MCP_ALLOW = ECHO;
    try {
      const viaEnv = await exec({ tool: ECHO, args: { text: 'env' } });
      assert.equal(viaEnv.text, 'echo: env');
    } finally {
      delete process.env.PUSH_MCP_ALLOW;
    }
  });

  it('asks approvalFn("mcp", …) interactively and honors a denial', async () => {
    const asked = [];
    const denied = await exec(
      { tool: ECHO, args: { text: 'no' } },
      { approvalFn: async (kind, detail) => (asked.push([kind, detail]), false) },
    );
    assert.equal(denied.ok, false);
    assert.equal(denied.structuredError.code, 'APPROVAL_DENIED');
    assert.deepEqual(asked, [['mcp', `${ECHO} {"text":"no"}`]]);
    const approved = await exec(
      { tool: ECHO, args: { text: 'yes' } },
      { approvalFn: async () => true },
    );
    assert.equal(approved.text, 'echo: yes');
  });

  it('readOnlyHint never skips approval; alwaysAllow does', async () => {
    let prompts = 0;
    const approvalFn = async () => (prompts++, true);
    await exec({ tool: ECHO, args: { text: 'a' } }, { approvalFn });
    assert.equal(prompts, 1, 'a server-claimed read-only tool still prompts');
    await exec({ tool: ECHO, args: { text: 'b' } }, { approvalFn, alwaysAllow: [ECHO] });
    assert.equal(prompts, 1);
  });

  it('denies read-only roles at the capability gate', async () => {
    const result = await exec(
      { tool: ECHO, args: { text: 'x' } },
      { role: 'explorer', mcpAllow: ['*'] },
    );
    assert.equal(result.structuredError.code, 'ROLE_CAPABILITY_DENIED');
  });

  it('honors disabledTools, exact and by server prefix', async () => {
    for (const disabledTools of [[ECHO], ['mcp__fake_srv__*']]) {
      const result = await exec(
        { tool: ECHO, args: { text: 'x' } },
        { disabledTools, mcpAllow: ['*'] },
      );
      assert.equal(result.structuredError.code, 'TOOL_DISABLED', JSON.stringify(disabledTools));
    }
  });

  it('maps isError to MCP_TOOL_ERROR and an unattached name to UNKNOWN_TOOL', async () => {
    const failed = await exec({ tool: 'mcp__fake_srv__fail', args: {} }, { mcpAllow: ['*'] });
    assert.equal(failed.ok, false);
    assert.equal(failed.structuredError.code, 'MCP_TOOL_ERROR');
    assert.match(failed.text, /boom/);
    const unknown = await exec({ tool: 'mcp__nope__x', args: {} }, { mcpAllow: ['*'] });
    assert.equal(unknown.structuredError.code, 'UNKNOWN_TOOL');
    const noRegistry = await exec({ tool: ECHO, args: {} }, { mcp: null, mcpAllow: ['*'] });
    assert.equal(noRegistry.structuredError.code, 'UNKNOWN_TOOL');
  });

  it('gives the stdio child only the SDK default env plus its own env block', async () => {
    const result = await exec({ tool: 'mcp__fake_srv__env_probe', args: {} }, { mcpAllow: ['*'] });
    assert.equal(result.text, 'secret=(unset) extra=from-config');
  });

  it('redacts workspace credential values out of MCP output', async () => {
    await fs.writeFile(path.join(workspace, '.env'), 'API_KEY=supersecretvalue123\n');
    try {
      const result = await exec(
        { tool: ECHO, args: { text: 'key is supersecretvalue123' } },
        { mcpAllow: ['*'] },
      );
      assert.ok(!result.text.includes('supersecretvalue123'), result.text);
      assert.match(result.text, /redacted/);
    } finally {
      await fs.rm(path.join(workspace, '.env'), { force: true });
    }
  });
});

const loopbackAvailable = await canListenOnLoopback();

describe('MCP through the lead turn', {
  skip: !loopbackAvailable && 'loopback HTTP listeners are unavailable in this sandbox',
}, () => {
  const saved = {};
  const KEYS = [
    'PUSH_CONFIG_PATH',
    'PUSH_SESSION_DIR',
    'PUSH_MEMORY_DIR',
    'PUSH_TASK_LEDGER_DIR',
    'PUSH_MCP_ALLOW',
  ];
  let tmp;

  before(async () => {
    for (const k of KEYS) saved[k] = process.env[k];
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'push-mcp-lead-'));
    process.env.PUSH_CONFIG_PATH = path.join(tmp, 'config.json');
    process.env.PUSH_SESSION_DIR = path.join(tmp, 'sessions');
    process.env.PUSH_MEMORY_DIR = path.join(tmp, 'memory');
    process.env.PUSH_TASK_LEDGER_DIR = path.join(tmp, 'task-ledgers');
    delete process.env.PUSH_MCP_ALLOW;
    await fs.writeFile(
      process.env.PUSH_CONFIG_PATH,
      JSON.stringify({ mcpServers: { 'fake-srv': FAKE } }),
    );
  });

  afterEach(async () => {
    await closeMcpRegistry();
  });

  after(async () => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function runTurn(plans, options) {
    const requests = [];
    let n = 0;
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        requests.push(JSON.parse(body));
        const plan = plans[Math.min(n++, plans.length - 1)];
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: plan } }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
    const emitted = [];
    try {
      const state = {
        sessionId: makeSessionId(),
        createdAt: 0,
        updatedAt: 0,
        provider: 'ollama',
        model: 'mock-model',
        cwd: tmp,
        rounds: 0,
        eventSeq: 0,
        sessionName: 'mcp lead test',
        messages: [{ role: 'system', content: 'You are a helpful assistant.' }],
      };
      const result = await runLeadKernelTurn(
        state,
        { ...PROVIDER_CONFIGS.ollama, url },
        'mock-key',
        'What does the MCP echo tool say back?',
        5,
        { emit: (e) => emitted.push(e), ...options },
      );
      return { result, requests, emitted };
    } finally {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    }
  }

  const echoCall = JSON.stringify({ tool: ECHO, args: { text: 'from the model' } });

  it('advertises attached tools and runs a model-emitted call when allowlisted', async () => {
    const { result, requests, emitted } = await runTurn(
      [echoCall, 'It said: echo: from the model'],
      {
        mcpAllow: [ECHO],
      },
    );
    assert.equal(result.outcome, 'success');
    const system = JSON.stringify(requests[0].messages.find((m) => m.role === 'system'));
    assert.match(system, /MCP TOOLS/);
    assert.match(system, /mcp__fake_srv__echo\(text\)/);
    assert.ok(
      JSON.stringify(requests[1]).includes('echo: from the model'),
      'MCP result reached the model',
    );
    const done = emitted.find((e) => e.type === 'tool.execution_complete');
    assert.equal(done.payload.toolName, ECHO);
    assert.equal(done.payload.isError, false);
  });

  it('refuses the same call headless without an allowlist entry', async () => {
    const { requests, emitted } = await runTurn([echoCall, 'Blocked.'], {});
    const done = emitted.find((e) => e.type === 'tool.execution_complete');
    assert.equal(done.payload.isError, true);
    assert.ok(
      JSON.stringify(requests[1]).includes('not allowlisted'),
      'the refusal reached the model',
    );
    assert.ok(!JSON.stringify(requests[1]).includes('echo: from the model'));
  });

  it('does not advertise a disabled server', async () => {
    const { requests } = await runTurn(['Nothing to do.'], { disabledTools: ['mcp__fake_srv__*'] });
    const system = JSON.stringify(requests[0].messages.find((m) => m.role === 'system'));
    assert.ok(!system.includes('mcp__fake_srv__'), 'disabled MCP tools are not in the prompt');
  });
});
