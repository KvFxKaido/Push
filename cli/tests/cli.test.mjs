import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { promisify } from 'node:util';
import path from 'node:path';

import { canCaptureChildStdout, canListenOnLoopback } from './test-environment.mjs';
import { startMockProviderServer } from './mock-provider-server.mjs';
import { validateEvent } from '../../lib/protocol-schema.ts';

const execFileAsync = promisify(execFile);
const CLI_PATH = path.resolve(import.meta.dirname, '..', 'cli.ts');
const childStdoutAvailable = await canCaptureChildStdout();
const loopbackAvailable = await canListenOnLoopback();
const needsChildStdout = {
  skip: !childStdoutAvailable && 'child_process stdout capture is unavailable in this sandbox',
};
const needsHeadlessJsonl = {
  skip:
    (!childStdoutAvailable && 'child_process stdout capture is unavailable in this sandbox') ||
    (!loopbackAvailable && 'loopback networking is unavailable in this sandbox'),
};

function shQuote(arg) {
  return `'${String(arg).replace(/'/g, `'\\''`)}'`;
}

function buildCliCommand(args) {
  return [process.execPath, '--import', 'tsx', CLI_PATH, ...args].map(shQuote).join(' ');
}

// Each CLI invocation gets a fresh temp dir for PUSH_SESSION_DIR and
// PUSH_CONFIG_PATH. Previously the helpers derived these paths from
// `Date.now()`, which collides under parallel runs (same millisecond)
// and can leak state between back-to-back calls inside one test. The
// OS temp dir mkdtemp is atomic + unique so parallelism is safe.
//
// Returns both the env vars and a cleanup callback. Helpers must call
// `cleanup()` after the child process exits so the test run doesn't
// leak a `push-test-env-*` directory per invocation (~1000+ across a
// full CLI suite run). Tests that need persistent session state
// always override `PUSH_SESSION_DIR` via `extraEnv`, so cleanup of
// the helper-owned temp root is always safe.
async function makeUniqueTestEnv() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'push-test-env-'));
  return {
    env: {
      PUSH_SESSION_DIR: path.join(root, 'sessions'),
      PUSH_CONFIG_PATH: path.join(root, 'config.json'),
    },
    cleanup: () => fs.rm(root, { recursive: true, force: true }).catch(() => {}),
  };
}

async function runCli(args, options = {}) {
  const { env: extraEnv, input, timeout = 5000 } = options;
  const testEnv = await makeUniqueTestEnv();
  const env = {
    ...process.env,
    ...testEnv.env,
    ...extraEnv,
  };
  try {
    // `spawn` (rather than `execFile`) so we can actually close the
    // child's stdin — `execFile` silently ignores the `input` option
    // and leaves the child's stdin pipe open forever, which blocks any
    // CLI path that drains piped stdin (the non-TTY task fallback).
    return await new Promise((resolve) => {
      const child = spawn(process.execPath, ['--import', 'tsx', CLI_PATH, ...args], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, timeout);
      child.stdout.on('data', (c) => {
        stdout += String(c);
      });
      child.stderr.on('data', (c) => {
        stderr += String(c);
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ code: 1, stdout, stderr: stderr || String(err.message || err) });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          stderr += (stderr.endsWith('\n') ? '' : '\n') + 'Timed out.';
        }
        resolve({ code: typeof code === 'number' ? code : 1, stdout, stderr });
      });
      if (input !== undefined) {
        child.stdin.write(input);
      }
      child.stdin.end();
    });
  } finally {
    await testEnv.cleanup();
  }
}

function stripAnsi(text) {
  return String(text || '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '');
}

async function runCliPty(args, options = {}) {
  const { env: extraEnv, input = '', timeout = 8000, ...spawnOpts } = options;
  const testEnv = await makeUniqueTestEnv();
  const env = {
    ...process.env,
    ...testEnv.env,
    ...extraEnv,
  };
  const cmd = buildCliCommand(args);
  const lines = String(input || '')
    .split('\n')
    .filter((line, idx, arr) => !(idx === arr.length - 1 && line === ''))
    .map((line) => `${line}\n`);

  function countPrompts(text) {
    const matches = stripAnsi(text).match(/(?:^|\n)> /g);
    return matches ? matches.length : 0;
  }

  try {
    return await new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      let sentCount = 0;
      let timedOut = false;

      const child = spawn('script', ['-q', '-e', '-c', cmd, '/dev/null'], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        ...spawnOpts,
      });

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, timeout);

      function maybeSendPendingCommands() {
        if (lines.length === 0) return;
        if (!child.stdin || child.stdin.destroyed || !child.stdin.writable) return;
        const promptCount = countPrompts(stdout);
        while (sentCount < lines.length && promptCount > sentCount) {
          child.stdin.write(lines[sentCount]);
          sentCount += 1;
        }
      }

      function finalize(result) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ...result, env });
      }

      child.on('error', (err) => {
        clearTimeout(timer);
        if (err && err.code === 'ENOENT') {
          reject(err);
          return;
        }
        finalize({ code: 1, stdout, stderr: `${stderr}${err?.message ? `\n${err.message}` : ''}` });
      });

      child.stdout?.on('data', (chunk) => {
        stdout += String(chunk);
        maybeSendPendingCommands();
      });

      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
      });

      child.on('close', (code, signal) => {
        if (timedOut) {
          finalize({
            code: 1,
            stdout,
            stderr: `${stderr}${stderr && !stderr.endsWith('\n') ? '\n' : ''}Timed out waiting for REPL interaction.`,
          });
          return;
        }
        if (typeof code === 'number' && code === 0) {
          finalize({ code: 0, stdout, stderr });
          return;
        }
        finalize({
          code: typeof code === 'number' ? code : 1,
          stdout,
          stderr: `${stderr}${signal ? `${stderr && !stderr.endsWith('\n') ? '\n' : ''}terminated by ${signal}` : ''}`,
        });
      });
    });
  } finally {
    await testEnv.cleanup();
  }
}

// ─── --version ───────────────────────────────────────────────────

describe('--version', needsChildStdout, () => {
  it('prints version and exits 0', async () => {
    const { code, stdout } = await runCli(['--version']);
    assert.equal(code, 0);
    assert.match(stdout, /^push \d+\.\d+\.\d+/);
  });

  it('works with -v shorthand', async () => {
    const { code, stdout } = await runCli(['-v']);
    assert.equal(code, 0);
    assert.match(stdout, /^push \d+\.\d+\.\d+/);
  });
});

// ─── --help ──────────────────────────────────────────────────────

describe('--help', needsChildStdout, () => {
  it('prints usage and exits 0', async () => {
    const { code, stdout } = await runCli(['--help']);
    assert.equal(code, 0);
    assert.ok(stdout.includes('Usage:'));
    assert.ok(stdout.includes('--version'));
  });
});

// ─── config explain ─────────────────────────────────────────────

describe('push config explain', needsChildStdout, () => {
  it('shows effective values and exact winning sources without exposing secrets', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'push-config-explain-'));
    const configPath = path.join(root, 'config.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        provider: 'ollama',
        ollama: { apiKey: 'user-secret' },
        anthropic: { model: 'claude-user' },
      }),
    );

    try {
      const { code, stdout, stderr } = await runCli(['config', 'explain'], {
        env: {
          PUSH_CONFIG_PATH: configPath,
          PUSH_PROVIDER: 'anthropic',
          PUSH_ANTHROPIC_MODEL: 'claude-env',
          PUSH_ANTHROPIC_API_KEY: '',
          ANTHROPIC_API_KEY: 'environment-secret',
        },
      });

      assert.equal(code, 0, stderr);
      assert.doesNotMatch(stdout, /user-secret|environment-secret/);
      const result = JSON.parse(stdout);
      assert.equal(result.config.provider, 'anthropic');
      assert.equal(result.config.anthropic.model, 'claude-env');
      assert.equal(result.provenance.provider.source, 'env:PUSH_PROVIDER');
      assert.equal(result.provenance['anthropic.model'].source, 'env:PUSH_ANTHROPIC_MODEL');
      assert.equal(result.provenance['anthropic.apiKey'].source, 'env:ANTHROPIC_API_KEY');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('places validated runtime flags above the environment layer', async () => {
    const { code, stdout, stderr } = await runCli(
      [
        'config',
        'explain',
        '--provider',
        'openai',
        '--model',
        'gpt-cli',
        '--no-sandbox',
        '--search-backend',
        'duckduckgo',
        '--mode',
        'strict',
      ],
      {
        env: {
          PUSH_PROVIDER: 'anthropic',
          PUSH_OPENAI_MODEL: 'gpt-env',
          PUSH_LOCAL_SANDBOX: 'native',
          PUSH_WEB_SEARCH_BACKEND: 'tavily',
          PUSH_EXEC_MODE: 'auto',
        },
      },
    );

    assert.equal(code, 0, stderr);
    const result = JSON.parse(stdout);
    assert.equal(result.config.provider, 'openai');
    assert.equal(result.config.openai.model, 'gpt-cli');
    assert.equal(result.config.localSandbox, false);
    assert.equal(result.config.webSearchBackend, 'duckduckgo');
    assert.equal(result.config.execMode, 'strict');
    assert.equal(result.provenance.provider.source, 'cli-overrides');
    assert.equal(result.provenance['openai.model'].source, 'cli-overrides');
    assert.equal(result.provenance.localSandbox.source, 'cli-overrides');
    assert.equal(result.provenance.webSearchBackend.source, 'cli-overrides');
    assert.equal(result.provenance.execMode.source, 'cli-overrides');
  });
});

// ─── unknown subcommand ──────────────────────────────────────────

describe('unknown subcommand', needsChildStdout, () => {
  it('rejects unknown subcommand with error', async () => {
    const { code, stderr } = await runCli(['blah'], { input: '' });
    assert.equal(code, 1);
    assert.ok(stderr.includes('Unknown command: blah'));
  });

  it('rejects typo of run', async () => {
    const { code, stderr } = await runCli(['rn', '--task', 'hi'], { input: '' });
    assert.equal(code, 1);
    assert.ok(stderr.includes('Unknown command: rn'));
  });
});

// ─── push eval ──────────────────────────────────────────────────

describe('push eval', needsChildStdout, () => {
  it('evaluates a saved runtime receipt without provider setup', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'push-cli-eval-'));
    const receiptPath = path.join(root, 'run.jsonl');
    const envelope = {
      v: 'push.runtime.v1',
      kind: 'event',
      sessionId: 'sess_cli_eval',
      runId: 'run_cli_eval',
      seq: 1,
      ts: 1_000,
      type: 'run_complete',
      payload: { runId: 'run_cli_eval', outcome: 'success', summary: 'done' },
    };
    await fs.writeFile(receiptPath, `${JSON.stringify(envelope)}\n`);

    try {
      const { code, stdout, stderr } = await runCli(['eval', receiptPath, '--json']);
      assert.equal(code, 0, stderr);
      const result = JSON.parse(stdout);
      assert.equal(result.verdict, 'pass');
      assert.equal(result.runId, 'run_cli_eval');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

// ─── --max-rounds validation ─────────────────────────────────────

describe('--max-rounds validation', needsChildStdout, () => {
  it('rejects non-numeric value', async () => {
    const { code, stderr } = await runCli(['run', '--task', 'hi', '--max-rounds', 'banana']);
    assert.equal(code, 1);
    assert.ok(stderr.includes('Invalid --max-rounds'));
  });
});

// ─── --sandbox / --no-sandbox conflict ───────────────────────────

describe('--sandbox / --no-sandbox conflict', needsChildStdout, () => {
  it('rejects both flags together', async () => {
    const { code, stderr } = await runCli(['--sandbox', '--no-sandbox', 'run', '--task', 'hi']);
    assert.equal(code, 1);
    assert.ok(stderr.includes('Conflicting flags'));
  });

  it('rejects a named backend combined with a legacy sandbox flag', async () => {
    const { code, stderr } = await runCli([
      '--sandbox-backend',
      'native',
      '--no-sandbox',
      'run',
      '--task',
      'hi',
    ]);
    assert.equal(code, 1);
    assert.ok(stderr.includes('Conflicting sandbox flags'));
  });

  it('rejects an unknown named backend', async () => {
    const { code, stderr } = await runCli([
      '--sandbox-backend',
      'cardboard',
      'run',
      '--task',
      'hi',
    ]);
    assert.equal(code, 1);
    assert.ok(stderr.includes('Invalid PUSH_LOCAL_SANDBOX value'));
  });
});

describe('push run --jsonl', needsChildStdout, () => {
  it('rejects --json and --jsonl together', async () => {
    const { code, stderr } = await runCli(['run', '--task', 'hi', '--json', '--jsonl']);
    assert.equal(code, 1);
    assert.match(stderr, /--json and --jsonl cannot be combined/);
  });

  it('rejects --jsonl outside push run', async () => {
    const { code, stderr } = await runCli(['resume', '--jsonl']);
    assert.equal(code, 1);
    assert.match(stderr, /supported only by `push run`/);
  });

  it('rejects --output-schema outside push run', async () => {
    const { code, stderr } = await runCli(['resume', '--output-schema', 'result.schema.json']);
    assert.equal(code, 1);
    assert.match(stderr, /--output-schema is supported only by `push run`/);
  });

  it('preflights --output-schema before provider auth or agent work', async () => {
    const missing = path.join(os.tmpdir(), `missing-output-schema-${Date.now()}.json`);
    const { code, stderr } = await runCli([
      'run',
      '--task',
      'hi',
      '--provider',
      'openrouter',
      '--output-schema',
      missing,
    ]);
    assert.equal(code, 1);
    assert.match(stderr, /Could not read --output-schema/);
    assert.doesNotMatch(stderr, /Missing API key/);
  });
});

describe('push run --output-schema', needsHeadlessJsonl, () => {
  const resultSchema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['ok'] },
      filesRead: { type: 'integer', minimum: 1 },
    },
    required: ['status', 'filesRead'],
    additionalProperties: false,
  };

  it('keeps --json aggregate output pure and persists one post-schema terminal event', async () => {
    const mock = await startMockProviderServer({
      tokens: ['{ "status": "ok", "filesRead": 1 }'],
    });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'push-output-schema-json-'));
    const schemaPath = path.join(root, 'result.schema.json');
    const sessionRoot = path.join(root, 'sessions');
    try {
      await fs.writeFile(schemaPath, JSON.stringify(resultSchema));
      const { code, stdout, stderr } = await runCli(
        [
          '--cwd',
          root,
          'run',
          '--task',
          'Return the result.',
          '--provider',
          'openrouter',
          '--json',
          '--output-schema',
          schemaPath,
        ],
        {
          timeout: 15_000,
          env: {
            PUSH_SESSION_DIR: sessionRoot,
            PUSH_OPENROUTER_URL: mock.url,
            PUSH_OPENROUTER_API_KEY: 'test-key',
            PUSH_OPENROUTER_TRANSPORT: 'chat',
          },
        },
      );

      assert.equal(code, 0, stripAnsi(stderr));
      assert.equal(mock.requestCount(), 1);
      const aggregate = JSON.parse(stdout);
      assert.equal(aggregate.outcome, 'success');
      assert.equal(aggregate.assistant, '{"status":"ok","filesRead":1}');
      assert.deepEqual(aggregate.outputSchema, { valid: true, repairs: 0 });
      assert.doesNotMatch(stderr, /output_schema_validated/);
      const persisted = (
        await fs.readFile(path.join(sessionRoot, aggregate.sessionId, 'events.jsonl'), 'utf8')
      )
        .trim()
        .split('\n')
        .map(JSON.parse);
      assert.equal(persisted.filter((event) => event.type === 'run_complete').length, 1);
      assert.equal(persisted.at(-1).type, 'run_complete');
      assert.equal(persisted.at(-1).payload.outcome, 'success');
      assert.equal(persisted.at(-1).payload.summary, aggregate.assistant);
    } finally {
      await mock.stop();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('repairs only the final output and leaves the primary tool turn single-shot', async () => {
    const mock = await startMockProviderServer({
      responses: [
        [JSON.stringify({ tool: 'read_file', args: { path: 'target.txt' } })],
        ['Finished reading the file.'],
        ['{"status":"ok","filesRead":1}'],
      ],
    });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'push-output-schema-cli-'));
    const schemaPath = path.join(root, 'result.schema.json');
    const sessionRoot = path.join(root, 'sessions');
    try {
      await fs.writeFile(path.join(root, 'target.txt'), 'file body\n');
      await fs.writeFile(schemaPath, JSON.stringify(resultSchema));
      const { code, stdout, stderr } = await runCli(
        [
          '--cwd',
          root,
          'run',
          '--task',
          'Read target.txt and report the result.',
          '--provider',
          'openrouter',
          '--jsonl',
          '--output-schema',
          schemaPath,
        ],
        {
          timeout: 15_000,
          env: {
            PUSH_SESSION_DIR: sessionRoot,
            PUSH_OPENROUTER_URL: mock.url,
            PUSH_OPENROUTER_API_KEY: 'test-key',
            PUSH_OPENROUTER_TRANSPORT: 'chat',
          },
        },
      );

      assert.equal(code, 0, stripAnsi(stderr));
      assert.equal(mock.requestCount(), 3, 'one tool round + one final round + one repair');
      const requestBodies = mock.requestBodies();
      assert.ok(
        requestBodies[0].tools.some((tool) => tool.type === 'openrouter:web_search'),
        'the primary turn should retain provider-native web search',
      );
      assert.equal(
        requestBodies.at(-1).tools,
        undefined,
        'the output-only repair must disable provider-native and local tools',
      );
      const lines = stdout.trim().split('\n').map(JSON.parse);
      assert.equal(lines.filter((event) => event.type === 'tool.execution_start').length, 1);
      assert.equal(lines.filter((event) => event.type === 'tool.execution_complete').length, 1);
      assert.equal(lines.filter((event) => event.type === 'run_complete').length, 1);
      assert.equal(lines.at(-1).type, 'run_complete');
      assert.equal(lines.at(-1).payload.outcome, 'success');
      assert.deepEqual(JSON.parse(lines.at(-1).payload.summary), {
        status: 'ok',
        filesRead: 1,
      });
      assert.match(stderr, /"event":"output_schema_validated","repairs":1/);
      const persisted = (
        await fs.readFile(path.join(sessionRoot, lines[0].sessionId, 'events.jsonl'), 'utf8')
      )
        .trim()
        .split('\n')
        .map(JSON.parse);
      assert.equal(persisted.filter((event) => event.type === 'run_complete').length, 1);
      assert.equal(persisted.at(-1).type, 'run_complete');
      assert.equal(persisted.at(-1).payload.outcome, 'success');
    } finally {
      await mock.stop();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed after two invalid repair responses', async () => {
    const mock = await startMockProviderServer({
      responses: [['not json'], ['still not json'], ['{"status":"wrong"}']],
    });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'push-output-schema-fail-'));
    const schemaPath = path.join(root, 'result.schema.json');
    const sessionRoot = path.join(root, 'sessions');
    const acceptanceMarker = path.join(root, 'acceptance-ran');
    try {
      await fs.writeFile(schemaPath, JSON.stringify(resultSchema));
      const { code, stdout, stderr } = await runCli(
        [
          '--cwd',
          root,
          'run',
          '--task',
          'Return the result.',
          '--provider',
          'openrouter',
          '--jsonl',
          '--output-schema',
          schemaPath,
          '--accept',
          `node -e "require('node:fs').writeFileSync('acceptance-ran', 'yes')"`,
        ],
        {
          timeout: 15_000,
          env: {
            PUSH_SESSION_DIR: sessionRoot,
            PUSH_OPENROUTER_URL: mock.url,
            PUSH_OPENROUTER_API_KEY: 'test-key',
            PUSH_OPENROUTER_TRANSPORT: 'chat',
          },
        },
      );

      assert.equal(code, 1);
      assert.equal(mock.requestCount(), 3);
      const lines = stdout.trim().split('\n').map(JSON.parse);
      const error = lines.find((event) => event.type === 'error');
      assert.equal(error.payload.code, 'OUTPUT_SCHEMA_VALIDATION_FAILED');
      assert.equal(
        lines.some((event) => event.type === 'acceptance_complete'),
        false,
      );
      assert.equal(lines.filter((event) => event.type === 'run_complete').length, 1);
      assert.deepEqual(
        lines.slice(-2).map((event) => event.type),
        ['error', 'run_complete'],
      );
      assert.equal(lines.at(-1).type, 'run_complete');
      assert.equal(lines.at(-1).payload.outcome, 'failed');
      assert.match(lines.at(-1).payload.summary, /Output schema validation failed/);
      assert.match(stderr, /"event":"output_schema_validation_failed","repairs":2/);
      await assert.rejects(fs.access(acceptanceMarker), { code: 'ENOENT' });
      const persisted = (
        await fs.readFile(path.join(sessionRoot, lines[0].sessionId, 'events.jsonl'), 'utf8')
      )
        .trim()
        .split('\n')
        .map(JSON.parse);
      assert.equal(persisted.filter((event) => event.type === 'run_complete').length, 1);
      assert.equal(persisted.at(-1).type, 'run_complete');
      assert.equal(persisted.at(-1).payload.outcome, 'failed');
    } finally {
      await mock.stop();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('push run --jsonl stream', needsHeadlessJsonl, () => {
  it('emits push.runtime.v1 envelopes and ends with one run_complete', async () => {
    const mock = await startMockProviderServer({ tokens: ['Hello', ' world.'] });
    const task = `Say hello. ${'x'.repeat(300)}`;
    try {
      const { code, stdout, stderr } = await runCli(
        ['run', '--task', task, '--provider', 'openrouter', '--jsonl'],
        {
          timeout: 15_000,
          env: {
            PUSH_OPENROUTER_URL: mock.url,
            PUSH_OPENROUTER_API_KEY: 'test-key',
            PUSH_OPENROUTER_TRANSPORT: 'chat',
          },
        },
      );
      assert.equal(code, 0, stripAnsi(stderr));
      const lines = stdout.trim().split('\n').map(JSON.parse);
      assert.ok(lines.length > 2);
      assert.ok(
        lines.every((event) => event.v === 'push.runtime.v1'),
        `unexpected JSONL output: ${stdout}`,
      );
      assert.ok(lines.every((event) => event.kind === 'event'));
      assert.ok(lines.every((event) => event.sessionId === lines[0].sessionId));
      assert.ok(lines.every((event) => event.runId === lines[0].runId));
      assert.equal(lines[0].type, 'user_message');
      assert.equal(lines[0].payload.text, task);
      assert.equal(lines[0].payload.preview.length, 280);
      assert.ok(lines.some((event) => event.type === 'assistant_token'));
      assert.equal(lines.filter((event) => event.type === 'run_complete').length, 1);
      assert.equal(lines.at(-1).type, 'run_complete');
      assert.equal(lines.at(-1).payload.outcome, 'success');
      assert.equal(lines.at(-1).payload.summary, 'Hello world.');
    } finally {
      await mock.stop();
    }
  });

  it('persists one terminal event after failed acceptance checks', async () => {
    const mock = await startMockProviderServer({ tokens: ['Implementation complete.'] });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'push-jsonl-acceptance-'));
    const sessionRoot = path.join(root, 'sessions');
    try {
      const { code, stdout } = await runCli(
        [
          'run',
          '--task',
          'Complete the task.',
          '--provider',
          'openrouter',
          '--jsonl',
          '--accept',
          'node -e "process.exit(7)"',
        ],
        {
          timeout: 15_000,
          env: {
            PUSH_SESSION_DIR: sessionRoot,
            PUSH_OPENROUTER_URL: mock.url,
            PUSH_OPENROUTER_API_KEY: 'test-key',
            PUSH_OPENROUTER_TRANSPORT: 'chat',
          },
        },
      );
      assert.equal(code, 1);
      const lines = stdout.trim().split('\n').map(JSON.parse);
      const acceptanceIndex = lines.findIndex((event) => event.type === 'acceptance_complete');
      const terminalIndex = lines.findIndex((event) => event.type === 'run_complete');
      assert.ok(acceptanceIndex >= 0);
      assert.ok(terminalIndex > acceptanceIndex);
      assert.equal(lines.filter((event) => event.type === 'run_complete').length, 1);
      assert.equal(lines.at(-1).payload.outcome, 'failed');

      const persisted = (
        await fs.readFile(path.join(sessionRoot, lines[0].sessionId, 'events.jsonl'), 'utf8')
      )
        .trim()
        .split('\n')
        .map(JSON.parse);
      const streamedUserMessage = lines.find((event) => event.type === 'user_message');
      assert.match(
        streamedUserMessage.payload.text,
        /Acceptance criteria \(verified after the run\)/,
      );
      assert.match(streamedUserMessage.payload.text, /node -e "process\.exit\(7\)"/);
      const persistedUserMessage = persisted.find((event) => event.type === 'user_message');
      assert.equal(Object.hasOwn(persistedUserMessage.payload, 'text'), false);
      assert.equal(persisted.filter((event) => event.type === 'run_complete').length, 1);
      assert.equal(persisted.at(-1).type, 'run_complete');
      assert.equal(persisted.at(-1).payload.outcome, 'failed');
    } finally {
      await mock.stop();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('validates tool-lifecycle events streamed from a real tool call', async () => {
    // The plain-text turns above never route a tool event through the writer's
    // unconditional `assertValidEvent`. Drive a real read-only tool call so
    // `tool.execution_start` / `tool.execution_complete` — both validator-backed
    // (toolName + args object; toolName + boolean isError) — cross that boundary.
    // A schema violation would throw mid-stream, so exit code 0 is itself the
    // core assertion that none did.
    const mock = await startMockProviderServer({
      responses: [
        // Round 1: bare-JSON tool call in content (the text-dispatch path).
        // read_file is read-only, so a headless run needs no approval.
        [JSON.stringify({ tool: 'read_file', args: { path: 'target.txt' } })],
        // Round 2: a plain answer ends the turn.
        ['Read it.'],
      ],
    });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'push-jsonl-tool-'));
    try {
      await fs.writeFile(path.join(root, 'target.txt'), 'file body\n');
      const { code, stdout, stderr } = await runCli(
        ['--cwd', root, 'run', '--task', 'Read target.txt.', '--provider', 'openrouter', '--jsonl'],
        {
          timeout: 15_000,
          env: {
            PUSH_OPENROUTER_URL: mock.url,
            PUSH_OPENROUTER_API_KEY: 'test-key',
            PUSH_OPENROUTER_TRANSPORT: 'chat',
          },
        },
      );
      assert.equal(code, 0, stripAnsi(stderr));
      const lines = stdout.trim().split('\n').map(JSON.parse);
      // Belt-and-suspenders over the exit code: re-validate every envelope.
      for (const event of lines) {
        assert.deepEqual(validateEvent(event), [], `invalid envelope: ${JSON.stringify(event)}`);
      }
      const start = lines.find((event) => event.type === 'tool.execution_start');
      const done = lines.find((event) => event.type === 'tool.execution_complete');
      assert.ok(start, `no tool.execution_start in stream: ${stdout}`);
      assert.equal(start.payload.toolName, 'read_file');
      assert.ok(start.payload.args && typeof start.payload.args === 'object');
      assert.ok(done, 'no tool.execution_complete in stream');
      assert.equal(done.payload.toolName, 'read_file');
      assert.equal(done.payload.isError, false);
      assert.equal(lines.filter((event) => event.type === 'run_complete').length, 1);
      assert.equal(lines.at(-1).type, 'run_complete');
      assert.equal(lines.at(-1).payload.outcome, 'success');
    } finally {
      await mock.stop();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

// ─── unknown flag warning ────────────────────────────────────────

describe('unknown flag warning', needsChildStdout, () => {
  it('warns on unknown flag but does not block --help', async () => {
    const { code, stdout, stderr } = await runCli(['--banana', '--help']);
    assert.equal(code, 0);
    assert.ok(stripAnsi(stderr).includes('Warning: unknown flag --banana'));
    assert.ok(stripAnsi(stdout).includes('Usage:'));
  });
});

// ─── non-TTY stdin guard ─────────────────────────────────────────

describe('non-TTY stdin guard', needsChildStdout, () => {
  it('prints friendly fallback hint when stdin is empty and not a TTY', async () => {
    // Pipe /dev/null (empty) as stdin to ensure !isTTY and no piped data.
    const { code, stderr } = await runCli([], {
      input: '',
      env: { PUSH_PROVIDER: 'ollama' },
    });
    assert.equal(code, 1);
    assert.ok(
      stderr.includes('no TTY available'),
      `expected friendly non-TTY hint, got: ${stderr}`,
    );
    assert.ok(stderr.includes('push run --task'));
    assert.ok(stderr.includes('cat task.md | push'));
  });

  it('treats sentinel PUSH_PROVIDER values as unset', async () => {
    const { code, stderr } = await runCli([], {
      input: '',
      env: { PUSH_PROVIDER: 'undefined', PUSH_TUI_ENABLED: '0' },
    });
    assert.equal(code, 1);
    assert.ok(stderr.includes('no TTY available'));
    assert.ok(!stderr.includes('Unsupported provider'));
  });

  it('reads piped stdin as the task when no --task is given', async () => {
    // With piped content on stdin, bare `push` should fall through to the
    // headless path instead of erroring. We can't run a full headless
    // turn without a provider key, so we assert the negative: the
    // friendly non-TTY hint must NOT fire, proving the fallback took.
    const { stderr } = await runCli([], {
      input: 'investigate the failing test',
      env: { PUSH_PROVIDER: 'ollama', PUSH_TUI_ENABLED: '0' },
    });
    assert.ok(
      !stderr.includes('no TTY available'),
      `expected piped stdin to bypass non-TTY hint, got: ${stderr}`,
    );
  });
});

// ─── --cwd validation ────────────────────────────────────────────

describe('--cwd validation', needsChildStdout, () => {
  it('rejects nonexistent path', async () => {
    const { code, stderr } = await runCli([
      '--cwd',
      '/definitely/not/a/real/path',
      'run',
      '--task',
      'hi',
    ]);
    assert.equal(code, 1);
    assert.ok(stderr.includes('does not exist'));
  });

  it('rejects file path (not directory)', async () => {
    const { code, stderr } = await runCli(['--cwd', CLI_PATH, 'run', '--task', 'hi']);
    assert.equal(code, 1);
    assert.ok(stderr.includes('not a directory'));
  });
});

// ─── --session error message ─────────────────────────────────────

describe('--session validation', needsChildStdout, () => {
  it('gives friendly error for nonexistent session', async () => {
    const { code, stderr } = await runCli(['--session', 'sess_abc123_def456']);
    assert.equal(code, 1);
    assert.ok(stderr.includes('Session not found: sess_abc123_def456'));
  });

  it('gives friendly error for invalid session id format', async () => {
    const { code, stderr } = await runCli(['--session', 'fake_session_id']);
    assert.equal(code, 1);
    assert.ok(stderr.includes('Invalid session id'));
  });
});

// ─── mode-specific flag handling ────────────────────────────────

describe('mode-specific flag handling', needsChildStdout, () => {
  it('honors --task on bare push when no TTY (falls through to headless)', async () => {
    // Pre-existing behavior: `push --task X` (no `run`) without a TTY
    // warned that --task was "ignored in interactive mode" and then
    // hard-errored on the missing TTY. The non-TTY fallback now treats
    // `push --task X` as `push run --task X`, so neither the warning
    // nor the friendly non-TTY hint should appear — the user's task is
    // taken seriously.
    const { stderr } = await runCli(['--task', 'something'], {
      input: '',
      env: { PUSH_PROVIDER: 'ollama' },
    });
    assert.ok(
      !stderr.includes('ignored in interactive mode'),
      `expected no ignored-flag warning, got: ${stderr}`,
    );
    assert.ok(
      !stderr.includes('no TTY available'),
      `expected no non-TTY hint when --task was provided, got: ${stderr}`,
    );
  });
});

// ─── interactive REPL /compact (pty) ──────────────────────────────

describe('interactive REPL /compact', needsChildStdout, () => {
  it('compacts saved session context and persists digest', async () => {
    // Skip on environments without util-linux `script` (pseudo-TTY helper).
    try {
      await execFileAsync('script', ['-V']);
    } catch (err) {
      if (err && err.code === 'ENOENT') return; // soft-skip in minimal environments
      // Some script variants return non-zero for -V; that's still "available".
    }

    const sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-test-cli-pty-'));
    const configPath = path.join(
      os.tmpdir(),
      `push-test-cli-config-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
    );
    const sessionId = 'sess_compact1_abcdef';
    const sessionDir = path.join(sessionRoot, sessionId);
    const statePath = path.join(sessionDir, 'state.json');
    const eventsPath = path.join(sessionDir, 'events.jsonl');
    const now = Date.now();

    const toolPayload = JSON.stringify(
      {
        tool: 'read_file',
        ok: true,
        output: 'x'.repeat(400),
        meta: null,
        structuredError: null,
      },
      null,
      2,
    );

    const seededState = {
      sessionId,
      createdAt: now,
      updatedAt: now,
      provider: 'ollama',
      model: 'gemini-3-flash-preview',
      cwd: process.cwd(),
      rounds: 0,
      eventSeq: 0,
      workingMemory: {
        plan: '',
        openTasks: [],
        filesTouched: [],
        assumptions: [],
        errorsEncountered: [],
      },
      messages: [
        { role: 'system', content: 'System prompt' },
        { role: 'user', content: 'Turn 1 user' },
        { role: 'assistant', content: 'Turn 1 assistant' },
        { role: 'user', content: `[TOOL_RESULT]\n${toolPayload}\n[/TOOL_RESULT]` },
        { role: 'user', content: 'Turn 2 user' },
        { role: 'assistant', content: 'Turn 2 assistant' },
        { role: 'user', content: 'Turn 3 user' },
        { role: 'assistant', content: 'Turn 3 assistant' },
      ],
    };

    await fs.mkdir(sessionDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(statePath, JSON.stringify(seededState, null, 2), 'utf8');
    await fs.writeFile(eventsPath, '', 'utf8');

    const { code, stdout, stderr } = await runCliPty(['--session', sessionId], {
      input: '/compact 1\n/exit\n',
      env: {
        PUSH_SESSION_DIR: sessionRoot,
        PUSH_CONFIG_PATH: configPath,
        PUSH_TUI_ENABLED: '0',
        PUSH_PROVIDER: 'ollama',
        PUSH_OLLAMA_API_KEY: 'test-key',
      },
    });

    const cleanStdout = stripAnsi(stdout);
    const cleanStderr = stripAnsi(stderr);
    if (/failed to create pseudo-terminal|permission denied/i.test(cleanStderr)) {
      return; // soft-skip when sandbox denies PTY allocation
    }
    assert.equal(code, 0, `stderr=${cleanStderr}\nstdout=${cleanStdout}`);
    assert.match(cleanStdout, /Compacted context:/);

    // Messages now live in messages.jsonl (one JSON per line); state.json
    // is slim and does not carry the array. Reload via the public path
    // (`messages.jsonl` if present, embedded fallback otherwise) and
    // assert the same compaction invariants.
    const messagesPath = path.join(sessionDir, 'messages.jsonl');
    const messagesRaw = await fs.readFile(messagesPath, 'utf8');
    const persistedMessages = messagesRaw
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
    const contents = persistedMessages.map((m) => String(m.content));
    assert.ok(
      contents.some((c) => c.includes('[CONTEXT DIGEST]')),
      'should persist context digest',
    );
    assert.ok(
      contents.some((c) => c === 'Turn 3 user'),
      'should preserve latest turn',
    );
    assert.ok(!contents.some((c) => c === 'Turn 2 user'), 'should compact older middle turn');

    const eventLines = (await fs.readFile(eventsPath, 'utf8')).trim().split('\n').filter(Boolean);
    const parsedEvents = eventLines.map((line) => JSON.parse(line));
    assert.ok(
      parsedEvents.some((e) => e.type === 'context_compacted'),
      'should append context_compacted event',
    );
  });
});

