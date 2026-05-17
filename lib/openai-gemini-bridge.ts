import type { OpenAIChatRequest, OpenAIContentPart } from './openai-chat-types.ts';

/**
 * OpenAI ↔ Gemini bridge.
 *
 * Translates an OpenAI-shaped chat request into Google's Generative Language
 * `:streamGenerateContent` body, and translates the upstream SSE response back
 * into OpenAI Chat Completions SSE so the client adapter can read it through
 * `openAISSEPump` like every other provider.
 *
 * Differences from Anthropic that drive shape choices:
 *   - Gemini's role vocabulary is `user` / `model` (not `user` / `assistant`).
 *   - System messages live in a separate top-level `systemInstruction` field,
 *     not in `contents[]`.
 *   - Sampling params and `max_tokens` go under `generationConfig`.
 *   - SSE frames are JSON objects with `candidates[0].content.parts[].text` +
 *     `candidates[0].finishReason` + a trailing `usageMetadata`.
 *   - Gemini sends a single terminal frame with `finishReason` and usage —
 *     no `[DONE]` sentinel.
 *
 * Gemini does not currently emit signed reasoning blocks the way Anthropic
 * does, so this translator surfaces text only. Prompt caching markers aren't
 * preserved here either — Gemini's explicit-cache API is opt-in and lives on
 * a different endpoint, so passing `cache_control: ephemeral` through would
 * be a no-op.
 */

function dataUrlToGeminiInlinePart(dataUrl: string): Record<string, unknown> | null {
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) return null;
  return {
    inline_data: {
      mime_type: match[1],
      data: match[2],
    },
  };
}

function convertOpenAIContentToGeminiParts(
  content: string | OpenAIContentPart[] | null | undefined,
): Array<Record<string, unknown>> {
  if (typeof content === 'string') {
    return [{ text: content }];
  }

  if (!Array.isArray(content)) {
    return [{ text: '' }];
  }

  const parts: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      parts.push({ text: part.text });
      continue;
    }
    if (part.type === 'image_url' && typeof part.image_url?.url === 'string') {
      const inlinePart = dataUrlToGeminiInlinePart(part.image_url.url);
      if (inlinePart) parts.push(inlinePart);
    }
  }

  return parts.length > 0 ? parts : [{ text: '' }];
}

function flattenSystemParts(parts: Array<Record<string, unknown>>): string {
  return parts
    .map((p) => (typeof p.text === 'string' ? p.text : ''))
    .filter((text) => text.length > 0)
    .join('\n\n');
}

