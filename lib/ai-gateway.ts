/**
 * Cloudflare AI Gateway request hygiene, shared by every surface that can
 * send provider traffic through a gateway route.
 *
 * Posture (#1554, decided in #1573): response caching stays ENABLED in the
 * gateway config, and every Push runtime path bypasses it per-request with
 * `cf-aig-skip-cache: true`. Push request bodies almost never legitimately
 * repeat, so the response cache would serve only the traffic it harms —
 * repeated-prompt evals and BYOK probes, where a byte-identical edge replay
 * (`cf-aig-cache-status: HIT`, ~40ms, $0, no token usage) silently poisons
 * the measurement.
 *
 * The Worker seams (#1573) inject the header where they BUILD the gateway
 * URL (`buildAiGatewayUrl` et al.) — authoritative, no detection needed.
 * The CLI's provider URL is user-supplied config, so its transports detect
 * the gateway host here instead. A gateway fronted by a custom domain
 * evades host detection by construction; the eval harness preflight
 * (scripts/eval/run-evals.ts) backstops that gap — but only while the
 * front forwards the standard `cf-aig-cache-status` header. A front that
 * strips it is beyond header-based detection entirely: point evals at the
 * canonical host to get the preflight's strict verification tier.
 */

/** Host serving Cloudflare AI Gateway provider-native routes. */
export const AI_GATEWAY_HOST = 'gateway.ai.cloudflare.com';

export function isAiGatewayUrl(url: string): boolean {
  try {
    return new URL(url).hostname === AI_GATEWAY_HOST;
  } catch {
    return false;
  }
}

/**
 * The per-request cache bypass for gateway routes; empty for every other
 * URL so non-gateway providers never see an unexplained `cf-aig-*` header.
 */
export function aiGatewaySkipCacheHeaders(url: string): Record<string, string> {
  return isAiGatewayUrl(url) ? { 'cf-aig-skip-cache': 'true' } : {};
}

/**
 * Every gateway header a direct-fetch transport (the CLI) needs for `url`: the
 * cache bypass, plus `cf-aig-authorization` for an authenticated gateway when
 * `env` carries `CF_AI_GATEWAY_TOKEN`. Empty for non-gateway URLs, so the token
 * never leaves for a provider.
 */
export function aiGatewayRequestHeaders(
  url: string,
  env: { CF_AI_GATEWAY_TOKEN?: string },
): Record<string, string> {
  if (!isAiGatewayUrl(url)) return {};
  const token = env.CF_AI_GATEWAY_TOKEN?.trim();
  return {
    'cf-aig-skip-cache': 'true',
    ...(token ? { 'cf-aig-authorization': `Bearer ${token}` } : {}),
  };
}

// ---------------------------------------------------------------------------
// Gateway routing core, shared by the Worker and the CLI. Both read the same
// `CF_AI_GATEWAY_*` names (Worker env bindings; CLI process env), so this takes
// any record carrying them. Everything is a no-op until account + slug are set,
// so direct-to-provider traffic stays bit-identical without a gateway.
// ---------------------------------------------------------------------------

export interface AiGatewayEnv {
  CF_AI_GATEWAY_ACCOUNT_ID?: string;
  CF_AI_GATEWAY_SLUG?: string;
  /** Authenticated gateways: sent as `cf-aig-authorization`. */
  CF_AI_GATEWAY_TOKEN?: string;
  /** Custom (`custom-{slug}`) providers enabled on the gateway, comma-separated. */
  CF_AI_GATEWAY_CUSTOM_SLUGS?: string;
  /** Providers whose key the gateway holds (BYOK), comma-separated. */
  CF_AI_GATEWAY_BYOK?: string;
}

export interface AiGatewayBinding {
  /** Gateway provider slug (e.g. `openrouter`). Forms the path segment after the gateway id. */
  provider: string;
  /** Path appended after the provider slug, e.g. `/chat/completions`. Includes the leading slash. */
  pathSuffix: string;
}

function csv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * First-party gateway providers (e.g. `openai`, `anthropic`) are always eligible
 * once the gateway env is set. A **custom** provider (`custom-{slug}`) is not: the
 * `custom-{slug}` path 404s unless that provider has been registered + enabled on
 * the gateway, so it must opt in per-slug via `CF_AI_GATEWAY_CUSTOM_SLUGS` rather
 * than ride the global CF_AI_GATEWAY_* toggle (already set in prod). An unlisted
 * custom binding returns false here and `buildAiGatewayUrl` falls back to direct.
 */
