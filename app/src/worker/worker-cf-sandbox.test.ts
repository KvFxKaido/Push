import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSandbox } from '@cloudflare/sandbox';
import { handleCloudflareSandbox, SANDBOX_EXEC_TIMEOUT_MS } from './worker-cf-sandbox';
import type { Env } from './worker-middleware';
import { MAX_TOKEN_BYTES } from './sandbox-token-store';

vi.mock('@cloudflare/sandbox', () => ({
  getSandbox: vi.fn(),
}));

const getSandboxMock = vi.mocked(getSandbox);
const OWNER_TOKEN_PATH = '/tmp/push-owner-token';
const DEFAULT_OWNER_TOKEN = 'test-owner-token';

interface FakeSandbox {
  exec: ReturnType<typeof vi.fn>;
  writeFile: ReturnType<typeof vi.fn>;
  readFile: ReturnType<typeof vi.fn>;
  listFiles: ReturnType<typeof vi.fn>;
  deleteFile: ReturnType<typeof vi.fn>;
  gitCheckout: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}

type ExecResult = { stdout?: string; stderr?: string; exitCode?: number };

function isOwnerTokenReadCommand(command: unknown): command is string {
  return typeof command === 'string' && command.includes(OWNER_TOKEN_PATH);
}

function withOwnerTokenAuthExec(
  sandbox: FakeSandbox,
  handler: (command: string, options?: unknown) => ExecResult | Promise<ExecResult>,
  ownerToken: string = DEFAULT_OWNER_TOKEN,
): void {
  sandbox.exec.mockImplementation(async (command: string, options?: unknown) => {
    if (isOwnerTokenReadCommand(command)) {
      return { stdout: ownerToken, stderr: '', exitCode: 0 };
    }
    return await handler(command, options);
  });
}

function queueExecResults(
  sandbox: FakeSandbox,
  results: Array<ExecResult | Error>,
  ownerToken: string = DEFAULT_OWNER_TOKEN,
): void {
  const pending = [...results];
  withOwnerTokenAuthExec(
    sandbox,
    async () => {
      const next = pending.shift();
      if (!next) return { stdout: '', stderr: '', exitCode: 0 };
      if (next instanceof Error) throw next;
      return next;
    },
    ownerToken,
  );
}

function createFakeSandbox(): FakeSandbox {
  return {
    exec: vi.fn(async (command: string) =>
      isOwnerTokenReadCommand(command)
        ? { stdout: DEFAULT_OWNER_TOKEN, stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 0 },
    ),
    writeFile: vi.fn(async () => ({ success: true })),
    readFile: vi.fn(async (path: string) => ({
      content: path === OWNER_TOKEN_PATH ? DEFAULT_OWNER_TOKEN : '',
    })),
    listFiles: vi.fn(async () => ({ entries: [] })),
    deleteFile: vi.fn(async () => ({ success: true })),
    gitCheckout: vi.fn(async () => ({ success: true })),
    destroy: vi.fn(async () => ({ success: true })),
  };
}

function mockSandbox(sandbox = createFakeSandbox()): FakeSandbox {
  getSandboxMock.mockReturnValue(sandbox as unknown as ReturnType<typeof getSandbox>);
  return sandbox;
}

// Default KV mock for SANDBOX_TOKENS. Most routes authenticate from the
// sandbox-local token file now; tests override this when they specifically
// exercise cleanup fallback or stale-KV behavior.

function makeTokensKV(token: string = DEFAULT_OWNER_TOKEN) {
  return {
    get: vi.fn(async (_key: string, type?: unknown) => {
      const record = { token, createdAt: Date.now() };
      if (type === 'json') return record;
      return JSON.stringify(record);
    }),
    put: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  };
}

function makeDefaultTokensKV() {
  return makeTokensKV(DEFAULT_OWNER_TOKEN);
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    RATE_LIMITER: {
      limit: vi.fn(async () => ({ success: true })),
    } as unknown as Env['RATE_LIMITER'],
    ASSETS: {} as Env['ASSETS'],
    Sandbox: {} as Env['Sandbox'],
    SANDBOX_TOKENS: makeDefaultTokensKV() as unknown as Env['SANDBOX_TOKENS'],
    ALLOWED_ORIGINS: 'https://push.example.test',
    ...overrides,
  };
}

