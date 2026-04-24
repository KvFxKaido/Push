/**
 * OpenRouter PushStream implementation.
 *
 * Hits the existing Worker proxy at `/api/openrouter/chat` (or the Vite dev
 * passthrough at `/openrouter/api/v1/chat/completions`), parses the
 * OpenAI-compatible SSE response, and yields `PushStreamEvent`s.
 *
 * Runs client-side. Timer/abort safety comes from `createProviderStreamAdapter`
 * wrapping this stream — no timer machinery lives here.
 */

import type { ChatMessage } from '@/types';
import type { PushStreamEvent, PushStreamRequest, StreamUsage } from '@push/lib/provider-contract';
import { REQUEST_ID_HEADER, createRequestId } from './request-id';
import { injectTraceHeaders } from './tracing';
import { parseProviderError } from './orchestrator-streaming';
import { buildOpenRouterTrace, getOpenRouterSessionId } from './openrouter-session';
import { getOpenRouterKey } from '@/hooks/useOpenRouterConfig';
import { openRouterModelSupportsReasoning, getReasoningEffort } from './model-catalog';
import { PROVIDER_URLS } from './providers';
import type { WorkspaceContext } from '@/types';
import { toLLMMessages } from './orchestrator';

/** Map OpenRouter / OpenAI `finish_reason` strings onto the PushStream done reason. */
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

export async function* openrouterStream(
  req: PushStreamRequest<ChatMessage>,
): AsyncIterable<PushStreamEvent> {
  // 1. Compose messages via the shared prompt builder. Runtime context
  //    (workspaceContext, hasSandbox, onPreCompact) flows through the
  //    adapter as opaque passthrough fields — cast locally.
  const workspaceContext = req.workspaceContext as WorkspaceContext | undefined;
  const llmMessages = toLLMMessages(
    req.messages,
    workspaceContext,
    req.hasSandbox,
    req.systemPromptOverride,
    req.scratchpadContent,
    'openrouter',
    req.model,
    req.onPreCompact,
    undefined,
    req.todoContent,
  );

  // 2. Layer in OpenRouter-specific body extensions. Mirrors the legacy
  //    `bodyTransform` in orchestrator-provider-routing.ts so the wire
  //    payload is byte-identical.
  const supportsReasoning = openRouterModelSupportsReasoning(req.model);
  const effort = getReasoningEffort('openrouter');
  const useReasoning = supportsReasoning && effort !== 'off';
  const sessionId = getOpenRouterSessionId();
  const trace = buildOpenRouterTrace();

  const body: Record<string, unknown> = {
    model: req.model,
    messages: llmMessages,
    stream: true,
    ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.topP !== undefined ? { top_p: req.topP } : {}),
    ...(useReasoning ? { reasoning: { effort } } : {}),
    ...(sessionId ? { session_id: sessionId } : {}),
    trace,
  };

  // 3. Headers. The Worker proxy overrides Authorization server-side when
  //    OPENROUTER_API_KEY is configured; we still send the client-side key
  //    so dev (Vite passthrough) and unconfigured-Worker paths work.
  const apiKey = getOpenRouterKey() ?? '';
  const requestId = createRequestId('chat');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [REQUEST_ID_HEADER]: requestId,
    Authorization: `Bearer ${apiKey}`,
  };
  injectTraceHeaders(headers);

  // 4. POST + stream response.
  const response = await fetch(PROVIDER_URLS.openrouter.chat, {
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
    throw new Error(`OpenRouter ${response.status}: ${detail}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('OpenRouter response had no body');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let pendingUsage: StreamUsage | undefined;

  // Propagate abort to the upstream reader so a client disconnect stops
  // the SSE pump and releases the connection.
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
          yield { type: 'done', finishReason: 'stop', usage: pendingUsage };
          return;
        }
        if (!trimmed.startsWith('data:')) continue;
        const jsonStr = trimmed[5] === ' ' ? trimmed.slice(6) : trimmed.slice(5);
        try {
          const parsed = JSON.parse(jsonStr);

          // Usage can arrive on an intermediate frame or alongside finish_reason.
          if (parsed.usage) {
            pendingUsage = mapUsage(parsed.usage);
          }

          const choice = parsed.choices?.[0];
          if (!choice) continue;

          const delta = choice.delta;

          // Reasoning channel — accept either field name. OpenRouter-hosted
          // DeepSeek-R1 and Kimi K2.5 use `reasoning_content`; Kimi K2.6
          // renamed it to `reasoning`. Pick the first non-empty string.
          const reasoning =
            typeof delta?.reasoning === 'string' && delta.reasoning.length > 0
              ? delta.reasoning
              : typeof delta?.reasoning_content === 'string' && delta.reasoning_content.length > 0
                ? delta.reasoning_content
                : undefined;
          if (reasoning) {
            yield { type: 'reasoning_delta', text: reasoning };
          }

          // Visible content delta — strip chat-template control tokens some
          // models leak into the stream, then yield.
          if (typeof delta?.content === 'string' && delta.content) {
            const token = stripTemplateTokens(delta.content);
            if (token) {
              yield { type: 'text_delta', text: token };
            }
          }

          // Finish reason closes the stream with whatever usage we've seen.
          if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
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

    // Stream ended without a `[DONE]` sentinel or finish_reason — treat as clean close.
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
