import type { OpenAIChatRequest, OpenAIContentPart } from './openai-chat-types.ts';
import type {
  LlmContentPart,
  LlmMessage,
  PushStreamEvent,
  PushStreamRequest,
  StreamUsage,
} from './provider-contract.ts';
import { stripTemplateTokens } from './openai-sse-pump.ts';

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

  return assembleGeminiBody({
    contents,
    systemText: systemParts.length > 0 ? flattenSystemParts(systemParts) : '',
    maxOutputTokens:
      typeof request.max_completion_tokens === 'number'
        ? request.max_completion_tokens
        : typeof request.max_tokens === 'number'
          ? request.max_tokens
          : undefined,
    temperature: typeof request.temperature === 'number' ? request.temperature : undefined,
    topP: typeof request.top_p === 'number' ? request.top_p : undefined,
    // Strict `=== true` so a malformed input (e.g. the string `"false"`) can't
    // accidentally enable grounding.
    enableGoogleSearch: request.google_search_grounding === true,
  });
}

/**
 * Shared final assembly — both `buildGeminiGenerateContentRequest` (OpenAI
 * shape) and `toGeminiGenerateContent` (neutral) converge here, so the two paths
 * can only diverge on message conversion. Applies Gemini's user-first-turn
 * requirement, `generationConfig` placement, the `systemInstruction` hoist, and
 * the `googleSearch` tool. (Model is NOT in the body — Gemini carries it in the
 * URL path.)
 */
interface GeminiBodyAssembly {
  contents: Array<Record<string, unknown>>;
  /** Flattened system text, or `''` when there is no system content. */
  systemText: string;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  enableGoogleSearch: boolean;
}

function assembleGeminiBody(parts: GeminiBodyAssembly): Record<string, unknown> {
  const contents = parts.contents;
  // Gemini requires `contents` non-empty AND starting with a `user` turn —
  // `[{ role: 'model', ... }]` 400s. Pad with an empty user turn when there are
  // no non-system messages, or when the first is an assistant (e.g. after
  // context compaction lops off the user prefix).
  if (contents.length === 0) {
    contents.push({ role: 'user', parts: [{ text: '' }] });
  } else if (contents[0].role === 'model') {
    contents.unshift({ role: 'user', parts: [{ text: '' }] });
  }

  const generationConfig: Record<string, unknown> = {};
  if (typeof parts.maxOutputTokens === 'number') {
    generationConfig.maxOutputTokens = parts.maxOutputTokens;
  }
  if (typeof parts.temperature === 'number') {
    generationConfig.temperature = parts.temperature;
  }
  if (typeof parts.topP === 'number') {
    generationConfig.topP = parts.topP;
  }

  const body: Record<string, unknown> = { contents };
  if (parts.systemText) {
    // Flattened-string form matches Gemini's REST examples; the upstream
    // concatenates parts into a single system turn anyway.
    body.systemInstruction = { parts: [{ text: parts.systemText }] };
  }
  if (Object.keys(generationConfig).length > 0) {
    body.generationConfig = generationConfig;
  }
  if (parts.enableGoogleSearch) {
    body.tools = [{ googleSearch: {} }];
  }
  return body;
}

/** Convert an `image_url.url` to a Gemini inline part. Gemini inline image
 *  content requires a base64 `data:` URL; an http(s) URL (which Gemini would
 *  only accept as `fileData` with a Google-hosted URI, not arbitrary http)
 *  throws so an attached image is never silently dropped — the loud-failure
 *  posture of the neutral path. */
function geminiInlineImageFromUrl(url: string): Record<string, unknown> {
  const inline = dataUrlToGeminiInlinePart(url);
  if (inline) return inline;
  throw new Error(
    `toGeminiGenerateContent: cannot represent image (Gemini inline parts require a data:image base64 URL): ${url.slice(0, 48)}`,
  );
}

/** Strict multimodal converter for the neutral `LlmMessage.contentParts` path —
 *  preserves text + image parts and THROWS on an unsupported/malformed part,
 *  rather than silently dropping it the way `convertOpenAIContentToGeminiParts`
 *  does on the OpenAI-shape path. */
function llmContentPartsToGemini(parts: readonly LlmContentPart[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const rawPart of parts) {
    const part = rawPart as { type?: unknown; text?: unknown; image_url?: unknown };
    if (part.type === 'text' && typeof part.text === 'string') {
      out.push({ text: part.text });
      continue;
    }
    if (
      part.type === 'image_url' &&
      part.image_url &&
      typeof part.image_url === 'object' &&
      typeof (part.image_url as { url?: unknown }).url === 'string'
    ) {
      out.push(geminiInlineImageFromUrl((part.image_url as { url: string }).url));
      continue;
    }
    throw new Error(
      `toGeminiGenerateContent: unsupported or malformed content part (type: ${JSON.stringify(part.type)})`,
    );
  }
  return out.length > 0 ? out : [{ text: '' }];
}

/** Options for the neutral `PushStreamRequest` → Gemini serializer. */
export interface ToGeminiGenerateContentOptions {
  /** Attach the native `googleSearch` grounding tool. The caller owns the policy
   *  decision (the CLI's env-driven default-on). Defaults to
   *  `req.googleSearchGrounding === true`. */
  enableGoogleSearch?: boolean;
  /** Temperature applied when `req.temperature` is unset (the CLI passes 0.1). */
  temperatureDefault?: number;
}

