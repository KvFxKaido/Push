/**
 * Kilo Code PushStream implementation.
 *
 * Hits the Kilo Code chat endpoint, parses the OpenAI-compatible SSE
 * response, and yields `PushStreamEvent`s.
 *
 * Runs client-side. Timer/abort safety comes from `createProviderStreamAdapter`
 * wrapping this stream — no timer machinery lives here.
 *
 * Structurally mirrors `zen-stream.ts` and `openrouter-stream.ts`. Kilo Code
 * is a plain OpenAI-compatible gateway: single endpoint, Bearer auth, no
 * provider-specific body extensions. The duplication across three streams is
 * intentional and motivates Phase 7's shared SSE pump extraction.
 */

import type { ChatMessage } from '@/types';
import type { PushStreamEvent, PushStreamRequest, StreamUsage } from '@push/lib/provider-contract';
import type { WorkspaceContext } from '@/types';
import { REQUEST_ID_HEADER, createRequestId } from './request-id';
import { injectTraceHeaders } from './tracing';
import { parseProviderError } from './orchestrator-streaming';
import { getKilocodeKey } from '@/hooks/useKilocodeConfig';
import { PROVIDER_URLS } from './providers';
import { toLLMMessages } from './orchestrator';
import { KNOWN_TOOL_NAMES } from './tool-dispatch';

/** Map OpenAI-shaped `finish_reason` strings onto the PushStream done reason. */
function mapFinishReason(
  value: string | undefined | null,
): 'stop' | 'length' | 'tool_calls' | 'unknown' {
  switch (value) {
    case 'stop':
    case 'end_turn':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    default:
      return 'unknown';
  }
}

function mapUsage(usage: {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}): StreamUsage {
  return {
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
    totalTokens: usage.total_tokens ?? 0,
  };
}

/** Strip model chat-template control tokens (e.g. `<|start|>`, `<|im_end|>`). */
function stripTemplateTokens(text: string): string {
  return text.replace(/<\|[a-z_]+\|>/gi, '');
}

