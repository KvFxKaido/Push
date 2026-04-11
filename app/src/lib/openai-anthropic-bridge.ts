import type { OpenAIChatRequest, OpenAIContentPart } from './chat-request-guardrails';

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
      parts.push({ type: 'text', text: part.text });
      continue;
    }
    if (part.type === 'image_url' && typeof part.image_url?.url === 'string') {
      const imagePart = dataUrlToAnthropicImagePart(part.image_url.url);
      if (imagePart) parts.push(imagePart);
    }
  }

  return parts.length > 0 ? parts : [{ type: 'text', text: '' }];
}

function buildOpenAISseChunk(params: {
  model: string;
  content?: string;
  finishReason?: string | null;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}): string {
  const payload: Record<string, unknown> = {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: params.model,
    choices: [
      {
        index: 0,
        delta: params.content ? { content: params.content } : {},
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

  const systemSegments: string[] = [];
  const anthropicMessages: Array<Record<string, unknown>> = [];

  for (const message of messages) {
    const role = typeof message.role === 'string' ? message.role : 'user';
    if (role === 'system' || role === 'developer') {
      const systemParts = convertOpenAIContentToAnthropic(message.content)
        .map((part) => (typeof part.text === 'string' ? part.text : ''))
        .filter(Boolean);
      if (systemParts.length > 0) {
        systemSegments.push(systemParts.join('\n\n'));
      }
      continue;
    }

    anthropicMessages.push({
      role: role === 'assistant' ? 'assistant' : 'user',
      content: convertOpenAIContentToAnthropic(message.content),
    });
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
  if (systemSegments.length > 0) {
    body.system = systemSegments.join('\n\n');
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
        if (eventType === 'content_block_delta') {
          const delta = parsed.delta as Record<string, unknown> | undefined;
          if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
            controller.enqueue(encoder.encode(buildOpenAISseChunk({ model, content: delta.text })));
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
