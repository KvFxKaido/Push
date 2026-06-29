import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSandbox } from '@cloudflare/sandbox';
import {
  createWorkspaceSnapshot,
  handleCloudflareSandbox,
  MAX_SNAPSHOT_BYTES,
  restoreWorkspaceSnapshot,
  SANDBOX_EXEC_TIMEOUT_MS,
  SandboxExecDeadlineError,
} from './worker-cf-sandbox';
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
  startProcess: ReturnType<typeof vi.fn>;
  getProcess: ReturnType<typeof vi.fn>;
  getProcessLogs: ReturnType<typeof vi.fn>;
  killProcess: ReturnType<typeof vi.fn>;
}

type ExecResult = { stdout?: string; stderr?: string; exitCode?: number };

function isOwnerTokenReadCommand(command: unknown): command is string {
  return typeof command === 'string' && command.includes(OWNER_TOKEN_PATH);
}

function isBranchStampCommand(command: unknown): command is string {
  return (
    typeof command === 'string' &&
    command.includes('git -C /workspace symbolic-ref --short -q HEAD')
  );
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
    if (isBranchStampCommand(command)) {
      return { stdout: 'main\n', stderr: '', exitCode: 0 };
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
        : isBranchStampCommand(command)
          ? { stdout: 'main\n', stderr: '', exitCode: 0 }
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
    startProcess: vi.fn(async (command: string) => ({
      id: 'proc_test_1',
      command,
      status: 'running',
      startTime: new Date('2026-06-04T00:00:00.000Z'),
    })),
    getProcess: vi.fn(async (id: string) => ({
      id,
      status: 'running',
      startTime: new Date('2026-06-04T00:00:00.000Z'),
    })),
    getProcessLogs: vi.fn(async (id: string) => ({
      stdout: '',
      stderr: '',
      processId: id,
    })),
    killProcess: vi.fn(async () => undefined),
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
    // Every accessor applies Push's raised idle-sleep policy (not CF's 10-min
    // default) so a foregrounded idle session doesn't get wiped from under it.
    expect(getSandboxMock).toHaveBeenCalledWith(env.Sandbox, sandboxId, { sleepAfter: '1h' });
    expect(sandbox.exec).toHaveBeenNthCalledWith(
      1,
      "git config --global user.name 'Push Bot' && git config --global user.email 'bot@example.test'",
    );
    expect(sandbox.gitCheckout).toHaveBeenCalledWith(
      'https://x-access-token:ghs_token@github.com/owner/repo.git',
      { branch: 'feature', targetDir: '/workspace', depth: 1 },
    );
    expect(sandbox.writeFile).toHaveBeenCalledWith('/workspace/README.md', 'hello');
    // Call 2 strips the tokenized clone URL out of .git/config so raw
    // sandbox_exec cannot reuse the clone credential (#987).
    expect(sandbox.exec.mock.calls[1]?.[0]).toContain(
      "git -C /workspace remote set-url origin 'https://github.com/owner/repo.git'",
    );
    expect(sandbox.exec.mock.calls[1]?.[0]).not.toContain('ghs_token');
    // Call 3 is the hardlink copy from the image-baked /opt/push-cache
    // cache (see routeCreate). Assert on a substring rather than the
    // whole script so the guard shape stays an implementation detail
    // the test doesn't pin.
    expect(sandbox.exec.mock.calls[2]?.[0]).toEqual(
      expect.stringContaining('cp -al "$src/node_modules"'),
    );
    expect(sandbox.exec).toHaveBeenCalledTimes(4);
  });

  it('recreates a branch absent on origin by cloning the default HEAD and checking it out', async () => {
    // A branch-on-first-prompt branch that was never pushed (local-only, then the
    // sandbox died) isn't on origin. `git clone --branch <missing>` hard-fails;
    // the create must recover by cloning the default HEAD and recreating the
    // branch locally rather than stranding the session.
    const sandbox = mockSandbox();
    mockUuid();
    // `ls-remote` reports the branch ABSENT on origin (exit 0, empty stdout); all
    // other execs succeed with the probe payload.
    sandbox.exec.mockImplementation(async (command: string) =>
      command.includes('ls-remote')
        ? { stdout: '', stderr: '', exitCode: 0 }
        : { stdout: probeStdout(), stderr: '', exitCode: 0 },
    );
    sandbox.gitCheckout.mockImplementation(async (_url: string, opts?: { branch?: string }) => {
      if (opts && 'branch' in opts) {
        throw new Error('fatal: Remote branch feature/x not found in upstream origin');
      }
      return { success: true };
    });

    const env = makeEnv();
    const response = await callRoute(
      'create',
      { repo: 'owner/repo', branch: 'feature/x', github_token: 'ghs_token' },
      env,
    );

    expect(response.status).toBe(200);
    // First attempt is the `--branch` clone (fails); the retry clones the
    // default HEAD with no branch pin.
    expect(sandbox.gitCheckout).toHaveBeenNthCalledWith(
      1,
      'https://x-access-token:ghs_token@github.com/owner/repo.git',
      { branch: 'feature/x', targetDir: '/workspace', depth: 1 },
    );
    expect(sandbox.gitCheckout).toHaveBeenNthCalledWith(
      2,
      'https://x-access-token:ghs_token@github.com/owner/repo.git',
      { targetDir: '/workspace', depth: 1 },
    );
    // Absence is confirmed against origin before recreating.
    expect(
      sandbox.exec.mock.calls.some((c) => String(c[0]).includes('git ls-remote --heads origin')),
    ).toBe(true);
    // The branch is recreated locally off the default checkout.
    expect(
      sandbox.exec.mock.calls.some((c) => String(c[0]).includes("git checkout -b 'feature/x'")),
    ).toBe(true);
    // Symmetric structured log so the recovery isn't a silent path.
    expect(
      vi
        .mocked(console.log)
        .mock.calls.some((c) => String(c[0]).includes('cf_sandbox_branch_recreated')),
    ).toBe(true);
  });

  it('does NOT recreate when the branch exists on origin (transient clone failure)', async () => {
    // P1: a `--branch` clone failing transiently on a branch that DOES exist on
    // origin must not be recreated off the default HEAD (that would base the
    // session branch on the wrong commit). The create surfaces the failure and
    // fails closed (destroys the tokenized fallback container).
    const sandbox = mockSandbox();
    mockUuid();
    sandbox.exec.mockImplementation(async (command: string) =>
      command.includes('ls-remote')
        ? { stdout: 'abc123\trefs/heads/feature/x', stderr: '', exitCode: 0 }
        : { stdout: probeStdout(), stderr: '', exitCode: 0 },
    );
    sandbox.gitCheckout.mockImplementation(async (_url: string, opts?: { branch?: string }) => {
      if (opts && 'branch' in opts) throw new Error('fatal: early EOF (transient)');
      return { success: true };
    });

    const env = makeEnv();
    const response = await callRoute(
      'create',
      { repo: 'owner/repo', branch: 'feature/x', github_token: 'ghs_token' },
      env,
    );

    expect(response.status).toBe(500);
    expect(JSON.stringify(await jsonBody(response))).not.toContain('ghs_token');
    // No `checkout -b` — the existing branch must not be recreated at the wrong base.
    expect(sandbox.exec.mock.calls.some((c) => String(c[0]).includes('git checkout -b'))).toBe(
      false,
    );
    // Fail closed: the tokenized fallback clone's container is destroyed.
    expect(sandbox.destroy).toHaveBeenCalled();
  });

  it('surfaces the original clone failure when the default-HEAD retry also fails', async () => {
    // If cloning the default HEAD ALSO fails, it's a real infra/auth error, not a
    // missing branch — the create must surface it rather than mask it as a
    // recreate.
    const sandbox = mockSandbox();
    mockUuid();
    sandbox.exec.mockResolvedValue({ stdout: probeStdout(), stderr: '', exitCode: 0 });
    sandbox.gitCheckout.mockRejectedValue(new Error('fatal: could not read from remote'));

    const env = makeEnv();
    const response = await callRoute(
      'create',
      { repo: 'owner/repo', branch: 'feature/x', github_token: 'ghs_token' },
      env,
    );

    expect(response.status).toBe(500);
    expect(JSON.stringify(await jsonBody(response))).not.toContain('ghs_token');
  });

  it('fails closed (destroys the sandbox) when the clone-credential strip fails', async () => {
    // #987: if the post-clone `git remote set-url` to the tokenless URL fails,
    // the tokenized clone URL may still be in .git/config — a reusable
    // credential. The create must abort and tear the sandbox down rather than
    // hand back a session whose origin carries a persisted token.
    const sandbox = mockSandbox();
    mockUuid();
    sandbox.exec.mockImplementation(async (command: string) =>
      command.includes('remote set-url origin')
        ? { stdout: '', stderr: 'fatal: No such remote', exitCode: 1 }
        : { stdout: probeStdout(), stderr: '', exitCode: 0 },
    );

    const env = makeEnv();
    const response = await callRoute(
      'create',
      { repo: 'owner/repo', branch: 'feature', github_token: 'ghs_token' },
      env,
    );

    expect(response.status).toBe(500);
    const body = await jsonBody(response);
    // The aborted create must not leak the token in its error.
    expect(JSON.stringify(body)).not.toContain('ghs_token');
    // Fail closed: the credential-bearing container is destroyed.
    expect(sandbox.destroy).toHaveBeenCalled();
  });

  it('emits cf_sandbox_create_timing on the success path with hashed repo and no raw identifiers', async () => {
    const sandbox = mockSandbox();
    const sandboxId = mockUuid();
    sandbox.exec.mockResolvedValue({ stdout: probeStdout(), stderr: '', exitCode: 0 });
    const consoleLog = vi.mocked(console.log);
    consoleLog.mockClear();

    const response = await callRoute('create', {
      repo: 'owner/secret-repo',
      branch: 'feat/private-codename',
      github_token: 'ghs_token',
    });

    expect(response.status).toBe(200);
    const timingEntries = consoleLog.mock.calls
      .map((args) => {
        try {
          return JSON.parse(args[0] as string) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter(
        (entry): entry is Record<string, unknown> => entry?.event === 'cf_sandbox_create_timing',
      );
    expect(timingEntries).toHaveLength(1);
    const timing = timingEntries[0];

    expect(timing.sandbox_id).toBe(sandboxId);
    expect(timing.has_repo).toBe(true);
    // Privacy: raw repo / branch strings must never appear anywhere in the
    // log entry. The hash is the only identifier carried; this guards
    // against a future field reintroducing the leak that prompted the
    // hashing in the first place.
    const serialized = JSON.stringify(timing);
    expect(serialized).not.toContain('owner/secret-repo');
    expect(serialized).not.toContain('feat/private-codename');
    expect(timing.repo_hash).toMatch(/^[0-9a-f]{12}$/);
    expect(timing.failed_phase).toBeUndefined();

    const phases = timing.phases_ms as Record<string, number>;
    expect(Object.keys(phases).sort()).toEqual([
      'cache_populate',
      'clone',
      'git_identity',
      'probe',
      'seed_files',
      'token_issue',
    ]);
    for (const ms of Object.values(phases)) {
      expect(typeof ms).toBe('number');
      expect(ms).toBeGreaterThanOrEqual(0);
    }
    expect(typeof timing.total_ms).toBe('number');
  });

  it('records failed_phase=clone and still emits timing when gitCheckout throws', async () => {
    const sandbox = mockSandbox();
    mockUuid();
    sandbox.exec.mockResolvedValue({ stdout: probeStdout(), stderr: '', exitCode: 0 });
    // Both clone attempts fail (the `--branch` clone and the default-HEAD retry),
    // so the failure is terminal — not a missing-branch recovery — and the
    // failed-phase timing path is exercised.
    sandbox.gitCheckout.mockRejectedValue(new Error('clone exploded'));
    const consoleLog = vi.mocked(console.log);
    consoleLog.mockClear();

    const response = await callRoute('create', {
      repo: 'owner/repo',
      branch: 'main',
      github_token: 'ghs_token',
    });

    // The route surfaces the upstream failure as a 5xx; the exact code is
    // not the subject of this test — what matters is that the finally
    // block fires and tags the failed phase.
    expect(response.status).toBeGreaterThanOrEqual(500);
    const timingEntries = consoleLog.mock.calls
      .map((args) => {
        try {
          return JSON.parse(args[0] as string) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter(
        (entry): entry is Record<string, unknown> => entry?.event === 'cf_sandbox_create_timing',
      );
    expect(timingEntries).toHaveLength(1);
    const timing = timingEntries[0];

    expect(timing.failed_phase).toBe('clone');
    const phases = timing.phases_ms as Record<string, number>;
    // Phases that ran before the throw should have non-undefined timings;
    // phases that never started stay at 0. Clone itself has a recorded
    // duration even though it threw — that's the whole point of the
    // try/finally inside the `time` helper.
    expect(typeof phases.clone).toBe('number');
    expect(phases.token_issue).toBe(0);
    expect(phases.probe).toBe(0);
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
    expect(getSandboxMock).toHaveBeenCalledWith(expect.anything(), 'sb-1', { sleepAfter: '1h' });
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

  it('executes a command in the requested workdir (wrapped in container timeout)', async () => {
    const sandbox = mockSandbox();
    withOwnerTokenAuthExec(sandbox, async (command, options) => {
      // Command is wrapped in `timeout -k <grace> <secs> bash -c '<cmd>'`
      // so a stuck process is killed inside the container rather than
      // abandoned when the SDK-level deadline fires. bash (not sh) is
      // deliberate: existing callers rely on bashisms like `set -o
      // pipefail`. The exact secs / grace values are internal
      // implementation details, so assert on shape rather than literal
      // values.
      expect(command).toMatch(/^timeout -k \d+ \d+ bash -c '.*'$/);
      expect(command).toContain("'npm test'");
      // Resource caps ride along on every user exec so a test-suite fan-out
      // can't OOM the container. Exact values are implementation details;
      // assert the heap cap is present rather than pinning numbers.
      expect(options).toEqual({
        cwd: '/workspace/app',
        env: expect.objectContaining({
          NODE_OPTIONS: expect.stringContaining('--max-old-space-size'),
        }),
      });
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
      branch: 'main',
    });
  });

  it('stamps unborn/orphan branches by their symref name', async () => {
    // `git switch --orphan gh-pages` leaves HEAD on a branch with no commits.
    // rev-parse would fail there; symbolic-ref still names the branch (Codex
    // P2 on PR #913).
    const sandbox = mockSandbox();
    sandbox.exec.mockImplementation(async (command: string) => {
      if (isOwnerTokenReadCommand(command)) {
        return { stdout: DEFAULT_OWNER_TOKEN, stderr: '', exitCode: 0 };
      }
      if (isBranchStampCommand(command)) {
        return { stdout: 'gh-pages\n', stderr: '', exitCode: 0 };
      }
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    });

    const response = await callRoute('exec', { sandbox_id: 'sb-1', command: 'pwd' });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ branch: 'gh-pages' });
  });

  it('stamps detached HEAD as the literal HEAD marker (symbolic-ref exit 1)', async () => {
    const sandbox = mockSandbox();
    sandbox.exec.mockImplementation(async (command: string) => {
      if (isOwnerTokenReadCommand(command)) {
        return { stdout: DEFAULT_OWNER_TOKEN, stderr: '', exitCode: 0 };
      }
      if (isBranchStampCommand(command)) {
        return { stdout: '', stderr: '', exitCode: 1 };
      }
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    });

    const response = await callRoute('exec', { sandbox_id: 'sb-1', command: 'pwd' });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ branch: 'HEAD' });
    const events = vi
      .mocked(console.log)
      .mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
    expect(events).not.toContainEqual(
      expect.objectContaining({ event: 'sandbox_exec_branch_stamp_failed' }),
    );
  });

  it('omits the branch stamp and logs when the post-exec branch read fails', async () => {
    const sandbox = mockSandbox();
    sandbox.exec.mockImplementation(async (command: string) => {
      if (isOwnerTokenReadCommand(command)) {
        return { stdout: DEFAULT_OWNER_TOKEN, stderr: '', exitCode: 0 };
      }
      if (isBranchStampCommand(command)) {
        return { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 };
      }
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    });

    const response = await callRoute('exec', { sandbox_id: 'sb-1', command: 'pwd' });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      stdout: 'ok',
      stderr: '',
      exit_code: 0,
      truncated: false,
      workspace_revision: 0,
    });
    const events = vi
      .mocked(console.log)
      .mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
    expect(events).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        event: 'sandbox_exec_branch_stamp_failed',
        sandboxId: 'sb-1',
        route: 'exec',
        exitCode: 128,
      }),
    );
  });

  it('passes compound commands through the timeout wrapper without corruption', async () => {
    const sandbox = mockSandbox();
    withOwnerTokenAuthExec(sandbox, async (command) => {
      // Verify the user's compound command is single-quoted inside
      // `bash -c '...'` so pipes / && / redirects are scoped by the
      // timeout wrapper, not split at the first whitespace.
      expect(command).toContain("bash -c 'ls /workspace && echo done | wc -l'");
      return { stdout: '3', stderr: '', exitCode: 0 };
    });

    const response = await callRoute('exec', {
      sandbox_id: 'sb-1',
      command: 'ls /workspace && echo done | wc -l',
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { stdout: string; exit_code: number };
    expect(body.stdout).toBe('3');
    expect(body.exit_code).toBe(0);
  });

  it('preserves bash-specific idioms (set -o pipefail) through the timeout wrapper', async () => {
    // Regression guard for the Codex P1 reviewer finding: an earlier
    // version of the wrapper used `sh -c`, which rejects bash-only
    // options like `set -o pipefail` that sandbox_search relies on.
    // Keep the assertion on the wrapper shape — the presence of `bash`
    // is what matters; the inner command is just carried through.
    const sandbox = mockSandbox();
    withOwnerTokenAuthExec(sandbox, async (command) => {
      expect(command).toMatch(/^timeout -k \d+ \d+ bash -c '/);
      expect(command).toContain('set -o pipefail');
      return { stdout: 'hit', stderr: '', exitCode: 0 };
    });

    const response = await callRoute('exec', {
      sandbox_id: 'sb-1',
      command: 'set -o pipefail; rg pattern /workspace | head -1',
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { stdout: string; exit_code: number };
    expect(body.stdout).toBe('hit');
  });

  it('surfaces exit_code 124 + partial stdout when the container-side timeout fires', async () => {
    const sandbox = mockSandbox();
    withOwnerTokenAuthExec(sandbox, async () => ({
      stdout: 'partial work...',
      stderr: '',
      exitCode: 124,
    }));

    const response = await callRoute('exec', { sandbox_id: 'sb-1', command: 'sleep 9999' });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      stdout: string;
      exit_code: number;
      truncated: boolean;
    };
    expect(body.exit_code).toBe(124);
    expect(body.stdout).toBe('partial work...');
    expect(body.truncated).toBe(false);
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

  it('returns 504 TIMEOUT when the owner-token probe itself exceeds the deadline', async () => {
    // Covers the auth-gate path: a wedged container that hangs on the
    // token file read shouldn't be misclassified as NOT_CONFIGURED/503
    // just because it tripped the auth probe. The deadline error must
    // propagate out as TIMEOUT/504 so clients hit their retry path.
    vi.useFakeTimers();
    try {
      const sandbox = mockSandbox();
      sandbox.exec.mockImplementation((command: unknown) => {
        if (isOwnerTokenReadCommand(command)) {
          return new Promise(() => {});
        }
        return Promise.resolve({ stdout: 'should-not-run', stderr: '', exitCode: 0 });
      });

      const pending = callRoute('exec', { sandbox_id: 'sb-1', command: 'ls' });
      await vi.advanceTimersByTimeAsync(SANDBOX_EXEC_TIMEOUT_MS + 1);
      const response = await pending;

      expect(response.status).toBe(504);
      const body = (await response.json()) as { code?: string; error?: string };
      expect(body.code).toBe('TIMEOUT');
      expect(body.error).toMatch(/deadline/i);
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

  it('uploads a large file to /workspace via the upload route (realpath-confined)', async () => {
    const sandbox = mockSandbox();
    withOwnerTokenAuthExec(sandbox, async (command) =>
      command.startsWith('realpath -m')
        ? { stdout: '/workspace/.push-checkpoint-restore.b64\n', stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 0 },
    );

    const response = await callRoute('upload', {
      sandbox_id: 'sb-1',
      path: '/workspace/.push-checkpoint-restore.b64',
      content: 'BASE64DATA',
    });

    expect(response.status).toBe(200);
    const body = await jsonBody(response);
    expect(body).toMatchObject({ ok: true, bytes_written: 10 });
    expect(sandbox.writeFile).toHaveBeenCalledWith(
      '/workspace/.push-checkpoint-restore.b64',
      'BASE64DATA',
    );
  });

  it('upload rejects a path outside /workspace without writing', async () => {
    const sandbox = mockSandbox();

    const response = await callRoute('upload', {
      sandbox_id: 'sb-1',
      path: '/etc/passwd',
      content: 'x',
    });

    expect(await jsonBody(response)).toMatchObject({
      ok: false,
      error: 'Path must be within /workspace',
    });
    expect(sandbox.writeFile).not.toHaveBeenCalled();
  });

  it('upload rejects a /workspace path that resolves outside (traversal/symlink)', async () => {
    const sandbox = mockSandbox();
    withOwnerTokenAuthExec(sandbox, async (command) =>
      command.startsWith('realpath -m')
        ? { stdout: '/etc/shadow\n', stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 0 },
    );

    const response = await callRoute('upload', {
      sandbox_id: 'sb-1',
      path: '/workspace/../etc/shadow',
      content: 'x',
    });

    expect(await jsonBody(response)).toMatchObject({
      ok: false,
      error: 'Path must be within /workspace',
    });
    expect(sandbox.writeFile).not.toHaveBeenCalled();
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
    // 1 auth token read + 3 probe attempts: the liveness probe retries
    // transient failures before declaring the sandbox dead, so a 404 now
    // requires every attempt to fail.
    expect(sandbox.exec).toHaveBeenCalledTimes(4);
    expect(sandbox.exec).toHaveBeenNthCalledWith(2, 'true');
    expect(sandbox.exec).toHaveBeenNthCalledWith(4, 'true');
  });

  it('connect survives a transient liveness blip via probe retry', async () => {
    const sandbox = mockSandbox();
    let probeCalls = 0;
    withOwnerTokenAuthExec(sandbox, async (command) => {
      if (command === 'true') {
        probeCalls += 1;
        if (probeCalls === 1) throw new Error('network blip');
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const response = await callRoute('connect', { sandbox_id: 'sb-blip' });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      sandbox_id: 'sb-blip',
      status: 'ready',
    });
    expect(probeCalls).toBe(2);
  });

  it('connect reports a wedged container as 504 TIMEOUT without retrying', async () => {
    const sandbox = mockSandbox();
    withOwnerTokenAuthExec(sandbox, async (command) => {
      if (command === 'true') throw new SandboxExecDeadlineError(150_000);
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const response = await callRoute('connect', { sandbox_id: 'sb-wedged' });

    // 504, not 404: callers treat 404 as "sandbox gone" and recreate, which
    // would orphan a container that is wedged but may still hold uncommitted
    // work. A deadline expiry also must not retry — the budget is burned.
    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toEqual({
      error: 'Sandbox is not responding',
      code: 'TIMEOUT',
    });
    expect(sandbox.exec).toHaveBeenCalledTimes(2);
  });

  it('classifies a disk-full write failure as DISK_FULL, not CONTAINER_ERROR', async () => {
    const sandbox = mockSandbox();
    sandbox.writeFile.mockRejectedValueOnce(
      new Error('write /workspace/big.bin: no space left on device'),
    );

    const response = await callRoute('write', {
      sandbox_id: 'sb-1',
      path: 'big.bin',
      content: 'x',
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ code: 'DISK_FULL' });
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
  ])('returns an error field when %s exits non-zero', async (_label, diffResult, statusResult, expectedError) => {
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
  });
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
    expect(sandbox.exec).toHaveBeenNthCalledWith(2, "mkdir -p '/workspace/project'");
    expect(sandbox.exec).toHaveBeenNthCalledWith(3, `base64 -d '${tmpB64}' > '${tmpTar}'`);
    expect(sandbox.exec).toHaveBeenNthCalledWith(4, `tar -tzf '${tmpTar}'`);
    expect(sandbox.exec).toHaveBeenNthCalledWith(
      5,
      `tar -xzf '${tmpTar}' -C '/workspace/project' --no-same-owner`,
    );
    expect(sandbox.exec).toHaveBeenNthCalledWith(6, `rm -f '${tmpB64}' '${tmpTar}'`);
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
    expect(sandbox.exec).toHaveBeenNthCalledWith(4, `rm -f '${tmpB64}' '${tmpTar}'`);
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
    expect(sandbox.exec).toHaveBeenNthCalledWith(5, `rm -f '${tmpB64}' '${tmpTar}'`);
  });

  it.each([
    '/etc/passwd',
    'safe/../evil.txt',
  ])('returns 400 and cleans up for unsafe archive member %s', async (unsafeMember) => {
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
    expect(sandbox.exec).toHaveBeenNthCalledWith(5, `rm -f '${tmpB64}' '${tmpTar}'`);
  });

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
    expect(sandbox.exec).toHaveBeenNthCalledWith(6, `rm -f '${tmpB64}' '${tmpTar}'`);
  });
});

describe('handleCloudflareSandbox routeDownload', () => {
  it('returns a base64 file payload for a raw single-file download', async () => {
    const sandbox = mockSandbox();
    queueExecResults(sandbox, [
      { stdout: '/workspace/src/notes.md', stderr: '', exitCode: 0 }, // realpath
      { stdout: 'regular file|11', stderr: '', exitCode: 0 }, // stat
      { stdout: 'aGVsbG8gd29ybGQ=', stderr: '', exitCode: 0 }, // base64
    ]);

    const response = await callRoute('download', {
      sandbox_id: 'sb-1',
      path: '/workspace/src/notes.md',
      format: 'raw',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      filename: 'notes.md',
      content_type: 'text/markdown',
      size_bytes: 11,
      file_base64: 'aGVsbG8gd29ybGQ=',
      format: 'raw',
    });
    expect(sandbox.exec.mock.calls[1]?.[0]).toBe("realpath -e -- '/workspace/src/notes.md'");
    expect(sandbox.exec.mock.calls[2]?.[0]).toBe("stat -c '%F|%s' -- '/workspace/src/notes.md'");
    expect(sandbox.exec.mock.calls[3]?.[0]).toBe("base64 -w0 -- '/workspace/src/notes.md'");
  });

  it('rejects a raw download of a directory', async () => {
    const sandbox = mockSandbox();
    queueExecResults(sandbox, [
      { stdout: '/workspace/src', stderr: '', exitCode: 0 }, // realpath
      { stdout: 'directory|4096', stderr: '', exitCode: 0 }, // stat
    ]);

    const response = await callRoute('download', {
      sandbox_id: 'sb-1',
      path: '/workspace/src',
      format: 'raw',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'Raw download is only supported for files',
    });
  });

  it('tars a directory to a temp file with shared excludes for the default tar.gz format', async () => {
    const sandbox = mockSandbox();
    const uuid = mockUuid();
    const tmp = `/tmp/push-download-${uuid}.tar.gz`;
    queueExecResults(sandbox, [
      { stdout: '/workspace', stderr: '', exitCode: 0 }, // realpath
      { stdout: 'directory|4096', stderr: '', exitCode: 0 }, // stat
      { stdout: '', stderr: '', exitCode: 0 }, // tar
      { stdout: '2048', stderr: '', exitCode: 0 }, // stat archive size
      { stdout: 'YXJjaGl2ZQ==', stderr: '', exitCode: 0 }, // base64
      { stdout: '', stderr: '', exitCode: 0 }, // rm
    ]);

    const response = await callRoute('download', { sandbox_id: 'sb-1', path: '/workspace' });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      archive_base64: 'YXJjaGl2ZQ==',
      size_bytes: 2048,
      format: 'tar.gz',
    });
    expect(sandbox.exec.mock.calls[3]?.[0]).toBe(
      `tar -czf '${tmp}' --exclude='.git' --exclude='node_modules' --exclude='__pycache__' ` +
        `--exclude='.venv' --exclude='dist' --exclude='build' -C '/workspace' .`,
    );
    expect(sandbox.exec.mock.calls[4]?.[0]).toBe(`stat -c %s -- '${tmp}'`);
    expect(sandbox.exec.mock.calls[5]?.[0]).toBe(`base64 -w0 -- '${tmp}'`);
    expect(sandbox.exec.mock.calls[6]?.[0]).toBe(`rm -f '${tmp}'`);
  });

  it('tars a single file relative to its parent for the tar.gz format', async () => {
    const sandbox = mockSandbox();
    const uuid = mockUuid();
    const tmp = `/tmp/push-download-${uuid}.tar.gz`;
    queueExecResults(sandbox, [
      { stdout: '/workspace/src/notes.md', stderr: '', exitCode: 0 }, // realpath
      { stdout: 'regular file|11', stderr: '', exitCode: 0 }, // stat
      { stdout: '', stderr: '', exitCode: 0 }, // tar
      { stdout: '512', stderr: '', exitCode: 0 }, // stat archive size
      { stdout: 'YXJjaGl2ZQ==', stderr: '', exitCode: 0 }, // base64
      { stdout: '', stderr: '', exitCode: 0 }, // rm
    ]);

    const response = await callRoute('download', {
      sandbox_id: 'sb-1',
      path: '/workspace/src/notes.md',
      format: 'tar.gz',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, format: 'tar.gz' });
    expect(sandbox.exec.mock.calls[3]?.[0]).toBe(
      `tar -czf '${tmp}' -C '/workspace/src' -- 'notes.md'`,
    );
  });

  it('returns ok:false for an unsupported format without touching the sandbox', async () => {
    const sandbox = mockSandbox();

    const response = await callRoute('download', {
      sandbox_id: 'sb-1',
      path: '/workspace',
      format: 'zip',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: false, error: 'Unsupported format' });
    // Only the owner-token auth read ran — no realpath/stat/tar.
    expect(sandbox.exec).toHaveBeenCalledTimes(1);
  });

  it('rejects a lexically out-of-tree path before spawning realpath', async () => {
    const sandbox = mockSandbox();

    const response = await callRoute('download', { sandbox_id: 'sb-1', path: '/etc/passwd' });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'Path must be within /workspace',
    });
    expect(sandbox.exec).toHaveBeenCalledTimes(1);
  });

  it('rejects a traversal escape that resolves outside /workspace', async () => {
    const sandbox = mockSandbox();
    // The lexical pre-filter passes ("/workspace/.." starts with "/workspace/"),
    // so realpath is the boundary: it resolves to /etc/passwd, which fails the
    // post-resolution guard before any stat/read/tar runs.
    queueExecResults(sandbox, [{ stdout: '/etc/passwd', stderr: '', exitCode: 0 }]);

    const response = await callRoute('download', {
      sandbox_id: 'sb-1',
      path: '/workspace/../../etc/passwd',
      format: 'raw',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'Path must be within /workspace',
    });
    expect(sandbox.exec.mock.calls[1]?.[0]).toBe("realpath -e -- '/workspace/../../etc/passwd'");
    // No stat/read happened after the failed guard.
    expect(sandbox.exec).toHaveBeenCalledTimes(2);
  });

  it('rejects an oversized tar.gz archive before base64-encoding it', async () => {
    const sandbox = mockSandbox();
    const uuid = mockUuid();
    const tmp = `/tmp/push-download-${uuid}.tar.gz`;
    queueExecResults(sandbox, [
      { stdout: '/workspace', stderr: '', exitCode: 0 }, // realpath
      { stdout: 'directory|4096', stderr: '', exitCode: 0 }, // stat
      { stdout: '', stderr: '', exitCode: 0 }, // tar
      { stdout: '100000001', stderr: '', exitCode: 0 }, // stat archive size (> 100MB)
      { stdout: '', stderr: '', exitCode: 0 }, // rm (finally)
    ]);

    const response = await callRoute('download', { sandbox_id: 'sb-1', path: '/workspace' });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'Archive exceeds max size of 100000000 bytes',
    });
    // base64 must never run for an oversized archive; the temp file is cleaned up.
    expect(sandbox.exec.mock.calls.some((c) => String(c[0]).startsWith('base64'))).toBe(false);
    expect(sandbox.exec.mock.calls.at(-1)?.[0]).toBe(`rm -f '${tmp}'`);
  });

  it('fails closed (and skips base64) when the archive size stat fails', async () => {
    const sandbox = mockSandbox();
    const uuid = mockUuid();
    const tmp = `/tmp/push-download-${uuid}.tar.gz`;
    queueExecResults(sandbox, [
      { stdout: '/workspace', stderr: '', exitCode: 0 }, // realpath
      { stdout: 'directory|4096', stderr: '', exitCode: 0 }, // stat
      { stdout: '', stderr: '', exitCode: 0 }, // tar
      { stdout: '', stderr: '', exitCode: 1 }, // stat archive size FAILS
      { stdout: '', stderr: '', exitCode: 0 }, // rm (finally)
    ]);

    const response = await callRoute('download', { sandbox_id: 'sb-1', path: '/workspace' });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'Failed to measure archive size',
    });
    // An unmeasured archive must never reach base64; temp file still cleaned up.
    expect(sandbox.exec.mock.calls.some((c) => String(c[0]).startsWith('base64'))).toBe(false);
    expect(sandbox.exec.mock.calls.at(-1)?.[0]).toBe(`rm -f '${tmp}'`);
  });

  it('falls back to a non-empty error when the size stat fails with whitespace-only stderr', async () => {
    const sandbox = mockSandbox();
    const uuid = mockUuid();
    const tmp = `/tmp/push-download-${uuid}.tar.gz`;
    queueExecResults(sandbox, [
      { stdout: '/workspace', stderr: '', exitCode: 0 }, // realpath
      { stdout: 'directory|4096', stderr: '', exitCode: 0 }, // stat
      { stdout: '', stderr: '', exitCode: 0 }, // tar
      { stdout: '', stderr: '   \n', exitCode: 1 }, // stat archive size FAILS with whitespace-only stderr
      { stdout: '', stderr: '', exitCode: 0 }, // rm (finally)
    ]);

    const response = await callRoute('download', { sandbox_id: 'sb-1', path: '/workspace' });

    expect(response.status).toBe(200);
    // Whitespace-only stderr must not collapse to error:"" after trim.
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'Failed to measure archive size',
    });
    expect(sandbox.exec.mock.calls.some((c) => String(c[0]).startsWith('base64'))).toBe(false);
    expect(sandbox.exec.mock.calls.at(-1)?.[0]).toBe(`rm -f '${tmp}'`);
  });

  it('returns ok:false when the path does not exist', async () => {
    const sandbox = mockSandbox();
    queueExecResults(sandbox, [{ stdout: '', stderr: 'No such file or directory', exitCode: 1 }]);

    const response = await callRoute('download', {
      sandbox_id: 'sb-1',
      path: '/workspace/missing.txt',
      format: 'raw',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'Path not found: /workspace/missing.txt',
    });
  });
});