// ─── push resume picker ──────────────────────────────────────────

async function seedSessions(root, rows) {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  for (const row of rows) {
    const dir = path.join(root, row.sessionId);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const state = {
      sessionId: row.sessionId,
      createdAt: row.updatedAt,
      updatedAt: row.updatedAt,
      provider: row.provider || 'ollama',
      model: row.model || 'test-model',
      cwd: row.cwd || '/tmp',
      rounds: 0,
      sessionName: row.sessionName || '',
      messages: Array.isArray(row.messages) ? row.messages : [],
    };
    await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify(state, null, 2), 'utf8');
    await fs.writeFile(path.join(dir, 'events.jsonl'), '', 'utf8');
  }
}

describe('push resume', needsChildStdout, () => {
  it('reports when no sessions exist', async () => {
    const sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-test-resume-empty-'));
    const { code, stdout } = await runCli(['resume'], {
      env: { PUSH_SESSION_DIR: sessionRoot },
    });
    assert.equal(code, 0);
    assert.match(stdout, /No sessions found\./);
  });

  it('prints list without prompting when stdin is not a TTY', async () => {
    const sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-test-resume-pipe-'));
    await seedSessions(sessionRoot, [
      { sessionId: 'sess_alpha1_abcdef', updatedAt: 1_700_000_000_000, sessionName: 'Alpha' },
      { sessionId: 'sess_beta22_bbccdd', updatedAt: 1_700_000_500_000 },
    ]);
    const { code, stdout } = await runCli(['resume'], {
      env: { PUSH_SESSION_DIR: sessionRoot },
    });
    assert.equal(code, 0);
    assert.ok(stdout.includes('sess_alpha1_abcdef'));
    assert.ok(stdout.includes('sess_beta22_bbccdd'));
    // No prompt line should leak out on the non-TTY path.
    assert.ok(!/Attach which\?/.test(stdout));
  });

  it('emits JSON when --json is set even without --no-attach', async () => {
    const sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-test-resume-json-'));
    await seedSessions(sessionRoot, [
      { sessionId: 'sess_alpha1_abcdef', updatedAt: 1_700_000_000_000 },
    ]);
    const { code, stdout } = await runCli(['resume', '--json'], {
      env: { PUSH_SESSION_DIR: sessionRoot },
    });
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].sessionId, 'sess_alpha1_abcdef');
  });

  it('--no-attach suppresses the prompt and exits after listing', async () => {
    const sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-test-resume-noattach-'));
    await seedSessions(sessionRoot, [
      { sessionId: 'sess_alpha1_abcdef', updatedAt: 1_700_000_000_000 },
    ]);
    const { code, stdout } = await runCli(['resume', '--no-attach'], {
      env: { PUSH_SESSION_DIR: sessionRoot },
    });
    assert.equal(code, 0);
    assert.ok(stdout.includes('sess_alpha1_abcdef'));
    assert.ok(!/Attach which\?/.test(stdout));
  });

  it('push sessions alias never prompts', async () => {
    const sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-test-sessions-alias-'));
    await seedSessions(sessionRoot, [
      { sessionId: 'sess_alpha1_abcdef', updatedAt: 1_700_000_000_000 },
    ]);
    const { code, stdout } = await runCli(['sessions'], {
      env: { PUSH_SESSION_DIR: sessionRoot },
    });
    assert.equal(code, 0);
    assert.ok(stdout.includes('sess_alpha1_abcdef'));
    assert.ok(!/Attach which\?/.test(stdout));
  });

  it('rename subcommand still works after picker split', async () => {
    const sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-test-resume-rename-'));
    await seedSessions(sessionRoot, [
      { sessionId: 'sess_alpha1_abcdef', updatedAt: 1_700_000_000_000 },
    ]);
    const { code, stdout } = await runCli(
      ['resume', 'rename', 'sess_alpha1_abcdef', 'My', 'Session'],
      { env: { PUSH_SESSION_DIR: sessionRoot } },
    );
    assert.equal(code, 0);
    assert.ok(stdout.includes('Renamed sess_alpha1_abcdef'));
  });

  it('cancels cleanly from the TTY picker when user types q', async () => {
    // Some script variants exit non-zero for -V; only ENOENT means it's
    // actually missing. Matches the /compact PTY test's approach.
    try {
      await execFileAsync('script', ['-V']);
    } catch (err) {
      if (err && err.code === 'ENOENT') return; // soft-skip in minimal environments
    }

    const sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-test-resume-tty-'));
    await seedSessions(sessionRoot, [
      { sessionId: 'sess_alpha1_abcdef', updatedAt: 1_700_000_000_000, sessionName: 'Alpha' },
      { sessionId: 'sess_beta22_bbccdd', updatedAt: 1_700_000_500_000 },
    ]);

    // runCliPty's countPrompts helper watches for `> ` prompts in the stream;
    // the picker emits one via readline.question so "q\n" flows through that
    // same path.
    const { stdout, stderr } = await spawnPickerPty(['resume'], 'q\n', {
      PUSH_SESSION_DIR: sessionRoot,
    });
    const clean = stripAnsi(stdout);
    // PTY-allocation failures can land on either stream depending on the
    // sandbox, so soft-skip against both.
    const combined = stripAnsi(`${stdout}\n${stderr}`);
    if (/failed to create pseudo-terminal|permission denied/i.test(combined)) {
      return; // soft-skip when sandbox denies PTY allocation
    }
    assert.ok(/Resumable sessions:/.test(clean), `stdout=${clean}`);
    assert.ok(/Attach which\?/.test(clean), `stdout=${clean}`);
    assert.ok(/Cancelled\./.test(clean), `stdout=${clean}`);
  });

  it('selecting a number attaches via runAttach (pushd-not-running error surfaces)', async () => {
    try {
      await execFileAsync('script', ['-V']);
    } catch (err) {
      if (err && err.code === 'ENOENT') return;
    }

    const sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-test-resume-select-'));
    // Point HOME at an empty temp dir so runAttach's readPidFile()
    // (~/.push/run/pushd.pid) misses deterministically, forcing the
    // "pushd is not running" error that proves the selection reached
    // runAttach.
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'push-test-fake-home-'));
    // Two sessions so the auto-attach-on-N=1 short-circuit doesn't fire
    // and the picker prompt is exercised end-to-end.
    await seedSessions(sessionRoot, [
      { sessionId: 'sess_alpha1_abcdef', updatedAt: 1_700_000_000_000, sessionName: 'Alpha' },
      { sessionId: 'sess_beta22_bbccdd', updatedAt: 1_700_000_500_000 },
    ]);

    const { stdout, stderr } = await spawnPickerPty(['resume'], '1\n', {
      PUSH_SESSION_DIR: sessionRoot,
      HOME: fakeHome,
    });
    const combined = stripAnsi(`${stdout}\n${stderr}`);
    if (/failed to create pseudo-terminal|permission denied/i.test(combined)) {
      return; // soft-skip when sandbox denies PTY allocation
    }
    assert.ok(/Attach which\?/.test(combined), `combined=${combined}`);
    assert.ok(
      /pushd is not running/.test(combined),
      `expected runAttach pushd-not-running error, combined=${combined}`,
    );
  });

  it('auto-attaches without prompting when only one session exists', async () => {
    try {
      await execFileAsync('script', ['-V']);
    } catch (err) {
      if (err && err.code === 'ENOENT') return;
    }

    const sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-test-resume-auto-'));
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'push-test-fake-home-auto-'));
    await seedSessions(sessionRoot, [
      { sessionId: 'sess_alpha1_abcdef', updatedAt: 1_700_000_000_000, sessionName: 'Alpha' },
    ]);

    // No input needed — auto-attach bypasses the prompt entirely. The child
    // still reaches runAttach which fails fast against the empty fake HOME.
    const { stdout, stderr } = await spawnPickerPty(['resume'], '', {
      PUSH_SESSION_DIR: sessionRoot,
      HOME: fakeHome,
    });
    const combined = stripAnsi(`${stdout}\n${stderr}`);
    if (/failed to create pseudo-terminal|permission denied/i.test(combined)) {
      return;
    }
    assert.ok(
      /Resuming only session: sess_alpha1_abcdef/.test(combined),
      `expected auto-resume banner, combined=${combined}`,
    );
    assert.ok(
      /pushd is not running/.test(combined),
      `expected runAttach to run, combined=${combined}`,
    );
    assert.ok(
      !/Attach which\?/.test(combined),
      `picker prompt should be skipped, combined=${combined}`,
    );
    assert.ok(
      !/Resumable sessions:/.test(combined),
      `numbered list header should be skipped, combined=${combined}`,
    );
  });

  it('auto-attach is skipped when --no-attach is set even for a single session', async () => {
    const sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-test-resume-auto-noattach-'));
    await seedSessions(sessionRoot, [
      { sessionId: 'sess_alpha1_abcdef', updatedAt: 1_700_000_000_000, sessionName: 'Alpha' },
    ]);
    const { code, stdout } = await runCli(['resume', '--no-attach'], {
      env: { PUSH_SESSION_DIR: sessionRoot },
    });
    assert.equal(code, 0);
    assert.ok(stdout.includes('sess_alpha1_abcdef'));
    assert.ok(!/Resuming only session:/.test(stdout));
  });

  it('strips ANSI/control chars from sessionName in the picker', async () => {
    try {
      await execFileAsync('script', ['-V']);
    } catch (err) {
      if (err && err.code === 'ENOENT') return;
    }

    const sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-test-resume-sanitize-'));
    // Name mixes ESC (C0) with plain text. The picker must strip the ESC
    // so the injected red-foreground SGR never reaches the terminal.
    // Two sessions so the auto-attach-on-N=1 short-circuit doesn't skip
    // the picker rendering this test is specifically pinning.
    await seedSessions(sessionRoot, [
      {
        sessionId: 'sess_alpha1_abcdef',
        updatedAt: 1_700_000_000_000,
        // CSI `\x1b[31m` + OSC `\x1b]0;TITLE\x07` together exercise both
        // the CSI and OSC strip passes in sanitizeTerminalText. The
        // literal text INJ / ECT / OSC / TAIL survives and should render
        // contiguously once the control sequences are dropped.
        sessionName: 'INJ\x1b[31mECT\x1b]0;TITLE\x07TAIL',
      },
      { sessionId: 'sess_beta22_bbccdd', updatedAt: 1_700_000_500_000 },
    ]);

    const { stdout, stderr } = await spawnPickerPty(['resume'], 'q\n', {
      PUSH_SESSION_DIR: sessionRoot,
    });
    const combined = stripAnsi(`${stdout}\n${stderr}`);
    if (/failed to create pseudo-terminal|permission denied/i.test(combined)) {
      return;
    }
    // Assert the raw stdout never carried the injected SGR. fmt.bold wraps
    // its own \x1b[1m/\x1b[22m around the name but 31m (red) is only in the
    // user-controlled segment, so its absence proves sanitization happened.
    assert.ok(!/\x1b\[31m/.test(stdout), 'injected SGR must not reach the terminal');
    // OSC sequences must be fully stripped too — no `\x1b]` payload and
    // no literal `]0;TITLE` tail (which would mean only the leading ESC
    // was scrubbed, leaving the OSC parameters as visible text).
    assert.ok(!/\x1b\]/.test(stdout), 'injected OSC must not reach the terminal');
    assert.ok(!/\]0;TITLE/.test(stripAnsi(stdout)), 'OSC parameters must not leak as visible text');
    assert.ok(
      /INJECTTAIL/.test(combined),
      `sanitized name should render contiguously, combined=${combined}`,
    );
  });

  it('renders relative time and last-user-message preview in the picker', async () => {
    try {
      await execFileAsync('script', ['-V']);
    } catch (err) {
      if (err && err.code === 'ENOENT') return;
    }

    const sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-test-resume-meta-'));
    // updatedAt pinned to "a few hours ago" relative to wall clock so the
    // picker renders a predictable relative-time band. Seed two sessions
    // so the auto-attach-on-N=1 short-circuit doesn't skip the picker
    // render this test is pinning. messages[] seeded with a human user
    // prompt that survives the [bracketed]-envelope filter, so the
    // picker should render a "quoted" preview line under the metadata.
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    await seedSessions(sessionRoot, [
      {
        sessionId: 'sess_alpha1_abcdef',
        updatedAt: twoHoursAgo,
        sessionName: 'Alpha',
        messages: [
          { role: 'system', content: 'System prompt' },
          {
            role: 'user',
            content:
              '[PROJECT_INSTRUCTIONS source="AGENTS.md"]\nignore me\n[/PROJECT_INSTRUCTIONS]',
          },
          { role: 'user', content: 'Fix the retry loop in pushd attach reconnect' },
          { role: 'assistant', content: 'ok' },
          { role: 'user', content: '[TOOL_RESULT]\n{"ok":true}\n[/TOOL_RESULT]' },
        ],
      },
      { sessionId: 'sess_beta22_bbccdd', updatedAt: twoHoursAgo + 1000 },
    ]);

    const { stdout, stderr } = await spawnPickerPty(['resume'], 'q\n', {
      PUSH_SESSION_DIR: sessionRoot,
    });
    const combined = stripAnsi(`${stdout}\n${stderr}`);
    if (/failed to create pseudo-terminal|permission denied/i.test(combined)) {
      return;
    }
    assert.ok(/\d+h ago/.test(combined), `expected relative-time band, combined=${combined}`);
    assert.ok(
      /"Fix the retry loop in pushd attach reconnect"/.test(combined),
      `expected quoted last-user-message preview, combined=${combined}`,
    );
    // The ISO timestamp is gone — picker now surfaces relative time only.
    assert.ok(
      !/20\d{2}-\d{2}-\d{2}T/.test(combined),
      `raw ISO should not leak into picker output, combined=${combined}`,
    );
    // `[PROJECT_INSTRUCTIONS]` / `[TOOL_RESULT]` envelopes must be
    // skipped by the extractor so they never surface as previews.
    assert.ok(
      !/PROJECT_INSTRUCTIONS|TOOL_RESULT/.test(combined),
      `internal envelopes must not leak into picker, combined=${combined}`,
    );
  });

  it('renders bracket-led human prompts (e.g. [WIP]) as preview', async () => {
    try {
      await execFileAsync('script', ['-V']);
    } catch (err) {
      if (err && err.code === 'ENOENT') return;
    }

    const sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-test-resume-bracket-'));
    // Human prompts that happen to start with `[` (WIP tags, markdown
    // checklists, JSON-like content) must still surface as previews.
    // Only paired `[NAME]...[/NAME]` envelopes get filtered.
    await seedSessions(sessionRoot, [
      {
        sessionId: 'sess_alpha1_abcdef',
        updatedAt: Date.now() - 60_000,
        messages: [{ role: 'user', content: '[WIP] refactor the auth middleware' }],
      },
      { sessionId: 'sess_beta22_bbccdd', updatedAt: Date.now() },
    ]);

    const { stdout, stderr } = await spawnPickerPty(['resume'], 'q\n', {
      PUSH_SESSION_DIR: sessionRoot,
    });
    const combined = stripAnsi(`${stdout}\n${stderr}`);
    if (/failed to create pseudo-terminal|permission denied/i.test(combined)) {
      return;
    }
    assert.ok(
      /"\[WIP\] refactor the auth middleware"/.test(combined),
      `bracket-led human prompt must render as preview, combined=${combined}`,
    );
  });

  it('truncates long last-user-message previews with an ellipsis', async () => {
    try {
      await execFileAsync('script', ['-V']);
    } catch (err) {
      if (err && err.code === 'ENOENT') return;
    }

    const sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-test-resume-truncate-'));
    const longPrompt = `${'x'.repeat(200)} should never render in full`;
    await seedSessions(sessionRoot, [
      {
        sessionId: 'sess_alpha1_abcdef',
        updatedAt: Date.now() - 60_000,
        messages: [{ role: 'user', content: longPrompt }],
      },
      { sessionId: 'sess_beta22_bbccdd', updatedAt: Date.now() },
    ]);

    const { stdout, stderr } = await spawnPickerPty(['resume'], 'q\n', {
      PUSH_SESSION_DIR: sessionRoot,
    });
    const combined = stripAnsi(`${stdout}\n${stderr}`);
    if (/failed to create pseudo-terminal|permission denied/i.test(combined)) {
      return;
    }
    // Ellipsis (U+2026) must appear and the tail text must not.
    assert.ok(/…/.test(combined), `expected truncation ellipsis, combined=${combined}`);
    assert.ok(
      !/should never render in full/.test(combined),
      `truncated tail leaked, combined=${combined}`,
    );
  });
});

