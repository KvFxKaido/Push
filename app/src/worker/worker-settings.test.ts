/**
 * Contract / drift test for the /api/settings wire shape. Pins the GET/PUT
 * envelope (`{ updatedAt: number, values: object }`), the PUT merge semantics,
 * and the validation/guard status codes so a change to the document contract is
 * a deliberate, visible edit here rather than a silent break for every client.
 */
import { describe, expect, it, vi } from 'vitest';
import { handleSettingsRoute, matchSettingsRoute } from './worker-settings';
import type { Env } from './worker-middleware';

function makeEnv(overrides: Partial<Env> = {}, store = new Map<string, string>()): Env {
  return {
    RATE_LIMITER: {
      limit: vi.fn(async () => ({ success: true })),
    } as unknown as Env['RATE_LIMITER'],
    ASSETS: {} as Env['ASSETS'],
    ALLOWED_ORIGINS: 'https://push.example.test',
    SNAPSHOT_INDEX: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => {
        store.set(k, v);
      },
    } as unknown as Env['SNAPSHOT_INDEX'],
    ...overrides,
  } as Env;
}

function makeRequest(method: 'GET' | 'PUT', body?: unknown, headers: Record<string, string> = {}) {
  return new Request('https://push.example.test/api/settings', {
    method,
    headers: {
      Origin: 'https://push.example.test',
      'content-type': 'application/json',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('matchSettingsRoute', () => {
  it('matches GET and PUT on /api/settings', () => {
    expect(matchSettingsRoute('/api/settings', 'GET')).toBe('get');
    expect(matchSettingsRoute('/api/settings', 'PUT')).toBe('put');
  });

  it('ignores other methods and paths', () => {
    expect(matchSettingsRoute('/api/settings', 'POST')).toBeNull();
    expect(matchSettingsRoute('/api/settings/extra', 'GET')).toBeNull();
    expect(matchSettingsRoute('/api/other', 'GET')).toBeNull();
  });
});

describe('GET /api/settings', () => {
  it('returns the document envelope shape', async () => {
    const res = await handleSettingsRoute(makeRequest('GET'), makeEnv(), 'get');
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { updatedAt: unknown; values: unknown };
    expect(typeof doc.updatedAt).toBe('number');
    expect(doc.values).toEqual({});
    expect(Array.isArray(doc.values)).toBe(false);
  });

  it('reflects a previously written value', async () => {
    const store = new Map<string, string>();
    const env = makeEnv({}, store);
    await handleSettingsRoute(makeRequest('PUT', { values: { theme: 'dark' } }), env, 'put');
    const res = await handleSettingsRoute(makeRequest('GET'), env, 'get');
    const doc = (await res.json()) as { values: Record<string, unknown> };
    expect(doc.values.theme).toBe('dark');
  });
});

describe('PUT /api/settings', () => {
  it('merges values and returns the merged document', async () => {
    const store = new Map<string, string>();
    const env = makeEnv({}, store);
    await handleSettingsRoute(makeRequest('PUT', { values: { a: 1 } }), env, 'put');
    const res = await handleSettingsRoute(makeRequest('PUT', { values: { b: 2 } }), env, 'put');
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { updatedAt: number; values: Record<string, unknown> };
    expect(doc.values).toEqual({ a: 1, b: 2 });
    expect(typeof doc.updatedAt).toBe('number');
  });

  it('rejects a non-object body', async () => {
    const res = await handleSettingsRoute(makeRequest('PUT', [1, 2, 3]), makeEnv(), 'put');
    expect(res.status).toBe(400);
  });

  it('rejects a body without a values object', async () => {
    const res = await handleSettingsRoute(makeRequest('PUT', { nope: true }), makeEnv(), 'put');
    expect(res.status).toBe(400);
  });

  it('returns 503 when the KV store is unbound', async () => {
    const env = makeEnv({ SNAPSHOT_INDEX: undefined });
    const res = await handleSettingsRoute(makeRequest('PUT', { values: { a: 1 } }), env, 'put');
    expect(res.status).toBe(503);
  });
});

describe('/api/settings guards', () => {
  it('rejects a disallowed origin with 403', async () => {
    const req = new Request('https://push.example.test/api/settings', {
      method: 'GET',
      headers: { Origin: 'https://evil.example' },
    });
    const res = await handleSettingsRoute(req, makeEnv(), 'get');
    expect(res.status).toBe(403);
  });

  it('rejects when rate-limited with 429', async () => {
    const env = makeEnv({
      RATE_LIMITER: {
        limit: vi.fn(async () => ({ success: false })),
      } as unknown as Env['RATE_LIMITER'],
    });
    const res = await handleSettingsRoute(makeRequest('GET'), env, 'get');
    expect(res.status).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// Provider keys (/api/settings/provider-keys) — the user-secrets fold
// ---------------------------------------------------------------------------

function makeKeysRequest(method: 'GET' | 'PUT' | 'DELETE', body?: unknown) {
  return new Request('https://push.example.test/api/settings/provider-keys', {
    method,
    headers: {
      Origin: 'https://push.example.test',
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function makeKeysEnv(store = new Map<string, string>()) {
  return makeEnv({ PUSH_SESSION_SECRET: 'test-session-secret' } as Partial<Env>, store);
}

describe('matchSettingsRoute — provider keys', () => {
  it('matches GET/PUT/DELETE on /api/settings/provider-keys', () => {
    expect(matchSettingsRoute('/api/settings/provider-keys', 'GET')).toBe('keys-list');
    expect(matchSettingsRoute('/api/settings/provider-keys', 'PUT')).toBe('keys-put');
    expect(matchSettingsRoute('/api/settings/provider-keys', 'DELETE')).toBe('keys-delete');
    expect(matchSettingsRoute('/api/settings/provider-keys', 'POST')).toBeNull();
  });
});

describe('/api/settings/provider-keys', () => {
  it('stores a key and lists presence metadata without key material', async () => {
    const store = new Map<string, string>();
    const env = makeKeysEnv(store);
    const put = await handleSettingsRoute(
      makeKeysRequest('PUT', { provider: 'openrouter', key: 'sk-or-secret-7890' }),
      env,
      'keys-put',
    );
    expect(put.status).toBe(200);

    const list = await handleSettingsRoute(makeKeysRequest('GET'), env, 'keys-list');
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      providers: Record<string, { last4: string; updatedAt: number }>;
    };
    expect(body.providers.openrouter).toMatchObject({ last4: '7890' });
    expect(JSON.stringify(body)).not.toContain('sk-or-secret-7890');
  });

  it('deletes a stored key', async () => {
    const store = new Map<string, string>();
    const env = makeKeysEnv(store);
    await handleSettingsRoute(
      makeKeysRequest('PUT', { provider: 'ollama', key: 'k-1234' }),
      env,
      'keys-put',
    );
    const del = await handleSettingsRoute(
      makeKeysRequest('DELETE', { provider: 'ollama' }),
      env,
      'keys-delete',
    );
    expect(del.status).toBe(200);
    const list = await handleSettingsRoute(makeKeysRequest('GET'), env, 'keys-list');
    const body = (await list.json()) as { providers: Record<string, unknown> };
    expect(body.providers.ollama).toBeUndefined();
  });

  it('rejects unknown providers, empty keys, and bad bodies with 400', async () => {
    const env = makeKeysEnv();
    expect(
      (
        await handleSettingsRoute(
          makeKeysRequest('PUT', { provider: 'mistral', key: 'k' }),
          env,
          'keys-put',
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handleSettingsRoute(
          makeKeysRequest('PUT', { provider: 'ollama', key: '  ' }),
          env,
          'keys-put',
        )
      ).status,
    ).toBe(400);
    expect((await handleSettingsRoute(makeKeysRequest('PUT'), env, 'keys-put')).status).toBe(400);
  });

  it('fails closed with 503 NOT_CONFIGURED when PUSH_SESSION_SECRET is absent', async () => {
    const env = makeEnv();
    const res = await handleSettingsRoute(
      makeKeysRequest('PUT', { provider: 'ollama', key: 'k-1' }),
      env,
      'keys-put',
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('NOT_CONFIGURED');
  });

  it('rejects a disallowed origin with 403 (same guard as /api/settings)', async () => {
    const req = new Request('https://push.example.test/api/settings/provider-keys', {
      method: 'GET',
      headers: { Origin: 'https://evil.example' },
    });
    const res = await handleSettingsRoute(req, makeKeysEnv(), 'keys-list');
    expect(res.status).toBe(403);
  });
});