function makeRequest(
  route: string,
  body: Record<string, unknown> | string = {},
  headers: Record<string, string> = {},
): Request {
  return new Request(`https://push.example.test/api/sandbox-cf/${route}`, {
    method: 'POST',
    headers: {
      Origin: 'https://push.example.test',
      'Content-Type': 'application/json',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function callRoute(
  route: string,
  body: Record<string, unknown> | string = {},
  env = makeEnv(),
  headers: Record<string, string> = {},
): Promise<Response> {
  // For non-create routes, inject a default owner_token matching the default
  // sandbox token-file stub. Tests that want to assert auth failures pass
  // their own owner_token (including empty string) via the body.
  const needsToken = route !== 'create' && typeof body === 'object' && body !== null;
  const bodyWithToken: Record<string, unknown> | string = needsToken
    ? { owner_token: DEFAULT_OWNER_TOKEN, ...(body as Record<string, unknown>) }
    : body;
  const request = makeRequest(route, bodyWithToken, headers);
  return await handleCloudflareSandbox(request, env, new URL(request.url), route);
}

function probeStdout(workspaceEntries: string[] = ['package.json']): string {
  return [
    '__node__v20.11.0',
    '__npm__10.2.4',
    '__python__Python 3.12.1',
    '__git__git version 2.43.0',
    '__rg__ripgrep 14.1.0',
    '__jq__jq-1.7',
    '__ruff__ruff 0.1.0',
    '__pytest__pytest 8.1.0',
    '__df__42G',
    ...workspaceEntries,
  ].join('\n');
}

function mockUuid(value = '00000000-0000-4000-8000-000000000001'): string {
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(value as ReturnType<typeof crypto.randomUUID>);
  return value;
}

async function jsonBody(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

beforeEach(() => {
  getSandboxMock.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('handleCloudflareSandbox route dispatch', () => {
  it('returns 404 for an unknown route', async () => {
    const response = await callRoute('bogus');
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Unknown sandbox-cf route: bogus' });
    expect(getSandboxMock).not.toHaveBeenCalled();
  });

  it('returns 503 when the Sandbox binding is missing', async () => {
    const response = await callRoute('create', {}, makeEnv({ Sandbox: undefined }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Cloudflare Sandbox not configured',
      code: 'CF_NOT_CONFIGURED',
    });
    expect(getSandboxMock).not.toHaveBeenCalled();
  });

  it('returns 403 when origin validation fails', async () => {
    const response = await callRoute('create', {}, makeEnv(), { Origin: 'https://evil.test' });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'Origin not allowed' });
    expect(getSandboxMock).not.toHaveBeenCalled();
  });

  it('returns 429 when rate limited', async () => {
    const limit = vi.fn(async () => ({ success: false }));
    const response = await callRoute(
      'create',
      {},
      makeEnv({ RATE_LIMITER: { limit } as unknown as Env['RATE_LIMITER'] }),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    await expect(response.json()).resolves.toEqual({
      error: 'Rate limit exceeded. Try again later.',
    });
    expect(limit).toHaveBeenCalledWith({ key: 'unknown' });
    expect(getSandboxMock).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid JSON body', async () => {
    const response = await callRoute('create', '{not json');
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid JSON body' });
    expect(getSandboxMock).not.toHaveBeenCalled();
  });
});

describe('handleCloudflareSandbox happy paths', () => {
  it('creates a sandbox, clones the repo, seeds files, and returns environment details', async () => {
    const sandbox = mockSandbox();
    const sandboxId = mockUuid();
    sandbox.exec.mockResolvedValue({ stdout: probeStdout(), stderr: '', exitCode: 0 });

    const env = makeEnv();
    const response = await callRoute(
      'create',
      {
        repo: 'owner/repo',
        branch: 'feature',
        github_token: 'ghs_token',
        github_identity: { name: 'Push Bot', email: 'bot@example.test' },
        seed_files: [{ path: '/workspace/README.md', content: 'hello' }],
      },
      env,
    );

    expect(response.status).toBe(200);
    const body = await jsonBody(response);
    expect(body).toMatchObject({
      sandbox_id: sandboxId,
      // mockUuid returns the same value for every crypto.randomUUID() call,
      // so the minted owner_token equals the sandbox_id in this test setup.
      // issueToken's KV write happens via the mocked SANDBOX_TOKENS binding.
      owner_token: sandboxId,
      status: 'ready',
      workspace_revision: 0,
      environment: {
        tools: {
          node: 'v20.11.0',
          npm: '10.2.4',
          git: 'git version 2.43.0',
        },
        project_markers: ['package.json'],
        git_available: true,
        disk_free: '42G',
        writable_root: '/workspace',
      },
    });
    expect(getSandboxMock).toHaveBeenCalledWith(env.Sandbox, sandboxId);
    expect(sandbox.exec).toHaveBeenNthCalledWith(
      1,
      "git config --global user.name 'Push Bot' && git config --global user.email 'bot@example.test'",
    );
    expect(sandbox.gitCheckout).toHaveBeenCalledWith(
      'https://x-access-token:ghs_token@github.com/owner/repo.git',
      { branch: 'feature', targetDir: '/workspace' },
    );
    expect(sandbox.writeFile).toHaveBeenCalledWith('/workspace/README.md', 'hello');
    expect(sandbox.exec).toHaveBeenCalledTimes(2);
  });

  it('connects to a reachable sandbox', async () => {
    const sandbox = mockSandbox();
    queueExecResults(
      sandbox,
      [
        { stdout: '', stderr: '', exitCode: 0 },
        { stdout: probeStdout(['pyproject.toml']), stderr: '', exitCode: 0 },
      ],
      'ot',
    );

    const response = await callRoute('connect', { sandbox_id: 'sb-1', owner_token: 'ot' });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      sandbox_id: 'sb-1',
      owner_token: 'ot',
      status: 'ready',
      workspace_revision: 0,
      environment: {
        project_markers: ['pyproject.toml'],
        writable_root: '/workspace',
      },
    });
    expect(getSandboxMock).toHaveBeenCalledWith(expect.anything(), 'sb-1');
    expect(sandbox.exec.mock.calls[0]?.[0]).toContain(`head -c ${MAX_TOKEN_BYTES + 1}`);
    expect(sandbox.exec).toHaveBeenNthCalledWith(2, 'true');
    expect(sandbox.exec).toHaveBeenCalledTimes(3);
  });

  it('authenticates normal routes from the sandbox token file even if KV is stale', async () => {
    const sandbox = mockSandbox();
    withOwnerTokenAuthExec(sandbox, async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }));

    const env = makeEnv({
      SANDBOX_TOKENS: makeTokensKV('stale-kv-token') as unknown as Env['SANDBOX_TOKENS'],
    });
    const response = await callRoute('exec', { sandbox_id: 'sb-1', command: 'pwd' }, env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      stdout: 'ok',
      stderr: '',
      exit_code: 0,
    });
    expect(sandbox.exec.mock.calls[0]?.[0]).toContain(OWNER_TOKEN_PATH);
  });

  it('executes a command in the requested workdir', async () => {
    const sandbox = mockSandbox();
    withOwnerTokenAuthExec(sandbox, async (command, options) => {
      expect(command).toBe('npm test');
      expect(options).toEqual({ cwd: '/workspace/app' });
      return { stdout: 'ok', stderr: 'warn', exitCode: 7 };
    });

    const response = await callRoute('exec', {
      sandbox_id: 'sb-1',
      command: 'npm test',
      workdir: '/workspace/app',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      stdout: 'ok',
      stderr: 'warn',
      exit_code: 7,
      truncated: false,
      workspace_revision: 0,
    });
    expect(sandbox.exec).toHaveBeenCalledWith('npm test', { cwd: '/workspace/app' });
  });

  it('returns 504 TIMEOUT when sandbox.exec hangs past the per-exec deadline', async () => {
    vi.useFakeTimers();
    try {
      const sandbox = mockSandbox();
      // Token-read exec resolves (so auth succeeds); the actual command
      // exec never resolves — simulates a wedged container after a heavy
      // FS write (e.g. the `npm install` case from the repro log).
      sandbox.exec.mockImplementation((command: unknown) => {
        if (isOwnerTokenReadCommand(command)) {
          return Promise.resolve({ stdout: DEFAULT_OWNER_TOKEN, stderr: '', exitCode: 0 });
        }
        return new Promise(() => {});
      });

      const pending = callRoute('exec', { sandbox_id: 'sb-1', command: 'sleep 999' });
      await vi.advanceTimersByTimeAsync(SANDBOX_EXEC_TIMEOUT_MS + 1);
      const response = await pending;

      expect(response.status).toBe(504);
      const body = (await response.json()) as { code?: string; error?: string };
      expect(body.code).toBe('TIMEOUT');
      expect(body.error).toContain(`${SANDBOX_EXEC_TIMEOUT_MS}ms deadline`);
    } finally {
      vi.useRealTimers();
    }
  });

  // The `read` route is covered comprehensively in worker-cf-sandbox-read.test.ts
  // (10 tests), which exercises the in-container sed/stat/sha256sum/awk
  // pipeline introduced by this PR. The old test in this file mocked
  // sandbox.readFile — which routeRead no longer calls — so keeping it
  // would duplicate coverage and test a dead code path.

  it('writes a file and returns the new version', async () => {
    const sandbox = mockSandbox();

    const response = await callRoute('write', {
      sandbox_id: 'sb-1',
      path: '/workspace/file.txt',
      content: 'new text',
    });

    expect(response.status).toBe(200);
    const body = await jsonBody(response);
    expect(body).toMatchObject({
      ok: true,
      bytes_written: 8,
      workspace_revision: 0,
    });
    expect(body.new_version).toMatch(/^[0-9a-f]{64}$/);
    expect(sandbox.writeFile).toHaveBeenCalledWith('/workspace/file.txt', 'new text');
  });

  it('deletes a file', async () => {
    const sandbox = mockSandbox();

    const response = await callRoute('delete', { sandbox_id: 'sb-1', path: '/workspace/old.txt' });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ workspace_revision: 0 });
    expect(sandbox.deleteFile).toHaveBeenCalledWith('/workspace/old.txt');
  });

  it('lists files and normalizes directory entries', async () => {
    const sandbox = mockSandbox();
    sandbox.listFiles.mockResolvedValue({
      entries: [
        { name: 'src', isDirectory: true, size: 0 },
        { name: 'README.md', type: 'file', size: 12 },
      ],
    });

    const response = await callRoute('list', { sandbox_id: 'sb-1', path: '/workspace' });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      entries: [
        { name: 'src', type: 'directory', size: 0 },
        { name: 'README.md', type: 'file', size: 12 },
      ],
    });
    expect(sandbox.listFiles).toHaveBeenCalledWith('/workspace');
  });

  it('probes the sandbox environment', async () => {
    const sandbox = mockSandbox();
    withOwnerTokenAuthExec(sandbox, async () => ({
      stdout: probeStdout(['Cargo.toml']),
      stderr: '',
      exitCode: 0,
    }));

    const response = await callRoute('probe', { sandbox_id: 'sb-1' });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      tools: {
        node: 'v20.11.0',
        python: 'Python 3.12.1',
        ripgrep: 'ripgrep 14.1.0',
      },
      project_markers: ['Cargo.toml'],
      git_available: true,
      disk_free: '42G',
      writable_root: '/workspace',
    });
    expect(sandbox.exec).toHaveBeenCalledTimes(2);
    expect(sandbox.exec.mock.calls[1][0]).toContain('__node__');
  });
});