async function spawnPickerPty(args, input, extraEnv) {
  const testEnv = await makeUniqueTestEnv();
  const env = {
    ...process.env,
    ...testEnv.env,
    ...extraEnv,
  };
  const cmd = buildCliCommand(args);
  try {
    return await new Promise((resolve) => {
      const child = spawn('script', ['-q', '-e', '-c', cmd, '/dev/null'], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, 5000);
      let sent = false;
      child.stdout?.on('data', (chunk) => {
        stdout += String(chunk);
        if (!sent && /Attach which\?/.test(stripAnsi(stdout))) {
          sent = true;
          try {
            child.stdin.write(input);
          } catch {
            // ignore
          }
        }
      });
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 0, stdout, stderr });
      });
      child.on('error', () => {
        clearTimeout(timer);
        resolve({ code: 1, stdout, stderr });
      });
    });
  } finally {
    await testEnv.cleanup();
  }
}

// ─── bare `push` resume prompt ───────────────────────────────────

describe('bare push resume prompt', needsChildStdout, () => {
  it('does not trigger picker in non-TTY (TTY guard still fires)', async () => {
    const sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-test-bare-nontty-'));
    // Seed a session whose cwd matches where `push` will run so the
    // cwd-filter would otherwise match. Non-TTY stdin must still win and
    // hit the existing TTY guard — the picker must NOT announce itself.
    await seedSessions(sessionRoot, [
      {
        sessionId: 'sess_alpha1_abcdef',
        updatedAt: 1_700_000_000_000,
        cwd: process.cwd(),
      },
    ]);
    const { code, stderr, stdout } = await runCli([], {
      env: { PUSH_SESSION_DIR: sessionRoot, PUSH_PROVIDER: 'ollama' },
    });
    assert.equal(code, 1);
    assert.ok(stderr.includes('no TTY available'), `expected non-TTY hint, stderr=${stderr}`);
    assert.ok(
      !/Resumable sessions for this workspace:/.test(stdout),
      `picker must not render on non-TTY, stdout=${stdout}`,
    );
  });

  it('--no-resume-prompt parses without unknown-flag warning', async () => {
    const sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-test-bare-optout-'));
    const { code, stderr } = await runCli(['--no-resume-prompt'], {
      env: { PUSH_SESSION_DIR: sessionRoot, PUSH_PROVIDER: 'ollama' },
    });
    assert.equal(code, 1); // still hits the non-TTY exit in non-TTY
    assert.ok(!stderr.includes('unknown flag --no-resume-prompt'));
    assert.ok(stderr.includes('no TTY available'));
  });

  it('cancels cleanly when user types q at the bare-push prompt', async () => {
    try {
      await execFileAsync('script', ['-V']);
    } catch (err) {
      if (err && err.code === 'ENOENT') return;
    }

    const sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-test-bare-cancel-'));
    // Seed two sessions with cwd matching the test's working dir so the
    // cwd filter keeps them. Using two so future N=1 auto-picks (if any)
    // don't short-circuit the prompt this test is pinning.
    const cwd = process.cwd();
    await seedSessions(sessionRoot, [
      {
        sessionId: 'sess_alpha1_abcdef',
        updatedAt: 1_700_000_000_000,
        sessionName: 'Alpha',
        cwd,
      },
      {
        sessionId: 'sess_beta22_bbccdd',
        updatedAt: 1_700_000_500_000,
        cwd,
      },
    ]);

    const { stdout, stderr } = await spawnBarePushPty('q\n', {
      PUSH_SESSION_DIR: sessionRoot,
      PUSH_TUI_ENABLED: '0',
      PUSH_PROVIDER: 'ollama',
    });
    const combined = stripAnsi(`${stdout}\n${stderr}`);
    if (/failed to create pseudo-terminal|permission denied/i.test(combined)) {
      return;
    }
    assert.ok(
      /Resumable sessions for this workspace:/.test(combined),
      `expected workspace picker banner, combined=${combined}`,
    );
    assert.ok(/Cancelled\./.test(combined), `expected cancel line, combined=${combined}`);
  });

  it('does not prompt when no sessions match the current workspace cwd', async () => {
    try {
      await execFileAsync('script', ['-V']);
    } catch (err) {
      if (err && err.code === 'ENOENT') return;
    }

    const sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-test-bare-othercwd-'));
    // Session exists but for a different cwd — the filter should exclude
    // it and the picker should never render.
    await seedSessions(sessionRoot, [
      {
        sessionId: 'sess_alpha1_abcdef',
        updatedAt: 1_700_000_000_000,
        cwd: '/tmp/some-other-dir-that-is-not-cwd',
      },
    ]);

    const { stdout, stderr } = await spawnBarePushPty('', {
      PUSH_SESSION_DIR: sessionRoot,
      PUSH_TUI_ENABLED: '0',
      PUSH_PROVIDER: 'ollama',
    });
    const combined = stripAnsi(`${stdout}\n${stderr}`);
    if (/failed to create pseudo-terminal|permission denied/i.test(combined)) {
      return;
    }
    assert.ok(
      !/Resumable sessions for this workspace:/.test(combined),
      `picker must be silent when no sessions match cwd, combined=${combined}`,
    );
  });
});

