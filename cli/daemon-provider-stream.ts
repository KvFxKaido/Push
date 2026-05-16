/**
 * Daemon-side `PushStream` factory.
 *
 * Returns a `PushStream<LlmMessage>` for the lib-side agent roles (explorer,
 * reviewer, auditor, coder, planner) to consume directly. The CLI daemon
 * equivalent of Web's `getProviderPushStream` — same shape, same per-event
 * contract — but uses the CLI's `PROVIDER_CONFIGS` + `resolveApiKey` instead
 * of Web settings.
 *
 * Policy-free on purpose: the factory takes a resolved provider name from
 * the caller (e.g. `handleDelegateExplorer` resolves role routing first),
 * so per-role routing stays out of this module. API keys are resolved
 * lazily on each invocation — `resolveApiKey` throws when the env is not
 * configured, and that throw surfaces as the iterator throwing.
 *
 * Behaviour change vs. the pre-#402-follow-up shim: this no longer wraps
 * `streamCompletion` (which has built-in 3-attempt retries on 429/5xx/
 * network) — the daemon path now matches the web side, which has no
 * automatic retry. Agent-role consumers (iteratePushStreamText) treat
 * transient failures as errors instead of silently re-trying. Symmetric
 * with `app/src/lib/openrouter-stream.ts` and friends.
 */

import type { LlmMessage, PushStream } from '../lib/provider-contract.ts';
import { normalizeReasoning } from '../lib/reasoning-tokens.ts';
import { createProviderStream, PROVIDER_CONFIGS, resolveApiKey } from './provider.js';

export function createDaemonProviderStream(
  provider: string,
  sessionId?: string,
): PushStream<LlmMessage> {
  const config = PROVIDER_CONFIGS[provider];
  if (!config) {
    throw new Error(`Unknown provider "${provider}" — not configured in PROVIDER_CONFIGS`);
  }

  return (req) =>
    (async function* () {
      // Resolve the key per-call so an env-var change between invocations is
      // observed. The throw lands on the consumer's first `.next()` and is
      // caught by the agent role's try/catch around iteratePushStreamText.
      const apiKey = resolveApiKey(config);
      // Route through the shape-aware factory so direct Anthropic / Google
      // delegations use their native adapters instead of the OpenAI-compat
      // path. The factory short-circuits to `createCliProviderStream` for
      // every legacy provider, so this is a no-op for them.
      yield* normalizeReasoning(createProviderStream(config, apiKey, { sessionId })(req));
    })();
}
