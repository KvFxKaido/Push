import { spawnSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The runtime base class: Workers RPC needs it, tests only need ctx/env.
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    protected ctx: unknown;
    protected env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const files = {
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  rename: vi.fn(),
  remove: vi.fn(),
  readDirectory: vi.fn(),
};
const backups = { backup: vi.fn(), restore: vi.fn() };
vi.mock('@cloudflare/sandbox', () => ({
  Files: vi.fn(function Files() {
    return files;
  }),
  DirectoryBackup: vi.fn(function DirectoryBackup() {
    return backups;
  }),
}));

const { Sandbox } = await import('./sandbox-do');

const encoder = new TextEncoder();

interface ExecCall {
  argv: string[];
  options: { cwd?: string; env?: Record<string, string>; signal?: AbortSignal; stdin?: unknown };
}

function makeContainer(
  execImpl?: (argv: string[]) => { exitCode: number; stdout?: string; stderr?: string },
) {
  const calls: ExecCall[] = [];
  const container = {
    running: false,
    images: { sandbox: 'registry/push-sandbox@sha256:abc' },
    start: vi.fn(() => {
      container.running = true;
    }),
    setInactivityTimeout: vi.fn(async () => {}),
    destroy: vi.fn(async () => {
      container.running = false;
    }),
    exec: vi.fn(async (argv: string[], options: ExecCall['options']) => {
      calls.push({ argv, options });
      const result = execImpl?.(argv) ?? { exitCode: 0 };
      return {
        output: async () => ({
          exitCode: result.exitCode,
          stdout: encoder.encode(result.stdout ?? '').buffer,
          stderr: encoder.encode(result.stderr ?? '').buffer,
        }),
      };
    }),
  };
  return { container, calls };
}

function makeBucket(objects: Record<string, string> = {}) {
  const store = new Map(Object.entries(objects));
  return {
    store,
    get: vi.fn(async (key: string) => {
      if (!store.has(key)) return null;
      const text = store.get(key)!;
      return { json: async () => JSON.parse(text), body: `stream:${key}` };
    }),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
  };
}

function makeSandbox(
  execImpl?: Parameters<typeof makeContainer>[0],
  bucket = makeBucket(),
  extraEnv: Record<string, unknown> = {},
) {
  const { container, calls } = makeContainer(execImpl);
  const ctx = {
    container,
    exports: { DirectoryBackupGateway: { name: 'gateway' } },
    blockConcurrencyWhile: vi.fn(async (fn: () => Promise<void>) => fn()),
    storage: {
      get: vi.fn(async () => undefined),
      put: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    },
  };
  const sandbox = new Sandbox(ctx as never, { BACKUP_BUCKET: bucket, ...extraEnv } as never);
  return { sandbox, container, calls, bucket };
}

beforeEach(() => {
  for (const fn of [...Object.values(files), ...Object.values(backups)]) fn.mockReset();
});

describe('Sandbox facade: Cloudflare Artifacts', () => {
  function binding() {
    const repo = {
      [Symbol.dispose]: vi.fn(),
      createToken: vi.fn(async () => ({ plaintext: 'short-lived?expires=123' })),
      revokeToken: vi.fn(async () => true),
      info: vi.fn(async () => ({
        remote:
          'https://0123456789abcdef0123456789abcdef.artifacts.cloudflare.net/git/push/test.git',
      })),
    };
    return {
      repo,
      create: vi.fn(async () => ({
        remote:
          'https://0123456789abcdef0123456789abcdef.artifacts.cloudflare.net/git/push/test.git',
        token: 'initial',
      })),
      get: vi.fn(async () => repo),
      delete: vi.fn(async () => true),
      import: vi.fn(),
    };
  }

  it('uploads a checkpoint without changing the live repo and revokes write access', async () => {
    const artifacts = binding();
    const { sandbox, calls } = makeSandbox(
      (argv) => ({
        exitCode: 0,
        stdout: argv.includes('push-artifacts-checkpoint') ? 'a'.repeat(40) : '',
      }),
      makeBucket(),
      { CF_ARTIFACTS: artifacts, PUSH_ARTIFACT_CHECKPOINTS: '1' },
    );
    const handle = await sandbox.createBackup({ dir: '/workspace', ttl: 3600 });
    expect(handle).toMatchObject({ format: 'push-artifacts-v1', commit: 'a'.repeat(40) });
    expect(backups.backup).not.toHaveBeenCalled();
    expect(
      calls.find((call) => call.argv[2]?.includes('git -c core.hooksPath'))?.options.cwd,
    ).toMatch(/^\/tmp\/push-checkpoint-/);
    expect(artifacts.repo.revokeToken.mock.calls).toEqual([
      ['initial'],
      ['short-lived?expires=123'],
    ]);
  });

  it('falls back to DirectoryBackup on capture failure for an ordinary workspace', async () => {
    const artifacts = binding();
    backups.backup.mockResolvedValue({ id: 'fallback', dir: '/workspace', format: 'tar.zst' });
    const { sandbox } = makeSandbox(
      (argv) => ({
        exitCode: argv[0] === 'mountpoint' || argv.includes('push-artifacts-checkpoint') ? 1 : 0,
      }),
      makeBucket(),
      { CF_ARTIFACTS: artifacts, PUSH_ARTIFACT_CHECKPOINTS: '1' },
    );
    expect(await sandbox.createBackup({ dir: '/workspace' })).toMatchObject({ id: 'fallback' });
  });

  it('never returns a DirectoryBackup containing an external ArtifactFS gitdir', async () => {
    const artifacts = binding();
    const { sandbox } = makeSandbox(
      (argv) => ({ exitCode: argv.includes('push-artifacts-checkpoint') ? 1 : 0 }),
      makeBucket(),
      { CF_ARTIFACTS: artifacts, PUSH_ARTIFACT_CHECKPOINTS: '1' },
    );
    await expect(sandbox.createBackup({ dir: '/workspace' })).rejects.toThrow('BACKUP_FAILED');
    expect(backups.backup).not.toHaveBeenCalled();
  });

  it('does not forward GitHub credentials to import and falls back after cleanup', async () => {
    const artifacts = binding();
    artifacts.import.mockRejectedValue(new Error('private repository'));
    const { sandbox, calls } = makeSandbox(undefined, makeBucket(), {
      CF_ARTIFACTS: artifacts,
      PUSH_ARTIFACT_FS: '1',
      SANDBOX_TOKENS: { put: vi.fn() },
    });
    await sandbox.gitCheckout('https://x-access-token:secret@github.com/owner/repo.git', {
      branch: 'main',
      artifactFs: true,
    });
    expect(artifacts.import).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { url: 'https://github.com/owner/repo.git', branch: 'main', depth: 1 },
      }),
    );
    expect(calls.some((call) => call.argv.includes('--cleanup'))).toBe(true);
    expect(calls.at(-1)?.argv.slice(0, 2)).toEqual(['git', 'clone']);
  });
});

