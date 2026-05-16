import type {
  OpenAIChatRequest,
  OpenAIContentPart,
  OpenAIReasoningBlock,
} from './chat-request-guardrails';

function dataUrlToAnthropicImagePart(dataUrl: string): Record<string, unknown> | null {
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) return null;
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: match[1],
      data: match[2],
    },
  };
}

/** Reasoning blocks must appear BEFORE text/tool_use in Anthropic's
 *  assistant `content[]` when extended thinking is in use — otherwise the
 *  API rejects the turn with `invalid_request_error`. */
function reasoningBlocksToAnthropic(
  blocks: OpenAIReasoningBlock[] | undefined,
): Array<Record<string, unknown>> {
  if (!blocks || blocks.length === 0) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const block of blocks) {
    if (block.type === 'thinking') {
      out.push({ type: 'thinking', thinking: block.text, signature: block.signature });
    } else if (block.type === 'redacted_thinking') {
      out.push({ type: 'redacted_thinking', data: block.data });
    }
  }
  return out;
}

function convertOpenAIContentToAnthropic(
  content: string | OpenAIContentPart[] | null | undefined,
): Array<Record<string, unknown>> {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }

  if (!Array.isArray(content)) {
    return [{ type: 'text', text: '' }];
  }

  const parts: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      const textPart: Record<string, unknown> = { type: 'text', text: part.text };
      // Anthropic accepts the same `cache_control: { type: 'ephemeral' }` shape
      // OpenAI uses for prompt caching. Pass it through verbatim — dropping it
      // here would silently disable caching on every direct-Anthropic /
      // Vertex-Anthropic turn even when the caller set breakpoints upstream.
      if (part.cache_control) textPart.cache_control = part.cache_control;
      parts.push(textPart);
      continue;
    }
    if (part.type === 'image_url' && typeof part.image_url?.url === 'string') {
      const imagePart = dataUrlToAnthropicImagePart(part.image_url.url);
      if (imagePart) {
        if (part.cache_control) imagePart.cache_control = part.cache_control;
        parts.push(imagePart);
      }
    }
  }

  return parts.length > 0 ? parts : [{ type: 'text', text: '' }];
}

function buildOpenAISseChunk(params: {
  model: string;
  content?: string;
  reasoningBlock?: OpenAIReasoningBlock;
  finishReason?: string | null;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}): string {
  const delta: Record<string, unknown> = {};
  if (params.content) delta.content = params.content;
  if (params.reasoningBlock) delta.reasoning_block = params.reasoningBlock;

  const payload: Record<string, unknown> = {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: params.model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: params.finishReason ?? null,
      },
    ],
  };

  if (params.usage) {
    payload.usage = {
      prompt_tokens: params.usage.prompt_tokens ?? 0,
      completion_tokens: params.usage.completion_tokens ?? 0,
      total_tokens: params.usage.total_tokens ?? 0,
    };
  }

  return `data: ${JSON.stringify(payload)}\n\n`;
}

function mapAnthropicStopReason(stopReason: string | null | undefined): string {
  switch (stopReason) {
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    default:
      return 'stop';
  }
}

export function buildAnthropicMessagesRequest(
  request: OpenAIChatRequest,
  options?: {
    anthropicVersion?: string;
  },
): Record<string, unknown> {
  const messages = Array.isArray(request.messages) ? request.messages : [];

  // Anthropic accepts `system` as a plain string OR as an array of content
  // blocks. We use the array form whenever the upstream system message carries
  // a `cache_control` marker so the Hermes `system_and_3` strategy's longest-
  // lived breakpoint survives translation. Otherwise we flatten to a string
  // (cheaper to wire, and consistent with the historical Vertex behaviour).
  const systemBlocks: Array<Record<string, unknown>> = [];
  let systemHasCacheControl = false;
  const anthropicMessages: Array<Record<string, unknown>> = [];

  for (const message of messages) {
    const role = typeof message.role === 'string' ? message.role : 'user';
    if (role === 'system' || role === 'developer') {
      const parts = convertOpenAIContentToAnthropic(message.content);
      for (const part of parts) {
        if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
          if (part.cache_control) systemHasCacheControl = true;
          systemBlocks.push(part);
        }
      }
      continue;
    }

    const contentBlocks = convertOpenAIContentToAnthropic(message.content);
    if (role === 'assistant') {
      const reasoning = reasoningBlocksToAnthropic(message.reasoning_blocks);
      anthropicMessages.push({
        role: 'assistant',
        content: reasoning.length > 0 ? [...reasoning, ...contentBlocks] : contentBlocks,
      });
    } else {
      anthropicMessages.push({ role: 'user', content: contentBlocks });
    }
  }

  const body: Record<string, unknown> = {
    messages:
      anthropicMessages.length > 0
        ? anthropicMessages
        : [{ role: 'user', content: [{ type: 'text', text: '' }] }],
    max_tokens:
      typeof request.max_completion_tokens === 'number'
        ? request.max_completion_tokens
        : typeof request.max_tokens === 'number'
          ? request.max_tokens
          : 8192,
    stream: Boolean(request.stream),
  };

  if (options?.anthropicVersion) {
    body.anthropic_version = options.anthropicVersion;
  }
  if (systemBlocks.length > 0) {
    body.system = systemHasCacheControl
      ? systemBlocks
      : systemBlocks.map((p) => p.text).join('\n\n');
  }
  if (typeof request.temperature === 'number') {
    body.temperature = request.temperature;
  }
  if (typeof request.top_p === 'number') {
    body.top_p = request.top_p;
  }

  return body;
}

