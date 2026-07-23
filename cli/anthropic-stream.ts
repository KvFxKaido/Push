/**
 * CLI native-Anthropic PushStream.
 *
 * Calls `https://api.anthropic.com/v1/messages` directly with `x-api-key`,
 * builds the Messages-API body straight from the neutral `PushStreamRequest`
 * via `toAnthropicMessages` (no OpenAI Chat-Completions intermediate — see
 * `docs/runbooks/Provider Request Normalization.md`), then parses the upstream
 * Anthropic SSE directly into neutral `PushStreamEvent`s via
 * `anthropicEventStream` (no OpenAI-SSE serialize/reparse round-trip). Every web
 * Anthropic-Messages route now uses this same native pump — the direct Anthropic
 * provider plus the multiplexed Zen-Go routes (their Workers proxy the raw
 * upstream SSE) — so the OpenAI-SSE translator is fully retired.
 *
 * Shape mirrors the Worker's `handleAnthropicChat`: build body, POST,
 * translate response, yield events. Difference vs the Worker version: the CLI
 * has no preamble / rate-limit preflight, and the API key is read from
 * `process.env` (or passed in) rather than from a Worker secret.
 *
 * Reasoning blocks ride through verbatim. When `LlmMessage.reasoningBlocks`
 * is populated on an assistant turn (typically by a lib-side agent role that
 * captured them from a prior `reasoning_block` event), `toAnthropicMessages`
 * re-emits them as the FIRST entries of the upstream assistant `content[]` so
 * signed thinking round-trips across chained turns. Without this, Anthropic +
 * extended-thinking + tool-use combinations 400 on the second turn with
 * `invalid_request_error`.
 *
 * Prompt caching: when `req.cacheBreakpointIndices` is set, the system message
 * + indicated tail messages get tagged with `cache_control: { type:
 * 'ephemeral' }`, hard-capped at the wire layer so direct-Anthropic CLI
 * sessions get the same Hermes `system_and_3` prefix caching the
 * OpenRouter-Anthropic CLI path already has.
 *
 * Sampling: `temperature` defaults to 0.1, but `toAnthropicMessages` strips it
 * (and `top_p`) on Opus 4.7+, which removed those parameters and 400s if sent.
 */

import type {
  LlmMessage,
  PushStream,
  PushStreamEvent,
  PushStreamRequest,
} from '../lib/provider-contract.ts';
import { aiGatewaySkipCacheHeaders } from '../lib/ai-gateway.ts';
import { anthropicEventStream, toAnthropicMessages } from '../lib/anthropic-bridge.ts';
import { continueAnthropicPauseTurns } from '../lib/anthropic-pause-continuation.ts';
import { CliProviderError } from './openai-stream.ts';
import type { ProviderConfig } from './provider.ts';

const ANTHROPIC_API_VERSION = '2023-06-01';

/** Per-request flag wins; otherwise Anthropic's native `web_search_20250305`
 *  tool defaults ON so Claude CLI chats search the web without an opt-in
 *  step (parity with the web app's `'auto'` web-search mode). Set
 *  `PUSH_ANTHROPIC_WEB_SEARCH=0` (or `false`/`no`/`off`) to disable. */
function resolveAnthropicWebSearch(
  req: PushStreamRequest<LlmMessage>,
  config: ProviderConfig,
): boolean {
  if (typeof req.anthropicWebSearch === 'boolean') return req.anthropicWebSearch;
  // Only the real Anthropic provider defaults web search on. Other providers on
  // the Anthropic transport (e.g. `deepseek` via api.deepseek.com/anthropic)
  // don't offer Anthropic's server-side `web_search_20250305` tool, so sending
  // it would be rejected/ignored — default off for them.
  if (config.id !== 'anthropic') return false;
  const env = process.env.PUSH_ANTHROPIC_WEB_SEARCH?.trim().toLowerCase();
  if (!env) return true;
  return !(env === '0' || env === 'false' || env === 'no' || env === 'off');
}

export function createCliAnthropicStream(
  config: ProviderConfig,
  apiKey: string,
): PushStream<LlmMessage> {
  return (req: PushStreamRequest<LlmMessage>): AsyncIterable<PushStreamEvent> =>
    cliAnthropicStream(config, apiKey, req);
}

async function* cliAnthropicStream(
  config: ProviderConfig,
  apiKey: string,
  req: PushStreamRequest<LlmMessage>,
): AsyncIterable<PushStreamEvent> {
  const model = req.model && req.model.trim() ? req.model : config.defaultModel;
  const enableWebSearch = resolveAnthropicWebSearch(req, config);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': ANTHROPIC_API_VERSION,
  };
  if (apiKey) headers['x-api-key'] = apiKey;
  Object.assign(headers, aiGatewaySkipCacheHeaders(config.url));

  // Transport and serializer stay CLI-local; the replay state machine is
  // shared with the web Anthropic family so cap/ordering/empty-block behavior
  // cannot drift between shells.
  yield* continueAnthropicPauseTurns({
    baseBody: {},
    runAttempt: async function* ({ replayAssistantTurns }) {
      const upstreamBody = JSON.stringify(
        toAnthropicMessages(req, {
          modelOverride: model,
          enableWebSearch,
          temperatureDefault: 0.1,
          replayAssistantTurns,
        }),
      );

      const response = await fetch(config.url, {
        method: 'POST',
        headers,
        body: upstreamBody,
        signal: req.signal,
      });

      if (!response.ok) {
        const errBody = await response.text().catch(() => '(no body)');
        throw new CliProviderError(
          `Provider error ${response.status} [provider=${config.id} model=${model} url=${config.url}]: ${errBody.slice(0, 400)}`,
          response.status,
        );
      }

      if (!response.body) {
        yield { type: 'done', finishReason: 'stop' };
        return;
      }

      yield* anthropicEventStream(response, req.signal);
    },
  });
}
