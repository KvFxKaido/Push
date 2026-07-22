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
import { OPENROUTER_MAX_SESSION_ID_LENGTH } from '../lib/provider-models.ts';
import { isGeminiModelId } from '../lib/gemini-thought-signature.ts';
import { parseResponsesReasoningItem } from '../lib/responses-reasoning-item.ts';
import { isOpenRouterRoutingConstraintBody } from '../lib/responses-chat-fallback.ts';
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
  const openRouterRequireParameters = responseTools.length > 0 || Boolean(baseBody.text);

  const body =
    config.id === 'openrouter'
      ? {
          ...baseBody,
          ...(options.sessionId
            ? { session_id: options.sessionId.slice(0, OPENROUTER_MAX_SESSION_ID_LENGTH) }
            : {}),
          ...(openRouterTools.length > 0 ? { tools: openRouterTools } : {}),
          ...(openRouterRequireParameters ? { provider: { require_parameters: true } } : {}),
          trace: { generation_name: 'push-cli-responses', trace_name: 'push-cli' },
        }
      : baseBody;

  const response = await fetch(config.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: req.signal,
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '(no body)');
    throw new CliProviderError(
      `Provider error ${response.status} [provider=${config.id} model=${model} url=${config.url}]: ${errBody.slice(0, 400)}`,
      response.status,
      {
        // Only a rejection of a constraint WE pinned is deterministic; otherwise this
        // message means the model has no /responses endpoint and chat is the recovery.
        openRouterRoutingConstraint:
          openRouterRequireParameters && isOpenRouterRoutingConstraintBody(errBody),
      },
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
