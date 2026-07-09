/**
 * worker-provider-capabilities.ts — per-provider "can the durable engine
 * dispatch this?" probe.
 *
 * Engine-routed turns (inline delegation default, background mode, durable-run
 * adoption) run the model loop server-side in a DO, where provider calls carry
 * NO client `Authorization` header — credential provisioning is out-of-band by
 * design (see `coder-job-stream-adapter.ts` / `run-host-adoption-runner.ts`).
 * So a provider is engine-capable only when BOTH hold:
 *
 *   1. the DO can dispatch it directly (`resolveProviderHandler` non-null), and
 *   2. its credentials are resolvable server-side: a Worker env secret, the
 *      Workers AI binding for `cloudflare`, or a user-stored key in the
 *      identity-keyed secrets store (`user-secrets.ts`) — the same store the
 *      DO injects from at dispatch, so this probe and the dispatch path can't
 *      disagree about which credentials exist.
 *
 * Providers with NO server-resolvable credentials fail an engine-routed turn
 * instantly with the provider's `keyMissingError` — the client uses this map
 * to keep those turns on the foreground loop instead (see
 * `app/src/lib/provider-engine-capability.ts`).
 *
 * The response is booleans only — never key material, never key shape. The
 * answer is per-identity (session-resolved), which is why the handler resolves
 * the caller before building the map.
 *
 * Drift note: the env-key names here mirror each handler's
 * `standardAuth('<KEY>')` literal in `worker-providers.ts` (and
 * `buildAnthropicAuth` / `buildGoogleAuth`). The provider SET is pinned to
 * `resolveProviderHandler` by the unit test; the key-name literals are
 * load-bearing copies — change them in lockstep.
 */

import { ALL_PROVIDERS, type AIProviderType } from '@push/lib/provider-contract';
import { resolveProviderHandler } from './coder-job-stream-adapter';
import { resolveSettingsUserId } from './settings-config';
import { getUserProviderKey, listUserProviderKeyMeta } from './user-secrets';
import type { Env } from './worker-middleware';
import { isGatewayByokProvider } from './worker-middleware';

// Re-exported for existing importers; the canonical home moved to the shared
// provider contract so user-secrets.ts can validate without an import cycle.
export { ALL_PROVIDERS };

/**
 * Server-side credential presence per provider. `cloudflare` authenticates via
 * the Workers AI binding rather than a secret; providers absent from the
 * env-key table (e.g. `demo`) are unreachable from the DO anyway
 * (`resolveProviderHandler` returns null), so their credential answer never
 * matters — report false.
 */
const PROVIDER_ENV_KEY: Partial<Record<AIProviderType, keyof Env>> = {
  ollama: 'OLLAMA_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  zen: 'ZEN_API_KEY',
  nvidia: 'NVIDIA_API_KEY',
  kilocode: 'KILOCODE_API_KEY',
  fireworks: 'FIREWORKS_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  sakana: 'SAKANA_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
};

function hasEnvCredentials(provider: AIProviderType, env: Env): boolean {
  if (provider === 'cloudflare') return Boolean(env.AI);
  // BYOK: the provider's key lives in the gateway, which injects it — so a
  // server-side turn can run with no Worker secret. Treat it as credentialed
  // even when the env key is absent (that's the whole point of retiring it).
  if (isGatewayByokProvider(env, provider)) return true;
  const envKey = PROVIDER_ENV_KEY[provider];
  if (!envKey) return false;
  return Boolean(env[envKey]);
}

/**
 * True when an engine-routed (server-side) turn can run on this provider with
 * Worker-env credentials alone. The identity-aware answer (env OR user-stored
 * key) lives in the handler; this sync form serves callers with no request
 * context (e.g. the PR-review DO's env-only dispatch).
 */
export function isProviderEngineCapable(provider: AIProviderType, env: Env): boolean {
  // zenGo only changes which Zen endpoint is hit — same key, same handler
  // family — so the plain resolution answers for both.
  return resolveProviderHandler(provider, false) !== null && hasEnvCredentials(provider, env);
}

export interface ProviderEngineCapabilities {
  providers: Record<AIProviderType, boolean>;
}

/**
 * GET /api/providers/engine-capabilities — the full per-provider map in one
 * round trip, for the session-resolved caller. `no-store` so a secret
 * rotation or a just-saved user key is visible on the next fetch rather than
 * a cache TTL later.
 */
export async function handleProviderEngineCapabilities(
  request: Request,
  env: Env,
): Promise<Response> {
  const identity = await resolveSettingsUserId(request, env);
  const userKeys = await listUserProviderKeyMeta(env, identity.userId);
  const entries = await Promise.all(
    ALL_PROVIDERS.map(async (provider): Promise<[AIProviderType, boolean]> => {
      if (resolveProviderHandler(provider, false) === null) return [provider, false];
      if (hasEnvCredentials(provider, env)) return [provider, true];
      // User-key arm resolves through the SAME path dispatch uses
      // (getUserProviderKey: secret present + decryptable), not metadata
      // presence — a rotated/missing PUSH_SESSION_SECRET must read as
      // not-capable here, or the client routes turns into a guaranteed
      // 401 (Codex P2, PR #890). Metadata short-circuits the decrypt for
      // the common no-key case.
      if (!userKeys[provider]) return [provider, false];
      const key = await getUserProviderKey(env, identity.userId, provider);
      return [provider, key !== null];
    }),
  );
  const providers = Object.fromEntries(entries) as Record<AIProviderType, boolean>;
  const body: ProviderEngineCapabilities = { providers };
  return Response.json(body, { headers: { 'Cache-Control': 'no-store' } });
}
