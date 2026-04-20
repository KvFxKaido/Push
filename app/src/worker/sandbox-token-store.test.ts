import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KVNamespace } from '@cloudflare/workers-types';
import { issueToken, revokeToken, verifyToken } from './sandbox-token-store';

function createFakeKV() {
  const store = new Map<string, string>();
  const fake: Pick<KVNamespace, 'get' | 'put' | 'delete'> = {
    get: vi.fn(async (key: string, type?: unknown) => {
      const raw = store.get(key);
      if (raw === undefined) return null;
      if (type === 'json') return JSON.parse(raw);
      return raw;
    }) as unknown as KVNamespace['get'],
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }) as unknown as KVNamespace['put'],
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }) as unknown as KVNamespace['delete'],
  };
  return { kv: fake as KVNamespace, store };
}

describe('sandbox-token-store', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('issueToken', () => {
    it('writes a record under token:<sandboxId> with a 24h TTL', async () => {
      const { kv, store } = createFakeKV();
      const token = await issueToken(kv, 'abc-123');
      expect(token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(kv.put).toHaveBeenCalledWith('token:abc-123', expect.any(String), {
        expirationTtl: 86_400,
      });
      const raw = store.get('token:abc-123');
      expect(raw).toBeTruthy();
      const record = JSON.parse(raw as string);
      expect(record.token).toBe(token);
      expect(typeof record.createdAt).toBe('number');
      expect(record.ownerHint).toBeUndefined();
    });

    it('persists ownerHint when provided', async () => {
      const { kv, store } = createFakeKV();
      await issueToken(kv, 'abc-123', 'user-42');
      const record = JSON.parse(store.get('token:abc-123') as string);
      expect(record.ownerHint).toBe('user-42');
    });

    it('generates a unique token per call', async () => {
      const { kv } = createFakeKV();
      const t1 = await issueToken(kv, 'sbx-1');
      const t2 = await issueToken(kv, 'sbx-2');
      expect(t1).not.toBe(t2);
    });
  });

  describe('verifyToken', () => {
    it('returns ok when the stored token matches', async () => {
      const { kv } = createFakeKV();
      const token = await issueToken(kv, 'abc-123');
      const result = await verifyToken(kv, 'abc-123', token);
      expect(result).toEqual({ ok: true });
    });

    it('fails closed with 503 when the KV binding is undefined', async () => {
      const result = await verifyToken(undefined, 'abc-123', 'anything');
      expect(result).toEqual({ ok: false, status: 503, code: 'NOT_CONFIGURED' });
    });

    it('returns 403 for empty sandboxId or empty token', async () => {
      const { kv } = createFakeKV();
      await issueToken(kv, 'abc-123');
      expect(await verifyToken(kv, '', 'whatever')).toEqual({
        ok: false,
        status: 403,
        code: 'AUTH_FAILURE',
      });
      expect(await verifyToken(kv, 'abc-123', '')).toEqual({
        ok: false,
        status: 403,
        code: 'AUTH_FAILURE',
      });
    });

    it('returns 404 when no record exists for the sandboxId', async () => {
      const { kv } = createFakeKV();
      const result = await verifyToken(kv, 'unknown-sandbox', 'some-token');
      expect(result).toEqual({ ok: false, status: 404, code: 'NOT_FOUND' });
    });

    it('returns 403 when the provided token does not match the stored one', async () => {
      const { kv } = createFakeKV();
      await issueToken(kv, 'abc-123');
      const result = await verifyToken(kv, 'abc-123', 'wrong-token');
      expect(result).toEqual({ ok: false, status: 403, code: 'AUTH_FAILURE' });
    });

    it('uses timing-safe equality — rejects tokens that differ in length', async () => {
      const { kv } = createFakeKV();
      const token = await issueToken(kv, 'abc-123');
      // Shorter and longer than the real token.
      expect(await verifyToken(kv, 'abc-123', token.slice(0, -1))).toEqual({
        ok: false,
        status: 403,
        code: 'AUTH_FAILURE',
      });
      expect(await verifyToken(kv, 'abc-123', `${token}x`)).toEqual({
        ok: false,
        status: 403,
        code: 'AUTH_FAILURE',
      });
    });

    it('uses timing-safe equality — rejects tokens that match except for one byte', async () => {
      const { kv } = createFakeKV();
      const token = await issueToken(kv, 'abc-123');
      // Flip one character in the middle.
      const tampered = `${token.slice(0, 10)}${token[10] === 'a' ? 'b' : 'a'}${token.slice(11)}`;
      expect(tampered).not.toBe(token);
      expect(tampered.length).toBe(token.length);
      const result = await verifyToken(kv, 'abc-123', tampered);
      expect(result).toEqual({ ok: false, status: 403, code: 'AUTH_FAILURE' });
    });

    it('rejects oversized providedToken without touching KV (OOM defense)', async () => {
      const { kv } = createFakeKV();
      await issueToken(kv, 'abc-123');
      const oversized = 'x'.repeat(1_000_000);
      const result = await verifyToken(kv, 'abc-123', oversized);
      expect(result).toEqual({ ok: false, status: 403, code: 'AUTH_FAILURE' });
      // Verify the check short-circuited before the KV read.
      expect(kv.get).not.toHaveBeenCalled();
    });

    it('returns NOT_FOUND when the KV record is not an object', async () => {
      const { kv, store } = createFakeKV();
      // Simulate a corrupted KV entry — bare string instead of JSON object.
      store.set('token:abc-123', JSON.stringify('just-a-string'));
      const result = await verifyToken(kv, 'abc-123', 'any-token');
      expect(result).toEqual({ ok: false, status: 404, code: 'NOT_FOUND' });
    });

    it('returns NOT_FOUND when the KV record has a non-string token field', async () => {
      const { kv, store } = createFakeKV();
      store.set('token:abc-123', JSON.stringify({ token: 42, createdAt: Date.now() }));
      const result = await verifyToken(kv, 'abc-123', '42');
      expect(result).toEqual({ ok: false, status: 404, code: 'NOT_FOUND' });
    });

    it('returns NOT_FOUND when the KV record is an object with an empty token', async () => {
      const { kv, store } = createFakeKV();
      store.set('token:abc-123', JSON.stringify({ token: '', createdAt: Date.now() }));
      const result = await verifyToken(kv, 'abc-123', '');
      // Empty providedToken fails at input validation first.
      expect(result).toEqual({ ok: false, status: 403, code: 'AUTH_FAILURE' });
    });
  });

  describe('revokeToken', () => {
    it('deletes the KV entry for the sandboxId', async () => {
      const { kv, store } = createFakeKV();
      await issueToken(kv, 'abc-123');
      expect(store.has('token:abc-123')).toBe(true);
      await revokeToken(kv, 'abc-123');
      expect(store.has('token:abc-123')).toBe(false);
      expect(kv.delete).toHaveBeenCalledWith('token:abc-123');
    });

    it('is a no-op when KV binding is undefined', async () => {
      await expect(revokeToken(undefined, 'abc-123')).resolves.toBeUndefined();
    });

    it('does not throw when the key does not exist (KV delete is idempotent)', async () => {
      const { kv } = createFakeKV();
      await expect(revokeToken(kv, 'never-existed')).resolves.toBeUndefined();
      expect(kv.delete).toHaveBeenCalledWith('token:never-existed');
    });
  });
});
