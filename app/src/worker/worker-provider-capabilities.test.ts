/**
 * Tests for the provider engine-capability probe.
 *
 * Pins the two-condition contract (DO-dispatchable AND server-side
 * credentials), the booleans-only response shape, and — via ALL_PROVIDERS —
 * that the map stays exhaustive over `AIProviderType` so a new provider can't
 * silently ship without an engine-capability answer.
 */

import { describe, expect, it } from 'vitest';
import type { Ai } from '@cloudflare/workers-types';

import { resolveProviderHandler } from './coder-job-stream-adapter';
import { putUserProviderKey } from './user-secrets';
import {
  ALL_PROVIDERS,
  handleProviderEngineCapabilities,
  isProviderEngineCapable,
} from './worker-provider-capabilities';
import type { Env } from './worker-middleware';

function makeRequest(): Request {
  return new Request('https://example.com/api/providers/engine-capabilities', { method: 'GET' });
}

describe('isProviderEngineCapable', () => {
  it('requires a server-side key even when the DO can dispatch the provider', () => {
    expect(resolveProviderHandler('ollama', false)).not.toBeNull();
    expect(isProviderEngineCapable('ollama', {} as Env)).toBe(false);
    expect(isProviderEngineCapable('ollama', { OLLAMA_API_KEY: 'k' } as Env)).toBe(true);
  });

  it('treats an empty-string secret as missing, matching standardAuth falsiness', () => {
    expect(isProviderEngineCapable('openrouter', { OPENROUTER_API_KEY: '' } as Env)).toBe(false);
  });

  it('reports cloudflare capable from the AI binding, not a secret', () => {
    expect(isProviderEngineCapable('cloudflare', {} as Env)).toBe(false);
    expect(isProviderEngineCapable('cloudflare', { AI: {} as Ai } as Env)).toBe(true);
  });

  it('reports non-DO-dispatchable providers incapable regardless of env', () => {
    for (const provider of ['demo'] as const) {
      expect(resolveProviderHandler(provider, false)).toBeNull();
      expect(isProviderEngineCapable(provider, { OLLAMA_API_KEY: 'k' } as Env)).toBe(false);
    }
  });

  it('agrees with resolveProviderHandler on the dispatchable set', () => {
    // Fully-keyed env: capability should now equal dispatchability, so the
    // ALL_PROVIDERS table can't drift from the DO's switch.
    const fullEnv = {
      AI: {} as Ai,
      OLLAMA_API_KEY: 'k',
      OPENROUTER_API_KEY: 'k',
      ZEN_API_KEY: 'k',
      NVIDIA_API_KEY: 'k',
      KILOCODE_API_KEY: 'k',
      FIREWORKS_API_KEY: 'k',
      DEEPSEEK_API_KEY: 'k',
      SAKANA_API_KEY: 'k',
      ANTHROPIC_API_KEY: 'k',
      OPENAI_API_KEY: 'k',
      GOOGLE_API_KEY: 'k',
    } as Env;
    for (const provider of ALL_PROVIDERS) {
      expect(isProviderEngineCapable(provider, fullEnv)).toBe(
        resolveProviderHandler(provider, false) !== null,
      );
    }
  });
});

describe('handleProviderEngineCapabilities', () => {
  it('returns an exhaustive boolean map and never key material', async () => {
    const res = await handleProviderEngineCapabilities(makeRequest(), {
      OLLAMA_API_KEY: 'sk-secret-value',
      ZEN_API_KEY: 'sk-other-secret',
    } as Env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = (await res.json()) as { providers: Record<string, boolean> };
    expect(Object.keys(body.providers).sort()).toEqual([...ALL_PROVIDERS].sort());
    expect(body.providers.ollama).toBe(true);
    expect(body.providers.zen).toBe(true);
    expect(body.providers.openrouter).toBe(false);
    for (const value of Object.values(body.providers)) {
      expect(typeof value).toBe('boolean');
    }
    expect(JSON.stringify(body)).not.toContain('secret');
  });
});

describe('handleProviderEngineCapabilities — user-stored keys', () => {
  it('reports capable when the identity has a stored key and no env secret exists', async () => {
    const store = new Map<string, string>();
    const env = {
      PUSH_SESSION_SECRET: 'test-session-secret',
      SNAPSHOT_INDEX: {
        get: async (k: string) => store.get(k) ?? null,
        put: async (k: string, v: string) => {
          store.set(k, v);
        },
      },
    } as unknown as Env;
    // No session on the request and no allowlist → identity resolves to anon;
    // store the key under that same identity, as the route layer would.
    await putUserProviderKey(env, 'anon', 'openrouter', 'sk-or-user-key');

    const res = await handleProviderEngineCapabilities(makeRequest(), env);
    const body = (await res.json()) as { providers: Record<string, boolean> };
    expect(body.providers.openrouter).toBe(true);
    // Providers with neither env nor user key stay false.
    expect(body.providers.nvidia).toBe(false);
  });
});

describe('handleProviderEngineCapabilities — decryptability (Codex P2)', () => {
  it('reports NOT capable when stored-key metadata exists but the session secret rotated', async () => {
    const store = new Map<string, string>();
    const makeEnv = (secret: string) =>
      ({
        PUSH_SESSION_SECRET: secret,
        SNAPSHOT_INDEX: {
          get: async (k: string) => store.get(k) ?? null,
          put: async (k: string, v: string) => {
            store.set(k, v);
          },
        },
      }) as unknown as Env;
    await putUserProviderKey(makeEnv('original-secret'), 'anon', 'openrouter', 'sk-or-1');

    // Same metadata, rotated secret: dispatch would fail to decrypt, so the
    // probe must say not-capable — otherwise the client routes into a 401.
    const res = await handleProviderEngineCapabilities(makeRequest(), makeEnv('rotated-secret'));
    const body = (await res.json()) as { providers: Record<string, boolean> };
    expect(body.providers.openrouter).toBe(false);
  });

  it('reports NOT capable when metadata exists but PUSH_SESSION_SECRET is absent', async () => {
    const store = new Map<string, string>();
    const env = (secret?: string) =>
      ({
        ...(secret ? { PUSH_SESSION_SECRET: secret } : {}),
        SNAPSHOT_INDEX: {
          get: async (k: string) => store.get(k) ?? null,
          put: async (k: string, v: string) => {
            store.set(k, v);
          },
        },
      }) as unknown as Env;
    await putUserProviderKey(env('secret'), 'anon', 'ollama', 'k-1');
    const res = await handleProviderEngineCapabilities(makeRequest(), env(undefined));
    const body = (await res.json()) as { providers: Record<string, boolean> };
    expect(body.providers.ollama).toBe(false);
  });
});
