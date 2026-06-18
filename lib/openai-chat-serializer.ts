/**
 * Neutral `PushStreamRequest` → OpenAI Chat Completions serializer.
 *
 * The OpenAI peer of `toAnthropicMessages` / `toGeminiGenerateContent` — the
 * "explicit peer serializer" from `docs/runbooks/Provider Request Normalization.md`.
 * OpenAI Chat Completions is the wire shape every OpenAI-compatible endpoint
 * speaks (OpenRouter, Zen, NVIDIA, Blackbox, Kilocode, OpenAdapter, direct
 * OpenAI, and the OpenAI-compat transports of Vertex / Zen-Go), so this is what
 * those neutral paths serialize to instead of hand-rolling the body inline.
 *
 * Unlike the Anthropic/Gemini serializers there's little translation to do:
 * `LlmMessage` roles map 1:1 to OpenAI roles, and `LlmContentPart` is already
 * the OpenAI `image_url` content-part shape. The notable choices:
 *
 *   - `reasoningBlocks` are NOT emitted. The Push-private `reasoning_blocks`
 *     sidecar is an unknown parameter to strict OpenAI-compat endpoints (they
 *     may reject it); it only round-trips on the Anthropic-bridge surface.
 *   - Image content passes through as `image_url` — OpenAI accepts both `data:`
 *     base64 and `http(s)` URLs natively, so (unlike Gemini) there's no
 *     loud-fail on the URL scheme; only a genuinely malformed/unknown part type
 *     throws.
 *   - Prompt-cache markers (`cache_control: ephemeral`) are tagged onto the
 *     system + rolling-tail messages only when `tagCacheBreakpoints` is set —
 *     OpenRouter forwards them to Anthropic models; other OpenAI-compat routes
 *     ignore them, so the caller opts in.
 */

import type {
  OpenAIChatRequest,
  OpenAIContentPart,
  OpenAIJsonSchemaResponseFormat,
  OpenAIMessage,
} from './openai-chat-types.ts';
import type {
  LlmContentPart,
  LlmMessage,
  PushStreamRequest,
  ResponseFormatSpec,
} from './provider-contract.ts';
import { MAX_ROLLING_CACHE_BREAKPOINTS } from './context-transformer.ts';

/**
 * Build the OpenAI `response_format` payload from the neutral `ResponseFormatSpec`.
 * Single source of truth for the wire shape — both `toOpenAIChat` (CLI +
 * OpenAI-compat) and the web `openrouter-stream.ts` inline body call this, so
 * the two paths can't drift. `strict` defaults to true (the schema produced by
 * `zodToStrictJsonSchema` is built for strict mode).
 */
export function toOpenAIResponseFormat(spec: ResponseFormatSpec): OpenAIJsonSchemaResponseFormat {
  return {
    type: 'json_schema',
    json_schema: {
      name: spec.name,
      strict: spec.strict ?? true,
      schema: spec.schema,
    },
  };
}

/**
 * Strict multimodal converter for `LlmMessage.contentParts`. Maps text/image
 * parts to OpenAI content parts and THROWS on an unsupported/malformed part,
 * rather than silently dropping it. (OpenAI accepts `image_url` with any URL, so
 * there's no per-URL loud-fail — only unknown part types throw.)
 *
 * `keepCacheControl` gates whether an incoming part's Push-private
 * `cache_control` marker is preserved on the wire. When false (the default for
 * strict OpenAI-compat routes), the marker is dropped — those endpoints can
 * reject unknown content-part fields, and the message-level cache gate is off,
 * so a per-part marker must not slip through it.
 */
function llmContentPartsToOpenAI(
  parts: readonly LlmContentPart[],
  keepCacheControl: boolean,
): OpenAIContentPart[] {
  const out: OpenAIContentPart[] = [];
  for (const rawPart of parts) {
    const part = rawPart as {
      type?: unknown;
      text?: unknown;
      image_url?: unknown;
      cache_control?: unknown;
    };
    if (part.type === 'text' && typeof part.text === 'string') {
      out.push({
        type: 'text',
        text: part.text,
        ...(keepCacheControl && part.cache_control
          ? { cache_control: part.cache_control as { type: 'ephemeral' } }
          : {}),
      });
      continue;
    }
    if (
      part.type === 'image_url' &&
      part.image_url &&
      typeof part.image_url === 'object' &&
      typeof (part.image_url as { url?: unknown }).url === 'string'
    ) {
      out.push({
        type: 'image_url',
        image_url: { url: (part.image_url as { url: string }).url },
        ...(keepCacheControl && part.cache_control
          ? { cache_control: part.cache_control as { type: 'ephemeral' } }
          : {}),
      });
      continue;
    }
    throw new Error(
      `toOpenAIChat: unsupported or malformed content part (type: ${JSON.stringify(part.type)})`,
    );
  }
  return out.length > 0 ? out : [{ type: 'text', text: '' }];
}

/** Tag a message's content with `cache_control: ephemeral` — promoting a
 *  bare-string content to a single text part, or tagging the last text part of
 *  a multimodal message. Mirrors the wire-tagging the CLI/orchestrator apply. */
