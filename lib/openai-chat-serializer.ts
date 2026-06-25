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
 * For the legacy `content` / `contentParts` path there's little translation to
 * do: `LlmMessage` roles map 1:1 to OpenAI roles, and `LlmContentPart` is
 * already the OpenAI `image_url` content-part shape. The Anthropic-conceptual
 * `contentBlocks` path (the contract migration) does real downcasting — most
 * notably the tool-block flatten, where one neutral message carrying
 * `tool_use` / `tool_result` blocks expands into several OpenAI messages
 * (`content` + `tool_calls[]` + standalone `role: 'tool'` results). The notable
 * choices:
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
  OpenAIToolCall,
} from './openai-chat-types.ts';
import type {
  LlmContentBlock,
  LlmContentPart,
  LlmMessage,
  LlmToolResultBlock,
  LlmToolUseBlock,
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

/**
 * Downcast the Anthropic-conceptual `LlmContentBlock[]` into OpenAI content
 * parts — contract migration (see
 * `docs/decisions/Provider Contract — Anthropic-Conceptual Neutral Hub.md`).
 * Handles `text` and `image` (the Anthropic-canonical image `source` collapses
 * to OpenAI's `image_url`: base64 → a `data:` URL, remote → the URL verbatim),
 * and DROPS `thinking` / `redacted_thinking` blocks — OpenAI-compat endpoints
 * reject the Push-private signed-reasoning sidecar, exactly as `reasoningBlocks`
 * are never emitted here (slice 2). Mirrors {@link llmContentPartsToOpenAI}:
 * THROWS on an unsupported/malformed block rather than dropping it, and
 * `keepCacheControl` gates the per-part marker the same way. Later slices add
 * `tool_use`/`tool_result`; those become their own OpenAI-shape targets then
 * (the "boss fight" downcast — `content` + `tool_calls` + `role: tool`).
 */
function llmContentBlocksToOpenAI(
  blocks: readonly LlmContentBlock[],
  keepCacheControl: boolean,
): OpenAIContentPart[] {
  const out: OpenAIContentPart[] = [];
  for (const rawBlock of blocks) {
    const block = rawBlock as {
      type?: unknown;
      text?: unknown;
      source?: { type?: unknown; media_type?: unknown; data?: unknown; url?: unknown };
      cache_control?: unknown;
    };
    const keep =
      keepCacheControl && block.cache_control
        ? { cache_control: block.cache_control as { type: 'ephemeral' } }
        : {};
    if (block.type === 'text' && typeof block.text === 'string') {
      out.push({ type: 'text', text: block.text, ...keep });
      continue;
    }
    if (block.type === 'image' && block.source && typeof block.source === 'object') {
      const source = block.source;
      // Validate the source shape before building the URL — a malformed source
      // (unknown `type`, or a `url` source missing its `url`) must throw the
      // advertised strict error, not serialize an `image_url` with an undefined
      // URL. Mirrors the runtime shape checks in `llmContentPartsToOpenAI`.
      if (
        source.type === 'base64' &&
        typeof source.media_type === 'string' &&
        typeof source.data === 'string'
      ) {
        out.push({
          type: 'image_url',
          image_url: { url: `data:${source.media_type};base64,${source.data}` },
          ...keep,
        });
        continue;
      }
      if (source.type === 'url' && typeof source.url === 'string') {
        out.push({ type: 'image_url', image_url: { url: source.url }, ...keep });
        continue;
      }
      // Malformed image source — fall through to the loud throw below.
    }
    // Signed reasoning has no OpenAI content-part representation and the
    // Push-private sidecar would be rejected by strict OpenAI-compat endpoints —
    // drop it, mirroring how `reasoningBlocks` are never emitted here.
    if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      continue;
    }
    throw new Error(
      `toOpenAIChat: unsupported or malformed content block (type: ${JSON.stringify(block.type)})`,
    );
  }
  return out.length > 0 ? out : [{ type: 'text', text: '' }];
}

/**
 * Flatten a tool-bearing `LlmContentBlock[]` (one neutral message carrying
 * `tool_use` / `tool_result` blocks) into the OpenAI representation — the "boss
 * fight" downcast of the contract migration (see the decision doc). OpenAI
 * splits what Anthropic models as one interleaved content array across several
 * messages: assistant `tool_use` blocks become the message's `tool_calls[]`
 * (the parsed `input` object → a stringified `function.arguments`), and each
 * `tool_result` block becomes a standalone `{ role: 'tool', tool_call_id,
 * content }` message. `text`/`image` blocks stay on the main message's content;
 * `thinking` is dropped (as in {@link llmContentBlocksToOpenAI}).
 *
 * Returns the ordered messages to splice in: tool-result messages first, then
 * the main (visible content + tool_calls) message when it carries anything.
 * THROWS on a malformed tool block, mirroring the strict text/image handling.
 */