describe('Sandbox facade: container lifecycle', () => {
  it('starts the container once, with the image, internet, standard-1 and a 1h idle window', async () => {
    const { sandbox, container } = makeSandbox();
    await Promise.all([sandbox.exec('true'), sandbox.exec('true')]);
    expect(container.start).toHaveBeenCalledTimes(1);
    expect(container.start).toHaveBeenCalledWith(
      expect.objectContaining({
        image: 'registry/push-sandbox@sha256:abc',
        enableInternet: true,
        instance: 'standard-1',
      }),
    );
    expect(container.setInactivityTimeout).toHaveBeenCalledWith(60 * 60 * 1000);
  });

  it('re-applies the idle window when the container outlived the Durable Object', () => {
    const { container } = makeContainer();
    container.running = true;
    const ctx = {
      container,
      exports: {},
      blockConcurrencyWhile: vi.fn(async (fn: () => Promise<void>) => fn()),
    };
    new Sandbox(ctx as never, {} as never);
    expect(ctx.blockConcurrencyWhile).toHaveBeenCalled();
    expect(container.setInactivityTimeout).toHaveBeenCalledWith(60 * 60 * 1000);
  });
});

describe('Sandbox facade: exec keeps 0.12 semantics', () => {
  it('runs a shell string via bash -c in /workspace with HOME set, merged with caller env', async () => {
    const { sandbox, calls } = makeSandbox(() => ({ exitCode: 0, stdout: 'hi\n' }));
    const result = await sandbox.exec('echo hi | cat', {
      env: { NODE_OPTIONS: '--max-old-space-size=1024' },
    });
    expect(calls[0].argv).toEqual(['bash', '-c', 'echo hi | cat']);
    expect(calls[0].options.cwd).toBe('/workspace');
    expect(calls[0].options.env).toMatchObject({
      HOME: '/root',
      LANG: 'C.UTF-8',
      NODE_OPTIONS: '--max-old-space-size=1024',
    });
    expect(result).toEqual({ success: true, exitCode: 0, stdout: 'hi\n', stderr: '' });
  });

  it('reports a non-zero exit instead of throwing', async () => {
    const { sandbox } = makeSandbox(() => ({ exitCode: 2, stderr: 'nope' }));
    await expect(sandbox.exec('false')).resolves.toEqual({
      success: false,
      exitCode: 2,
      stdout: '',
      stderr: 'nope',
    });
  });

  it('passes a deadline signal for a timeout, and maps an abort to exit 124', async () => {
    const { sandbox, container, calls } = makeSandbox();
    await sandbox.exec('sleep 1', { timeout: 5000 });
    expect(calls[0].options.signal).toBeInstanceOf(AbortSignal);
    container.exec.mockRejectedValueOnce(
      Object.assign(new Error('timed out'), { name: 'TimeoutError' }),
    );
    await expect(sandbox.exec('sleep 99', { timeout: 10 })).resolves.toMatchObject({
      exitCode: 124,
      success: false,
    });
  });
});

