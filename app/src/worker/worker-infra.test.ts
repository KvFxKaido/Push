import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import {
  generateGitHubAppJWT,
  handleGitHubAppOAuth,
  handleGitHubAppToken,
  handleHealthCheck,
} from './worker-infra';
import type { Env } from './worker-middleware';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    RATE_LIMITER: {
      limit: vi.fn(async () => ({ success: true })),
    } as unknown as Env['RATE_LIMITER'],
    ASSETS: {} as Env['ASSETS'],
    ...overrides,
  };
}

function makeRequest(
  url: string,
  init: RequestInit = {},
  headers: Record<string, string> = {},
): Request {
  return new Request(url, {
    method: 'POST',
    ...init,
    headers: {
      Origin: 'https://push.example.test',
      'Content-Type': 'application/json',
      ...headers,
      ...(init.headers as Record<string, string>),
    },
  });
}

// Generate a single RSA key pair once — RSA key generation is the slow part
// of these tests (~100ms), so we reuse the PEM across every happy path.
const { privateKey: rsaPrivateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const RSA_PRIVATE_KEY_PEM = rsaPrivateKey as string;

type SequentialFetchResponder = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Response | Promise<Response>;

/**
 * Build a fetch stub that responds to successive calls with the supplied
 * responders, in order. Each responder receives the original fetch
 * `(input, init)` arguments so tests can validate the exact URL/method/
 * headers used for that step. Fails the test if a call is made past the
 * queue end.
 */
function sequentialFetch(responses: SequentialFetchResponder[]) {
  let i = 0;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (i >= responses.length) {
      throw new Error(`fetch called ${i + 1} times; only ${responses.length} responses queued`);
    }
    const response = responses[i++];
    return await response(input, init);
  });
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ===========================================================================
// handleHealthCheck
// ===========================================================================

