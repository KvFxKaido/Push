/**
 * Tests for the encrypted user-secrets store: round-trip through real
 * AES-GCM/HKDF (no crypto mocking — Node's WebCrypto matches workerd's),
 * fail-closed behavior without PUSH_SESSION_SECRET, ciphertext-at-rest
 * verification, decrypt-failure-on-rotation handling, and the
 * presence-only list contract.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Env } from './worker-middleware';
import {
  MAX_PROVIDER_KEY_CHARS,
  deleteUserProviderKey,
  getUserProviderKey,
  listUserProviderKeyMeta,
  putUserProviderKey,
  userSecretsKey,
} from './user-secrets';

function makeEnv(overrides: Partial<Env> = {}, store = new Map<string, string>()): Env {
  return {
    PUSH_SESSION_SECRET: 'test-session-secret',
    SNAPSHOT_INDEX: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => {
        store.set(k, v);
      },
    } as unknown as Env['SNAPSHOT_INDEX'],
    ...overrides,
  } as Env;
}

describe('user-secrets store', () => {
  it('round-trips a key through encrypt → KV → decrypt', async () => {
    const store = new Map<string, string>();
    const env = makeEnv({}, store);
    const put = await putUserProviderKey(env, '107059169', 'openrouter', 'sk-or-test-1234abcd');
    expect(put).toEqual({ ok: true });
    expect(await getUserProviderKey(env, '107059169', 'openrouter')).toBe('sk-or-test-1234abcd');
  });

  it('stores ciphertext, not plaintext, in KV', async () => {
    const store = new Map<string, string>();
    const env = makeEnv({}, store);
    await putUserProviderKey(env, 'u1', 'ollama', 'super-secret-plaintext-value');
    const raw = store.get(userSecretsKey('u1'))!;
    expect(raw).toBeTruthy();
    expect(raw).not.toContain('super-secret-plaintext-value');
    // last4 is the only plaintext-derived field, by design (presence UI).
    expect(raw).toContain('alue');
  });

  it('fails closed on write without PUSH_SESSION_SECRET', async () => {
    const env = makeEnv({ PUSH_SESSION_SECRET: undefined });
    const result = await putUserProviderKey(env, 'u1', 'ollama', 'k');
    expect(result).toEqual({ ok: false, reason: 'not_configured' });
  });

  it('returns null on read without PUSH_SESSION_SECRET even if a doc exists', async () => {
    const store = new Map<string, string>();
    await putUserProviderKey(makeEnv({}, store), 'u1', 'ollama', 'k-123');
    const noSecretEnv = makeEnv({ PUSH_SESSION_SECRET: undefined }, store);
    expect(await getUserProviderKey(noSecretEnv, 'u1', 'ollama')).toBeNull();
  });

  it('treats a rotated session secret as a missing key and logs it', async () => {
    const store = new Map<string, string>();
    await putUserProviderKey(makeEnv({}, store), 'u1', 'zen', 'sk-zen-original');
    const warn = vi.spyOn(console, 'log').mockImplementation(() => {});
    const rotated = makeEnv({ PUSH_SESSION_SECRET: 'rotated-secret' }, store);
    expect(await getUserProviderKey(rotated, 'u1', 'zen')).toBeNull();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('user_secret_decrypt_failed'))).toBe(
      true,
    );
    warn.mockRestore();
  });

  it('rejects unknown providers and oversized keys', async () => {
    const env = makeEnv();
    expect(await putUserProviderKey(env, 'u1', 'mistral', 'k')).toEqual({
      ok: false,
      reason: 'invalid_provider',
    });
    expect(
      await putUserProviderKey(env, 'u1', 'ollama', 'x'.repeat(MAX_PROVIDER_KEY_CHARS + 1)),
    ).toEqual({ ok: false, reason: 'too_large' });
  });

  it('scopes documents per user', async () => {
    const store = new Map<string, string>();
    const env = makeEnv({}, store);
    await putUserProviderKey(env, 'user-a', 'ollama', 'key-a');
    expect(await getUserProviderKey(env, 'user-b', 'ollama')).toBeNull();
    expect(await getUserProviderKey(env, 'user-a', 'ollama')).toBe('key-a');
  });

  it('returns null without a userId (env-only callers)', async () => {
    expect(await getUserProviderKey(makeEnv(), undefined, 'ollama')).toBeNull();
  });

  it('deletes idempotently and lists presence metadata only', async () => {
    const store = new Map<string, string>();
    const env = makeEnv({}, store);
    await putUserProviderKey(env, 'u1', 'openrouter', 'sk-or-abcd1234');
    await putUserProviderKey(env, 'u1', 'google', 'AIza-test-5678');

    const meta = await listUserProviderKeyMeta(env, 'u1');
    expect(Object.keys(meta).sort()).toEqual(['google', 'openrouter']);
    expect(meta.openrouter).toMatchObject({ last4: '1234' });
    expect(JSON.stringify(meta)).not.toContain('sk-or-abcd1234');

    expect(await deleteUserProviderKey(env, 'u1', 'openrouter')).toEqual({ ok: true });
    expect(await deleteUserProviderKey(env, 'u1', 'openrouter')).toEqual({ ok: true });
    expect(await getUserProviderKey(env, 'u1', 'openrouter')).toBeNull();
    expect(await getUserProviderKey(env, 'u1', 'google')).toBe('AIza-test-5678');
  });
});

describe('review-response pins (PR #890)', () => {
  it('allows delete without PUSH_SESSION_SECRET — data removal is never gated', async () => {
    const store = new Map<string, string>();
    await putUserProviderKey(makeEnv({}, store), 'u1', 'ollama', 'k-123');
    const noSecret = makeEnv({ PUSH_SESSION_SECRET: undefined }, store);
    expect(await deleteUserProviderKey(noSecret, 'u1', 'ollama')).toEqual({ ok: true });
    expect(await listUserProviderKeyMeta(noSecret, 'u1')).toEqual({});
  });

  it('logs user_secrets_not_configured on the secretless read path', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const env = makeEnv({ PUSH_SESSION_SECRET: undefined });
    expect(await getUserProviderKey(env, 'u1', 'ollama')).toBeNull();
    expect(
      logSpy.mock.calls.some((c) => String(c[0]).includes('user_secrets_not_configured')),
    ).toBe(true);
    logSpy.mockRestore();
  });
});
