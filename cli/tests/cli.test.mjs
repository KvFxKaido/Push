import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { promisify } from 'node:util';
import path from 'node:path';

import { canCaptureChildStdout } from './test-environment.mjs';

const execFileAsync = promisify(execFile);
const CLI_PATH = path.resolve(import.meta.dirname, '..', 'cli.ts');
const childStdoutAvailable = await canCaptureChildStdout();
const needsChildStdout = {
  skip: !childStdoutAvailable && 'child_process stdout capture is unavailable in this sandbox',
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
  const { env: extraEnv, input: _input, ...execOpts } = options;
  const testEnv = await makeUniqueTestEnv();
  const env = {
    ...process.env,
    ...testEnv.env,
    ...extraEnv,
  };
  try {
    try {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        ['--import', 'tsx', CLI_PATH, ...args],
        {
          timeout: 5000,
          env,
          ...execOpts,
        },
      );
      return { code: 0, stdout, stderr };
    } catch (err) {
      return {
        code: typeof err.code === 'number' ? err.code : 1,
        stdout: err.stdout || '',
        stderr: err.stderr || String(err.message || err),
      };
    }
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
});

// ─── unknown flag warning ────────────────────────────────────────

describe('unknown flag warning', needsChildStdout, () => {
  it('warns on unknown flag but does not block --help', async () => {
    const { code, stdout, stderr } = await runCli(['--banana', '--help']);
    assert.equal(code, 0);
    assert.ok(stderr.includes('Warning: unknown flag --banana'));
    assert.ok(stdout.includes('Usage:'));
  });
});

// ─── non-TTY stdin guard ─────────────────────────────────────────

describe('non-TTY stdin guard', needsChildStdout, () => {
  it('rejects interactive mode when stdin is not a TTY', async () => {
    // Pipe /dev/null as stdin to ensure !isTTY
    const { code, stderr } = await runCli([], {
      input: '',
      env: { PUSH_PROVIDER: 'ollama' },
    });
    assert.equal(code, 1);
    assert.ok(stderr.includes('Interactive mode requires a TTY'));
  });

  it('treats sentinel PUSH_PROVIDER values as unset', async () => {
    const { code, stderr } = await runCli([], {
      input: '',
      env: { PUSH_PROVIDER: 'undefined', PUSH_TUI_ENABLED: '0' },
    });
    assert.equal(code, 1);
    assert.ok(stderr.includes('Interactive mode requires a TTY'));
    assert.ok(!stderr.includes('Unsupported provider'));
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

// ─── mode-specific flag warnings ─────────────────────────────────

describe('mode-specific flag warnings', needsChildStdout, () => {
  it('warns when --task is used without run subcommand', async () => {
    // This will also hit the TTY guard, but the warning should appear before it
    const { stderr } = await runCli(['--task', 'something'], { input: '' });
    assert.ok(stderr.includes('--task'));
    assert.ok(stderr.includes('ignored in interactive mode'));
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
    assert.ok(
      stderr.includes('Interactive mode requires a TTY'),
      `expected TTY guard, stderr=${stderr}`,
    );
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
    assert.equal(code, 1); // still hits TTY guard in non-TTY
    assert.ok(!stderr.includes('unknown flag --no-resume-prompt'));
    assert.ok(stderr.includes('Interactive mode requires a TTY'));
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
  for (const deprecated of ['mistral', 'zai', 'google', 'minimax']) {
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
      env: { PUSH_PROVIDER: 'google' },
    });
    assert.ok(stderr.includes('provider "google" has been removed'));
    assert.ok(stderr.includes('openrouter'));
  });

  it('rejects truly unknown provider', async () => {
    const { code, stderr } = await runCli(['run', '--task', 'hi', '--provider', 'banana']);
    assert.equal(code, 1);
    assert.ok(stderr.includes('Unsupported provider: banana'));
  });
});
