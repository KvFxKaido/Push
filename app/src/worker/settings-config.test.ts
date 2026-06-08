import { describe, expect, it } from 'vitest';
import {
  ANON_USER_ID,
  MAX_SETTINGS_BYTES,
  readSettingsDoc,
  resolveOwnerUserId,
  resolveSettingsUserId,
  settingsKey,
  writeSettingsMerge,
} from './settings-config';
import { SESSION_HEADER, mintSessionToken } from './worker-session';
import type { Env } from './worker-middleware';

function kvEnv(
  initial?: Record<string, string>,
  extra?: Partial<Env>,
): { env: Env; store: Map<string, string> } {
  const store = new Map<string, string>();
  if (initial) for (const [k, v] of Object.entries(initial)) store.set(k, v);
  const env = {
    SNAPSHOT_INDEX: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => {
        store.set(k, v);
      },
    },
    ...extra,
  } as unknown as Env;
  return { env, store };
}

describe('settings-config: identity resolution', () => {
  it('resolveOwnerUserId returns the single allowlisted id', () => {
    const { env } = kvEnv(undefined, { GITHUB_ALLOWED_USER_IDS: '107059169' });
    expect(resolveOwnerUserId(env)).toBe('107059169');
  });

  it('resolveOwnerUserId falls back to anon when unconfigured', () => {
    expect(resolveOwnerUserId(kvEnv().env)).toBe(ANON_USER_ID);
  });

  it('resolveOwnerUserId falls back to anon when more than one id is allowed', () => {
    const { env } = kvEnv(undefined, { GITHUB_ALLOWED_USER_IDS: '1,2' });
    expect(resolveOwnerUserId(env)).toBe(ANON_USER_ID);
  });

  it('resolveSettingsUserId prefers a verified session over the allowlist', async () => {
    const secret = 'test-secret';
    const { token } = await mintSessionToken(secret, { sub: '42', login: 'octocat' });
    const { env } = kvEnv(undefined, {
      PUSH_SESSION_SECRET: secret,
      GITHUB_ALLOWED_USER_IDS: '107059169',
    });
    const req = new Request('https://x/api/settings', { headers: { [SESSION_HEADER]: token } });
    expect(await resolveSettingsUserId(req, env)).toEqual({ userId: '42', source: 'session' });
  });

  it('resolveSettingsUserId falls back to the deployment owner without a session', async () => {
    const { env } = kvEnv(undefined, {
      PUSH_SESSION_SECRET: 'test-secret',
      GITHUB_ALLOWED_USER_IDS: '107059169',
    });
    const req = new Request('https://x/api/settings');
    expect(await resolveSettingsUserId(req, env)).toEqual({
      userId: '107059169',
      source: 'allowlist',
    });
  });

  it('resolveSettingsUserId returns anon when nothing is configured', async () => {
    const req = new Request('https://x/api/settings');
    expect(await resolveSettingsUserId(req, kvEnv().env)).toEqual({
      userId: ANON_USER_ID,
      source: 'anon',
    });
  });

  it('resolveSettingsUserId ignores a session signed with the wrong secret', async () => {
    const { token } = await mintSessionToken('attacker-secret', { sub: '42' });
    const { env } = kvEnv(undefined, {
      PUSH_SESSION_SECRET: 'real-secret',
      GITHUB_ALLOWED_USER_IDS: '107059169',
    });
    const req = new Request('https://x/api/settings', { headers: { [SESSION_HEADER]: token } });
    expect(await resolveSettingsUserId(req, env)).toEqual({
      userId: '107059169',
      source: 'allowlist',
    });
  });
});

describe('settings-config: document CRUD', () => {
  it('reads an empty doc for an unknown user', async () => {
    expect(await readSettingsDoc(kvEnv().env, '42')).toEqual({ updatedAt: 0, values: {} });
  });

  it('returns an empty doc (never throws) when KV is unbound', async () => {
    expect(await readSettingsDoc({} as Env, '42')).toEqual({ updatedAt: 0, values: {} });
  });

  it('falls back to an empty doc on unparseable stored JSON', async () => {
    const { env, store } = kvEnv();
    store.set(settingsKey('42'), '{not json');
    expect(await readSettingsDoc(env, '42')).toEqual({ updatedAt: 0, values: {} });
  });

  it('falls back to an empty doc on a wrong-shaped stored value', async () => {
    const { env, store } = kvEnv();
    store.set(settingsKey('42'), JSON.stringify({ updatedAt: 'nope', values: [] }));
    expect(await readSettingsDoc(env, '42')).toEqual({ updatedAt: 0, values: {} });
  });

  it('merges new keys without clobbering existing ones (LWW per key)', async () => {
    const { env } = kvEnv();
    const first = await writeSettingsMerge(env, '42', { a: 1 }, 1000);
    const second = await writeSettingsMerge(env, '42', { b: 2 }, 2000);
    expect(first.ok && first.doc.values).toEqual({ a: 1 });
    expect(second.ok && second.doc.values).toEqual({ a: 1, b: 2 });
    expect(second.ok && second.doc.updatedAt).toBe(2000);
  });

  it('last write wins for the same key', async () => {
    const { env } = kvEnv();
    await writeSettingsMerge(env, '42', { theme: 'dark' }, 1000);
    const next = await writeSettingsMerge(env, '42', { theme: 'light' }, 2000);
    expect(next.ok && next.doc.values.theme).toBe('light');
  });

  it('advances updatedAt monotonically even when the clock does not', async () => {
    const { env } = kvEnv();
    await writeSettingsMerge(env, '42', { a: 1 }, 5000);
    const next = await writeSettingsMerge(env, '42', { b: 2 }, 5000);
    expect(next.ok && next.doc.updatedAt).toBe(5001);
  });

  it('isolates documents per user id', async () => {
    const { env } = kvEnv();
    await writeSettingsMerge(env, '1', { a: 1 }, 1000);
    await writeSettingsMerge(env, '2', { b: 2 }, 1000);
    expect((await readSettingsDoc(env, '1')).values).toEqual({ a: 1 });
    expect((await readSettingsDoc(env, '2')).values).toEqual({ b: 2 });
  });

  it('rejects a write that exceeds the size limit', async () => {
    const { env } = kvEnv();
    const big = 'x'.repeat(MAX_SETTINGS_BYTES + 1);
    expect(await writeSettingsMerge(env, '42', { big })).toEqual({
      ok: false,
      reason: 'too_large',
    });
  });

  it('reports no_kv when the binding is missing', async () => {
    expect(await writeSettingsMerge({} as Env, '42', { a: 1 })).toEqual({
      ok: false,
      reason: 'no_kv',
    });
  });
});