describe('handleCloudflareSandbox hardened connect and diff paths', () => {
  it.each([
    [
      'non-zero exit',
      async (sandbox: FakeSandbox) =>
        withOwnerTokenAuthExec(sandbox, async (command) =>
          command === 'true' ? { exitCode: 1 } : { stdout: '', stderr: '', exitCode: 0 },
        ),
    ],
    [
      'exec rejection',
      async (sandbox: FakeSandbox) =>
        withOwnerTokenAuthExec(sandbox, async (command) => {
          if (command === 'true') throw new Error('container gone');
          return { stdout: '', stderr: '', exitCode: 0 };
        }),
    ],
  ])('returns 404 when connect liveness fails: %s', async (_label, arrange) => {
    const sandbox = mockSandbox();
    await arrange(sandbox);

    const response = await callRoute('connect', { sandbox_id: 'sb-dead' });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: 'Sandbox is not reachable',
      code: 'NOT_FOUND',
    });
    expect(sandbox.exec).toHaveBeenCalledTimes(2);
    expect(sandbox.exec).toHaveBeenNthCalledWith(2, 'true');
  });

  it('falls back to KV auth for cleanup when the sandbox token file is gone', async () => {
    const sandbox = mockSandbox();
    withOwnerTokenAuthExec(sandbox, async () => {
      throw new Error('container unhealthy');
    });

    const response = await callRoute(
      'cleanup',
      { sandbox_id: 'sb-1' },
      makeEnv({
        SANDBOX_TOKENS: makeTokensKV(DEFAULT_OWNER_TOKEN) as unknown as Env['SANDBOX_TOKENS'],
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });

  it('rejects oversized sandbox token files before comparing them', async () => {
    const sandbox = mockSandbox();
    withOwnerTokenAuthExec(
      sandbox,
      async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
      'x'.repeat(MAX_TOKEN_BYTES + 1),
    );

    const response = await callRoute('exec', { sandbox_id: 'sb-1', command: 'pwd' });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Owner token does not match',
      code: 'AUTH_FAILURE',
    });
  });

  it.each([
    [
      'git diff',
      { stdout: '', stderr: 'fatal: bad revision', exitCode: 128 },
      { stdout: ' M file.ts', stderr: '', exitCode: 0 },
      'fatal: bad revision',
    ],
    [
      'git status',
      { stdout: 'diff --git a/file.ts b/file.ts', stderr: '', exitCode: 0 },
      { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 },
      'fatal: not a git repository',
    ],
  ])(
    'returns an error field when %s exits non-zero',
    async (_label, diffResult, statusResult, expectedError) => {
      const sandbox = mockSandbox();
      queueExecResults(sandbox, [diffResult, statusResult]);

      const response = await callRoute('diff', { sandbox_id: 'sb-1' });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        diff: '',
        truncated: false,
        git_status: '',
        error: expectedError,
      });
      expect(sandbox.exec).toHaveBeenNthCalledWith(2, 'git -C /workspace diff HEAD');
      expect(sandbox.exec).toHaveBeenNthCalledWith(3, 'git -C /workspace status --porcelain');
    },
  );
});