export function isCustomGatewaySlugEnabled(env: AiGatewayEnv, provider: string): boolean {
  const CUSTOM_PREFIX = 'custom-';
  if (!provider.startsWith(CUSTOM_PREFIX)) return true;
  return csv(env.CF_AI_GATEWAY_CUSTOM_SLUGS).includes(provider.slice(CUSTOM_PREFIX.length));
}

/**
 * Returns the AI-Gateway-rewritten upstream URL when the gateway is configured,
 * or `null` when callers should fall back to the direct provider URL.
 */
export function buildAiGatewayUrl(env: AiGatewayEnv, binding: AiGatewayBinding): string | null {
  const account = env.CF_AI_GATEWAY_ACCOUNT_ID?.trim();
  const slug = env.CF_AI_GATEWAY_SLUG?.trim();
  if (!account || !slug) return null;
  if (!isCustomGatewaySlugEnabled(env, binding.provider)) return null;
  return `https://${AI_GATEWAY_HOST}/v1/${account}/${slug}/${binding.provider}${binding.pathSuffix}`;
}

/**
 * True when `providerId`'s key lives in the AI Gateway (BYOK) rather than being
 * sent by Push. Requires the gateway to be configured — a BYOK provider with no
 * gateway would have nothing to inject the key, so we keep sending the caller
 * key in that case. Callers that see `true` must route through the gateway and
 * omit the provider auth header (the gateway injects the stored key).
 */
export function isGatewayByokProvider(env: AiGatewayEnv, providerId: string): boolean {
  if (!env.CF_AI_GATEWAY_ACCOUNT_ID?.trim() || !env.CF_AI_GATEWAY_SLUG?.trim()) return false;
  // A custom provider reaches here two ways: as the gateway binding slug
  // (`custom-sakana`) from the handler, and as the bare id (`sakana`) from the
  // engine-capability check. Normalize to the bare id so CF_AI_GATEWAY_BYOK
  // lists one canonical name per provider and both call sites agree.
  const id = providerId.startsWith('custom-') ? providerId.slice('custom-'.length) : providerId;
  return csv(env.CF_AI_GATEWAY_BYOK).includes(id);
}

/**
 * Returns the value for the `cf-aig-authorization` header when
 * `CF_AI_GATEWAY_TOKEN` is set, otherwise `null`. Independent of account/slug
 * presence — callers should only attach the header when the request is
 * actually being routed through the gateway (i.e. `buildAiGatewayUrl` returned
 * a non-null URL), so an orphan token never leaks to the direct provider.
 */
export function getAiGatewayAuthHeader(env: AiGatewayEnv): string | null {
  const token = env.CF_AI_GATEWAY_TOKEN?.trim();
  return token ? `Bearer ${token}` : null;
}

/**
 * Resolve where a provider request goes: the gateway URL plus its headers when
 * the binding routes, else the direct URL with none. `byok` is only true when
 * the request ACTUALLY routes through the gateway — a BYOK-listed custom binding
 * whose slug isn't enabled falls back to the direct URL, where a keyless call
 * 401s, so callers must keep sending the key in that case.
 */
export function resolveAiGatewayFetchTarget(
  env: AiGatewayEnv,
  directUrl: string,
  gateway?: AiGatewayBinding,
): { upstreamUrl: string; gatewayHeaders: Record<string, string>; byok: boolean } {
  const gatewayUrl = gateway ? buildAiGatewayUrl(env, gateway) : null;
  const aigAuth = gatewayUrl ? getAiGatewayAuthHeader(env) : null;
  return {
    upstreamUrl: gatewayUrl ?? directUrl,
    gatewayHeaders: gatewayUrl
      ? {
          'cf-aig-skip-cache': 'true',
          ...(aigAuth ? { 'cf-aig-authorization': aigAuth } : {}),
        }
      : {},
    byok: gatewayUrl !== null && gateway ? isGatewayByokProvider(env, gateway.provider) : false,
  };
}

/**
 * BYOK is only safe to act on (omit the provider auth header, skip the
 * key-missing fallback) when a keyless call would ACTUALLY route through the
 * gateway AND the provider is BYOK-listed. `gatewaySlug` is the CF gateway
 * binding string, which differs from the canonical BYOK id for google
 * (`google-ai-studio` vs `google`).
 */
export function gatewayByokActive(
  env: AiGatewayEnv,
  byokId: string,
  gatewaySlug: string = byokId,
): boolean {
  return (
    buildAiGatewayUrl(env, { provider: gatewaySlug, pathSuffix: '' }) !== null &&
    isGatewayByokProvider(env, byokId)
  );
}