/**
 * Build a Gemini `:generateContent` body **directly** from the neutral
 * `PushStreamRequest` — no OpenAI Chat Completions intermediate. The Gemini
 * analog of `toAnthropicMessages`: system hoist into `systemInstruction`,
 * `user`/`model` role rename, multimodal `contentParts` (text + base64 image,
 * failing loudly on an unrepresentable part), and `generationConfig` assembly.
 *
 * Gemini has **no** model-capability sampling gate (temperature/topP/topK are
 * accepted across gemini-2.5 / gemini-3.x), so there is no Phase-1-style strip
 * here. `cacheBreakpointIndices` are ignored — Gemini's explicit-cache API lives
 * on a different endpoint, so inline cache markers are a no-op (same as the
 * legacy bridge). Model is NOT emitted: Gemini carries it in the URL path.
 */
export function toGeminiGenerateContent(
  req: PushStreamRequest<LlmMessage>,
  options?: ToGeminiGenerateContentOptions,
): Record<string, unknown> {
  const messages = Array.isArray(req.messages) ? req.messages : [];
  const hasOverride =
    typeof req.systemPromptOverride === 'string' && req.systemPromptOverride.length > 0;

  const systemParts: Array<Record<string, unknown>> = [];
  const contents: Array<Record<string, unknown>> = [];

  const pushSystemText = (text: string): void => {
    if (text.length > 0) systemParts.push({ text });
  };
  if (hasOverride) pushSystemText(req.systemPromptOverride as string);

  for (const m of messages) {
    if (m.role === 'system') {
      // Gemini's systemInstruction is text-only; the web's system message is a
      // plain string.
      pushSystemText(m.content);
      continue;
    }
    const parts =
      m.contentParts && m.contentParts.length > 0
        ? llmContentPartsToGemini(m.contentParts)
        : [{ text: m.content }];
    contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
  }

  return assembleGeminiBody({
    contents,
    systemText: systemParts.length > 0 ? flattenSystemParts(systemParts) : '',
    maxOutputTokens: typeof req.maxTokens === 'number' ? req.maxTokens : undefined,
    temperature:
      typeof req.temperature === 'number' ? req.temperature : options?.temperatureDefault,
    topP: typeof req.topP === 'number' ? req.topP : undefined,
    enableGoogleSearch: options?.enableGoogleSearch ?? req.googleSearchGrounding === true,
  });
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

/**
 * Phase 3a (Gemini): parse the Gemini `:streamGenerateContent` SSE stream
 * **directly into neutral `PushStreamEvent`s**, with no OpenAI Chat-Completions
 * SSE intermediate. The inverse of `createGeminiTranslatedStream` (which rebuilds
 * OpenAI SSE bytes for the web Worker's response wire) — same parse, neutral
 * output. The CLI consumes this directly, dropping the old
 * `createGeminiTranslatedStream → openAISSEPump` serialize-then-reparse
 * round-trip; the web Worker still uses the translator until the response-contract
 * migration. The drift test pins the two to emit the same event sequence.
 *
 * Gemini is text-only here (no reasoning blocks, no pause_turn): each frame's
 * candidate text becomes a `text_delta` (through the same `stripTemplateTokens`
 * the pump applies, for byte-parity), usage is tracked from `usageMetadata`, and
 * a single terminal `done` is emitted at stream end with the last-seen finish
 * reason — Gemini sends no `[DONE]` sentinel and carries `finishReason` on its
 * final candidate frame.
 */
export async function* geminiEventStream(
  upstream: Response,
  signal?: AbortSignal,
): AsyncIterable<PushStreamEvent> {
  const reader = upstream.body?.getReader();
  if (!reader) {
    yield { type: 'done', finishReason: 'stop' };
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let usage: StreamUsage | undefined;
  let terminalFinishReason: 'stop' | 'length' = 'stop';

  function* processFrame(raw: string): Generator<PushStreamEvent> {
    const trimmed = raw.trim();
    if (!trimmed) return;
    // Gemini emits `data: { ... }` frames under `?alt=sse`; some intermediaries
    // strip the prefix. Handle both, and ignore a stray `[DONE]`.
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
      // Same chat-template-token strip the openAISSEPump text branch applies,
      // so the direct path stays event-for-event identical to the legacy path.
      const token = stripTemplateTokens(text);
      if (token) yield { type: 'text_delta', text: token };
    }

    if (parsed.usageMetadata) {
      const inputTokens = parsed.usageMetadata.promptTokenCount ?? usage?.inputTokens ?? 0;
      const outputTokens = parsed.usageMetadata.candidatesTokenCount ?? usage?.outputTokens ?? 0;
      const totalTokens = parsed.usageMetadata.totalTokenCount ?? inputTokens + outputTokens;
      usage = { inputTokens, outputTokens, totalTokens };
    }

    if (candidate?.finishReason) {
      terminalFinishReason =
        mapGeminiFinishReason(candidate.finishReason) === 'length' ? 'length' : 'stop';
    }
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
      if (signal?.aborted) return;
      if (done) break;

      // Normalize CRLF → LF so the `\n\n` boundary scan matches Google's edge
      // framing (same defense the translator applies).
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        yield* processFrame(rawEvent);
        boundary = buffer.indexOf('\n\n');
      }
    }

    if (buffer.trim()) {
      yield* processFrame(buffer);
    }
    // Gemini has no [DONE] sentinel — emit the single terminal `done` at stream
    // end with the finish reason + usage accumulated from the final frame.
    yield { type: 'done', finishReason: terminalFinishReason, usage };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      /* reader may have been cancelled */
    }
  }
}