describe('Sandbox facade: files', () => {
  it('creates parent directories and writes through a temp file, as 0.12 did', async () => {
    const { sandbox } = makeSandbox();
    await sandbox.writeFile('src/new/file.ts', 'x');
    expect(files.mkdir).toHaveBeenCalledWith('/workspace/src/new', { recursive: true });
    const temp = files.writeFile.mock.calls[0][0] as string;
    expect(temp).toMatch(/^\/workspace\/src\/new\/file\.ts\.push-tmp-/);
    expect(files.rename).toHaveBeenCalledWith(temp, '/workspace/src/new/file.ts');
  });

  it('hides dotfiles from listings, as 0.12 did', async () => {
    const { sandbox } = makeSandbox();
    files.readDirectory.mockResolvedValue([
      { name: '.git', type: 'directory' },
      { name: 'src', type: 'directory' },
      { name: 'README.md', type: 'file' },
    ]);
    await expect(sandbox.listFiles('/workspace')).resolves.toEqual({
      entries: [
        { name: 'src', type: 'directory', isDirectory: true },
        { name: 'README.md', type: 'file', isDirectory: false },
      ],
    });
  });

  it('reads text content in the 0.12 shape', async () => {
    const { sandbox } = makeSandbox();
    files.readFile.mockResolvedValue(new Response('hello'));
    await expect(sandbox.readFile('/workspace/a.txt')).resolves.toEqual({ content: 'hello' });
  });
});

describe('Sandbox facade: gitCheckout', () => {
  it('clones with depth and branch, and throws git stderr with the token redacted', async () => {
    const { sandbox, calls } = makeSandbox(() => ({
      exitCode: 128,
      stderr:
        "fatal: Remote branch nope not found in upstream origin\nfatal: unable to access 'https://x-access-token:ghs_SECRET@github.com/o/r.git/'",
    }));
    const error = await sandbox
      .gitCheckout('https://x-access-token:ghs_SECRET@github.com/o/r.git', {
        branch: 'nope',
        depth: 1,
      })
      .catch((e: Error) => e);
    expect(calls[0].argv).toEqual([
      'git',
      'clone',
      '--depth',
      '1',
      '--branch',
      'nope',
      '--',
      'https://x-access-token:ghs_SECRET@github.com/o/r.git',
      '/workspace',
    ]);
    expect((error as Error).message).toMatch(/Remote branch nope not found/);
    expect((error as Error).message).not.toContain('ghs_SECRET');
  });
});

describe('Sandbox facade: background processes', () => {
  const id = '11111111-2222-3333-4444-555555555555';

  it.each([
    ['running', 'start=1000\nend=\nexit=\nkilled=\nalive=1', { status: 'running' }],
    [
      'completed',
      'start=1000\nend=2000\nexit=0\nkilled=\nalive=',
      { status: 'completed', exitCode: 0 },
    ],
    ['failed', 'start=1000\nend=2000\nexit=3\nkilled=\nalive=', { status: 'failed', exitCode: 3 }],
    ['killed', 'start=1000\nend=\nexit=\nkilled=1\nalive=', { status: 'killed' }],
    ['died without an exit file', 'start=1000\nend=\nexit=\nkilled=\nalive=', { status: 'failed' }],
  ])('maps a %s process to the 0.12 status', async (_label, probe, expected) => {
    const { sandbox } = makeSandbox(() => ({ exitCode: 0, stdout: probe }));
    await expect(sandbox.getProcess(id)).resolves.toMatchObject({ id, ...expected });
  });

  it('returns null for an unknown or malformed id', async () => {
    const { sandbox } = makeSandbox(() => ({ exitCode: 0, stdout: 'missing\n' }));
    await expect(sandbox.getProcess(id)).resolves.toBeNull();
    await expect(sandbox.getProcess('../../etc')).resolves.toBeNull();
  });

  it('starts a detached, own-group process with a GNU timeout when asked', async () => {
    const { sandbox, calls } = makeSandbox();
    const info = await sandbox.startProcess('npm test', { timeout: 60_000, cwd: '/workspace/app' });
    expect(info.status).toBe('running');
    const script = calls[0].argv[2];
    expect(script).toContain('setsid bash -c');
    expect(script).toContain('timeout -k 5 60');
    expect(calls[0].options.cwd).toBe('/workspace/app');
  });

  it('runs the command in its own bash, so an `exit` in it still records the exit code', async () => {
    const { sandbox, calls } = makeSandbox();
    await sandbox.startProcess('echo hi; exit 3');
    const script = calls[0].argv[2];
    // The command is quoted into a nested `bash -c`, followed by the bookkeeping.
    expect(script).toMatch(/bash -c '\\''echo hi; exit 3'\\''; echo \$\? > /);
  });

  // String assertions can't see a shell syntax error: the first launcher
  // joined its steps with `&&`, producing `& &&`, and every background process
  // failed on staging while these tests passed. Parse each generated script
  // with a real bash.
  it.skipIf(spawnSync('bash', ['--version']).status !== 0)(
    'generates scripts that real bash parses',
    async () => {
      const id = '11111111-2222-3333-4444-555555555555';
      const { sandbox, calls } = makeSandbox(() => ({ exitCode: 0, stdout: 'start=1' }));
      await sandbox.startProcess("echo 'quoted' && sleep 1");
      await sandbox.startProcess('npm test', { timeout: 60_000 });
      await sandbox.getProcess(id);
      await sandbox.killProcess(id, 'SIGTERM');
      const scripts = calls.filter((c) => c.argv[0] === 'bash').map((c) => c.argv[2]);
      expect(scripts.length).toBeGreaterThanOrEqual(4);
      for (const script of scripts) {
        const parsed = spawnSync('bash', ['-n', '-c', script], { encoding: 'utf8' });
        expect(parsed.stderr, script).toBe('');
        expect(parsed.status, script).toBe(0);
      }
    },
  );
});

