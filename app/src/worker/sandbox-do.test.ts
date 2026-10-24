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

function makeSandbox(execImpl?: Parameters<typeof makeContainer>[0], bucket = makeBucket()) {
  const { container, calls } = makeContainer(execImpl);
  const ctx = {
    container,
    exports: { DirectoryBackupGateway: { name: 'gateway' } },
    blockConcurrencyWhile: vi.fn(async (fn: () => Promise<void>) => fn()),
  };
  const sandbox = new Sandbox(ctx as never, { BACKUP_BUCKET: bucket } as never);
  return { sandbox, container, calls, bucket };
}

beforeEach(() => {
  for (const fn of [...Object.values(files), ...Object.values(backups)]) fn.mockReset();
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

  it('unpacks a 0.12 SquashFS backup (no format) straight into the target', async () => {
    const id = '11111111-2222-3333-4444-555555555555';
    const bucket = makeBucket({
      [`backups/${id}/meta.json`]: JSON.stringify({
        createdAt: new Date().toISOString(),
        ttl: 3600,
      }),
      [`backups/${id}/data.sqsh`]: '"bytes"',
    });
    const { sandbox, calls } = makeSandbox(undefined, bucket);
    await expect(sandbox.restoreBackup({ id, dir: '/tmp/stage' })).resolves.toMatchObject({
      success: true,
    });
    expect(calls[0].options.stdin).toBe(`stream:backups/${id}/data.sqsh`);
    expect(calls[1].argv[2]).toContain('unsquashfs -f -d');
    expect(backups.restore).not.toHaveBeenCalled();
  });

  it('refuses an expired 0.12 backup', async () => {
    const id = '11111111-2222-3333-4444-555555555555';
    const bucket = makeBucket({
      [`backups/${id}/meta.json`]: JSON.stringify({ createdAt: '2000-01-01T00:00:00Z', ttl: 3600 }),
    });
    const { sandbox } = makeSandbox(undefined, bucket);
    await expect(sandbox.restoreBackup({ id, dir: '/tmp/stage' })).rejects.toThrow(
      /^BACKUP_EXPIRED: /,
    );
  });
});
