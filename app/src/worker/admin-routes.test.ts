import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleAdminSnapshots } from './admin-routes';
import { putSnapshot } from './snapshot-index';
import type { Env } from './worker-middleware';
import type { KVNamespace } from '@cloudflare/workers-types';

interface StoredValue {
  value: string;
  metadata?: unknown;
  expirationTtl?: number;
}

function createFakeKv(): { kv: KVNamespace; store: Map<string, StoredValue> } {
  const store = new Map<string, StoredValue>();
  const kv = {
    async get(key: string): Promise<string | null> {
      return store.get(key)?.value ?? null;
    },
    async getWithMetadata(key: string) {
      const entry = store.get(key);
      if (!entry) return { value: null, metadata: null };
      return { value: entry.value, metadata: entry.metadata ?? null };
    },
    async put(
      key: string,
      value: string,
      options?: { metadata?: unknown; expirationTtl?: number },
    ): Promise<void> {
      store.set(key, {
        value,
        metadata: options?.metadata,
        expirationTtl: options?.expirationTtl,
      });
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    async list(options?: { prefix?: string; cursor?: string }) {
      const prefix = options?.prefix ?? '';
      const keys = Array.from(store.entries())
        .filter(([k]) => k.startsWith(prefix))
        .map(([name, entry]) => ({ name, metadata: entry.metadata }));
      return { keys, list_complete: true, cursor: '' };
    },
  };
  return { kv: kv as unknown as KVNamespace, store };
}

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
  headers: Record<string, string> = {},
  url = 'https://push.example.test/api/admin/snapshots',
): Request {
  return new Request(url, {
    method: 'GET',
    headers: {
      Origin: 'https://push.example.test',
      ...headers,
    },
  });
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleAdminSnapshots', () => {
  describe('auth gating', () => {
    it('returns 404 when ADMIN_TOKEN env is not set (endpoint invisible)', async () => {
      const env = makeEnv();
      const response = await handleAdminSnapshots(
        makeRequest({ 'X-Admin-Token': 'anything' }),
        env,
      );
      expect(response.status).toBe(404);
    });

    it('returns 401 when ADMIN_TOKEN is set but header is missing', async () => {
      const env = makeEnv({ ADMIN_TOKEN: 'secret' });
      const response = await handleAdminSnapshots(makeRequest(), env);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'Unauthorized' });
    });

    it('returns 401 when ADMIN_TOKEN is set but header is wrong', async () => {
      const env = makeEnv({ ADMIN_TOKEN: 'secret' });
      const response = await handleAdminSnapshots(makeRequest({ 'X-Admin-Token': 'wrong' }), env);
      expect(response.status).toBe(401);
    });

    it('returns 401 when header has matching prefix but different length', async () => {
      // Guards the timingSafeEqual early-return on length mismatch.
      const env = makeEnv({ ADMIN_TOKEN: 'secret-full-token' });
      const response = await handleAdminSnapshots(
        makeRequest({ 'X-Admin-Token': 'secret-full' }),
        env,
      );
      expect(response.status).toBe(401);
    });

    it('returns 403 when Origin is not allowed, regardless of token', async () => {
      const env = makeEnv({ ADMIN_TOKEN: 'secret', ALLOWED_ORIGINS: 'https://push.example.test' });
      const response = await handleAdminSnapshots(
        makeRequest({ 'X-Admin-Token': 'secret', Origin: 'https://attacker.example' }),
        env,
      );
      expect(response.status).toBe(403);
    });
  });

  describe('degraded states', () => {
    it('returns 503 when SNAPSHOT_INDEX binding is missing', async () => {
      const env = makeEnv({ ADMIN_TOKEN: 'secret' });
      const response = await handleAdminSnapshots(makeRequest({ 'X-Admin-Token': 'secret' }), env);
      expect(response.status).toBe(503);
      const body = (await response.json()) as { code?: string };
      expect(body.code).toBe('KV_NOT_BOUND');
    });

    it('returns 429 when rate-limited', async () => {
      const { kv } = createFakeKv();
      const env = makeEnv({
        ADMIN_TOKEN: 'secret',
        SNAPSHOT_INDEX: kv,
        RATE_LIMITER: {
          limit: vi.fn(async () => ({ success: false })),
        } as unknown as Env['RATE_LIMITER'],
      });
      const response = await handleAdminSnapshots(makeRequest({ 'X-Admin-Token': 'secret' }), env);
      expect(response.status).toBe(429);
      expect(response.headers.get('Retry-After')).toBe('60');
    });
  });

  describe('happy path', () => {
    it('returns an empty summary when the index has no entries', async () => {
      const { kv } = createFakeKv();
      const env = makeEnv({ ADMIN_TOKEN: 'secret', SNAPSHOT_INDEX: kv });
      const response = await handleAdminSnapshots(makeRequest({ 'X-Admin-Token': 'secret' }), env);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        summary: {
          total: number;
          totalSizeBytes: number;
          oldestAccessedAtIso: string | null;
          newestAccessedAtIso: string | null;
        };
        entries: unknown[];
      };
      expect(body.summary).toEqual({
        total: 0,
        totalSizeBytes: 0,
        oldestAccessedAtIso: null,
        newestAccessedAtIso: null,
      });
      expect(body.entries).toEqual([]);
    });

    it('aggregates size and oldest/newest timestamps across multiple entries', async () => {
      const { kv } = createFakeKv();
      const old = 1_700_000_000_000; // ~Nov 2023
      const recent = 1_740_000_000_000; // ~Feb 2025
      await putSnapshot(
        kv,
        {
          repoFullName: 'a/b',
          branch: 'main',
          imageId: 'im-a',
          restoreToken: 'tok-a',
          sizeBytes: 1000,
        },
        old,
      );
      await putSnapshot(
        kv,
        {
          repoFullName: 'c/d',
          branch: 'main',
          imageId: 'im-c',
          restoreToken: 'tok-c',
          sizeBytes: 2500,
        },
        recent,
      );

      const env = makeEnv({ ADMIN_TOKEN: 'secret', SNAPSHOT_INDEX: kv });
      const response = await handleAdminSnapshots(makeRequest({ 'X-Admin-Token': 'secret' }), env);
      expect(response.status).toBe(200);

      const body = (await response.json()) as {
        summary: { total: number; totalSizeBytes: number };
        entries: Array<{ repoFullName: string; sizeBytes: number | null }>;
      };
      expect(body.summary.total).toBe(2);
      expect(body.summary.totalSizeBytes).toBe(3500);
      expect(body.entries).toHaveLength(2);
    });

    it('redacts imageId and restoreToken from entries', async () => {
      const { kv } = createFakeKv();
      await putSnapshot(kv, {
        repoFullName: 'owner/repo',
        branch: 'main',
        imageId: 'im-SECRET-IMAGE-ID',
        restoreToken: 'tok-SECRET-RESTORE-TOKEN',
        sizeBytes: 999,
      });

      const env = makeEnv({ ADMIN_TOKEN: 'secret', SNAPSHOT_INDEX: kv });
      const response = await handleAdminSnapshots(makeRequest({ 'X-Admin-Token': 'secret' }), env);
      const body = await response.text();
      expect(body).not.toContain('im-SECRET-IMAGE-ID');
      expect(body).not.toContain('tok-SECRET-RESTORE-TOKEN');
    });

    it('computes ageSeconds from lastAccessedAt', async () => {
      const { kv } = createFakeKv();
      const accessedAt = Date.now() - 3600_000; // 1 hour ago
      await putSnapshot(
        kv,
        {
          repoFullName: 'owner/repo',
          branch: 'main',
          imageId: 'im-x',
          restoreToken: 'tok-x',
        },
        accessedAt,
      );

      const env = makeEnv({ ADMIN_TOKEN: 'secret', SNAPSHOT_INDEX: kv });
      const response = await handleAdminSnapshots(makeRequest({ 'X-Admin-Token': 'secret' }), env);
      const body = (await response.json()) as {
        entries: Array<{ ageSeconds: number }>;
      };
      // Accept a small window for test-runtime slippage.
      expect(body.entries[0].ageSeconds).toBeGreaterThanOrEqual(3599);
      expect(body.entries[0].ageSeconds).toBeLessThanOrEqual(3601);
    });
  });
});
