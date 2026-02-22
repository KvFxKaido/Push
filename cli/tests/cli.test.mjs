import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const CLI_PATH = path.resolve(import.meta.dirname, '..', 'cli.mjs');

async function runCli(args, options = {}) {
  const { env: extraEnv, ...execOpts } = options;
  const env = {
    ...process.env,
    PUSH_SESSION_DIR: '/tmp/push-test-cli-' + Date.now(),
    PUSH_CONFIG_PATH: '/tmp/push-test-cli-config-' + Date.now(),
    ...extraEnv,
  };
  try {
    const result = await execFileAsync('node', [CLI_PATH, ...args], {
      timeout: 5000,
      env,
      ...execOpts,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (err) {
    return {
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
    };
  }
}

function stripAnsi(text) {
  return String(text || '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '');
}

function shQuote(arg) {
  return `'${String(arg).replace(/'/g, `'\\''`)}'`;
}

async function runCliPty(args, options = {}) {
  const { env: extraEnv, input = '', timeout = 8000, ...spawnOpts } = options;
  const env = {
    ...process.env,
    PUSH_SESSION_DIR: '/tmp/push-test-cli-' + Date.now(),
    PUSH_CONFIG_PATH: '/tmp/push-test-cli-config-' + Date.now(),
    ...extraEnv,
  };
  const cmd = [process.execPath, CLI_PATH, ...args].map(shQuote).join(' ');
  const lines = String(input || '')
    .split('\n')
    .filter((line, idx, arr) => !(idx === arr.length - 1 && line === ''))
    .map((line) => `${line}\n`);

  function countPrompts(text) {
    const matches = stripAnsi(text).match(/(?:^|\n)> /g);
    return matches ? matches.length : 0;
  }

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
}

// ─── --version ───────────────────────────────────────────────────

describe('--version', () => {
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

describe('--help', () => {
  it('prints usage and exits 0', async () => {
    const { code, stdout } = await runCli(['--help']);
    assert.equal(code, 0);
    assert.ok(stdout.includes('Usage:'));
    assert.ok(stdout.includes('--version'));
  });
});

// ─── unknown subcommand ──────────────────────────────────────────

describe('unknown subcommand', () => {
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

// ─── --max-rounds validation ─────────────────────────────────────

describe('--max-rounds validation', () => {
  it('rejects non-numeric value', async () => {
    const { code, stderr } = await runCli(['run', '--task', 'hi', '--max-rounds', 'banana']);
    assert.equal(code, 1);
    assert.ok(stderr.includes('Invalid --max-rounds'));
  });
});

// ─── --sandbox / --no-sandbox conflict ───────────────────────────

describe('--sandbox / --no-sandbox conflict', () => {
  it('rejects both flags together', async () => {
    const { code, stderr } = await runCli(['--sandbox', '--no-sandbox', 'run', '--task', 'hi']);
    assert.equal(code, 1);
    assert.ok(stderr.includes('Conflicting flags'));
  });
});

// ─── unknown flag warning ────────────────────────────────────────

describe('unknown flag warning', () => {
  it('warns on unknown flag but does not block --help', async () => {
    const { code, stdout, stderr } = await runCli(['--banana', '--help']);
    assert.equal(code, 0);
    assert.ok(stderr.includes('Warning: unknown flag --banana'));
    assert.ok(stdout.includes('Usage:'));
  });
});

// ─── non-TTY stdin guard ─────────────────────────────────────────

describe('non-TTY stdin guard', () => {
  it('rejects interactive mode when stdin is not a TTY', async () => {
    // Pipe /dev/null as stdin to ensure !isTTY
    const { code, stderr } = await runCli([], {
      input: '',
      env: { PUSH_PROVIDER: 'ollama' },
    });
    assert.equal(code, 1);
    assert.ok(stderr.includes('Interactive mode requires a TTY'));
  });
});

// ─── --cwd validation ────────────────────────────────────────────

describe('--cwd validation', () => {
  it('rejects nonexistent path', async () => {
    const { code, stderr } = await runCli(['--cwd', '/definitely/not/a/real/path', 'run', '--task', 'hi']);
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

describe('--session validation', () => {
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

// ─── mode-specific flag warnings ─────────────────────────────────

describe('mode-specific flag warnings', () => {
  it('warns when --task is used without run subcommand', async () => {
    // This will also hit the TTY guard, but the warning should appear before it
    const { stderr } = await runCli(['--task', 'something'], { input: '' });
    assert.ok(stderr.includes('--task'));
    assert.ok(stderr.includes('ignored in interactive mode'));
  });
});

// ─── interactive REPL /compact (pty) ──────────────────────────────

describe('interactive REPL /compact', () => {
  it('compacts saved session context and persists digest', async () => {
    // Skip on environments without util-linux `script` (pseudo-TTY helper).
    try {
      await execFileAsync('script', ['-V']);
    } catch (err) {
      if (err && err.code === 'ENOENT') return; // soft-skip in minimal environments
      // Some script variants return non-zero for -V; that's still "available".
    }

    const sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-test-cli-pty-'));
    const configPath = path.join(os.tmpdir(), `push-test-cli-config-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
    const sessionId = 'sess_compact1_abcdef';
    const sessionDir = path.join(sessionRoot, sessionId);
    const statePath = path.join(sessionDir, 'state.json');
    const eventsPath = path.join(sessionDir, 'events.jsonl');
    const now = Date.now();

    const toolPayload = JSON.stringify({
      tool: 'read_file',
      ok: true,
      output: 'x'.repeat(400),
      meta: null,
      structuredError: null,
    }, null, 2);

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

    const savedRaw = await fs.readFile(statePath, 'utf8');
    const saved = JSON.parse(savedRaw);
    const contents = saved.messages.map((m) => String(m.content));
    assert.ok(contents.some((c) => c.includes('[CONTEXT DIGEST]')), 'should persist context digest');
    assert.ok(contents.some((c) => c === 'Turn 3 user'), 'should preserve latest turn');
    assert.ok(!contents.some((c) => c === 'Turn 2 user'), 'should compact older middle turn');

    const eventLines = (await fs.readFile(eventsPath, 'utf8')).trim().split('\n').filter(Boolean);
    const parsedEvents = eventLines.map((line) => JSON.parse(line));
    assert.ok(parsedEvents.some((e) => e.type === 'context_compacted'), 'should append context_compacted event');
  });
});