export async function* kilocodeStream(
  req: PushStreamRequest<ChatMessage>,
): AsyncIterable<PushStreamEvent> {
  // 1. Compose messages via the shared prompt builder. Runtime context flows
  //    through the adapter as opaque passthrough fields — cast locally.
  const workspaceContext = req.workspaceContext as WorkspaceContext | undefined;
  const llmMessages = toLLMMessages(
    req.messages,
    workspaceContext,
    req.hasSandbox,
    req.systemPromptOverride,
    req.scratchpadContent,
    'kilocode',
    req.model,
    req.onPreCompact,
    undefined,
    req.todoContent,
  );

  // 2. Plain OpenAI-compatible request body — no Kilo Code-specific fields.
  const body: Record<string, unknown> = {
    model: req.model,
    messages: llmMessages,
    stream: true,
    ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.topP !== undefined ? { top_p: req.topP } : {}),
  };

  // 3. Headers. Bearer auth, single endpoint.
  const apiKey = getKilocodeKey() ?? '';
  const requestId = createRequestId('chat');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [REQUEST_ID_HEADER]: requestId,
    Authorization: `Bearer ${apiKey}`,
  };
  injectTraceHeaders(headers);

  // 4. POST + stream response.
  const response = await fetch(PROVIDER_URLS.kilocode.chat, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: req.signal,
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    let detail = errBody;
    try {
      const parsed = JSON.parse(errBody);
      detail = parseProviderError(parsed, errBody.slice(0, 200), true);
    } catch {
      detail = errBody ? errBody.slice(0, 200) : 'empty body';
    }
    throw new Error(`Kilo Code ${response.status}: ${detail}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('Kilo Code response had no body');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let pendingUsage: StreamUsage | undefined;

  // Native tool-call bridge. Same shape as the OpenRouter / Zen streams.
  const pendingNativeToolCalls = new Map<number, { name: string; args: string }>();

  function* flushNativeToolCalls(): Generator<PushStreamEvent> {
    if (pendingNativeToolCalls.size === 0) return;
    for (const [, tc] of pendingNativeToolCalls) {
      if (!tc.name && !tc.args) continue;
      if (!tc.name) {
        console.warn(
          '[Push] Native tool call with no function name — args dropped:',
          tc.args.slice(0, 200),
        );
        continue;
      }
      if (!KNOWN_TOOL_NAMES.has(tc.name)) {
        console.warn(`[Push] Native tool call "${tc.name}" is not a known tool — dropped`);
        continue;
      }
      let parsedArgs: unknown = {};
      try {
        parsedArgs = tc.args ? JSON.parse(tc.args) : {};
      } catch {
        parsedArgs = {};
      }
      yield {
        type: 'text_delta',
        text: `\n\`\`\`json\n${JSON.stringify({ tool: tc.name, args: parsedArgs })}\n\`\`\`\n`,
      };
    }
    pendingNativeToolCalls.clear();
  }

  // Propagate abort to the upstream reader so a client disconnect stops the
  // SSE pump and releases the connection.
  const onAbort = () => {
    reader.cancel().catch(() => {
      /* reader may already be closed */
    });
  };
  req.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    while (true) {
      if (req.signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed === 'data: [DONE]' || trimmed === 'data:[DONE]') {
          yield* flushNativeToolCalls();
          yield { type: 'done', finishReason: 'stop', usage: pendingUsage };
          return;
        }
        if (!trimmed.startsWith('data:')) continue;
        const jsonStr = trimmed[5] === ' ' ? trimmed.slice(6) : trimmed.slice(5);
        try {
          const parsed = JSON.parse(jsonStr);

          if (parsed.usage) {
            pendingUsage = mapUsage(parsed.usage);
          }

          const choice = parsed.choices?.[0];
          if (!choice) continue;

          const delta = choice.delta;

          // Reasoning channel — accept either field name. Kilo Code routes to
          // the same reasoning-capable model catalogs as the other gateways,
          // so both `reasoning` and `reasoning_content` shapes show up.
          const reasoning =
            typeof delta?.reasoning === 'string' && delta.reasoning.length > 0
              ? delta.reasoning
              : typeof delta?.reasoning_content === 'string' && delta.reasoning_content.length > 0
                ? delta.reasoning_content
                : undefined;
          if (reasoning) {
            yield { type: 'reasoning_delta', text: reasoning };
          }

          if (typeof delta?.content === 'string' && delta.content) {
            const token = stripTemplateTokens(delta.content);
            if (token) {
              yield { type: 'text_delta', text: token };
            }
          }

          // See `openrouter-stream.ts` — yield a `tool_call_delta` per
          // fragment so the adapter's content timer counts native tool-arg
          // streaming as progress rather than tripping `contentTimeoutMs`.
          const toolCalls = delta?.tool_calls;
          if (Array.isArray(toolCalls)) {
            let observedFragment = false;
            for (const tc of toolCalls) {
              const idx = typeof tc?.index === 'number' ? tc.index : 0;
              const fnCall = tc?.function;
              if (!fnCall) continue;
              const entry = pendingNativeToolCalls.get(idx) ?? { name: '', args: '' };
              if (typeof fnCall.name === 'string') entry.name = fnCall.name;
              if (typeof fnCall.arguments === 'string') entry.args += fnCall.arguments;
              pendingNativeToolCalls.set(idx, entry);
              observedFragment = true;
            }
            if (observedFragment) {
              yield { type: 'tool_call_delta' };
            }
          }

          if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
            yield* flushNativeToolCalls();
            yield {
              type: 'done',
              finishReason: mapFinishReason(choice.finish_reason),
              usage: pendingUsage,
            };
            return;
          }
        } catch {
          // Skip malformed JSON — upstream may emit keepalive or comment lines.
        }
      }
    }

    // Stream ended without a `[DONE]` sentinel or finish_reason — treat as
    // clean close. Flush any pending native tool_calls first so they don't
    // get dropped on the floor.
    yield* flushNativeToolCalls();
    yield { type: 'done', finishReason: 'stop', usage: pendingUsage };
  } finally {
    req.signal?.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      /* reader may have been cancelled */
    }
  }
}
