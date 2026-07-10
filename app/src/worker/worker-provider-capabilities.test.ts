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

  it('reports a BYOK provider capable with no secret (gateway injects the key)', () => {
    const byokEnv = {
      CF_AI_GATEWAY_ACCOUNT_ID: 'acc',
      CF_AI_GATEWAY_SLUG: 'push-prod',
      CF_AI_GATEWAY_BYOK: 'anthropic',
    } as Env;
    // No ANTHROPIC_API_KEY, but the gateway holds it → server-side turns can run.
    expect(isProviderEngineCapable('anthropic', byokEnv)).toBe(true);
    // A different provider not on the BYOK list still needs its own secret.
    expect(isProviderEngineCapable('openai', byokEnv)).toBe(false);
    // BYOK without a configured gateway is not enough.
    expect(isProviderEngineCapable('anthropic', { CF_AI_GATEWAY_BYOK: 'anthropic' } as Env)).toBe(
      false,
    );
  });

  it('maps the Kimi provider to the moonshot custom-provider BYOK slug', () => {
    const env = {
      CF_AI_GATEWAY_ACCOUNT_ID: 'acc',
      CF_AI_GATEWAY_SLUG: 'push-prod',
      CF_AI_GATEWAY_CUSTOM_SLUGS: 'moonshot',
      CF_AI_GATEWAY_BYOK: 'moonshot',
    } as Env;
    expect(isProviderEngineCapable('kimi', env)).toBe(true);
  });

  it('reports Kimi server-capable via either accepted Worker secret (any-of alias)', () => {
    // Kimi's handler authenticates with MOONSHOT_API_KEY OR KIMI_API_KEY, so the
    // capability probe must credential it when EITHER is set — otherwise a
    // MOONSHOT_API_KEY-only deployment authenticates at dispatch while the probe
    // reports Kimi locked (the two disagree).
    expect(isProviderEngineCapable('kimi', {} as Env)).toBe(false);
    expect(isProviderEngineCapable('kimi', { MOONSHOT_API_KEY: 'k' } as Env)).toBe(true);
    expect(isProviderEngineCapable('kimi', { KIMI_API_KEY: 'k' } as Env)).toBe(true);
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
      ZAI_API_KEY: 'k',
      KIMI_API_KEY: 'k',
      ZEN_API_KEY: 'k',
      NVIDIA_API_KEY: 'k',
      FIREWORKS_API_KEY: 'k',
      DEEPSEEK_API_KEY: 'k',
      SAKANA_API_KEY: 'k',
      ANTHROPIC_API_KEY: 'k',
      OPENAI_API_KEY: 'k',
      XAI_API_KEY: 'k',
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
    // No key MATERIAL in the response ('worker-secret' as a provenance enum
    // value is fine; the configured key strings are not).
    expect(JSON.stringify(body)).not.toContain('sk-secret-value');
    expect(JSON.stringify(body)).not.toContain('sk-other-secret');
  });

  it('reports credential sources in dispatch-precedence order', async () => {
    const res = await handleProviderEngineCapabilities(makeRequest(), {
      AI: {} as Ai,
      OLLAMA_API_KEY: 'sk-secret-value',
      // anthropic has BOTH a Worker secret and a BYOK listing — BYOK must win,
      // because dispatch omits the auth header for a BYOK provider and the
      // lingering secret is dead weight.
      ANTHROPIC_API_KEY: 'sk-ant-unused',
      CF_AI_GATEWAY_ACCOUNT_ID: 'acc',
      CF_AI_GATEWAY_SLUG: 'push-gate',
      CF_AI_GATEWAY_BYOK: 'anthropic,openai',
    } as Env);
    const body = (await res.json()) as {
      providers: Record<string, boolean>;
      sources: Record<string, string | null>;
      gatewayActive: boolean;
    };
    expect(Object.keys(body.sources).sort()).toEqual([...ALL_PROVIDERS].sort());
    expect(body.sources.anthropic).toBe('gateway-byok');
    expect(body.sources.openai).toBe('gateway-byok');
    expect(body.sources.ollama).toBe('worker-secret');
    expect(body.sources.cloudflare).toBe('binding');
    expect(body.sources.zen).toBeNull();
    // The boolean map and the sources map can't disagree.
    for (const provider of ALL_PROVIDERS) {
      expect(body.providers[provider]).toBe(body.sources[provider] !== null);
    }
    expect(body.gatewayActive).toBe(true);
  });

  it('reports custom-provider BYOK only when dispatch would route it through the gateway', async () => {
    const base = {
      CF_AI_GATEWAY_ACCOUNT_ID: 'acc',
      CF_AI_GATEWAY_SLUG: 'push-gate',
    };
    // Canonical id + custom slug enabled → dispatch routes keyless-through-
    // gateway (isGatewayByokProvider normalizes the custom- prefix, 76f6fdc1).
    let res = await handleProviderEngineCapabilities(makeRequest(), {
      ...base,
      CF_AI_GATEWAY_BYOK: 'ollama',
      CF_AI_GATEWAY_CUSTOM_SLUGS: 'ollama',
    } as Env);
    let body = (await res.json()) as { sources: Record<string, string | null> };
    expect(body.sources.ollama).toBe('gateway-byok');

    // BYOK-listed but custom slug NOT enabled → buildAiGatewayUrl falls back
    // to direct, where a keyless call 401s at the upstream — must not report
    // byok (Codex P2, PR #1380).
    res = await handleProviderEngineCapabilities(makeRequest(), {
      ...base,
      CF_AI_GATEWAY_BYOK: 'ollama',
    } as Env);
    body = (await res.json()) as { sources: Record<string, string | null> };
    expect(body.sources.ollama).toBeNull();

    // First-party bindings have no slug gate — BYOK alone is enough.
    res = await handleProviderEngineCapabilities(makeRequest(), {
      ...base,
      CF_AI_GATEWAY_BYOK: 'openai',
    } as Env);
    body = (await res.json()) as { sources: Record<string, string | null> };
    expect(body.sources.openai).toBe('gateway-byok');
  });

  it('reports gatewayActive false and no BYOK sources when the gateway is unconfigured', async () => {
    const res = await handleProviderEngineCapabilities(makeRequest(), {
      CF_AI_GATEWAY_BYOK: 'anthropic',
    } as Env);
    const body = (await res.json()) as {
      sources: Record<string, string | null>;
      gatewayActive: boolean;
    };
    expect(body.gatewayActive).toBe(false);
    // BYOK-listed but no gateway → not a credential.
    expect(body.sources.anthropic).toBeNull();
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
    const body = (await res.json()) as {
      providers: Record<string, boolean>;
      sources: Record<string, string | null>;
    };
    expect(body.providers.openrouter).toBe(true);
    expect(body.sources.openrouter).toBe('user-key');
    // Providers with neither env nor user key stay false.
    expect(body.providers.nvidia).toBe(false);
    expect(body.sources.nvidia).toBeNull();
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
