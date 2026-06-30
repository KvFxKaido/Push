/**
 * CLI OpenAI Responses PushStream.
 *
 * Chat-Completions CLI providers keep using `cli/openai-stream.ts`. This file
 * serves every provider whose definition declares `streamShape:
 * 'openai-responses'` — direct OpenAI plus the OpenAI-compatible Responses
 * gateways (Sakana, Fireworks) — speaking the `/v1/responses` contract against
 * `config.url`.
 */

import type {
  LlmMessage,
  PushStream,
  PushStreamEvent,
  PushStreamRequest,
} from '../lib/provider-contract.ts';
import { toOpenAIResponses } from '../lib/openai-responses-serializer.ts';
import { openAIResponsesSSEPump } from '../lib/openai-responses-sse-pump.ts';
import type { ProviderConfig } from './provider.ts';
import { CliProviderError } from './openai-stream.ts';

export function createCliOpenAIResponsesStream(
  config: ProviderConfig,
  apiKey: string,
): PushStream<LlmMessage> {
  return (req: PushStreamRequest<LlmMessage>): AsyncIterable<PushStreamEvent> =>
    cliOpenAIResponsesStream(config, apiKey, req);
}

async function* cliOpenAIResponsesStream(
  config: ProviderConfig,
  apiKey: string,
  req: PushStreamRequest<LlmMessage>,
): AsyncIterable<PushStreamEvent> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const model = req.model && req.model.trim() ? req.model : config.defaultModel;
  const body = toOpenAIResponses(req, {
    modelOverride: model,
    temperatureDefault: 0.1,
  });

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
    );
  }

  if (!response.body) {
    type FallbackBody = {
      output_text?: string;
      output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
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
