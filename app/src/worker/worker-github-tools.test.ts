import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the shared GitHub core executor so tests don't actually talk to
// api.github.com. We preserve the real `normalizeGitHubRepoName` because the
// allowed-repo guard depends on it.
vi.mock('@push/lib/github-tool-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@push/lib/github-tool-core')>();
  return {
    ...actual,
    executeGitHubCoreTool: vi.fn(async () => ({ text: 'ok' })),
  };
});

import { executeGitHubCoreTool } from '@push/lib/github-tool-core';
import type { Env } from './worker-middleware';
import { handleGitHubTools } from './worker-github-tools';

const mockedExecute = executeGitHubCoreTool as unknown as ReturnType<typeof vi.fn>;

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    RATE_LIMITER: {
      limit: vi.fn(async () => ({ success: true })),
    } as unknown as Env['RATE_LIMITER'],
    ASSETS: {} as Env['ASSETS'],
    ...overrides,
  };
}

function makeRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://push.example.test/api/github/tools', {
    method: 'POST',
    headers: {
      Origin: 'https://push.example.test',
      'Content-Type': 'application/json',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const baseListPrsPayload = {
  tool: 'list_prs',
  args: { repo: 'owner/repo', state: 'open' },
  allowedRepo: 'owner/repo',
};

beforeEach(() => {
  mockedExecute.mockReset();
  mockedExecute.mockResolvedValue({ text: 'ok' });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Preamble: origin / rate limit / body
// ---------------------------------------------------------------------------

describe('handleGitHubTools preamble', () => {
  it('rejects a request from a disallowed origin with 403', async () => {
    const request = makeRequest(baseListPrsPayload, { Origin: 'https://evil.test' });
    const response = await handleGitHubTools(request, makeEnv());
    expect(response.status).toBe(403);
    expect(mockedExecute).not.toHaveBeenCalled();
  });

  it('returns 429 with Retry-After when the rate limiter rejects', async () => {
    const env = makeEnv({
      RATE_LIMITER: {
        limit: vi.fn(async () => ({ success: false })),
      } as unknown as Env['RATE_LIMITER'],
    });
    const response = await handleGitHubTools(makeRequest(baseListPrsPayload), env);
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(mockedExecute).not.toHaveBeenCalled();
  });

  it('returns 400 for an empty body', async () => {
    const request = new Request('https://push.example.test/api/github/tools', {
      method: 'POST',
      headers: { Origin: 'https://push.example.test' },
      body: '',
    });
    const response = await handleGitHubTools(request, makeEnv());
    expect(response.status).toBe(400);
  });

  it('returns 400 for invalid JSON', async () => {
    const response = await handleGitHubTools(makeRequest('{not valid'), makeEnv());
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/Invalid JSON/i);
  });

  it('returns 413 when the body exceeds the 64 KiB limit', async () => {
    const big = {
      ...baseListPrsPayload,
      args: { ...baseListPrsPayload.args, pad: 'x'.repeat(70_000) },
    };
    const response = await handleGitHubTools(makeRequest(big), makeEnv());
    expect(response.status).toBe(413);
  });
});

// ---------------------------------------------------------------------------
// Payload validation
// ---------------------------------------------------------------------------

describe('handleGitHubTools payload validation', () => {
  it.each([
    ['missing tool name', { args: { repo: 'owner/repo' }, allowedRepo: 'owner/repo' }],
    ['missing args', { tool: 'list_prs', allowedRepo: 'owner/repo' }],
    ['missing allowedRepo', { tool: 'list_prs', args: { repo: 'owner/repo' } }],
    [
      'unknown tool',
      { tool: 'delete_the_entire_org', args: { repo: 'owner/repo' }, allowedRepo: 'owner/repo' },
    ],
    ['missing repo in args', { tool: 'list_prs', args: {}, allowedRepo: 'owner/repo' }],
    [
      'fetch_pr without pr number',
      { tool: 'fetch_pr', args: { repo: 'owner/repo' }, allowedRepo: 'owner/repo' },
    ],
  ])('returns 400 when payload is invalid: %s', async (_label, payload) => {
    const response = await handleGitHubTools(makeRequest(payload), makeEnv());
    expect(response.status).toBe(400);
    expect(mockedExecute).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Allowed-repo guard — the critical security boundary.
// ---------------------------------------------------------------------------

describe('handleGitHubTools allowed-repo guard', () => {
  it('returns 403 when args.repo does not match allowedRepo', async () => {
    const response = await handleGitHubTools(
      makeRequest({
        tool: 'list_prs',
        args: { repo: 'other/repo' },
        allowedRepo: 'owner/repo',
      }),
      makeEnv(),
    );
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toMatch(/can only query the active repo/i);
    expect(mockedExecute).not.toHaveBeenCalled();
  });

  it.each([
    ['case mismatch', 'OWNER/Repo', 'owner/repo'],
    ['trailing .git', 'owner/repo.git', 'owner/repo'],
    ['https prefix on allowed', 'owner/repo', 'https://github.com/owner/repo'],
    ['https prefix on requested', 'https://github.com/owner/repo', 'owner/repo'],
    ['whitespace', '  owner/repo  ', 'owner/repo'],
  ])(
    'accepts request when args.repo and allowedRepo normalize equally: %s',
    async (_label, argsRepo, allowed) => {
      const response = await handleGitHubTools(
        makeRequest({
          tool: 'list_prs',
          args: { repo: argsRepo },
          allowedRepo: allowed,
        }),
        makeEnv(),
      );
      expect(response.status).toBe(200);
      expect(mockedExecute).toHaveBeenCalledOnce();
    },
  );

  it('rejects when allowedRepo normalises to empty (defensive)', async () => {
    const response = await handleGitHubTools(
      makeRequest({
        tool: 'list_prs',
        args: { repo: 'owner/repo' },
        allowedRepo: '   ',
      }),
      makeEnv(),
    );
    // Whitespace-only allowedRepo passes the asString check but normalises
    // to '' — the guard then refuses the request rather than matching it
    // against an empty allowlist.
    expect(response.status).toBe(403);
    expect(mockedExecute).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Happy path + upstream errors
// ---------------------------------------------------------------------------

describe('handleGitHubTools execution', () => {
  it('wraps the core tool result in a JSON response on success', async () => {
    mockedExecute.mockResolvedValueOnce({ text: 'pr list', data: { count: 3 } });
    const response = await handleGitHubTools(makeRequest(baseListPrsPayload), makeEnv());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result).toEqual({ text: 'pr list', data: { count: 3 } });
  });

  it('dispatches the parsed core call to executeGitHubCoreTool', async () => {
    await handleGitHubTools(makeRequest(baseListPrsPayload), makeEnv());
    expect(mockedExecute).toHaveBeenCalledOnce();
    const [, call] = mockedExecute.mock.calls[0];
    expect(call.tool).toBe('list_prs');
    expect(call.args.repo).toBe('owner/repo');
    expect(call.allowedRepo).toBe('owner/repo');
  });

  it('propagates the response X-Push-Request-Id header on success', async () => {
    const response = await handleGitHubTools(
      makeRequest(baseListPrsPayload, { 'X-Push-Request-Id': 'req_abcdef12345' }),
      makeEnv(),
    );
    expect(response.headers.get('X-Push-Request-Id')).toBe('req_abcdef12345');
  });

  it('returns 502 with the upstream error message when the core executor throws', async () => {
    mockedExecute.mockRejectedValueOnce(new Error('upstream blew up'));
    const response = await handleGitHubTools(makeRequest(baseListPrsPayload), makeEnv());
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error).toBe('upstream blew up');
  });

  it('includes the request id on the error response too', async () => {
    mockedExecute.mockRejectedValueOnce(new Error('nope'));
    const response = await handleGitHubTools(
      makeRequest(baseListPrsPayload, { 'X-Push-Request-Id': 'req_errordemo123' }),
      makeEnv(),
    );
    expect(response.headers.get('X-Push-Request-Id')).toBe('req_errordemo123');
  });

  it('wires a runtime that uses atob for base64 decoding', async () => {
    let captured: Parameters<typeof executeGitHubCoreTool>[0] | undefined;
    mockedExecute.mockImplementationOnce(async (runtime) => {
      captured = runtime;
      return { text: '' };
    });
    await handleGitHubTools(
      makeRequest({
        tool: 'read_file',
        args: { repo: 'owner/repo', path: 'README.md' },
        allowedRepo: 'owner/repo',
      }),
      makeEnv(),
    );
    expect(captured).toBeDefined();
    expect(captured!.decodeBase64('aGVsbG8=')).toBe('hello');
  });

  it('forwards the Authorization header through buildHeaders', async () => {
    let captured: Parameters<typeof executeGitHubCoreTool>[0] | undefined;
    mockedExecute.mockImplementationOnce(async (runtime) => {
      captured = runtime;
      return { text: '' };
    });
    await handleGitHubTools(
      makeRequest(baseListPrsPayload, { Authorization: 'token ghp_test' }),
      makeEnv(),
    );
    const headers = captured!.buildHeaders();
    expect(headers.Authorization).toBe('token ghp_test');
    expect(headers.Accept).toBe('application/vnd.github.v3+json');
  });

  it('omits Authorization in buildHeaders when the request has none', async () => {
    let captured: Parameters<typeof executeGitHubCoreTool>[0] | undefined;
    mockedExecute.mockImplementationOnce(async (runtime) => {
      captured = runtime;
      return { text: '' };
    });
    await handleGitHubTools(makeRequest(baseListPrsPayload), makeEnv());
    const headers = captured!.buildHeaders();
    expect(headers.Authorization).toBeUndefined();
  });

  it('builds API URLs under https://api.github.com regardless of leading slash', async () => {
    let captured: Parameters<typeof executeGitHubCoreTool>[0] | undefined;
    mockedExecute.mockImplementationOnce(async (runtime) => {
      captured = runtime;
      return { text: '' };
    });
    await handleGitHubTools(makeRequest(baseListPrsPayload), makeEnv());
    expect(captured!.buildApiUrl('/repos/x')).toBe('https://api.github.com/repos/x');
    expect(captured!.buildApiUrl('repos/x')).toBe('https://api.github.com/repos/x');
  });
});