export function createAnthropicTranslatedStream(
  upstream: Response,
  model: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.body?.getReader();
      if (!reader) {
        controller.enqueue(encoder.encode(buildOpenAISseChunk({ model, finishReason: 'stop' })));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
        return;
      }

      let buffer = '';
      let usage:
        | { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
        | undefined;

      // Per-index thinking-block accumulators. Anthropic streams open a
      // `thinking` or `redacted_thinking` block via `content_block_start`,
      // emit zero or more `thinking_delta` + a single `signature_delta`,
      // then close with `content_block_stop`. We accumulate until stop and
      // emit a single structured `reasoning_block` SSE chunk so the OpenAI
      // pump can persist it onto the assistant message intact — the
      // signature is what makes the next turn round-trippable, so
      // splitting it across multiple deltas would force every consumer to
      // re-assemble.
      type ThinkingState = {
        kind: 'thinking';
        text: string;
        signature: string;
      };
      type RedactedState = { kind: 'redacted_thinking'; data: string };
      const openBlocks = new Map<number, ThinkingState | RedactedState>();

      const processSseLine = (rawLine: string): boolean => {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) return false;
        const jsonStr = line[5] === ' ' ? line.slice(6) : line.slice(5);
        if (jsonStr === '[DONE]') {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
          return true;
        }

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(jsonStr) as Record<string, unknown>;
        } catch {
          return false;
        }

        const eventType = typeof parsed.type === 'string' ? parsed.type : '';

        if (eventType === 'content_block_start') {
          const idx = typeof parsed.index === 'number' ? parsed.index : -1;
          const block = parsed.content_block as Record<string, unknown> | undefined;
          if (idx >= 0 && block) {
            if (block.type === 'thinking') {
              openBlocks.set(idx, {
                kind: 'thinking',
                text: typeof block.thinking === 'string' ? block.thinking : '',
                signature: typeof block.signature === 'string' ? block.signature : '',
              });
            } else if (block.type === 'redacted_thinking') {
              openBlocks.set(idx, {
                kind: 'redacted_thinking',
                data: typeof block.data === 'string' ? block.data : '',
              });
            }
          }
          return false;
        }

        if (eventType === 'content_block_stop') {
          const idx = typeof parsed.index === 'number' ? parsed.index : -1;
          const state = idx >= 0 ? openBlocks.get(idx) : undefined;
          if (state) {
            openBlocks.delete(idx);
            if (state.kind === 'thinking') {
              // Drop blocks with no signature: without one Anthropic
              // would reject the round-trip on the next turn anyway, and
              // emitting a half-formed block would just push the failure
              // downstream. Text-only thinking still flows via the
              // existing reasoning_delta channel for display.
              if (state.signature) {
                controller.enqueue(
                  encoder.encode(
                    buildOpenAISseChunk({
                      model,
                      reasoningBlock: {
                        type: 'thinking',
                        text: state.text,
                        signature: state.signature,
                      },
                    }),
                  ),
                );
              }
            } else if (state.data) {
              controller.enqueue(
                encoder.encode(
                  buildOpenAISseChunk({
                    model,
                    reasoningBlock: { type: 'redacted_thinking', data: state.data },
                  }),
                ),
              );
            }
          }
          return false;
        }

        if (eventType === 'content_block_delta') {
          const idx = typeof parsed.index === 'number' ? parsed.index : -1;
          const delta = parsed.delta as Record<string, unknown> | undefined;
          if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
            controller.enqueue(encoder.encode(buildOpenAISseChunk({ model, content: delta.text })));
            return false;
          }
          // Thinking deltas ride a separate per-block state machine.
          // Anthropic emits `thinking_delta` for the visible reasoning
          // text and `signature_delta` for the cryptographic signature
          // that makes the block round-trippable. We accumulate both into
          // the open state and flush together at content_block_stop.
          const state = idx >= 0 ? openBlocks.get(idx) : undefined;
          if (state?.kind === 'thinking') {
            if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
              state.text += delta.thinking;
            } else if (delta?.type === 'signature_delta' && typeof delta.signature === 'string') {
              state.signature += delta.signature;
            }
          }
          return false;
        }

        if (
          eventType === 'message_start' ||
          eventType === 'message_delta' ||
          eventType === 'message_stop'
        ) {
          const message = parsed.message as Record<string, unknown> | undefined;
          const delta = parsed.delta as Record<string, unknown> | undefined;
          const usageRec =
            (parsed.usage as Record<string, unknown> | undefined) ||
            (message?.usage as Record<string, unknown> | undefined) ||
            (delta?.usage as Record<string, unknown> | undefined);
          if (usageRec) {
            const promptTokens =
              typeof usageRec.input_tokens === 'number'
                ? usageRec.input_tokens
                : (usage?.prompt_tokens ?? 0);
            const completionTokens =
              typeof usageRec.output_tokens === 'number'
                ? usageRec.output_tokens
                : (usage?.completion_tokens ?? 0);
            usage = {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: promptTokens + completionTokens,
            };
          }

          if (eventType === 'message_delta' || eventType === 'message_stop') {
            const stopReason =
              typeof delta?.stop_reason === 'string'
                ? delta.stop_reason
                : typeof message?.stop_reason === 'string'
                  ? message.stop_reason
                  : null;
            if (stopReason || eventType === 'message_stop') {
              controller.enqueue(
                encoder.encode(
                  buildOpenAISseChunk({
                    model,
                    finishReason: mapAnthropicStopReason(stopReason),
                    usage,
                  }),
                ),
              );
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
              return true;
            }
          }
        }

        return false;
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const rawLine of lines) {
            if (processSseLine(rawLine)) return;
          }
        }

        if (buffer.trim()) {
          if (processSseLine(buffer)) return;
        }

        controller.enqueue(
          encoder.encode(buildOpenAISseChunk({ model, finishReason: 'stop', usage })),
        );
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}