function flattenToolBearingBlocks(
  role: string,
  blocks: readonly LlmContentBlock[],
  keepCacheControl: boolean,
): OpenAIMessage[] {
  const visible: LlmContentBlock[] = [];
  const toolUses: LlmToolUseBlock[] = [];
  const toolResults: LlmToolResultBlock[] = [];
  for (const block of blocks) {
    if (block.type === 'tool_use') {
      if (
        typeof block.id !== 'string' ||
        typeof block.name !== 'string' ||
        block.input === null ||
        typeof block.input !== 'object'
      ) {
        throw new Error(
          `toOpenAIChat: malformed tool_use block (id: ${JSON.stringify(
            (block as { id?: unknown }).id,
          )})`,
        );
      }
      toolUses.push(block);
    } else if (block.type === 'tool_result') {
      if (typeof block.tool_use_id !== 'string' || typeof block.content !== 'string') {
        throw new Error(
          `toOpenAIChat: malformed tool_result block (tool_use_id: ${JSON.stringify(
            (block as { tool_use_id?: unknown }).tool_use_id,
          )})`,
        );
      }
      toolResults.push(block);
    } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      // Dropped — no OpenAI representation (see llmContentBlocksToOpenAI).
    } else {
      visible.push(block);
    }
  }

  const messages: OpenAIMessage[] = [];

  // Tool results become standalone `role: 'tool'` messages. OpenAI has no
  // `is_error` slot, so a failed call is conveyed only through `content`.
  for (const tr of toolResults) {
    messages.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: tr.content });
  }

  // The main message: visible content (downcast as usual) plus any tool calls.
  // Anthropic carries `input` as a parsed object; OpenAI wants a JSON string.
  const toolCalls: OpenAIToolCall[] = toolUses.map((tu) => ({
    id: tu.id,
    type: 'function',
    function: { name: tu.name, arguments: JSON.stringify(tu.input) },
  }));
  const hasVisible = visible.length > 0;
  if (hasVisible || toolCalls.length > 0) {
    const message: OpenAIMessage = {
      role,
      content: hasVisible ? llmContentBlocksToOpenAI(visible, keepCacheControl) : null,
    };
    if (toolCalls.length > 0) message.tool_calls = toolCalls;
    messages.push(message);
  }

  return messages;
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
 * message; `messages` map 1:1, with content resolved by precedence
 * (`contentBlocks` → `contentParts` → `content` text); `reasoningBlocks` are
 * dropped (OpenAI-compat-unsafe).
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
    // Precedence mirrors the additive-field pattern: the rich block
    // representation wins when present, else the legacy `contentParts`, else
    // the `content` text fallback. No production path emits `contentBlocks`
    // yet (see the decision doc), so existing traffic is unaffected.
    if (m.contentBlocks && m.contentBlocks.length > 0) {
      const hasToolBlocks = m.contentBlocks.some(
        (b) => b.type === 'tool_use' || b.type === 'tool_result',
      );
      if (hasToolBlocks) {
        // Boss-fight flatten: one neutral message can map to several OpenAI
        // messages (standalone tool-result messages + the content/tool_calls
        // message), so push the expansion rather than a single message.
        messages.push(...flattenToolBearingBlocks(m.role, m.contentBlocks, tagCache));
      } else {
        messages.push({
          role: m.role,
          content: llmContentBlocksToOpenAI(m.contentBlocks, tagCache),
        });
      }
      continue;
    }
    if (m.contentParts && m.contentParts.length > 0) {
      messages.push({ role: m.role, content: llmContentPartsToOpenAI(m.contentParts, tagCache) });
      continue;
    }
    messages.push({ role: m.role, content: m.content });
  }

  const rawBreakpoints = req.cacheBreakpointIndices;
  if (tagCache && Array.isArray(rawBreakpoints) && rawBreakpoints.length > 0) {
    // NOTE: this maps a request-message index to a wire index assuming one
    // output message per input message (`reqIndex + offset`). The tool-block
    // flatten above can emit multiple wire messages for one input message,
    // which would skew this mapping. The two don't co-occur today — no producer
    // emits `contentBlocks`, and cache tagging is OpenRouter→Anthropic-only — so
    // this is correct for current traffic; it must be revisited when the
    // producer flip lands (final migration slice).
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
    // 'auto'` keeps prose answers available. This serializer feeds neutral
    // OpenAI-compatible Worker paths (Vertex Gemini, Zen-Go) and the CLI
    // OpenAI-compat adapters; all ignore the field when no caller sets `tools`.
    ...(nativeTools.length > 0 ? { tools: nativeTools, tool_choice: 'auto' } : {}),
    ...(req.responseFormat ? { response_format: toOpenAIResponseFormat(req.responseFormat) } : {}),
  };
}
