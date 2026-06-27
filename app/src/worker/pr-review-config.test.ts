import { describe, expect, it } from 'vitest';
import {
  coerceKnownPrReviewer,
  getPrReviewEffectiveConfig,
  getPrReviewRuntimeConfig,
  isPrReviewEnabled,
  isValidPrReviewRuntimeConfig,
  setPrReviewEnabled,
  setPrReviewRuntimeConfig,
} from './pr-review-config';
import type { Env } from './worker-middleware';

function kvEnv(initial?: Record<string, string> | string): {
  env: Env;
  store: Map<string, string>;
} {
  const store = new Map<string, string>();
  if (typeof initial === 'string') store.set('config:pr-review-enabled', initial);
  else if (initial) {
    for (const [key, value] of Object.entries(initial)) store.set(key, value);
  }
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

  it('persists and round-trips the flag through the settings doc', async () => {
    const { env, store } = kvEnv();
    expect(await setPrReviewEnabled(env, false)).toBe(true);
    // Written into the owner's settings document, not the legacy flat key.
    expect(store.has('config:pr-review-enabled')).toBe(false);
    expect(JSON.parse(store.get('settings:anon')!).values['reviewer.autonomous.enabled']).toBe(
      false,
    );
    expect(await isPrReviewEnabled(env)).toBe(false);
    await setPrReviewEnabled(env, true);
    expect(await isPrReviewEnabled(env)).toBe(true);
  });

  it('reads a disabled flag from the legacy flat key when the doc is unset', async () => {
    const { env } = kvEnv({ 'config:pr-review-enabled': '0' });
    expect(await isPrReviewEnabled(env)).toBe(false);
  });

  it('lets the settings doc override the legacy enabled flag', async () => {
    const { env } = kvEnv({
      'config:pr-review-enabled': '0',
      'settings:anon': JSON.stringify({
        updatedAt: 1,
        values: { 'reviewer.autonomous.enabled': true },
      }),
    });
    expect(await isPrReviewEnabled(env)).toBe(true);
  });

  it('returns false from setPrReviewEnabled when there is no KV binding', async () => {
    expect(await setPrReviewEnabled({} as Env, false)).toBe(false);
  });

  it('defaults provider/model to the built-in automated reviewer', async () => {
    expect(await getPrReviewEffectiveConfig(kvEnv().env)).toEqual({
      enabled: true,
      provider: 'sakana',
      model: 'fugu',
    });
  });

  it('falls back to the default reviewer when the persisted provider was removed from the catalog', async () => {
    // A deployment previously configured for the retired `blackbox` provider:
    // resolving must drop the now-unavailable id (and its stale model) and use
    // the built-in default reviewer instead of hard-failing every review.
    const { env } = kvEnv({
      'config:pr-review-provider': 'blackbox',
      'config:pr-review-model': 'blackboxai/x-ai/grok-code-fast-1:free',
    });
    expect(await getPrReviewEffectiveConfig(env)).toEqual({
      enabled: true,
      provider: 'sakana',
      model: 'fugu',
    });
  });

  it('coerceKnownPrReviewer passes a known pair through and remaps an unknown provider', () => {
    expect(coerceKnownPrReviewer('openai', 'gpt-5.4')).toEqual({
      provider: 'openai',
      model: 'gpt-5.4',
    });
    // Removed provider -> default reviewer + its default model (stale model dropped).
    expect(coerceKnownPrReviewer('blackbox', 'blackboxai/x-ai/grok-code-fast-1:free')).toEqual({
      provider: 'sakana',
      model: 'fugu',
    });
  });

  it('reads provider/model from env when KV is unset', async () => {
    const env = { ...kvEnv().env, PR_REVIEW_PROVIDER: 'openai', PR_REVIEW_MODEL: 'gpt-5.4' };
    expect(await getPrReviewRuntimeConfig(env)).toEqual({ provider: 'openai', model: 'gpt-5.4' });
  });

  it('lets KV provider/model override env vars', async () => {
    const { env } = kvEnv({
      'config:pr-review-provider': 'google',
      'config:pr-review-model': 'gemini-3.5-flash',
    });
    env.PR_REVIEW_PROVIDER = 'openai';
    env.PR_REVIEW_MODEL = 'gpt-5.4';
    expect(await getPrReviewRuntimeConfig(env)).toEqual({
      provider: 'google',
      model: 'gemini-3.5-flash',
    });
  });

  it('persists provider/model config to the settings doc', async () => {
    const { env, store } = kvEnv();
    expect(await setPrReviewRuntimeConfig(env, 'openai', 'gpt-5.4')).toBe(true);
    const doc = JSON.parse(store.get('settings:anon')!);
    expect(doc.values['reviewer.autonomous.provider']).toBe('openai');
    expect(doc.values['reviewer.autonomous.model']).toBe('gpt-5.4');
    expect(await getPrReviewRuntimeConfig(env)).toEqual({ provider: 'openai', model: 'gpt-5.4' });
  });

  it('lets the settings doc override legacy provider/model', async () => {
    const { env } = kvEnv({
      'config:pr-review-provider': 'google',
      'config:pr-review-model': 'gemini-3.5-flash',
      'settings:anon': JSON.stringify({
        updatedAt: 1,
        values: {
          'reviewer.autonomous.provider': 'openai',
          'reviewer.autonomous.model': 'gpt-5.4',
        },
      }),
    });
    expect(await getPrReviewRuntimeConfig(env)).toEqual({ provider: 'openai', model: 'gpt-5.4' });
  });

  it('keys the reviewer config by the deployment owner when an allowlist is set', async () => {
    const { env, store } = kvEnv();
    env.GITHUB_ALLOWED_USER_IDS = '107059169';
    await setPrReviewRuntimeConfig(env, 'openai', 'gpt-5.4');
    expect(store.has('settings:anon')).toBe(false);
    expect(
      JSON.parse(store.get('settings:107059169')!).values['reviewer.autonomous.provider'],
    ).toBe('openai');
  });

  it('returns false from setPrReviewRuntimeConfig when there is no KV binding', async () => {
    expect(await setPrReviewRuntimeConfig({} as Env, 'openai', 'gpt-5.4')).toBe(false);
  });

  it('validates automated reviewer provider/model pairs', () => {
    expect(isValidPrReviewRuntimeConfig('anthropic', 'claude-sonnet-4-6')).toBe(true);
    expect(isValidPrReviewRuntimeConfig('anthropic', 'gpt-5.4')).toBe(false);
    expect(isValidPrReviewRuntimeConfig('not-a-provider', 'claude-sonnet-4-6')).toBe(false);
  });
});