export function buildGeminiGenerateContentRequest(
  request: OpenAIChatRequest,
): Record<string, unknown> {
  const messages = Array.isArray(request.messages) ? request.messages : [];

  const systemParts: Array<Record<string, unknown>> = [];
  const contents: Array<Record<string, unknown>> = [];

  for (const message of messages) {
    const role = typeof message.role === 'string' ? message.role : 'user';
    if (role === 'system' || role === 'developer') {
      for (const part of convertOpenAIContentToGeminiParts(message.content)) {
        if (typeof part.text === 'string' && part.text.length > 0) {
          systemParts.push(part);
        }
      }
      continue;
    }

    const parts = convertOpenAIContentToGeminiParts(message.content);
    contents.push({
      role: role === 'assistant' ? 'model' : 'user',
      parts,
    });
  }

  // Gemini requires `contents` to be non-empty AND to start with a `user`
  // turn — `[{ role: 'model', ... }]` 400s with "contents must not start
  // with a model turn". Pad with an empty user turn in two cases:
  //   - no non-system messages at all (e.g. system-only opening turn);
  //   - first non-system message is an assistant, which happens after
  //     context compaction lops off the user prefix.
  if (contents.length === 0) {
    contents.push({ role: 'user', parts: [{ text: '' }] });
  } else if (contents[0].role === 'model') {
    contents.unshift({ role: 'user', parts: [{ text: '' }] });
  }

  const generationConfig: Record<string, unknown> = {};
  if (typeof request.max_completion_tokens === 'number') {
    generationConfig.maxOutputTokens = request.max_completion_tokens;
  } else if (typeof request.max_tokens === 'number') {
    generationConfig.maxOutputTokens = request.max_tokens;
  }
  if (typeof request.temperature === 'number') {
    generationConfig.temperature = request.temperature;
  }
  if (typeof request.top_p === 'number') {
    generationConfig.topP = request.top_p;
  }

  const body: Record<string, unknown> = { contents };

  if (systemParts.length > 0) {
    // The flattened-string form is what Gemini's REST examples use and avoids
    // any per-part shape mismatch with the SDK schema; we lose nothing by
    // joining since the upstream concatenates the parts into a single system
    // turn anyway.
    body.systemInstruction = { parts: [{ text: flattenSystemParts(systemParts) }] };
  }
  if (Object.keys(generationConfig).length > 0) {
    body.generationConfig = generationConfig;
  }

  if (request.google_search_grounding) {
    body.tools = [
      {
        googleSearch: {},
      },
    ];
  }

  return body;
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
  const delta: Record<string, unknown> = {};
  if (params.content) delta.content = params.content;

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

function mapGeminiFinishReason(reason: string | null | undefined): string {
  switch (reason) {
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
      // Gemini's safety stops are still terminal; surface as `stop` so the
      // OpenAI-shaped consumer treats the run as a clean finish rather than
      // a tool-call expectation.
      return 'stop';
    case 'STOP':
    default:
      return 'stop';
  }
}

type GeminiCandidate = {
  content?: { parts?: Array<{ text?: unknown }> };
  finishReason?: string;
};

type GeminiStreamChunk = {
  candidates?: GeminiCandidate[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
};

function extractTextFromCandidate(candidate: GeminiCandidate | undefined): string {
  const parts = candidate?.content?.parts;
  if (!Array.isArray(parts)) return '';
  let out = '';
  for (const part of parts) {
    if (part && typeof part.text === 'string') out += part.text;
  }
  return out;
}

export function createGeminiTranslatedStream(
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
      let terminalFinishReason: string | null = null;
      let closed = false;

      const finishWithCurrent = (): void => {
        if (closed) return;
        closed = true;
        controller.enqueue(
          encoder.encode(
            buildOpenAISseChunk({
              model,
              finishReason: terminalFinishReason ?? 'stop',
              usage,
            }),
          ),
        );
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      };

      const handleChunk = (raw: string): void => {
        if (closed) return;
        const trimmed = raw.trim();
        if (!trimmed) return;

        // Gemini emits SSE frames as `data: { ... }` when invoked with
        // `?alt=sse`. Strip the `data:` prefix when present; otherwise treat
        // the chunk as a bare JSON object (some intermediaries / library
        // helpers normalize the framing away).
        const jsonStr = trimmed.startsWith('data:') ? trimmed.slice(5).trimStart() : trimmed;
        if (!jsonStr || jsonStr === '[DONE]') return;

        let parsed: GeminiStreamChunk;
        try {
          parsed = JSON.parse(jsonStr) as GeminiStreamChunk;
        } catch {
          return;
        }

        const candidate = parsed.candidates?.[0];
        const text = extractTextFromCandidate(candidate);
        if (text) {
          controller.enqueue(encoder.encode(buildOpenAISseChunk({ model, content: text })));
        }

        if (parsed.usageMetadata) {
          const prompt = parsed.usageMetadata.promptTokenCount ?? usage?.prompt_tokens ?? 0;
          const completion =
            parsed.usageMetadata.candidatesTokenCount ?? usage?.completion_tokens ?? 0;
          const total = parsed.usageMetadata.totalTokenCount ?? prompt + completion;
          usage = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
        }

        if (candidate?.finishReason) {
          terminalFinishReason = mapGeminiFinishReason(candidate.finishReason);
        }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          // Normalize CRLF → LF before scanning. SSE permits `\r\n\r\n`
          // framing and Google's edge can emit it; without the rewrite the
          // single-form `\n\n` boundary scan would never match, buffer the
          // entire response, and fail JSON.parse on the multi-frame blob at
          // EOF — same defense `coder-job-stream-adapter.ts` already applies.
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

          // SSE event boundary is a blank line (\n\n). Process every complete
          // event in the buffer and keep the trailing partial for the next
          // iteration.
          let boundary = buffer.indexOf('\n\n');
          while (boundary !== -1) {
            const rawEvent = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            handleChunk(rawEvent);
            boundary = buffer.indexOf('\n\n');
          }
        }

        if (buffer.trim()) {
          handleChunk(buffer);
        }

        finishWithCurrent();
      } catch (err) {
        if (!closed) {
          try {
            controller.error(err);
          } catch {
            /* controller may already be closed */
          }
        }
      }
    },
  });
}
