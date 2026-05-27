/**
 * env-scrub.test.mjs — Coverage for the subprocess env policy in
 * `cli/env-scrub.ts`. The integration test at the bottom is the one
 * that catches regressions: it spawns a real subprocess and asserts
 * that provider API keys hydrated into process.env by config-store
 * are NOT visible to `env`-style introspection from inside the child.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { scrubEnv } from '../env-scrub.ts';

const SCRUB_ENV_VARS = ['PUSH_SCRUB_ALLOW', 'PUSH_SCRUB_DISABLED'];

let originalScrubEnv;

beforeEach(() => {
  originalScrubEnv = {};
  for (const k of SCRUB_ENV_VARS) {
    originalScrubEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of SCRUB_ENV_VARS) {
    if (originalScrubEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalScrubEnv[k];
  }
});

describe('scrubEnv', () => {
  it('strips provider API keys from the default allowlist', () => {
    const out = scrubEnv({
      source: {
        PATH: '/usr/bin',
        HOME: '/home/u',
        PUSH_ANTHROPIC_API_KEY: 'sk-anthropic',
        PUSH_OPENAI_API_KEY: 'sk-openai',
        PUSH_GOOGLE_API_KEY: 'sk-google',
        PUSH_OPENROUTER_API_KEY: 'sk-openrouter',
        ANTHROPIC_API_KEY: 'sk-fallback',
        OPENAI_API_KEY: 'sk-fallback',
        GITHUB_TOKEN: 'ghp_xxx',
        AWS_SECRET_ACCESS_KEY: 'aws-secret',
        TAVILY_API_KEY: 'tavily',
      },
    });
    assert.equal(out.PATH, '/usr/bin');
    assert.equal(out.HOME, '/home/u');
    assert.equal(out.PUSH_ANTHROPIC_API_KEY, undefined);
    assert.equal(out.PUSH_OPENAI_API_KEY, undefined);
    assert.equal(out.PUSH_GOOGLE_API_KEY, undefined);
    assert.equal(out.PUSH_OPENROUTER_API_KEY, undefined);
    assert.equal(out.ANTHROPIC_API_KEY, undefined);
    assert.equal(out.OPENAI_API_KEY, undefined);
    assert.equal(out.GITHUB_TOKEN, undefined);
    assert.equal(out.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(out.TAVILY_API_KEY, undefined);
  });

  it('preserves common build, runtime, and CI env vars', () => {
    const out = scrubEnv({
      source: {
        PATH: '/usr/bin',
        HOME: '/home/u',
        NODE_ENV: 'production',
        NODE_OPTIONS: '--max-old-space-size=4096',
        CI: 'true',
        FORCE_COLOR: '1',
        TERM: 'xterm-256color',
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8',
        npm_config_registry: 'https://example.com/',
        NPM_CONFIG_CACHE: '/tmp/npm',
        BUN_INSTALL: '/home/u/.bun',
        PYTHONUNBUFFERED: '1',
        VIRTUAL_ENV: '/home/u/.venv',
        GOPATH: '/home/u/go',
        JAVA_HOME: '/usr/lib/jvm/default',
        DOCKER_HOST: 'unix:///var/run/docker.sock',
      },
    });
    assert.equal(out.PATH, '/usr/bin');
    assert.equal(out.HOME, '/home/u');
    assert.equal(out.NODE_ENV, 'production');
    assert.equal(out.NODE_OPTIONS, '--max-old-space-size=4096');
    assert.equal(out.CI, 'true');
    assert.equal(out.FORCE_COLOR, '1');
    assert.equal(out.TERM, 'xterm-256color');
    assert.equal(out.LANG, 'en_US.UTF-8');
    assert.equal(out.LC_ALL, 'en_US.UTF-8');
    assert.equal(out.npm_config_registry, 'https://example.com/');
    assert.equal(out.NPM_CONFIG_CACHE, '/tmp/npm');
    assert.equal(out.BUN_INSTALL, '/home/u/.bun');
    assert.equal(out.PYTHONUNBUFFERED, '1');
    assert.equal(out.VIRTUAL_ENV, '/home/u/.venv');
    assert.equal(out.GOPATH, '/home/u/go');
    assert.equal(out.JAVA_HOME, '/usr/lib/jvm/default');
    assert.equal(out.DOCKER_HOST, 'unix:///var/run/docker.sock');
  });

  it('drops unknown env vars (default-deny)', () => {
    const out = scrubEnv({
      source: {
        PATH: '/usr/bin',
        MY_PROJECT_BUILD_VAR: 'value',
        SOME_RANDOM_THING: 'value',
      },
    });
    assert.equal(out.PATH, '/usr/bin');
    assert.equal(out.MY_PROJECT_BUILD_VAR, undefined);
    assert.equal(out.SOME_RANDOM_THING, undefined);
  });

  it('honors PUSH_SCRUB_ALLOW for exact-match extras', () => {
    process.env.PUSH_SCRUB_ALLOW = 'MY_BUILD_VAR, OTHER_VAR';
    const out = scrubEnv({
      source: {
        PATH: '/usr/bin',
        MY_BUILD_VAR: 'foo',
        OTHER_VAR: 'bar',
        NOT_LISTED: 'no',
      },
    });
    assert.equal(out.MY_BUILD_VAR, 'foo');
    assert.equal(out.OTHER_VAR, 'bar');
    assert.equal(out.NOT_LISTED, undefined);
  });

  it('honors PUSH_SCRUB_ALLOW for prefix patterns', () => {
    process.env.PUSH_SCRUB_ALLOW = 'MYAPP_*';
    const out = scrubEnv({
      source: {
        PATH: '/usr/bin',
        MYAPP_REGION: 'us-east-1',
        MYAPP_TIER: 'prod',
        OTHER_VAR: 'no',
      },
    });
    assert.equal(out.MYAPP_REGION, 'us-east-1');
    assert.equal(out.MYAPP_TIER, 'prod');
    assert.equal(out.OTHER_VAR, undefined);
  });

  it('PUSH_SCRUB_DISABLED=1 returns the full source env', () => {
    process.env.PUSH_SCRUB_DISABLED = '1';
    const out = scrubEnv({
      source: {
        PUSH_ANTHROPIC_API_KEY: 'sk-secret',
        ANY_RANDOM_VAR: 'value',
      },
    });
    assert.equal(out.PUSH_ANTHROPIC_API_KEY, 'sk-secret');
    assert.equal(out.ANY_RANDOM_VAR, 'value');
  });

  it('skips undefined values', () => {
    const out = scrubEnv({
      source: { PATH: '/usr/bin', HOME: undefined },
    });
    assert.equal(out.PATH, '/usr/bin');
    assert.ok(!Object.prototype.hasOwnProperty.call(out, 'HOME'));
  });
});

describe('scrubEnv on Windows', () => {
  // Windows env vars are case-insensitive at the OS level and Node
  // surfaces the OS spelling. The allowlist's canonical uppercase
  // entries must still cover Node's mixed-case keys, otherwise
  // sandbox_exec subprocesses on Windows lose Path/SystemRoot/ComSpec
  // and can't launch cmd/powershell/anything under Program Files.
  it('matches Windows mixed-case env names case-insensitively', () => {
    const out = scrubEnv({
      platform: 'win32',
      source: {
        Path: 'C:\\Windows\\System32',
        SystemRoot: 'C:\\Windows',
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
        ProgramFiles: 'C:\\Program Files',
        'ProgramFiles(x86)': 'C:\\Program Files (x86)',
        ProgramW6432: 'C:\\Program Files',
        UserProfile: 'C:\\Users\\test',
        APPDATA: 'C:\\Users\\test\\AppData\\Roaming',
        PUSH_ANTHROPIC_API_KEY: 'sk-secret',
      },
    });
    assert.equal(out.Path, 'C:\\Windows\\System32');
    assert.equal(out.SystemRoot, 'C:\\Windows');
    assert.equal(out.ComSpec, 'C:\\Windows\\System32\\cmd.exe');
    assert.equal(out.ProgramFiles, 'C:\\Program Files');
    assert.equal(out['ProgramFiles(x86)'], 'C:\\Program Files (x86)');
    assert.equal(out.ProgramW6432, 'C:\\Program Files');
    assert.equal(out.UserProfile, 'C:\\Users\\test');
    assert.equal(out.APPDATA, 'C:\\Users\\test\\AppData\\Roaming');
    assert.equal(out.PUSH_ANTHROPIC_API_KEY, undefined);
  });

  it('preserves the source key casing on output', () => {
    const out = scrubEnv({
      platform: 'win32',
      source: { Path: 'C:\\Windows' },
    });
    assert.equal(out.Path, 'C:\\Windows');
    assert.ok(!Object.prototype.hasOwnProperty.call(out, 'PATH'));
  });

  it('matches prefix patterns case-insensitively on Windows', () => {
    const out = scrubEnv({
      platform: 'win32',
      source: {
        Path: '/u',
        // npm sets these lowercase even on Windows but be defensive:
        Npm_Config_Registry: 'https://example.com/',
        Lc_All: 'en_US.UTF-8',
      },
    });
    assert.equal(out.Npm_Config_Registry, 'https://example.com/');
    assert.equal(out.Lc_All, 'en_US.UTF-8');
  });

  it('keeps POSIX matching case-sensitive', () => {
    // On POSIX, `Path` and `PATH` are distinct env vars. Don't merge
    // them silently — preserve the prior strict matching.
    const out = scrubEnv({
      platform: 'linux',
      source: { Path: '/usr/bin', PATH: '/usr/local/bin' },
    });
    assert.equal(out.PATH, '/usr/local/bin');
    assert.equal(out.Path, undefined);
  });
});

describe('scrubEnv end-to-end', () => {
  it('subprocess cannot see provider keys via env', async (t) => {
    // Skip on Windows — sh/env aren't reliably available there. The
    // unit tests above already cover the policy itself; this test is
    // the defense-in-depth check that the policy actually applies at
    // the spawn boundary on POSIX.
    if (process.platform === 'win32') {
      t.skip('POSIX-only integration test');
      return;
    }

    const env = scrubEnv({
      source: {
        ...process.env,
        PATH: process.env.PATH || '/usr/bin:/bin',
        PUSH_ANTHROPIC_API_KEY: 'sk-LEAKED-IF-VISIBLE-ANTHROPIC',
        PUSH_OPENAI_API_KEY: 'sk-LEAKED-IF-VISIBLE-OPENAI',
        ANTHROPIC_API_KEY: 'sk-LEAKED-IF-VISIBLE-FALLBACK',
        GITHUB_TOKEN: 'ghp_LEAKED-IF-VISIBLE',
      },
    });

    const child = spawn('sh', ['-c', 'env'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });

    const exitCode = await new Promise((resolve) => {
      child.once('close', (code) => resolve(code));
    });

    assert.equal(exitCode, 0, 'sh -c env exited non-zero');
    assert.ok(
      !stdout.includes('sk-LEAKED-IF-VISIBLE-ANTHROPIC'),
      'PUSH_ANTHROPIC_API_KEY leaked into subprocess env',
    );
    assert.ok(
      !stdout.includes('sk-LEAKED-IF-VISIBLE-OPENAI'),
      'PUSH_OPENAI_API_KEY leaked into subprocess env',
    );
    assert.ok(
      !stdout.includes('sk-LEAKED-IF-VISIBLE-FALLBACK'),
      'ANTHROPIC_API_KEY leaked into subprocess env',
    );
    assert.ok(!stdout.includes('ghp_LEAKED-IF-VISIBLE'), 'GITHUB_TOKEN leaked into subprocess env');
  });
});
