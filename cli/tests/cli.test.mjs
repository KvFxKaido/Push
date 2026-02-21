import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
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