describe('handleCloudflareSandbox routeHydrate hardening', () => {
  it('writes the archive to /tmp and extracts after successful checks', async () => {
    const sandbox = mockSandbox();
    const uuid = mockUuid();
    const tmpB64 = `/tmp/push-restore-${uuid}.b64`;
    const tmpTar = `${tmpB64}.tar.gz`;
    queueExecResults(sandbox, [
      { exitCode: 0 },
      { exitCode: 0 },
      { stdout: 'safe/file.txt\nsafe/dir/\n', exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0 },
    ]);

    const response = await callRoute('restore', {
      sandbox_id: 'sb-1',
      archive: 'YXJjaGl2ZQ==',
      path: '/workspace/project/',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(sandbox.writeFile).toHaveBeenCalledWith(tmpB64, 'YXJjaGl2ZQ==');
    expect(sandbox.exec).toHaveBeenNthCalledWith(2, 'mkdir -p "/workspace/project"');
    expect(sandbox.exec).toHaveBeenNthCalledWith(3, `base64 -d ${tmpB64} > ${tmpTar}`);
    expect(sandbox.exec).toHaveBeenNthCalledWith(4, `tar -tzf ${tmpTar}`);
    expect(sandbox.exec).toHaveBeenNthCalledWith(
      5,
      `tar -xzf ${tmpTar} -C "/workspace/project" --no-same-owner`,
    );
    expect(sandbox.exec).toHaveBeenNthCalledWith(6, `rm -f ${tmpB64} ${tmpTar}`);
  });

  it('returns 500 when creating the target directory fails', async () => {
    const sandbox = mockSandbox();
    mockUuid();
    queueExecResults(sandbox, [{ exitCode: 1, stderr: 'mkdir denied' }]);

    const response = await callRoute('restore', { sandbox_id: 'sb-1', archive: 'x' });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'Failed to create target directory: mkdir denied',
      code: 'CF_ERROR',
    });
    expect(sandbox.exec).toHaveBeenCalledTimes(2);
  });

  it('returns 400 and cleans up when base64 decode fails', async () => {
    const sandbox = mockSandbox();
    const uuid = mockUuid();
    const tmpB64 = `/tmp/push-restore-${uuid}.b64`;
    const tmpTar = `${tmpB64}.tar.gz`;
    queueExecResults(sandbox, [
      { exitCode: 0 },
      { exitCode: 1, stderr: 'invalid input' },
      { exitCode: 0 },
    ]);

    const response = await callRoute('restore', { sandbox_id: 'sb-1', archive: 'not-base64' });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Failed to decode archive: invalid input',
      code: 'CF_ERROR',
    });
    expect(sandbox.exec).toHaveBeenNthCalledWith(4, `rm -f ${tmpB64} ${tmpTar}`);
  });

  it('returns 400 and cleans up when archive listing fails', async () => {
    const sandbox = mockSandbox();
    const uuid = mockUuid();
    const tmpB64 = `/tmp/push-restore-${uuid}.b64`;
    const tmpTar = `${tmpB64}.tar.gz`;
    queueExecResults(sandbox, [
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 2, stderr: 'not gzip' },
      { exitCode: 0 },
    ]);

    const response = await callRoute('restore', { sandbox_id: 'sb-1', archive: 'bad-tar' });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Invalid archive: not gzip',
      code: 'CF_ERROR',
    });
    expect(sandbox.exec).toHaveBeenNthCalledWith(5, `rm -f ${tmpB64} ${tmpTar}`);
  });

  it.each(['/etc/passwd', 'safe/../evil.txt'])(
    'returns 400 and cleans up for unsafe archive member %s',
    async (unsafeMember) => {
      const sandbox = mockSandbox();
      const uuid = mockUuid();
      const tmpB64 = `/tmp/push-restore-${uuid}.b64`;
      const tmpTar = `${tmpB64}.tar.gz`;
      queueExecResults(sandbox, [
        { exitCode: 0 },
        { exitCode: 0 },
        { stdout: `safe/file.txt\n${unsafeMember}\n`, exitCode: 0 },
        { exitCode: 0 },
      ]);

      const response = await callRoute('restore', { sandbox_id: 'sb-1', archive: 'unsafe-tar' });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: `Archive member rejected (path traversal): ${unsafeMember}`,
        code: 'CF_ERROR',
      });
      expect(sandbox.exec).toHaveBeenNthCalledWith(5, `rm -f ${tmpB64} ${tmpTar}`);
    },
  );

  it('returns 500 and cleans up when archive extraction fails', async () => {
    const sandbox = mockSandbox();
    const uuid = mockUuid();
    const tmpB64 = `/tmp/push-restore-${uuid}.b64`;
    const tmpTar = `${tmpB64}.tar.gz`;
    queueExecResults(sandbox, [
      { exitCode: 0 },
      { exitCode: 0 },
      { stdout: 'safe/file.txt\n', exitCode: 0 },
      { exitCode: 2, stderr: 'permission denied' },
      { exitCode: 0 },
    ]);

    const response = await callRoute('restore', { sandbox_id: 'sb-1', archive: 'safe-tar' });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'Archive extraction failed: permission denied',
      code: 'CF_ERROR',
    });
    expect(sandbox.exec).toHaveBeenNthCalledWith(6, `rm -f ${tmpB64} ${tmpTar}`);
  });
});

describe('handleCloudflareSandbox snapshot stubs', () => {
  it.each(['hibernate', 'restore-snapshot'])(
    'returns 501 for %s with SNAPSHOT_NOT_SUPPORTED',
    async (route) => {
      const sandbox = mockSandbox();
      const response = await callRoute(route, { sandbox_id: 'sb-1' });

      expect(response.status).toBe(501);
      await expect(response.json()).resolves.toEqual({
        error: 'Snapshots not supported on the Cloudflare provider yet',
        code: 'SNAPSHOT_NOT_SUPPORTED',
      });
      expect(getSandboxMock).toHaveBeenCalledOnce();
      expect(sandbox.exec.mock.calls[0]?.[0]).toContain(OWNER_TOKEN_PATH);
    },
  );
});
