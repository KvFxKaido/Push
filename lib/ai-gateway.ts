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
 * (scripts/eval/run-evals.ts) is the backstop that turns that silent gap
 * into a hard error at eval start.
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