async function spawnBarePushPty(input, extraEnv) {
  const testEnv = await makeUniqueTestEnv();
  const env = {
    ...process.env,
    ...testEnv.env,
    ...extraEnv,
  };
  const cmd = buildCliCommand([]);
  try {
    return await new Promise((resolve) => {
      const child = spawn('script', ['-q', '-e', '-c', cmd, '/dev/null'], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, 5000);
      let sent = false;
      child.stdout?.on('data', (chunk) => {
        stdout += String(chunk);
        if (!sent && input && /Resume \[/.test(stripAnsi(stdout))) {
          sent = true;
          try {
            child.stdin.write(input);
          } catch {
            // ignore
          }
        }
      });
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 0, stdout, stderr });
      });
      child.on('error', () => {
        clearTimeout(timer);
        resolve({ code: 1, stdout, stderr });
      });
    });
  } finally {
    await testEnv.cleanup();
  }
}

// ─── deprecated provider migration ─────────────────────────────

describe('deprecated provider migration', needsChildStdout, () => {
  // `google` was previously a deprecated alias for openrouter; it now
  // resolves natively to the direct Google Gemini provider, so it's no
  // longer in this iteration.
  for (const deprecated of ['mistral', 'minimax', 'azure', 'bedrock', 'vertex', 'kilocode']) {
    it(`warns and falls back for --provider ${deprecated}`, async () => {
      // run --task will parse the provider, emit a warning, then proceed.
      // It will eventually fail (no API key / no server), but the warning
      // must appear on stderr and the resolved provider should be openrouter.
      const { stderr } = await runCli(['run', '--task', 'hi', '--provider', deprecated]);
      assert.ok(
        stderr.includes(`provider "${deprecated}" has been removed`),
        `should warn about removed provider "${deprecated}": ${stderr}`,
      );
      assert.ok(stderr.includes('openrouter'), `should mention openrouter as fallback: ${stderr}`);
    });
  }

  it('accepts PUSH_PROVIDER env for deprecated provider', async () => {
    const { stderr } = await runCli(['run', '--task', 'hi'], {
      env: { PUSH_PROVIDER: 'mistral' },
    });
    assert.ok(stderr.includes('provider "mistral" has been removed'));
    assert.ok(stderr.includes('openrouter'));
  });

  it('rejects truly unknown provider', async () => {
    const { code, stderr } = await runCli(['run', '--task', 'hi', '--provider', 'banana']);
    assert.equal(code, 1);
    assert.ok(stderr.includes('Unsupported provider: banana'));
  });
});
