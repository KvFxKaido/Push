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
 *   2. its credentials are resolvable server-side (Worker env secret, or the
 *      Workers AI binding for `cloudflare`).
 *
 * Providers configured only via in-app Settings keys (browser-held, forwarded
 * per-request by the foreground loop) fail an engine-routed turn instantly
 * with the provider's `keyMissingError` — the client uses this map to keep
 * those turns on the foreground loop instead (see
 * `app/src/lib/provider-engine-capability.ts`).
 *
 * The response is booleans only — never key material, never key shape.
 *
 * Drift note: the env-key names here mirror each handler's
 * `standardAuth('<KEY>')` literal in `worker-providers.ts` (and
 * `buildAnthropicAuth` / `buildGoogleAuth`). The provider SET is pinned to
 * `resolveProviderHandler` by the unit test; the key-name literals are
 * load-bearing copies — change them in lockstep.
 */

import type { AIProviderType } from '@push/lib/provider-contract';
import { resolveProviderHandler } from './coder-job-stream-adapter';
import type { Env } from './worker-middleware';

/** Every member of `AIProviderType`, for exhaustive map construction. */
export const ALL_PROVIDERS: readonly AIProviderType[] = [
  'ollama',
  'openrouter',
  'cloudflare',
  'zen',
  'nvidia',
  'blackbox',
  'azure',
  'kilocode',
  'openadapter',
  'bedrock',
  'vertex',
  'anthropic',
  'openai',
  'google',
  'demo',
] as const;

/**
 * Server-side credential presence per provider. `cloudflare` authenticates via
 * the Workers AI binding rather than a secret; providers absent from the
 * env-key table (azure/bedrock/vertex/demo) are unreachable from the DO anyway
 * (`resolveProviderHandler` returns null), so their credential answer never
 * matters — report false.
 */
const PROVIDER_ENV_KEY: Partial<Record<AIProviderType, keyof Env>> = {
  ollama: 'OLLAMA_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  zen: 'ZEN_API_KEY',
  nvidia: 'NVIDIA_API_KEY',
  blackbox: 'BLACKBOX_API_KEY',
  kilocode: 'KILOCODE_API_KEY',
  openadapter: 'OPENADAPTER_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
};

function hasServerCredentials(provider: AIProviderType, env: Env): boolean {
  if (provider === 'cloudflare') return Boolean(env.AI);
  const envKey = PROVIDER_ENV_KEY[provider];
  if (!envKey) return false;
  return Boolean(env[envKey]);
}

/** True when an engine-routed (server-side) turn can run on this provider. */
export function isProviderEngineCapable(provider: AIProviderType, env: Env): boolean {
  // zenGo only changes which Zen endpoint is hit — same key, same handler
  // family — so the plain resolution answers for both.
  return resolveProviderHandler(provider, false) !== null && hasServerCredentials(provider, env);
}

export interface ProviderEngineCapabilities {
  providers: Record<AIProviderType, boolean>;
}

/**
 * GET /api/providers/engine-capabilities — the full per-provider map in one
 * round trip. `no-store` so a secret rotation is visible on the next fetch
 * rather than a cache TTL later.
 */
export async function handleProviderEngineCapabilities(
  _request: Request,
  env: Env,
): Promise<Response> {
  const providers = Object.fromEntries(
    ALL_PROVIDERS.map((provider) => [provider, isProviderEngineCapable(provider, env)]),
  ) as Record<AIProviderType, boolean>;
  const body: ProviderEngineCapabilities = { providers };
  return Response.json(body, { headers: { 'Cache-Control': 'no-store' } });
}
