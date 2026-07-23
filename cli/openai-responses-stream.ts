/**
 * CLI OpenAI Responses PushStream.
 *
 * Chat-Completions CLI providers keep using `cli/openai-stream.ts`. This file
 * serves every provider whose definition declares `streamShape:
 * 'openai-responses'` — direct OpenAI plus the OpenAI-compatible Responses
 * gateways (OpenRouter, Sakana, Fireworks) — speaking the `/v1/responses`
 * contract against `config.url`.
 */

import process from 'node:process';
import type {
  LlmMessage,
  PushStream,
  PushStreamEvent,
  PushStreamRequest,
} from '../lib/provider-contract.ts';
import { toOpenAIResponses } from '../lib/openai-responses-serializer.ts';
import { openAIResponsesSSEPump } from '../lib/openai-responses-sse-pump.ts';
import {
  OPENROUTER_PARAMETER_EVENTS,
  fetchOpenRouterWithStructuredOutputFallback,
  scopeOpenRouterRequiredParameters,
} from '../lib/openrouter-parameters.ts';
import { OPENROUTER_MAX_SESSION_ID_LENGTH } from '../lib/provider-models.ts';
import { isGeminiModelId } from '../lib/gemini-thought-signature.ts';
import { parseResponsesReasoningItem } from '../lib/responses-reasoning-item.ts';
import type { ProviderConfig } from './provider.ts';
import { CliProviderError, type CliProviderStreamOptions } from './openai-stream.ts';

const OPENROUTER_WEB_SEARCH_TOOL = { type: 'openrouter:web_search' } as const;

function resolveOpenRouterWebSearch(req: PushStreamRequest<LlmMessage>): boolean {
  if (typeof req.openrouterWebSearch === 'boolean') return req.openrouterWebSearch;
  const env = process.env.PUSH_OPENROUTER_WEB_SEARCH?.trim().toLowerCase();
  if (!env) return true;
  return !(env === '0' || env === 'false' || env === 'no' || env === 'off');
}

export function createCliOpenAIResponsesStream(
  config: ProviderConfig,
  apiKey: string,
  options: CliProviderStreamOptions = {},
): PushStream<LlmMessage> {
  return (req: PushStreamRequest<LlmMessage>): AsyncIterable<PushStreamEvent> =>
    cliOpenAIResponsesStream(config, apiKey, options, req);
}

async function* cliOpenAIResponsesStream(
  config: ProviderConfig,
  apiKey: string,
  options: CliProviderStreamOptions,
  req: PushStreamRequest<LlmMessage>,
): AsyncIterable<PushStreamEvent> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (config.id === 'openrouter') {
    headers['HTTP-Referer'] = process.env.PUSH_OPENROUTER_REFERER || 'https://push.local';
    headers['X-Title'] = 'Push CLI';
  }

  const model = req.model && req.model.trim() ? req.model : config.defaultModel;
  const baseBody = toOpenAIResponses(req, {
    modelOverride: model,
    temperatureDefault: 0.1,
    geminiThoughtSignatureFallback:
      config.id === 'openrouter' &&
      Array.isArray(req.tools) &&
      req.tools.length > 0 &&
      isGeminiModelId(model),
    encryptedReasoningReplay: config.id === 'openrouter',
  }) as unknown as Record<string, unknown>;
  const responseTools = Array.isArray(baseBody.tools)
    ? [...(baseBody.tools as Record<string, unknown>[])]
    : [];
  const openRouterWebSearch = config.id === 'openrouter' && resolveOpenRouterWebSearch(req);
  const openRouterTools = [
    ...responseTools,
    ...(openRouterWebSearch ? [OPENROUTER_WEB_SEARCH_TOOL] : []),
  ];
  // OpenRouter's routing guard is all-or-nothing. The shared scoper omits only
  // redundant auto tool choice; it deliberately preserves the CLI's temperature
  // and any explicit top_p. A routing rejection gets one adjusted retry without
  // structured output below, while native tools remain hard.
  const openRouterRequireParameters = responseTools.length > 0 || Boolean(baseBody.text);

  const body =
    config.id === 'openrouter'
      ? scopeOpenRouterRequiredParameters(
          {
            ...baseBody,
            ...(options.sessionId
              ? { session_id: options.sessionId.slice(0, OPENROUTER_MAX_SESSION_ID_LENGTH) }
              : {}),
            ...(openRouterTools.length > 0 ? { tools: openRouterTools } : {}),
            trace: { generation_name: 'push-cli-responses', trace_name: 'push-cli' },
          },
          openRouterRequireParameters,
        )
      : baseBody;

  let response: Response;
  let errorBody: string | null = null;
  if (config.id === 'openrouter') {
    const result = await fetchOpenRouterWithStructuredOutputFallback({
      body,
      transport: 'responses',
      requireParameters: openRouterRequireParameters,
      requireParametersAfterRelaxation: responseTools.length > 0,
      attempt: (attemptBody) =>
        fetch(config.url, {
          method: 'POST',
          headers,
          body: JSON.stringify(attemptBody),
          signal: req.signal,
        }),
      onRelaxed: () => {
        // stderr: CLI stdout is the user/--json channel.
        console.error(
          JSON.stringify({
            level: 'warn',
            event: OPENROUTER_PARAMETER_EVENTS.structuredOutputRelaxed,
            reason: 'routing_constraint',
            model,
            transport: 'responses',
            droppedParameter: 'response_format',
            wireField: 'text.format',
          }),
        );
      },
    });
    response = result.response;
    errorBody = result.errorBody;
  } else {
    response = await fetch(config.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: req.signal,
    });
  }

  if (!response.ok) {
    const errBody = errorBody ?? (await response.text().catch(() => '(no body)'));
    throw new CliProviderError(
      `Provider error ${response.status} [provider=${config.id} model=${model} url=${config.url}]: ${errBody.slice(0, 400)}`,
      response.status,
    );
  }

  if (!response.body) {
    type FallbackBody = {
      output_text?: string;
      output?: Array<{
        type?: string;
        content?: Array<{ type?: string; text?: string }>;
        [key: string]: unknown;
      }>;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        total_tokens?: number;
        input_tokens_details?: { cached_tokens?: number };
      };
    } | null;
    let fallback: FallbackBody = null;
    try {
      fallback = (await response.json()) as FallbackBody;
    } catch {
      /* empty / non-JSON body */
    }
    for (const outputItem of fallback?.output ?? []) {
      const reasoningItem = parseResponsesReasoningItem(outputItem);
      if (reasoningItem) {
        yield { type: 'responses_reasoning_item', item: reasoningItem };
      }
    }
    const text =
      fallback?.output_text ??
      fallback?.output
        ?.flatMap((item) => item.content ?? [])
        .filter((part) => part.type === 'output_text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('') ??
      '';
    if (text) {
      yield { type: 'text_delta', text };
    }
    yield { type: 'done', finishReason: 'stop' };
    return;
  }

  yield* openAIResponsesSSEPump({ body: response.body, signal: req.signal });
}