describe('handleHealthCheck', () => {
  it('reports unhealthy with a 503 when nothing is configured', async () => {
    const response = await handleHealthCheck(makeEnv());
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.status).toBe('unhealthy');
    expect(body.services.worker.status).toBe('ok');
  });

  it('reports degraded with a 200 when only an LLM key is configured', async () => {
    const response = await handleHealthCheck(makeEnv({ OLLAMA_API_KEY: 'sk' }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('degraded');
    expect(body.services.ollama).toEqual({ status: 'ok', configured: true });
  });

  it('reports degraded when only the sandbox base URL is configured', async () => {
    const response = await handleHealthCheck(
      makeEnv({ MODAL_SANDBOX_BASE_URL: 'https://org--push-app.modal.run' }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('degraded');
    expect(body.services.sandbox.status).toBe('ok');
  });

  it('reports healthy when both a provider and the sandbox are configured', async () => {
    const response = await handleHealthCheck(
      makeEnv({
        OPENROUTER_API_KEY: 'sk',
        MODAL_SANDBOX_BASE_URL: 'https://org--push-app.modal.run',
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('healthy');
  });

  it('marks the sandbox as misconfigured when the base URL is rejected', async () => {
    // resolveModalSandboxBase rejects non-https and trailing-slash URLs.
    const response = await handleHealthCheck(
      makeEnv({ MODAL_SANDBOX_BASE_URL: 'http://insecure.test' }),
    );
    const body = await response.json();
    expect(body.services.sandbox.status).toBe('misconfigured');
    expect(body.services.sandbox.error).toBeDefined();
  });

  it('reports github_app as configured only when both app id and private key are set', async () => {
    const partial = await handleHealthCheck(makeEnv({ GITHUB_APP_ID: '123' })).then((r) =>
      r.json(),
    );
    expect(partial.services.github_app.configured).toBe(false);

    const full = await handleHealthCheck(
      makeEnv({ GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: 'pem' }),
    ).then((r) => r.json());
    expect(full.services.github_app.configured).toBe(true);
  });

  it('reports github_app_oauth as configured only when both client id and secret are set', async () => {
    const body = await handleHealthCheck(
      makeEnv({ GITHUB_APP_CLIENT_ID: 'cid', GITHUB_APP_CLIENT_SECRET: 'secret' }),
    ).then((r) => r.json());
    expect(body.services.github_app_oauth.configured).toBe(true);
  });

  it('sets Cache-Control: no-store to prevent stale health probes', async () => {
    const response = await handleHealthCheck(makeEnv());
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});

// ===========================================================================
// handleGitHubAppOAuth — error paths
// ===========================================================================

describe('handleGitHubAppOAuth error paths', () => {
  const appEnv: Partial<Env> = {
    GITHUB_APP_CLIENT_ID: 'cid',
    GITHUB_APP_CLIENT_SECRET: 'secret',
    GITHUB_APP_ID: '42',
    GITHUB_APP_PRIVATE_KEY: RSA_PRIVATE_KEY_PEM,
  };

  it('rejects a request from a disallowed origin with 403', async () => {
    const request = makeRequest(
      'https://push.example.test/api/auth/github-app/oauth',
      { body: JSON.stringify({ code: 'x' }) },
      { Origin: 'https://evil.test' },
    );
    const response = await handleGitHubAppOAuth(request, makeEnv(appEnv));
    expect(response.status).toBe(403);
  });

  it('returns 500 when OAuth client credentials are missing', async () => {
    const response = await handleGitHubAppOAuth(
      makeRequest('https://push.example.test/api/auth/github-app/oauth', {
        body: JSON.stringify({ code: 'x' }),
      }),
      makeEnv({ GITHUB_APP_ID: '42', GITHUB_APP_PRIVATE_KEY: 'pem' }),
    );
    expect(response.status).toBe(500);
  });

  it('returns 500 when the GitHub App itself is not configured', async () => {
    const response = await handleGitHubAppOAuth(
      makeRequest('https://push.example.test/api/auth/github-app/oauth', {
        body: JSON.stringify({ code: 'x' }),
      }),
      makeEnv({ GITHUB_APP_CLIENT_ID: 'cid', GITHUB_APP_CLIENT_SECRET: 'secret' }),
    );
    expect(response.status).toBe(500);
  });

  it('returns 400 for invalid JSON', async () => {
    const response = await handleGitHubAppOAuth(
      makeRequest('https://push.example.test/api/auth/github-app/oauth', {
        body: '{not json',
      }),
      makeEnv(appEnv),
    );
    expect(response.status).toBe(400);
  });

  it('returns 400 when code is missing or not a string', async () => {
    const missing = await handleGitHubAppOAuth(
      makeRequest('https://push.example.test/api/auth/github-app/oauth', { body: '{}' }),
      makeEnv(appEnv),
    );
    expect(missing.status).toBe(400);

    const nonString = await handleGitHubAppOAuth(
      makeRequest('https://push.example.test/api/auth/github-app/oauth', {
        body: JSON.stringify({ code: 123 }),
      }),
      makeEnv(appEnv),
    );
    expect(nonString.status).toBe(400);
  });

  it('returns 502 when the GitHub token exchange fails upstream', async () => {
    vi.stubGlobal('fetch', sequentialFetch([() => new Response('Bad creds', { status: 500 })]));
    const response = await handleGitHubAppOAuth(
      makeRequest('https://push.example.test/api/auth/github-app/oauth', {
        body: JSON.stringify({ code: 'x' }),
      }),
      makeEnv(appEnv),
    );
    expect(response.status).toBe(502);
  });

  it('returns 400 when GitHub returns an OAuth error payload', async () => {
    vi.stubGlobal(
      'fetch',
      sequentialFetch([
        () =>
          jsonResponse({
            error: 'bad_verification_code',
            error_description: 'The code passed is incorrect or expired.',
          }),
      ]),
    );
    const response = await handleGitHubAppOAuth(
      makeRequest('https://push.example.test/api/auth/github-app/oauth', {
        body: JSON.stringify({ code: 'x' }),
      }),
      makeEnv(appEnv),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/incorrect or expired/i);
  });

  it('returns 404 when the user has no matching installation', async () => {
    vi.stubGlobal(
      'fetch',
      sequentialFetch([
        () => jsonResponse({ access_token: 'user_token' }),
        () => jsonResponse({ login: 'user', avatar_url: '' }),
        () => jsonResponse({ total_count: 0, installations: [] }),
      ]),
    );
    const response = await handleGitHubAppOAuth(
      makeRequest('https://push.example.test/api/auth/github-app/oauth', {
        body: JSON.stringify({ code: 'x' }),
      }),
      makeEnv(appEnv),
    );
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.install_url).toMatch(/apps\/push-auth/);
  });

  it('returns 403 when the installation is not in the allowlist', async () => {
    vi.stubGlobal(
      'fetch',
      sequentialFetch([
        () => jsonResponse({ access_token: 'user_token' }),
        () => jsonResponse({ login: 'user', avatar_url: '' }),
        () =>
          jsonResponse({
            total_count: 1,
            installations: [{ id: 9999, app_id: 42, app_slug: 'push-auth' }],
          }),
      ]),
    );
    const response = await handleGitHubAppOAuth(
      makeRequest('https://push.example.test/api/auth/github-app/oauth', {
        body: JSON.stringify({ code: 'x' }),
      }),
      makeEnv({ ...appEnv, GITHUB_ALLOWED_INSTALLATION_IDS: '1, 2, 3' }),
    );
    expect(response.status).toBe(403);
  });

  it('returns 502 when the user/installations endpoint fails', async () => {
    vi.stubGlobal(
      'fetch',
      sequentialFetch([
        () => jsonResponse({ access_token: 'user_token' }),
        () => jsonResponse({ login: 'user', avatar_url: '' }),
        () => new Response('boom', { status: 500 }),
      ]),
    );
    const response = await handleGitHubAppOAuth(
      makeRequest('https://push.example.test/api/auth/github-app/oauth', {
        body: JSON.stringify({ code: 'x' }),
      }),
      makeEnv(appEnv),
    );
    expect(response.status).toBe(502);
  });
});

// ===========================================================================
// handleGitHubAppOAuth — happy path
// ===========================================================================

describe('handleGitHubAppOAuth happy path', () => {
  const appEnv: Partial<Env> = {
    GITHUB_APP_CLIENT_ID: 'cid',
    GITHUB_APP_CLIENT_SECRET: 'secret',
    GITHUB_APP_ID: '42',
    GITHUB_APP_PRIVATE_KEY: RSA_PRIVATE_KEY_PEM,
  };

  it('returns installation token, user, and commit identity when everything succeeds', async () => {
    // Record every call's URL + method so we can verify the exact 5-call
    // sequence rather than just the call count.
    const calls: Array<{ url: string; method: string }> = [];
    const record = (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        input instanceof URL ? input.toString() : typeof input === 'string' ? input : input.url;
      calls.push({ url, method: (init?.method ?? 'GET').toUpperCase() });
    };
    const fetchStub = sequentialFetch([
      (input, init) => {
        record(input, init);
        return jsonResponse({ access_token: 'user_token' });
      },
      (input, init) => {
        record(input, init);
        return jsonResponse({ login: 'alice', avatar_url: 'https://avatar/alice' });
      },
      (input, init) => {
        record(input, init);
        return jsonResponse({
          total_count: 1,
          installations: [
            {
              id: 123,
              app_id: 42,
              app_slug: 'push-auth',
              account: { login: 'org', avatar_url: 'https://avatar/org' },
            },
          ],
        });
      },
      (input, init) => {
        record(input, init);
        return jsonResponse({ token: 'inst_token', expires_at: '2030-01-01T00:00:00Z' });
      },
      (input, init) => {
        record(input, init);
        return jsonResponse({
          id: 4242,
          login: 'push-auth[bot]',
          avatar_url: 'https://avatar/bot',
        });
      },
    ]);
    vi.stubGlobal('fetch', fetchStub);

    const response = await handleGitHubAppOAuth(
      makeRequest('https://push.example.test/api/auth/github-app/oauth', {
        body: JSON.stringify({ code: 'valid' }),
      }),
      makeEnv(appEnv),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.token).toBe('inst_token');
    expect(body.installation_id).toBe('123');
    expect(body.user).toEqual({ login: 'alice', avatar_url: 'https://avatar/alice' });
    expect(body.expires_at).toBe('2030-01-01T00:00:00Z');
    expect(body.commit_identity).toEqual({
      name: 'push-auth[bot]',
      email: '4242+push-auth[bot]@users.noreply.github.com',
      login: 'push-auth[bot]',
      avatar_url: 'https://avatar/bot',
    });

    // Verify the exact 5-call sequence: token exchange -> user lookup ->
    // installations list -> installation access-token -> bot identity.
    expect(calls).toHaveLength(5);
    expect(calls[0]).toEqual({
      url: 'https://github.com/login/oauth/access_token',
      method: 'POST',
    });
    expect(calls[1]).toEqual({ url: 'https://api.github.com/user', method: 'GET' });
    expect(calls[2]).toEqual({ url: 'https://api.github.com/user/installations', method: 'GET' });
    expect(calls[3]).toEqual({
      url: 'https://api.github.com/app/installations/123/access_tokens',
      method: 'POST',
    });
    expect(calls[4].url).toBe('https://api.github.com/users/push-auth%5Bbot%5D');
    expect(calls[4].method).toBe('GET');
  });
});

// ===========================================================================
// handleGitHubAppToken
// ===========================================================================

describe('handleGitHubAppToken error paths', () => {
  const appEnv: Partial<Env> = {
    GITHUB_APP_ID: '42',
    GITHUB_APP_PRIVATE_KEY: RSA_PRIVATE_KEY_PEM,
  };

  it('rejects a disallowed origin with 403', async () => {
    const response = await handleGitHubAppToken(
      makeRequest(
        'https://push.example.test/api/auth/github-app/token',
        { body: JSON.stringify({ installation_id: '1' }) },
        { Origin: 'https://evil.test' },
      ),
      makeEnv(appEnv),
    );
    expect(response.status).toBe(403);
  });

  it('returns 500 when the GitHub App is not configured', async () => {
    const response = await handleGitHubAppToken(
      makeRequest('https://push.example.test/api/auth/github-app/token', {
        body: JSON.stringify({ installation_id: '1' }),
      }),
      makeEnv(),
    );
    expect(response.status).toBe(500);
  });

  it('returns 400 for invalid JSON', async () => {
    const response = await handleGitHubAppToken(
      makeRequest('https://push.example.test/api/auth/github-app/token', {
        body: '{not json',
      }),
      makeEnv(appEnv),
    );
    expect(response.status).toBe(400);
  });

  it.each([
    ['missing installation_id', {}],
    ['numeric installation_id', { installation_id: 123 }],
    ['non-digit installation_id', { installation_id: 'abc' }],
    ['installation_id with non-digits mixed in', { installation_id: '12a' }],
    ['installation_id with leading space', { installation_id: ' 12' }],
    ['installation_id longer than 20 chars', { installation_id: '1'.repeat(21) }],
  ])('returns 400 when installation_id is invalid: %s', async (_label, payload) => {
    const response = await handleGitHubAppToken(
      makeRequest('https://push.example.test/api/auth/github-app/token', {
        body: JSON.stringify(payload),
      }),
      makeEnv(appEnv),
    );
    expect(response.status).toBe(400);
  });

  it('returns 403 when installation_id is not in the allowlist', async () => {
    const response = await handleGitHubAppToken(
      makeRequest('https://push.example.test/api/auth/github-app/token', {
        body: JSON.stringify({ installation_id: '999' }),
      }),
      makeEnv({ ...appEnv, GITHUB_ALLOWED_INSTALLATION_IDS: '1,2,3' }),
    );
    expect(response.status).toBe(403);
  });

  it('ignores an empty or whitespace-only allowlist (opens to all installations)', async () => {
    // Whitespace/empty entries are filtered out; the allowlist ends up empty,
    // which the handler treats as "no allowlist enforcement".
    vi.stubGlobal(
      'fetch',
      sequentialFetch([
        () => jsonResponse({ token: 't', expires_at: '2030-01-01T00:00:00Z' }),
        () => jsonResponse({ app_slug: 'push-auth', account: { login: 'o', avatar_url: '' } }),
        () => jsonResponse({ slug: 'push-auth' }),
      ]),
    );
    const response = await handleGitHubAppToken(
      makeRequest('https://push.example.test/api/auth/github-app/token', {
        body: JSON.stringify({ installation_id: '42' }),
      }),
      makeEnv({ ...appEnv, GITHUB_ALLOWED_INSTALLATION_IDS: '  ,  ,  ' }),
    );
    expect(response.status).toBe(200);
  });
});

describe('handleGitHubAppToken happy path', () => {
  const appEnv: Partial<Env> = {
    GITHUB_APP_ID: '42',
    GITHUB_APP_PRIVATE_KEY: RSA_PRIVATE_KEY_PEM,
  };

  it('returns the installation token along with the account and commit identity', async () => {
    vi.stubGlobal(
      'fetch',
      sequentialFetch([
        () => jsonResponse({ token: 'inst_token', expires_at: '2030-01-01T00:00:00Z' }),
        () =>
          jsonResponse({
            app_slug: 'push-auth',
            account: { login: 'myorg', avatar_url: 'https://avatar/myorg' },
          }),
        () =>
          jsonResponse({
            id: 4242,
            login: 'push-auth[bot]',
            avatar_url: 'https://avatar/bot',
          }),
      ]),
    );
    const response = await handleGitHubAppToken(
      makeRequest('https://push.example.test/api/auth/github-app/token', {
        body: JSON.stringify({ installation_id: '42' }),
      }),
      makeEnv(appEnv),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.token).toBe('inst_token');
    expect(body.user).toEqual({ login: 'myorg', avatar_url: 'https://avatar/myorg' });
    expect(body.commit_identity).toEqual({
      name: 'push-auth[bot]',
      email: '4242+push-auth[bot]@users.noreply.github.com',
      login: 'push-auth[bot]',
      avatar_url: 'https://avatar/bot',
    });
  });
});

// ===========================================================================
// generateGitHubAppJWT
// ===========================================================================

function decodeBase64Url(input: string): string {
  const pad = input.length % 4 === 0 ? 0 : 4 - (input.length % 4);
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
  return atob(base64);
}

describe('generateGitHubAppJWT', () => {
  // Pin wall-clock time so iat/exp assertions are exact instead of
  // tolerating a ~2s window that was flaky on slow CI runners.
  const fixedNow = new Date('2026-01-01T00:00:00.000Z');
  const fixedSeconds = Math.floor(fixedNow.getTime() / 1000);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('produces a 3-part RS256 JWT with the supplied app id as issuer', async () => {
    const jwt = await generateGitHubAppJWT('12345', RSA_PRIVATE_KEY_PEM);
    const parts = jwt.split('.');
    expect(parts).toHaveLength(3);

    const header = JSON.parse(decodeBase64Url(parts[0]));
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });

    const payload = JSON.parse(decodeBase64Url(parts[1]));
    expect(payload.iss).toBe('12345');
    expect(payload.exp - payload.iat).toBe(660); // 600s exp horizon + 60s iat backdate
  });

  it('back-dates iat by 60s and sets exp 600s ahead of "now"', async () => {
    const jwt = await generateGitHubAppJWT('12345', RSA_PRIVATE_KEY_PEM);
    const payload = JSON.parse(decodeBase64Url(jwt.split('.')[1]));
    expect(payload.iat).toBe(fixedSeconds - 60);
    expect(payload.exp).toBe(fixedSeconds + 600);
  });

  it('normalises literal \\n sequences in the PEM before parsing', async () => {
    // Simulate a dotenv-encoded PEM where newlines come through as \\n.
    const escapedPem = RSA_PRIVATE_KEY_PEM.replace(/\n/g, '\\n');
    const jwt = await generateGitHubAppJWT('1', escapedPem);
    expect(jwt.split('.')).toHaveLength(3);
  });

  it('throws a helpful error when the PEM looks empty or truncated', async () => {
    await expect(
      generateGitHubAppJWT('1', '-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----'),
    ).rejects.toThrow(/truncated|empty/i);
  });
});
