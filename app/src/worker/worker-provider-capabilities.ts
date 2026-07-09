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
 * The response is booleans and provenance enums only — never key material,
 * never key shape. `sources` reports WHERE each provider's credential resolves
 * from (in dispatch-precedence order: gateway BYOK, then Worker secret /
 * binding, then user-stored key) so Settings can render the truth instead of
 * inferring unlock state from localStorage. The answer is per-identity
 * (session-resolved), which is why the handler resolves the caller before
 * building the map.
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
import { isCustomGatewaySlugEnabled, isGatewayByokProvider } from './worker-middleware';

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

/**
 * Gateway binding provider strings, mirroring each handler's `gateway:`
 * binding in `worker-providers.ts` — the BYOK env list matches against THESE
 * (e.g. `custom-ollama`), not the plain provider id, because that's what the
 * handlers pass to `isGatewayByokProvider` at dispatch (Codex P2, PR #1380).
 * `kilocode` has no binding (dropped — egress-discriminating origin), so BYOK
 * can never apply to it. Load-bearing copies like PROVIDER_ENV_KEY above —
 * change in lockstep with the handlers.
 */
const GATEWAY_BINDING_PROVIDER: Partial<Record<AIProviderType, string>> = {
  ollama: 'custom-ollama',
  openrouter: 'openrouter',
  zen: 'custom-zen',
  nvidia: 'custom-nvidia',
  fireworks: 'custom-fireworks',
  deepseek: 'deepseek',
  sakana: 'custom-sakana',
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google',
};

/**
 * True when a keyless dispatch on this provider would ACTUALLY route through
 * the gateway with an injected key. Three conditions, all mirroring dispatch:
 * the provider has a gateway binding, that binding is BYOK-listed, and — for
 * `custom-*` bindings — the custom slug is enabled (an unlisted custom binding
 * makes `buildAiGatewayUrl` fall back to direct, where a keyless call 401s
 * at the upstream).
 */
function isByokDispatchable(provider: AIProviderType, env: Env): boolean {
  const binding = GATEWAY_BINDING_PROVIDER[provider];
  if (!binding) return false;
  return isGatewayByokProvider(env, binding) && isCustomGatewaySlugEnabled(env, binding);
}

/**
 * Which server-resolvable credential (if any) a provider would dispatch with,
 * in dispatch-precedence order. BYOK outranks a Worker secret deliberately:
 * when a provider is BYOK-listed, handlers omit the auth header entirely and
 * the gateway injects its stored key — a lingering Worker secret (or user key)
 * is dead weight, and reporting it as the source would misrepresent dispatch.
 */
function resolveEnvCredentialSource(
  provider: AIProviderType,
  env: Env,
): ProviderCredentialSource | null {
  if (provider === 'cloudflare') return env.AI ? 'binding' : null;
  // BYOK: the provider's key lives in the gateway, which injects it — so a
  // server-side turn can run with no Worker secret. Treat it as credentialed
  // even when the env key is absent (that's the whole point of retiring it).
  if (isByokDispatchable(provider, env)) return 'gateway-byok';
  const envKey = PROVIDER_ENV_KEY[provider];
  if (!envKey) return null;
  return env[envKey] ? 'worker-secret' : null;
}

function hasEnvCredentials(provider: AIProviderType, env: Env): boolean {
  return resolveEnvCredentialSource(provider, env) !== null;
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

/**
 * Where a provider's credential resolves from, mirroring dispatch precedence:
 * `gateway-byok` (key stored in the AI Gateway, injected there — any client or
 * Worker key is ignored), `binding` (Workers AI), `worker-secret` (env),
 * `user-key` (identity-keyed store / browser key), or null (no credential —
 * the provider is locked until a key is added).
 */
export type ProviderCredentialSource = 'gateway-byok' | 'binding' | 'worker-secret' | 'user-key';

export interface ProviderEngineCapabilities {
  providers: Record<AIProviderType, boolean>;
  sources: Record<AIProviderType, ProviderCredentialSource | null>;
  /** True when the AI Gateway is configured (account + slug) and routing. */
  gatewayActive: boolean;
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
    ALL_PROVIDERS.map(
      async (provider): Promise<[AIProviderType, ProviderCredentialSource | null]> => {
        if (resolveProviderHandler(provider, false) === null) return [provider, null];
        const envSource = resolveEnvCredentialSource(provider, env);
        if (envSource !== null) return [provider, envSource];
        // User-key arm resolves through the SAME path dispatch uses
        // (getUserProviderKey: secret present + decryptable), not metadata
        // presence — a rotated/missing PUSH_SESSION_SECRET must read as
        // not-capable here, or the client routes turns into a guaranteed
        // 401 (Codex P2, PR #890). Metadata short-circuits the decrypt for
        // the common no-key case.
        if (!userKeys[provider]) return [provider, null];
        const key = await getUserProviderKey(env, identity.userId, provider);
        return [provider, key !== null ? 'user-key' : null];
      },
    ),
  );
  const providers = Object.fromEntries(
    entries.map(([provider, source]) => [provider, source !== null]),
  ) as Record<AIProviderType, boolean>;
  const sources = Object.fromEntries(entries) as Record<
    AIProviderType,
    ProviderCredentialSource | null
  >;
  const body: ProviderEngineCapabilities = {
    providers,
    sources,
    gatewayActive: Boolean(env.CF_AI_GATEWAY_ACCOUNT_ID?.trim() && env.CF_AI_GATEWAY_SLUG?.trim()),
  };
  return Response.json(body, { headers: { 'Cache-Control': 'no-store' } });
}