function tagMessageCacheControl(message: OpenAIMessage): void {
  if (typeof message.content === 'string') {
    message.content = [
      { type: 'text', text: message.content, cache_control: { type: 'ephemeral' } },
    ];
    return;
  }
  if (Array.isArray(message.content) && message.content.length > 0) {
    for (let i = message.content.length - 1; i >= 0; i -= 1) {
      const part = message.content[i];
      if (part.type === 'text') {
        part.cache_control = { type: 'ephemeral' };
        break;
      }
    }
  }
}

/** Options for the neutral `PushStreamRequest` → OpenAI Chat serializer. */
export interface ToOpenAIChatOptions {
  /** Model id for the body. Defaults to `req.model`. */
  modelOverride?: string;
  /** Temperature applied when `req.temperature` is unset (the CLI passes 0.1). */
  temperatureDefault?: number;
  /** Whether to set `stream: true`. Defaults to true. */
  stream?: boolean;
  /**
   * Apply `cache_control: ephemeral` tagging from `req.cacheBreakpointIndices`
   * (system + up to `MAX_ROLLING_CACHE_BREAKPOINTS` rolling-tail messages).
   * Defaults to false — only OpenRouter→Anthropic routing wants it.
   */
  tagCacheBreakpoints?: boolean;
  /**
   * Emit `stream_options: { include_usage: true }` so the OpenAI-compat upstream
   * sends the trailing usage chunk. The Worker's neutral Zen-Go path sets this to
   * match what the legacy guardrail validator defaulted before forwarding —
   * without it, flipping Zen-Go to neutral loses token/cache accounting. Off by
   * default so other callers (CLI) keep their current behavior.
   */
  includeUsage?: boolean;
}

/**
 * Build an OpenAI Chat Completions request body directly from the neutral
 * `PushStreamRequest`. `systemPromptOverride` is prepended as a `system`
 * message; `messages` map 1:1 (multimodal `contentParts` → OpenAI content
 * parts); `reasoningBlocks` are dropped (OpenAI-compat-unsafe).
 */
export function toOpenAIChat(
  req: PushStreamRequest<LlmMessage>,
  options?: ToOpenAIChatOptions,
): OpenAIChatRequest {
  const model = options?.modelOverride ?? req.model;
  const reqMessages = Array.isArray(req.messages) ? req.messages : [];
  const hasOverride =
    typeof req.systemPromptOverride === 'string' && req.systemPromptOverride.length > 0;
  const tagCache = options?.tagCacheBreakpoints === true;

  const messages: OpenAIMessage[] = [];
  if (hasOverride) {
    messages.push({ role: 'system', content: req.systemPromptOverride as string });
  }
  for (const m of reqMessages) {
    messages.push({
      role: m.role,
      content:
        m.contentParts && m.contentParts.length > 0
          ? llmContentPartsToOpenAI(m.contentParts, tagCache)
          : m.content,
    });
  }

  const rawBreakpoints = req.cacheBreakpointIndices;
  if (tagCache && Array.isArray(rawBreakpoints) && rawBreakpoints.length > 0) {
    const offset = hasOverride ? 1 : 0;
    if (messages[0]?.role === 'system') {
      tagMessageCacheControl(messages[0]);
    }
    for (const reqIndex of rawBreakpoints.slice(-MAX_ROLLING_CACHE_BREAKPOINTS)) {
      const wireIndex = reqIndex + offset;
      const target = messages[wireIndex];
      if (!target) continue;
      // The leading system was tagged above; don't double-tag it.
      if (wireIndex === 0 && messages[0]?.role === 'system') continue;
      tagMessageCacheControl(target);
    }
  }

  const temperature =
    typeof req.temperature === 'number' ? req.temperature : options?.temperatureDefault;

  const nativeTools = Array.isArray(req.tools) && req.tools.length > 0 ? req.tools : [];

  return {
    model,
    messages,
    stream: options?.stream ?? true,
    ...(typeof temperature === 'number' ? { temperature } : {}),
    ...(typeof req.topP === 'number' ? { top_p: req.topP } : {}),
    ...(typeof req.maxTokens === 'number' ? { max_tokens: req.maxTokens } : {}),
    ...(options?.includeUsage ? { stream_options: { include_usage: true } } : {}),
    // Native function-calling tool schemas, when the caller attached them (gated
    // on model support upstream). Additive — `openai-sse-pump` normalizes any
    // native `tool_calls` back into the dispatcher's fenced JSON. `tool_choice:
    // 'auto'` keeps prose answers available. This serializer feeds the worker's
    // neutral-contract Zen-Go path (`handleZenGoChat`) and the CLI OpenAI-compat
    // adapters; both ignore the field when no caller sets `tools`.
    ...(nativeTools.length > 0 ? { tools: nativeTools, tool_choice: 'auto' } : {}),
    ...(req.responseFormat ? { response_format: toOpenAIResponseFormat(req.responseFormat) } : {}),
  };
}
