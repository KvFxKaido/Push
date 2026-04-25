/**
 * OpenAI-shaped SSE pump.
 *
 * Pure-parsing transducer over an OpenAI-compatible chat-completions SSE
 * response body. Converts a `ReadableStream<Uint8Array>` into
 * `AsyncIterable<PushStreamEvent>`.
 *
 * Lives in `lib/` so CLI and Web share one parser. Provider-specific
 * concerns (endpoint URL, auth, body construction, error mapping, prompt
 * assembly) stay in the per-provider adapter that calls this pump — the
 * pump only handles the wire-shape: `data:` framing, `[DONE]` sentinel,
 * `choices[0].delta` parsing, native `tool_calls` accumulation, usage,
 * and `finish_reason`. Anything app-specific (e.g. the known-tool name
 * filter for native tool calls) flows in via injected config.
 */

import type { PushStreamEvent, StreamUsage } from './provider-contract.js';

// ---------------------------------------------------------------------------
// Helpers — duplicated across openrouter/zen/kilocode adapters before #392
// ---------------------------------------------------------------------------

/** Map OpenAI-shaped `finish_reason` strings onto the PushStream done reason. */
export function mapOpenAIFinishReason(
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

/** Map an OpenAI-shaped `usage` object onto a `StreamUsage`. */
export function mapOpenAIUsage(usage: {
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
export function stripTemplateTokens(text: string): string {
  return text.replace(/<\|[a-z_]+\|>/gi, '');
}

// ---------------------------------------------------------------------------
// Pump
// ---------------------------------------------------------------------------

export interface OpenAISSEPumpOptions {
  /** SSE-framed response body. Must be a `data: <json>\n\n`-style stream. */
  body: ReadableStream<Uint8Array>;
  /** Cancels the upstream reader when fired. Optional. */
  signal?: AbortSignal;
  /**
   * Predicate for filtering native `delta.tool_calls` by function name on
   * flush. When omitted, every accumulated tool call is flushed regardless
   * of name. The orchestrator's known-tool registry is app-side, so each
   * adapter passes a binding rather than the pump importing it.
   */
  isKnownToolName?: (name: string) => boolean;
}

interface PendingNativeToolCall {
  name: string;
  args: string;
}

/**
 * Drain an OpenAI-shaped SSE response body and yield `PushStreamEvent`s.
 *
 * Behaviour:
 * - `[DONE]` sentinel closes the stream with `finishReason: 'stop'` and the
 *   most recently observed usage.
 * - Each parsed `data:` JSON frame may carry usage (recorded for the next
 *   `done`), a `delta.reasoning` / `delta.reasoning_content` chunk
 *   (`reasoning_delta`), a `delta.content` chunk (`text_delta` after
 *   template-token stripping), and/or `delta.tool_calls` fragments
 *   (accumulated by `index`; one `tool_call_delta` per fragment so the
 *   adapter's content timer treats long tool-arg payloads as activity).
 * - `finish_reason` flushes pending native tool calls as fenced JSON
 *   `text_delta`s and yields `done` with the mapped reason. So does
 *   stream end without a `[DONE]` or `finish_reason`.
 * - Malformed JSON frames are skipped (upstream may emit keepalives).
 * - When `signal` aborts mid-stream, the reader is cancelled and the
 *   generator returns; the consumer sees whatever events have already
 *   been yielded.
 */
export async function* openAISSEPump(opts: OpenAISSEPumpOptions): AsyncIterable<PushStreamEvent> {
  const { body, signal, isKnownToolName } = opts;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let pendingUsage: StreamUsage | undefined;

  // Accumulate native `delta.tool_calls` fragments by index; flush as
  // fenced JSON text_delta on finish_reason / [DONE] / clean close so the
  // downstream text-based tool dispatcher picks them up. Names not in the
  // injected predicate are dropped on flush — the orchestrator filters
  // hallucinated tools the same way on the legacy path.
  const pendingNativeToolCalls = new Map<number, PendingNativeToolCall>();

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
      if (isKnownToolName && !isKnownToolName(tc.name)) {
        console.warn(`[Push] Native tool call "${tc.name}" is not a known tool — dropped`);
        continue;
      }
      let parsedArgs: unknown = {};
      try {
        parsedArgs = tc.args ? JSON.parse(tc.args) : {};
      } catch {
        // Malformed args — still emit a fenced shell so the malformed-tool-
        // call diagnostic path in the dispatcher can guide a retry.
        parsedArgs = {};
      }
      yield {
        type: 'text_delta',
        text: `\n\`\`\`json\n${JSON.stringify({ tool: tc.name, args: parsedArgs })}\n\`\`\`\n`,
      };
    }
    pendingNativeToolCalls.clear();
  }

  const onAbort = () => {
    reader.cancel().catch(() => {
      /* reader may already be closed */
    });
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    while (true) {
      if (signal?.aborted) return;
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

          // Usage may arrive on an intermediate frame or alongside finish_reason.
          if (parsed.usage) {
            pendingUsage = mapOpenAIUsage(parsed.usage);
          }

          const choice = parsed.choices?.[0];
          if (!choice) continue;

          const delta = choice.delta;

          // Reasoning channel — accept either field name. Modern providers
          // (Kimi K2.6) use `reasoning`; older ones (DeepSeek-R1, Kimi K2.5)
          // use `reasoning_content`. Pick the first non-empty string.
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

          // Native tool_call fragments — accumulate by index; the name and
          // arguments often arrive split across frames. Flushed as fenced
          // JSON `text_delta` on finish_reason / [DONE]. Yield one
          // `tool_call_delta` per fragment so the adapter's content timer
          // counts native tool-arg streaming as progress while we buffer.
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
              finishReason: mapOpenAIFinishReason(choice.finish_reason),
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
    signal?.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      /* reader may have been cancelled */
    }
  }
}