describe('Sandbox facade: backups', () => {
  it('backs up with any-depth excludes and records the expiry beside the archive', async () => {
    const bucket = makeBucket();
    const { sandbox } = makeSandbox(undefined, bucket);
    backups.backup.mockResolvedValue({
      id: 'b1',
      dir: '/workspace',
      size: 10,
      sha256: 'h',
      format: 'tar.zst',
    });
    const handle = await sandbox.createBackup({
      dir: '/workspace',
      ttl: 60,
      gitignore: true,
      excludes: ['node_modules/'],
    });
    expect(backups.backup).toHaveBeenCalledWith({
      dir: '/workspace',
      gitignore: true,
      exclude: ['**/node_modules/'],
    });
    expect(handle).toMatchObject({ id: 'b1', format: 'tar.zst' });
    expect(bucket.store.get('backups/b1.meta.json')).toContain('expiresAt');
  });

  it('refuses an expired backup with the code in the message (it must survive RPC)', async () => {
    const bucket = makeBucket({
      'backups/b1.meta.json': JSON.stringify({ expiresAt: '2000-01-01T00:00:00Z' }),
    });
    const { sandbox } = makeSandbox(undefined, bucket);
    const record = {
      id: 'b1',
      dir: '/tmp/stage',
      size: 1,
      sha256: 'h',
      format: 'tar.zst',
    } as never;
    await expect(sandbox.restoreBackup(record)).rejects.toThrow(/^BACKUP_EXPIRED: /);
    expect(backups.restore).not.toHaveBeenCalled();
  });

  it('restores a current backup into the requested directory', async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const bucket = makeBucket({ 'backups/b1.meta.json': JSON.stringify({ expiresAt: future }) });
    const { sandbox } = makeSandbox(undefined, bucket);
    const record = { id: 'b1', dir: '/tmp/stage', size: 1, sha256: 'h', format: 'tar.zst' };
    await expect(sandbox.restoreBackup(record as never)).resolves.toEqual({
      success: true,
      dir: '/tmp/stage',
      id: 'b1',
    });
    expect(backups.restore).toHaveBeenCalledWith(record, { dir: '/tmp/stage' });
  });

  it('refuses a 0.12 SquashFS handle (no format) as expired, without starting the container', async () => {
    const id = '11111111-2222-3333-4444-555555555555';
    // A live 0.12 backup: still within its TTL, archive present. Refused anyway.
    const bucket = makeBucket({
      [`backups/${id}/meta.json`]: JSON.stringify({
        createdAt: new Date().toISOString(),
        ttl: 3600,
      }),
      [`backups/${id}/data.sqsh`]: '"bytes"',
    });
    const { sandbox, calls, container } = makeSandbox(undefined, bucket);
    await expect(sandbox.restoreBackup({ id, dir: '/tmp/stage' } as never)).rejects.toThrow(
      /^BACKUP_EXPIRED: .*Sandbox SDK 0\.12/,
    );
    expect(calls).toHaveLength(0);
    expect(container.start).not.toHaveBeenCalled();
    expect(backups.restore).not.toHaveBeenCalled();
  });
});
