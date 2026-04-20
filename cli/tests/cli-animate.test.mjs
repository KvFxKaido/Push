import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const CLI_PATH = path.resolve(import.meta.dirname, '..', 'cli.ts');

function stripAnsi(text) {
  return String(text || '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

async function runAnimate(args, { config, env = {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'push-animate-test-'));
  const configPath = path.join(root, 'config.json');
  if (config !== undefined) {
    await fs.writeFile(configPath, JSON.stringify(config), 'utf8');
  }
  const childEnv = {
    ...process.env,
    PUSH_CONFIG_PATH: configPath,
    PUSH_SESSION_DIR: path.join(root, 'sessions'),
    // Isolate from the outer environment — tests that want these vars set
    // can pass them via `env` below.
    PUSH_ANIMATION: undefined,
    PUSH_REDUCED_MOTION: undefined,
    REDUCED_MOTION: undefined,
    ...env,
  };
  // execFile doesn't strip undefined values; convert to unset.
  for (const [k, v] of Object.entries(childEnv)) {
    if (v === undefined) delete childEnv[k];
  }
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', CLI_PATH, 'animate', ...args],
      { env: childEnv, timeout: 8000 },
    );
    const savedRaw = await fs.readFile(configPath, 'utf8').catch(() => '{}');
    return {
      code: 0,
      stdout: stripAnsi(stdout),
      stderr: stripAnsi(stderr),
      config: JSON.parse(savedRaw || '{}'),
    };
  } catch (err) {
    const savedRaw = await fs.readFile(configPath, 'utf8').catch(() => '{}');
    return {
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: stripAnsi(err.stdout || ''),
      stderr: stripAnsi(err.stderr || String(err.message || '')),
      config: JSON.parse(savedRaw || '{}'),
    };
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

describe('push animate show', () => {
  it('prints follow-theme when no animation pinned', async () => {
    const r = await runAnimate([]);
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), 'follow-theme');
  });

  it('prints the pinned effect when config.animation is a valid effect', async () => {
    const r = await runAnimate([], { config: { animation: 'pulse' } });
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), 'pulse');
  });

  it('treats an invalid config.animation as unpinned (not "pinned")', async () => {
    // Regression guard for review feedback: `typeof === 'string'` accepts
    // garbage values that the runtime would ignore, misreporting them as
    // pinned. The gate must be `isAnimationEffect`.
    const r = await runAnimate([], { config: { animation: 'sparkle' } });
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), 'follow-theme');
  });

  it('flags reduced-motion when active', async () => {
    const r = await runAnimate([], {
      config: { animation: 'rainbow' },
      env: { PUSH_REDUCED_MOTION: '1' },
    });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /reduced-motion active/);
  });
});

describe('push animate list', () => {
  it('places the active marker on the matching effect', async () => {
    const r = await runAnimate(['list'], { config: { animation: 'pulse' } });
    assert.equal(r.code, 0);
    const lines = r.stdout.trim().split('\n');
    const pulseLine = lines.find((l) => /\bpulse\b/.test(l));
    assert.ok(pulseLine?.startsWith('*'), `expected '*' marker on pulse, got: ${pulseLine}`);
    const followLine = lines.find((l) => /follow-theme/.test(l));
    assert.ok(
      followLine?.startsWith(' '),
      `expected blank marker on follow-theme, got: ${followLine}`,
    );
  });

  it('marks follow-theme when no effect is pinned', async () => {
    const r = await runAnimate(['list']);
    assert.equal(r.code, 0);
    const followLine = r.stdout
      .trim()
      .split('\n')
      .find((l) => /follow-theme/.test(l));
    assert.ok(
      followLine?.startsWith('*'),
      `expected '*' marker on follow-theme, got: ${followLine}`,
    );
  });
});

describe('push animate set', () => {
  it('persists the pinned effect to config', async () => {
    const r = await runAnimate(['set', 'pulse']);
    assert.equal(r.code, 0);
    assert.equal(r.config.animation, 'pulse');
  });

  it('normalizes case/whitespace (RAINBOW → rainbow)', async () => {
    const r = await runAnimate(['set', '  RAINBOW  ']);
    assert.equal(r.code, 0);
    assert.equal(r.config.animation, 'rainbow');
  });

  it('rejects unknown effects with a clear error and no config write', async () => {
    const r = await runAnimate(['set', 'sparkle']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /Unknown animation effect: sparkle/);
    assert.match(r.stderr, /follow-theme/);
    assert.equal(r.config.animation, undefined);
  });

  it('reports missing value as "(missing)", not "undefined"', async () => {
    const r = await runAnimate(['set']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /\(missing\)/);
    assert.equal(r.stderr.includes('undefined'), false);
  });
});

describe('push animate follow-theme', () => {
  it('clears a previously pinned effect', async () => {
    const r = await runAnimate(['follow-theme'], { config: { animation: 'pulse' } });
    assert.equal(r.code, 0);
    assert.equal(r.config.animation, undefined);
  });
});

describe('push animate <bare>', () => {
  it('accepts `push animate pulse` without an explicit `set`', async () => {
    const r = await runAnimate(['pulse']);
    assert.equal(r.code, 0);
    assert.equal(r.config.animation, 'pulse');
  });
});
