import { describe, expect, it } from 'vitest';
import { isPrReviewEnabled, setPrReviewEnabled } from './pr-review-config';
import type { Env } from './worker-middleware';

function kvEnv(initial?: string): { env: Env; store: Map<string, string> } {
  const store = new Map<string, string>();
  if (initial !== undefined) store.set('config:pr-review-enabled', initial);
  const env = {
    SNAPSHOT_INDEX: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => {
        store.set(k, v);
      },
    },
  } as unknown as Env;
  return { env, store };
}

describe('pr-review-config', () => {
  it('defaults to enabled when the flag is unset', async () => {
    expect(await isPrReviewEnabled(kvEnv().env)).toBe(true);
  });

  it('reads a persisted disabled flag', async () => {
    expect(await isPrReviewEnabled(kvEnv('0').env)).toBe(false);
  });

  it('treats any non-"0" value as enabled', async () => {
    expect(await isPrReviewEnabled(kvEnv('1').env)).toBe(true);
  });

  it('fails open (enabled) when the KV binding is absent', async () => {
    expect(await isPrReviewEnabled({} as Env)).toBe(true);
  });

  it('fails open (enabled) when the KV read throws', async () => {
    const env = {
      SNAPSHOT_INDEX: {
        get: async () => {
          throw new Error('kv down');
        },
      },
    } as unknown as Env;
    expect(await isPrReviewEnabled(env)).toBe(true);
  });

  it('persists and round-trips the flag', async () => {
    const { env, store } = kvEnv();
    expect(await setPrReviewEnabled(env, false)).toBe(true);
    expect(store.get('config:pr-review-enabled')).toBe('0');
    expect(await isPrReviewEnabled(env)).toBe(false);
    await setPrReviewEnabled(env, true);
    expect(await isPrReviewEnabled(env)).toBe(true);
  });

  it('returns false from setPrReviewEnabled when there is no KV binding', async () => {
    expect(await setPrReviewEnabled({} as Env, false)).toBe(false);
  });
});