type R2Entry = { body: string; customMetadata?: Record<string, string> };

function makeR2(seed: Record<string, R2Entry> = {}) {
  const store = new Map<string, R2Entry>(Object.entries(seed));
  return {
    store,
    put: vi.fn(
      async (key: string, value: string, opts?: { customMetadata?: Record<string, string> }) => {
        store.set(key, { body: value, customMetadata: opts?.customMetadata });
      },
    ),
    get: vi.fn(async (key: string) => {
      const e = store.get(key);
      return e ? { customMetadata: e.customMetadata, text: async () => e.body } : null;
    }),
    head: vi.fn(async (key: string) => {
      const e = store.get(key);
      return e ? { customMetadata: e.customMetadata } : null;
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
}

// Minimal SNAPSHOT_INDEX KV stub. getSnapshot reads getWithMetadata; a valid
// entry (schema v1) lets routeHibernate discover the prior snapshot's R2 key.
function makeSnapshotIndexKV(priorEntry?: Record<string, unknown>) {
  return {
    getWithMetadata: vi.fn(async () => ({ value: null, metadata: priorEntry ?? null })),
    put: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    list: vi.fn(async () => ({ keys: [], list_complete: true, cursor: '' })),
  };
}

describe('handleCloudflareSandbox snapshots (R2)', () => {
  it('hibernate archives /workspace to R2 (keeping .git) and frees the container', async () => {
    const sandbox = mockSandbox();
    const uuid = mockUuid();
    const r2 = makeR2();
    const tokensKV = makeDefaultTokensKV();
    queueExecResults(sandbox, [
      { exitCode: 0 }, // tar
      { stdout: '1024', exitCode: 0 }, // stat size
      { stdout: 'QkFTRTY0', exitCode: 0 }, // base64
      { exitCode: 0 }, // rm (finally)
    ]);

    const response = await callRoute(
      'hibernate',
      { sandbox_id: 'sb-1' },
      makeEnv({
        SNAPSHOTS: r2 as unknown as Env['SNAPSHOTS'],
        SANDBOX_TOKENS: tokensKV as unknown as Env['SANDBOX_TOKENS'],
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      snapshot_id: `cf-snapshots/${uuid}`,
      restore_token: uuid,
      size_bytes: 1024,
      kept_warm: false,
    });
    expect(r2.put).toHaveBeenCalledTimes(1);
    expect(r2.store.get(`cf-snapshots/${uuid}`)).toEqual({
      body: 'QkFTRTY0',
      customMetadata: { rt: uuid, repo: '', branch: '' },
    });
    // Container freed + token revoked after the snapshot is durable.
    expect(sandbox.destroy).toHaveBeenCalledOnce();
    expect(tokensKV.delete).toHaveBeenCalledWith('token:sb-1');
    // Snapshot archive excludes regenerable caches but KEEPS .git (call[0] is
    // the owner-token auth read; call[1] is the tar).
    const tarCall = sandbox.exec.mock.calls[1]?.[0] as string;
    expect(tarCall).toContain("--exclude='node_modules'");
    expect(tarCall).not.toContain("--exclude='.git'");
  });

  it('hibernate with keep_warm snapshots but does NOT free the container', async () => {
    const sandbox = mockSandbox();
    const uuid = mockUuid();
    const r2 = makeR2();
    const tokensKV = makeDefaultTokensKV();
    queueExecResults(sandbox, [
      { exitCode: 0 }, // tar
      { stdout: '1024', exitCode: 0 }, // stat size
      { stdout: 'QkFTRTY0', exitCode: 0 }, // base64
      { exitCode: 0 }, // rm (finally)
    ]);

    const response = await callRoute(
      'hibernate',
      { sandbox_id: 'sb-1', keep_warm: true },
      makeEnv({
        SNAPSHOTS: r2 as unknown as Env['SNAPSHOTS'],
        SANDBOX_TOKENS: tokensKV as unknown as Env['SANDBOX_TOKENS'],
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      snapshot_id: `cf-snapshots/${uuid}`,
      restore_token: uuid,
      size_bytes: 1024,
      kept_warm: true,
    });
    // The durability snapshot still happens...
    expect(r2.put).toHaveBeenCalledTimes(1);
    // ...but the container and its token survive for warm re-attach.
    expect(sandbox.destroy).not.toHaveBeenCalled();
    expect(tokensKV.delete).not.toHaveBeenCalled();
  });

  it('hibernate reclaims the previous snapshot object for the same repo/branch', async () => {
    const sandbox = mockSandbox();
    const uuid = mockUuid();
    const r2 = makeR2({ 'cf-snapshots/old': { body: 'old', customMetadata: { rt: 'x' } } });
    const indexKV = makeSnapshotIndexKV({
      v: 1,
      imageId: 'cf-snapshots/old',
      restoreToken: 'x',
      repoFullName: 'o/r',
      branch: 'main',
      createdAt: 1,
      lastAccessedAt: 1,
    });
    queueExecResults(sandbox, [
      { exitCode: 0 }, // tar
      { stdout: '1024', exitCode: 0 }, // stat size
      { stdout: 'QkFTRTY0', exitCode: 0 }, // base64
      { exitCode: 0 }, // rm
    ]);

    const response = await callRoute(
      'hibernate',
      { sandbox_id: 'sb-1', repo_full_name: 'o/r', branch: 'main' },
      makeEnv({
        SNAPSHOTS: r2 as unknown as Env['SNAPSHOTS'],
        SNAPSHOT_INDEX: indexKV as unknown as Env['SNAPSHOT_INDEX'],
      }),
    );

    expect(response.status).toBe(200);
    // New object written, prior one reclaimed so R2 keeps one object per branch.
    expect(r2.store.has(`cf-snapshots/${uuid}`)).toBe(true);
    expect(r2.delete).toHaveBeenCalledWith('cf-snapshots/old');
    expect(r2.store.has('cf-snapshots/old')).toBe(false);
    expect(indexKV.put).toHaveBeenCalled();
  });

  it('hibernate returns 503 when R2 is not configured', async () => {
    mockSandbox();
    const response = await callRoute('hibernate', { sandbox_id: 'sb-1' });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: 'CF_NOT_CONFIGURED' });
  });

  it('createWorkspaceSnapshot archives to R2 WITHOUT terminating the container', async () => {
    const sandbox = mockSandbox();
    const uuid = mockUuid();
    const r2 = makeR2();
    queueExecResults(sandbox, [
      { exitCode: 0 }, // tar
      { stdout: '2048', exitCode: 0 }, // stat size
      { stdout: 'QkFTRTY0', exitCode: 0 }, // base64
      { exitCode: 0 }, // rm
    ]);

    const result = await createWorkspaceSnapshot(
      makeEnv({ SNAPSHOTS: r2 as unknown as Env['SNAPSHOTS'] }),
      { sandboxId: 'sb-1' },
    );

    expect(result).toEqual({
      ok: true,
      snapshotId: `cf-snapshots/${uuid}`,
      restoreToken: uuid,
      sizeBytes: 2048,
    });
    expect(r2.store.has(`cf-snapshots/${uuid}`)).toBe(true);
    // The defining contract for mid-run checkpoints: the container survives.
    expect(sandbox.destroy).not.toHaveBeenCalled();
  });

  it('createWorkspaceSnapshot rejects an over-cap archive (413) before base64/RPC', async () => {
    const sandbox = mockSandbox();
    const r2 = makeR2();
    queueExecResults(sandbox, [
      { exitCode: 0 }, // tar
      { stdout: String(MAX_SNAPSHOT_BYTES + 1), exitCode: 0 }, // stat — over the cap
      { exitCode: 0 }, // rm (finally)
    ]);

    const result = await createWorkspaceSnapshot(
      makeEnv({ SNAPSHOTS: r2 as unknown as Env['SNAPSHOTS'] }),
      { sandboxId: 'sb-1' },
    );

    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining('exceeds max size'),
      status: 413,
    });
    // Never base64-encoded — the whole point is to stop before the value would
    // cross the 32 MiB DO RPC boundary — and nothing written to R2.
    const cmds = sandbox.exec.mock.calls.map((c) => c[0] as string);
    expect(cmds.some((c) => c.startsWith('base64 -w0'))).toBe(false);
    expect(r2.put).not.toHaveBeenCalled();
  });

  it('hibernate surfaces an over-cap archive as 413 SNAPSHOT_TOO_LARGE (not a raw RPC throw)', async () => {
    const sandbox = mockSandbox();
    const r2 = makeR2();
    const tokensKV = makeDefaultTokensKV();
    queueExecResults(sandbox, [
      { exitCode: 0 }, // tar
      { stdout: String(MAX_SNAPSHOT_BYTES + 1), exitCode: 0 }, // stat — over the cap
      { exitCode: 0 }, // rm
    ]);

    const response = await callRoute(
      'hibernate',
      { sandbox_id: 'sb-1' },
      makeEnv({
        SNAPSHOTS: r2 as unknown as Env['SNAPSHOTS'],
        SANDBOX_TOKENS: tokensKV as unknown as Env['SANDBOX_TOKENS'],
      }),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: 'SNAPSHOT_TOO_LARGE',
    });
    // The snapshot never succeeded, so the container must NOT be torn down.
    expect(sandbox.destroy).not.toHaveBeenCalled();
    expect(r2.put).not.toHaveBeenCalled();
  });

  it('createWorkspaceSnapshot returns a 503 result when R2 is unbound', async () => {
    const result = await createWorkspaceSnapshot(makeEnv(), { sandboxId: 'sb-1' });
    expect(result).toEqual({ ok: false, error: expect.any(String), status: 503 });
  });

  it('createWorkspaceSnapshot returns a 503 result (not a throw) when Sandbox is unbound', async () => {
    const r2 = makeR2();
    const result = await createWorkspaceSnapshot(
      makeEnv({ SNAPSHOTS: r2 as unknown as Env['SNAPSHOTS'], Sandbox: undefined }),
      { sandboxId: 'sb-1' },
    );
    expect(result).toEqual({ ok: false, error: expect.any(String), status: 503 });
  });

  it('createWorkspaceSnapshot without repo/branch leaves the shared index untouched (per-job isolation)', async () => {
    const sandbox = mockSandbox();
    mockUuid();
    const r2 = makeR2();
    const indexKV = makeSnapshotIndexKV();
    queueExecResults(sandbox, [
      { exitCode: 0 }, // tar
      { stdout: '64', exitCode: 0 }, // stat
      { stdout: 'Qg', exitCode: 0 }, // base64
      { exitCode: 0 }, // rm
    ]);

    const result = await createWorkspaceSnapshot(
      makeEnv({
        SNAPSHOTS: r2 as unknown as Env['SNAPSHOTS'],
        SNAPSHOT_INDEX: indexKV as unknown as Env['SNAPSHOT_INDEX'],
      }),
      { sandboxId: 'sb-1' },
    );

    expect(result.ok).toBe(true);
    // The checkpoint path must NOT participate in the repo/branch index or its
    // reclaim — that's what keeps concurrent same-branch jobs from deleting each
    // other's checkpoints.
    expect(indexKV.put).not.toHaveBeenCalled();
    expect(r2.delete).not.toHaveBeenCalled();
  });

  it('restoreWorkspaceSnapshot returns a result (not a throw) when Sandbox is unbound', async () => {
    const r2 = makeR2({ 'cf-snapshots/snap1': { body: 'x', customMetadata: { rt: 'tok' } } });
    const result = await restoreWorkspaceSnapshot(
      makeEnv({ SNAPSHOTS: r2 as unknown as Env['SNAPSHOTS'], Sandbox: undefined }),
      { snapshotId: 'cf-snapshots/snap1', restoreToken: 'tok' },
    );
    expect(result).toEqual({
      ok: false,
      error: expect.any(String),
      status: 503,
      code: 'CF_NOT_CONFIGURED',
    });
  });

  it('restoreWorkspaceSnapshot rejects a bad token with a 403 result', async () => {
    const r2 = makeR2({ 'cf-snapshots/snap1': { body: 'x', customMetadata: { rt: 'good' } } });
    const result = await restoreWorkspaceSnapshot(
      makeEnv({ SNAPSHOTS: r2 as unknown as Env['SNAPSHOTS'] }),
      { snapshotId: 'cf-snapshots/snap1', restoreToken: 'bad' },
    );
    expect(result).toMatchObject({ ok: false, status: 403, code: 'AUTH_FAILURE' });
    expect(getSandboxMock).not.toHaveBeenCalled();
  });

  it('restore-snapshot pulls the archive into a fresh sandbox and mints a token', async () => {
    const sandbox = mockSandbox();
    const uuid = mockUuid();
    const r2 = makeR2({
      'cf-snapshots/snap1': { body: 'YXJjaGl2ZQ==', customMetadata: { rt: 'tok-abc' } },
    });
    queueExecResults(sandbox, [
      { exitCode: 0 }, // git config
      { exitCode: 0 }, // mkdir
      { exitCode: 0 }, // base64 -d
      { stdout: 'safe/file.txt\n', exitCode: 0 }, // tar -tzf (member list)
      { exitCode: 0 }, // tar -xzf
      { exitCode: 0 }, // rm
      { stdout: probeStdout(), exitCode: 0 }, // probe
    ]);

    const response = await callRoute(
      'restore-snapshot',
      { snapshot_id: 'cf-snapshots/snap1', restore_token: 'tok-abc' },
      makeEnv({ SNAPSHOTS: r2 as unknown as Env['SNAPSHOTS'] }),
    );

    expect(response.status).toBe(200);
    const body = await jsonBody(response);
    expect(body).toMatchObject({
      ok: true,
      sandbox_id: uuid,
      owner_token: uuid,
      status: 'ready',
      workspace_revision: 0,
    });
    expect(body.environment).toBeTypeOf('object');
    // Fresh owner token written into the restored container.
    expect(sandbox.writeFile).toHaveBeenCalledWith(OWNER_TOKEN_PATH, uuid);
  });

  it('restore-snapshot returns 404 when the snapshot is missing', async () => {
    const response = await callRoute(
      'restore-snapshot',
      { snapshot_id: 'cf-snapshots/missing', restore_token: 'x' },
      makeEnv({ SNAPSHOTS: makeR2() as unknown as Env['SNAPSHOTS'] }),
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: 'SNAPSHOT_NOT_FOUND' });
    expect(getSandboxMock).not.toHaveBeenCalled();
  });

  it('restore-snapshot returns 403 on a bad restore token', async () => {
    const r2 = makeR2({
      'cf-snapshots/snap1': { body: 'YXJjaGl2ZQ==', customMetadata: { rt: 'good' } },
    });
    const response = await callRoute(
      'restore-snapshot',
      { snapshot_id: 'cf-snapshots/snap1', restore_token: 'bad' },
      makeEnv({ SNAPSHOTS: r2 as unknown as Env['SNAPSHOTS'] }),
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: 'AUTH_FAILURE' });
    expect(getSandboxMock).not.toHaveBeenCalled();
  });

  it('restore-snapshot does not require a sandbox owner token (auth-exempt)', async () => {
    const sandbox = mockSandbox();
    mockUuid();
    const r2 = makeR2({
      'cf-snapshots/snap1': { body: 'YXJjaGl2ZQ==', customMetadata: { rt: 'tok-abc' } },
    });
    queueExecResults(sandbox, [
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0 },
      { stdout: 'safe/file.txt\n', exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0 },
      { stdout: probeStdout(), exitCode: 0 },
    ]);

    const response = await callRoute(
      'restore-snapshot',
      { snapshot_id: 'cf-snapshots/snap1', restore_token: 'tok-abc', owner_token: '' },
      makeEnv({ SNAPSHOTS: r2 as unknown as Env['SNAPSHOTS'] }),
    );

    expect(response.status).toBe(200);
    // The owner-token gate never ran: the first exec is git config, not the
    // owner-token file read the gate would issue.
    expect(sandbox.exec.mock.calls[0]?.[0]).not.toContain(OWNER_TOKEN_PATH);
  });

  it('delete-snapshot removes the R2 object after verifying the token', async () => {
    const r2 = makeR2({ 'cf-snapshots/snap1': { body: 'x', customMetadata: { rt: 'tok-abc' } } });
    const response = await callRoute(
      'delete-snapshot',
      { snapshot_id: 'cf-snapshots/snap1', restore_token: 'tok-abc' },
      makeEnv({ SNAPSHOTS: r2 as unknown as Env['SNAPSHOTS'] }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(r2.delete).toHaveBeenCalledWith('cf-snapshots/snap1');
    expect(r2.store.has('cf-snapshots/snap1')).toBe(false);
  });

  it('delete-snapshot is idempotent when the snapshot is already gone', async () => {
    const r2 = makeR2();
    const response = await callRoute(
      'delete-snapshot',
      { snapshot_id: 'cf-snapshots/missing', restore_token: 'x' },
      makeEnv({ SNAPSHOTS: r2 as unknown as Env['SNAPSHOTS'] }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(r2.delete).not.toHaveBeenCalled();
  });

  it('delete-snapshot returns 403 on a bad token and keeps the object', async () => {
    const r2 = makeR2({ 'cf-snapshots/snap1': { body: 'x', customMetadata: { rt: 'good' } } });
    const response = await callRoute(
      'delete-snapshot',
      { snapshot_id: 'cf-snapshots/snap1', restore_token: 'bad' },
      makeEnv({ SNAPSHOTS: r2 as unknown as Env['SNAPSHOTS'] }),
    );
    expect(response.status).toBe(403);
    expect(r2.delete).not.toHaveBeenCalled();
    expect(r2.store.has('cf-snapshots/snap1')).toBe(true);
  });

  it('restore-snapshot rejects an over-long restore token before touching R2', async () => {
    const r2 = makeR2({ 'cf-snapshots/snap1': { body: 'x', customMetadata: { rt: 'tok-abc' } } });
    const response = await callRoute(
      'restore-snapshot',
      { snapshot_id: 'cf-snapshots/snap1', restore_token: 'a'.repeat(MAX_TOKEN_BYTES + 1) },
      makeEnv({ SNAPSHOTS: r2 as unknown as Env['SNAPSHOTS'] }),
    );
    expect(response.status).toBe(403);
    // Guard short-circuits before any R2 read or constant-time compare.
    expect(r2.get).not.toHaveBeenCalled();
    expect(getSandboxMock).not.toHaveBeenCalled();
  });

  it('delete-snapshot rejects an over-long restore token before touching R2', async () => {
    const r2 = makeR2({ 'cf-snapshots/snap1': { body: 'x', customMetadata: { rt: 'tok-abc' } } });
    const response = await callRoute(
      'delete-snapshot',
      { snapshot_id: 'cf-snapshots/snap1', restore_token: 'a'.repeat(MAX_TOKEN_BYTES + 1) },
      makeEnv({ SNAPSHOTS: r2 as unknown as Env['SNAPSHOTS'] }),
    );
    expect(response.status).toBe(403);
    expect(r2.head).not.toHaveBeenCalled();
  });
});

describe('background execution routes', () => {
  it('exec-start detaches the process with autoCleanup disabled', async () => {
    const sandbox = mockSandbox();
    sandbox.startProcess.mockResolvedValue({
      id: 'proc_42',
      command: 'sleep 5',
      status: 'running',
      startTime: new Date('2026-06-04T01:02:03.000Z'),
    });

    const response = await callRoute('exec-start', {
      sandbox_id: 'sb1',
      command: 'sleep 5',
      workdir: '/workspace/app',
      timeout_ms: 30_000,
    });

    expect(response.status).toBe(200);
    expect(await jsonBody(response)).toEqual({
      process_id: 'proc_42',
      status: 'running',
      running: true,
      started_at: '2026-06-04T01:02:03.000Z',
    });
    // autoCleanup:false is load-bearing — without it the record (and final
    // status/logs) is purged on exit, breaking reconnect-after-completion.
    expect(sandbox.startProcess).toHaveBeenCalledWith(
      'sleep 5',
      expect.objectContaining({
        cwd: '/workspace/app',
        timeout: 30_000,
        autoCleanup: false,
        // Detached execs carry the same resource caps as foreground execs —
        // long test/build runs are exactly the fan-outs that OOM the container.
        env: expect.objectContaining({
          NODE_OPTIONS: expect.stringContaining('--max-old-space-size'),
        }),
      }),
    );
  });

  it('exec-status maps a finished process and reports not-running', async () => {
    const sandbox = mockSandbox();
    sandbox.getProcess.mockResolvedValue({
      id: 'proc_42',
      status: 'completed',
      exitCode: 0,
      startTime: new Date('2026-06-04T01:00:00.000Z'),
      endTime: new Date('2026-06-04T01:00:09.000Z'),
    });

    const response = await callRoute('exec-status', { sandbox_id: 'sb1', process_id: 'proc_42' });

    expect(response.status).toBe(200);
    expect(await jsonBody(response)).toEqual({
      process_id: 'proc_42',
      status: 'completed',
      running: false,
      exit_code: 0,
      started_at: '2026-06-04T01:00:00.000Z',
      ended_at: '2026-06-04T01:00:09.000Z',
      branch: 'main',
    });
  });

  it('exec-status returns terminal NOT_FOUND when the process is gone', async () => {
    const sandbox = mockSandbox();
    sandbox.getProcess.mockResolvedValue(null);

    const response = await callRoute('exec-status', { sandbox_id: 'sb1', process_id: 'ghost' });

    expect(response.status).toBe(404);
    expect((await jsonBody(response)).code).toBe('NOT_FOUND');
  });

  it('exec-logs returns only the slice after the cursor and advances it', async () => {
    const sandbox = mockSandbox();
    const full = 'line 1\nline 2\nline 3\nline 4\n'; // length 28
    sandbox.getProcessLogs.mockResolvedValue({ stdout: full, stderr: '', processId: 'proc_42' });

    // Cursor past the first two lines (14 bytes) — expect only lines 3-4.
    const response = await callRoute('exec-logs', {
      sandbox_id: 'sb1',
      process_id: 'proc_42',
      cursor_stdout: 14,
    });

    expect(response.status).toBe(200);
    const body = await jsonBody(response);
    expect(body.stdout).toBe('line 3\nline 4\n');
    expect(body.next_cursor_stdout).toBe(full.length);
    expect(body.truncated).toBe(false);
  });

  it('exec-logs clamps a cursor past the buffer instead of throwing', async () => {
    const sandbox = mockSandbox();
    sandbox.getProcessLogs.mockResolvedValue({ stdout: 'abc', stderr: '', processId: 'proc_42' });

    const response = await callRoute('exec-logs', {
      sandbox_id: 'sb1',
      process_id: 'proc_42',
      cursor_stdout: 999,
    });

    expect(response.status).toBe(200);
    const body = await jsonBody(response);
    expect(body.stdout).toBe('');
    expect(body.next_cursor_stdout).toBe(3);
  });

  it('exec-logs maps an unknown process to NOT_FOUND', async () => {
    const sandbox = mockSandbox();
    sandbox.getProcessLogs.mockRejectedValue(new Error('no such process'));

    const response = await callRoute('exec-logs', { sandbox_id: 'sb1', process_id: 'ghost' });

    expect(response.status).toBe(404);
    expect((await jsonBody(response)).code).toBe('NOT_FOUND');
  });

  it('exec-kill is idempotent when the process is already gone', async () => {
    const sandbox = mockSandbox();
    sandbox.killProcess.mockRejectedValue(new Error('no such process'));

    const response = await callRoute('exec-kill', { sandbox_id: 'sb1', process_id: 'ghost' });

    expect(response.status).toBe(200);
    expect(await jsonBody(response)).toEqual({ ok: true });
  });

  it('classifies a missing directory as FILE_NOT_FOUND (404), not a gone sandbox', async () => {
    // Regression: listing a path that doesn't exist inside a LIVE sandbox threw
    // FileNotFoundError, which the broad `not found` classifier folded into the
    // sandbox-gone NOT_FOUND bucket → the client surfaced "Sandbox not found or
    // expired" and the kernel killed the whole turn. A missing path must be a
    // benign, non-retryable FILE_NOT_FOUND (4xx), distinct from a gone sandbox.
    const sandbox = mockSandbox();
    sandbox.listFiles.mockRejectedValue(
      new Error('FileNotFoundError: Directory not found: /workspace/src'),
    );

    const response = await callRoute('list', { sandbox_id: 'sb1', path: '/workspace/src' });

    expect(response.status).toBe(404);
    const body = await jsonBody(response);
    expect(body.code).toBe('FILE_NOT_FOUND');
    expect(body.code).not.toBe('NOT_FOUND');
  });

  it('treats a missing owner-token file as a gone session (404), not a 503 config error', async () => {
    // Regression (Codex P2 on #923): the file-not-found split must not
    // reclassify the missing /tmp/push-owner-token read as a benign
    // FILE_NOT_FOUND that falls through to NOT_CONFIGURED. A missing token
    // file means the sandbox has no session — the client must recreate (404),
    // not see a 503 config error.
    const sandbox = mockSandbox();
    sandbox.exec.mockImplementation(async (command: string) => {
      if (isOwnerTokenReadCommand(command)) {
        return {
          stdout: '',
          stderr: 'head: /tmp/push-owner-token: No such file or directory',
          exitCode: 1,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const response = await callRoute('diff', { sandbox_id: 'sb1' });

    expect(response.status).toBe(404);
    expect((await jsonBody(response)).code).toBe('NOT_FOUND');
  });
});
