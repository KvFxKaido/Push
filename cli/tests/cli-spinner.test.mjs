import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
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

function stripAnsi(text) {
  return String(text || '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

async function runSpinner(args, { config, env = {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'push-spinner-test-'));
  const configPath = path.join(root, 'config.json');
  if (config !== undefined) {
    await fs.writeFile(configPath, JSON.stringify(config), 'utf8');
  }
  const childEnv = {
    ...process.env,
    PUSH_CONFIG_PATH: configPath,
    PUSH_SESSION_DIR: path.join(root, 'sessions'),
    PUSH_SPINNER: undefined,
    PUSH_REDUCED_MOTION: undefined,
    REDUCED_MOTION: undefined,
    ...env,
  };
  for (const [k, v] of Object.entries(childEnv)) {
    if (v === undefined) delete childEnv[k];
  }
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', CLI_PATH, 'spinner', ...args],
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

describe('push spinner show', needsChildStdout, () => {
  it('prints "off" when no spinner pinned', async () => {
    const r = await runSpinner([]);
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), 'off');
  });

  it('prints the pinned spinner when config.spinner is valid', async () => {
    const r = await runSpinner([], { config: { spinner: 'braille' } });
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), 'braille');
  });

  it('treats an invalid config.spinner as unpinned (reports "off")', async () => {
    const r = await runSpinner([], { config: { spinner: 'sparkle' } });
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), 'off');
  });

  it('flags reduced-motion when active', async () => {
    const r = await runSpinner([], {
      config: { spinner: 'helix' },
      env: { PUSH_REDUCED_MOTION: '1' },
    });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /reduced-motion active/);
  });
});

describe('push spinner list', needsChildStdout, () => {
  it('marks the active spinner with *', async () => {
    const r = await runSpinner(['list'], { config: { spinner: 'orbit' } });
    assert.equal(r.code, 0);
    const line = r.stdout.split('\n').find((l) => /\borbit\b/.test(l));
    assert.ok(line?.startsWith('*'), `expected '*' marker on orbit, got: ${line}`);
  });

  it('shows a frame preview for every non-off spinner', async () => {
    const r = await runSpinner(['list']);
    assert.equal(r.code, 0);
    for (const name of ['braille', 'orbit', 'breathe', 'pulse', 'helix']) {
      const line = r.stdout.split('\n').find((l) => new RegExp(`\\b${name}\\b`).test(l));
      assert.ok(line, `missing list row for ${name}`);
      // Row format is: `${marker} ${preview}  ${name.padEnd(10)}  ${description}`
      // so position 2 (index after marker + space) holds the preview glyph.
      const preview = line.slice(2, 3);
      const code = preview.codePointAt(0);
      assert.ok(
        code >= 0x2800 && code <= 0x28ff,
        `${name} preview must be a Braille glyph, got U+${code?.toString(16)}`,
      );
    }
  });
});

describe('push spinner set', needsChildStdout, () => {
  it('persists the pinned spinner to config', async () => {
    const r = await runSpinner(['set', 'braille']);
    assert.equal(r.code, 0);
    assert.equal(r.config.spinner, 'braille');
  });

  it('normalizes case/whitespace (HELIX → helix)', async () => {
    const r = await runSpinner(['set', '  HELIX  ']);
    assert.equal(r.code, 0);
    assert.equal(r.config.spinner, 'helix');
  });

  it('rejects unknown spinners with a clear error and no config write', async () => {
    const r = await runSpinner(['set', 'sparkle']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /Unknown spinner: sparkle/);
    assert.match(r.stderr, /unpin/);
    assert.equal(r.config.spinner, undefined);
  });

  it('reports missing value as "(missing)" rather than "undefined"', async () => {
    const r = await runSpinner(['set']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /\(missing\)/);
    assert.equal(r.stderr.includes('undefined'), false);
  });

  it('refuses to save non-off spinner under reduced-motion', async () => {
    // Reduced-motion is a hard accessibility guard — the CLI must match
    // the TUI handler, which also refuses. Without this, a headless save
    // on a machine where PUSH_REDUCED_MOTION is set would silently persist
    // a motion preference the runtime would then ignore.
    const r = await runSpinner(['set', 'helix'], { env: { PUSH_REDUCED_MOTION: '1' } });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /reduced-motion/);
    assert.equal(r.config.spinner, undefined);
  });

  it('still allows saving "off" under reduced-motion', async () => {
    const r = await runSpinner(['set', 'off'], { env: { PUSH_REDUCED_MOTION: '1' } });
    assert.equal(r.code, 0);
    assert.equal(r.config.spinner, 'off');
  });

  it('honours REDUCED_MOTION (standard convention) too', async () => {
    const r = await runSpinner(['set', 'braille'], { env: { REDUCED_MOTION: 'true' } });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /reduced-motion/);
  });
});

describe('push spinner unpin', needsChildStdout, () => {
  it('clears a previously pinned spinner', async () => {
    const r = await runSpinner(['unpin'], { config: { spinner: 'braille' } });
    assert.equal(r.code, 0);
    assert.equal(r.config.spinner, undefined);
  });
});

describe('push spinner <bare>', needsChildStdout, () => {
  it('accepts `push spinner braille` without an explicit `set`', async () => {
    const r = await runSpinner(['braille']);
    assert.equal(r.code, 0);
    assert.equal(r.config.spinner, 'braille');
  });
});
