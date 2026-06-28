/**
 * Neutral `PushStreamRequest` → OpenAI Chat Completions serializer.
 *
 * The OpenAI peer of `toAnthropicMessages` / `toGeminiGenerateContent` — the
 * "explicit peer serializer" from `docs/runbooks/Provider Request Normalization.md`.
 * OpenAI Chat Completions is the wire shape every OpenAI-compatible endpoint
 * speaks (OpenRouter, Zen, NVIDIA, Kilocode, direct
 * OpenAI, and the OpenAI-compat transports of Vertex / Zen-Go), so this is what
 * those neutral paths serialize to instead of hand-rolling the body inline.
 *
 * Plain text remains a 1:1 fallback for text-only and degraded exchanges. Rich
 * content runs through the Anthropic-conceptual `contentBlocks` path (the
 * contract migration), which does real downcasting — most notably the tool-block
 * flatten, where one neutral message carrying
 * `tool_use` / `tool_result` blocks expands into several OpenAI messages
 * (`content` + `tool_calls[]` + standalone `role: 'tool'` results). The notable
 * choices:
 *
 *   - Signed `reasoningBlocks` are NOT emitted. The Push-private
 *     `reasoning_blocks` sidecar is an unknown parameter to strict
 *     OpenAI-compat endpoints (they may reject it); it only round-trips on the
 *     Anthropic-bridge surface. Plain `reasoningContent` is different: when a
 *     route-gated caller sets it, it is emitted as the upstream
 *     `reasoning_content` field for DeepSeek thinking-mode replay.
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
  OpenAIFunctionTool,
  OpenAIJsonSchemaResponseFormat,
  OpenAIMessage,
  OpenAIToolCall,
} from './openai-chat-types.ts';
import type {
  CacheControl,
  LlmContentBlock,
  LlmMessage,
  PushStreamRequest,
  ResponseFormatSpec,
  ToolFunctionSchema,
} from './provider-contract.ts';
import { EPHEMERAL_CACHE_CONTROL } from './provider-contract.ts';
import { MAX_ROLLING_CACHE_BREAKPOINTS } from './context-transformer.ts';
import { withRequestContentBlocks } from './content-blocks.ts';
import {
  resolveGeminiReplaySignature,
  toolCallThoughtSignatureFields,
} from './gemini-thought-signature.ts';

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

export function flatToolToOpenAITool(tool: ToolFunctionSchema): OpenAIFunctionTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  };
}

/** Inverse of {@link flatToolToOpenAITool}: lift OpenAI's nested function-tool
 *  wire shape back into the flat canonical `ToolFunctionSchema`. Used by the
 *  legacy OpenAI-shape → Anthropic/Gemini bridge entry points, which receive an
 *  `OpenAIChatRequest` (nested tools) and must normalize to the flat canonical
 *  before the providers' downcast converters (which now read flat). */
export function openAIToolToFlatTool(tool: OpenAIFunctionTool): ToolFunctionSchema {
  return {
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters,
  };
}

/**
 * Downcast the Anthropic-conceptual `LlmContentBlock[]` into OpenAI content
 * parts — contract migration (see
 * `docs/decisions/Provider Contract — Anthropic-Conceptual Neutral Hub.md`).
 * Handles `text` and `image` (the Anthropic-canonical image `source` collapses
 * to OpenAI's `image_url`: base64 → a `data:` URL, remote → the URL verbatim),
 * and DROPS `thinking` / `redacted_thinking` blocks — OpenAI-compat endpoints
 * reject the Push-private signed-reasoning sidecar, exactly as signed
 * `reasoningBlocks` are never emitted here (slice 2). Plain `reasoningContent`
 * is carried on the assistant message, not as a content block. THROWS on an
 * unsupported/malformed block
 * rather than dropping it, and
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
        ? { cache_control: block.cache_control as CacheControl }
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
      // URL. Mirrors the runtime shape checks in the request materializer.
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
    // Push-private sidecar would be rejected by strict OpenAI-compat endpoints.
    // Drop it; plain DeepSeek reasoning replay is emitted separately as
    // assistant `reasoning_content` when the route-gated caller sets it.
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
 * signed `thinking` is dropped (as in {@link llmContentBlocksToOpenAI});
 * plain `reasoningContent`, when present, is attached to the first flushed
 * assistant message as `reasoning_content`.
 *
 * Returns the ordered messages to splice in: tool-result messages first, then
 * the main (visible content + tool_calls) message when it carries anything.
 * THROWS on a malformed tool block, mirroring the strict text/image handling.
 */
function flattenToolBearingBlocks(
  role: string,
  blocks: readonly LlmContentBlock[],
  keepCacheControl: boolean,
  reasoningContent?: string,
  geminiThoughtSignatureFallback = false,
): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];
  // Gemini validates that an assistant turn's FIRST tool call carries a
  // thoughtSignature; track whether one's been emitted so the placeholder
  // fallback (Gemini-fronted compat upstreams only) fills just that call.
  let seenToolCall = false;

  // Walk blocks IN ORDER, accumulating visible content + tool calls into a
  // pending main message and flushing it before each tool result. This
  // preserves the call→result ordering OpenAI requires: a `role: 'tool'`
  // message must follow the assistant message that declares its `tool_calls`
  // entry, so we can't simply hoist all results to the front.
  let pendingVisible: LlmContentBlock[] = [];
  let pendingToolCalls: OpenAIToolCall[] = [];
  let reasoningContentAttached = false;
  const flushMain = () => {
    if (pendingVisible.length === 0 && pendingToolCalls.length === 0) return;
    const message: OpenAIMessage = {
      role,
      content:
        pendingVisible.length > 0
          ? llmContentBlocksToOpenAI(pendingVisible, keepCacheControl)
          : null,
    };
    if (pendingToolCalls.length > 0) message.tool_calls = pendingToolCalls;
    if (
      role === 'assistant' &&
      !reasoningContentAttached &&
      typeof reasoningContent === 'string' &&
      reasoningContent.length > 0
    ) {
      message.reasoning_content = reasoningContent;
      reasoningContentAttached = true;
    }
    messages.push(message);
    pendingVisible = [];
    pendingToolCalls = [];
    // A flush closes the current assistant message. When a `tool_result` flushes
    // mid-list, a following `tool_use` starts a NEW assistant message (= a new
    // Gemini turn), so its first call must be eligible for the placeholder again
    // — reset the per-turn first-call tracker. (Parallel calls in one turn don't
    // flush between them, so this never clears a genuine trailing-parallel skip.)
    seenToolCall = false;
  };

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
      // Anthropic carries `input` as a parsed object; OpenAI wants a JSON string.
      // Round-trip Gemini's `thoughtSignature` when present (an OpenAI-compat
      // upstream fronting Gemini, e.g. Ollama Cloud, 400s on replay without it).
      // Emitted in BOTH wire shapes (top-level sibling + Google's `extra_content`
      // envelope) since compat upstreams disagree on which they honor. When the
      // target is Gemini (`geminiThoughtSignatureFallback`) and the turn's first
      // call carries no captured signature, substitute the documented placeholder
      // so the replay doesn't 400; non-Gemini upstreams pass `false` and keep
      // emitting only a real signature (which they never have → no field).
      const ownSignature =
        typeof block.thoughtSignature === 'string' && block.thoughtSignature
          ? block.thoughtSignature
          : undefined;
      const replaySignature = geminiThoughtSignatureFallback
        ? resolveGeminiReplaySignature({ ownSignature, isFirstCallInTurn: !seenToolCall })
        : ownSignature;
      seenToolCall = true;
      pendingToolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input) },
        ...toolCallThoughtSignatureFields(replaySignature),
      });
    } else if (block.type === 'tool_result') {
      if (typeof block.tool_use_id !== 'string' || typeof block.content !== 'string') {
        throw new Error(
          `toOpenAIChat: malformed tool_result block (tool_use_id: ${JSON.stringify(
            (block as { tool_use_id?: unknown }).tool_use_id,
          )})`,
        );
      }
      // Emit any assistant message accumulated so far (declaring the calls this
      // result may answer) before the standalone `role: 'tool'` message. OpenAI
      // has no `is_error` slot, so a failed call is conveyed only via `content`.
      flushMain();
      messages.push({ role: 'tool', tool_call_id: block.tool_use_id, content: block.content });
    } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      // Intentionally dropped (not thrown): signed reasoning has no OpenAI
      // content-part representation and the Push-private sidecar would be
      // rejected by strict OpenAI-compat endpoints. Plain DeepSeek reasoning
      // replay is emitted separately as assistant `reasoning_content`. Unknown
      // block types still throw (below / there).
    } else {
      pendingVisible.push(block);
    }
  }
  flushMain();

  return messages;
}

/** Tag a message's content with `cache_control: ephemeral` — promoting a
 *  bare-string content to a single text part, or tagging the last text part of
 *  a multimodal message. Mirrors the wire-tagging the CLI/orchestrator apply. */
function tagMessageCacheControl(message: OpenAIMessage): void {
  if (typeof message.content === 'string') {
    message.content = [
      { type: 'text', text: message.content, cache_control: EPHEMERAL_CACHE_CONTROL },
    ];
    return;
  }
  if (Array.isArray(message.content) && message.content.length > 0) {
    for (let i = message.content.length - 1; i >= 0; i -= 1) {
      const part = message.content[i];
      if (part.type === 'text') {
        part.cache_control = EPHEMERAL_CACHE_CONTROL;
        break;
      }
    }
  }
}

function withReasoningContent(
  message: OpenAIMessage,
  reasoningContent: string | undefined,
): OpenAIMessage {
  if (
    message.role === 'assistant' &&
    typeof reasoningContent === 'string' &&
    reasoningContent.length > 0
  ) {
    return { ...message, reasoning_content: reasoningContent };
  }
  return message;
}

/** Options for the neutral `PushStreamRequest` → OpenAI Chat serializer. */
export interface ToOpenAIChatOptions {
  /** Model id for the body. Defaults to `req.model`. */
  modelOverride?: string;
  /** Temperature applied when `req.temperature` is unset (the CLI passes 0.1). */
  temperatureDefault?: number;
  /**
   * Request field used for `req.maxTokens`. Defaults to `max_tokens` for broad
   * OpenAI-compatible provider support; callers can opt into the newer Chat
   * Completions `max_completion_tokens` field when their upstream requires it.
   */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
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
  /**
   * Substitute the documented placeholder `thought_signature` on a tool turn's
   * first signatureless call. Only set this when the upstream fronts Gemini (it
   * 400s otherwise on the replay turn); leave false for every other OpenAI-compat
   * route so their bodies stay byte-identical. See
   * `gemini-thought-signature.ts#resolveGeminiReplaySignature`.
   */
  geminiThoughtSignatureFallback?: boolean;
}

/**
 * Build an OpenAI Chat Completions request body directly from the neutral
 * `PushStreamRequest`. `systemPromptOverride` is prepended as a `system`
 * message; `messages` map 1:1, with content resolved by precedence
 * (`contentBlocks` → `content` text); signed `reasoningBlocks` are dropped
 * (OpenAI-compat-unsafe), while route-gated plain `reasoningContent` is emitted
 * as `reasoning_content`. `contentParts` are normalized into `contentBlocks` by
 * `withRequestContentBlocks` before this loop.
 */
export function toOpenAIChat(
  req: PushStreamRequest<LlmMessage>,
  options?: ToOpenAIChatOptions,
): OpenAIChatRequest {
  const model = options?.modelOverride ?? req.model;
  // Producer flip: materialize contentBlocks for multimodal/tool turns so they
  // run the block path in production. See lib/content-blocks.ts.
  const reqMessages = withRequestContentBlocks(Array.isArray(req.messages) ? req.messages : []);
  const hasOverride =
    typeof req.systemPromptOverride === 'string' && req.systemPromptOverride.length > 0;
  const tagCache = options?.tagCacheBreakpoints === true;

  const messages: OpenAIMessage[] = [];
  if (hasOverride) {
    messages.push({ role: 'system', content: req.systemPromptOverride as string });
  }
  // Wire index of the LAST OpenAI message each request message produced. The
  // tool-block flatten can expand one request message into several wire
  // messages, so cache-breakpoint tagging below resolves the wire target
  // through this map rather than assuming a 1:1 `reqIndex + offset` mapping.
  // Every request message produces at least one wire message (the empty-content
  // fallback covers the degenerate cases), so each entry is always valid.
  const reqIndexToWireIndex: number[] = [];
  for (const m of reqMessages) {
    // Precedence mirrors the additive-field pattern: the rich block
    // representation wins when present, else the permanent `content` text
    // fallback carries text-only and degraded tool exchanges.
    if (m.contentBlocks && m.contentBlocks.length > 0) {
      const hasToolBlocks = m.contentBlocks.some(
        (b) => b.type === 'tool_use' || b.type === 'tool_result',
      );
      if (hasToolBlocks) {
        // Boss-fight flatten: one neutral message can map to several OpenAI
        // messages (standalone tool-result messages + the content/tool_calls
        // message), so push the expansion rather than a single message.
        messages.push(
          ...flattenToolBearingBlocks(
            m.role,
            m.contentBlocks,
            tagCache,
            m.reasoningContent,
            options?.geminiThoughtSignatureFallback === true,
          ),
        );
      } else {
        messages.push(
          withReasoningContent(
            {
              role: m.role,
              content: llmContentBlocksToOpenAI(m.contentBlocks, tagCache),
            },
            m.reasoningContent,
          ),
        );
      }
    } else {
      messages.push(withReasoningContent({ role: m.role, content: m.content }, m.reasoningContent));
    }
    reqIndexToWireIndex.push(messages.length - 1);
  }

  const rawBreakpoints = req.cacheBreakpointIndices;
  if (tagCache && Array.isArray(rawBreakpoints) && rawBreakpoints.length > 0) {
    if (messages[0]?.role === 'system') {
      tagMessageCacheControl(messages[0]);
    }
    for (const reqIndex of rawBreakpoints.slice(-MAX_ROLLING_CACHE_BREAKPOINTS)) {
      // Resolve through the flatten-aware map: a request message that expanded
      // into several wire messages tags its LAST one (the prefix boundary).
      const wireIndex = reqIndexToWireIndex[reqIndex];
      if (wireIndex === undefined) continue;
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
    ...(typeof req.maxTokens === 'number'
      ? options?.maxTokensField === 'max_completion_tokens'
        ? { max_completion_tokens: req.maxTokens }
        : { max_tokens: req.maxTokens }
      : {}),
    ...(options?.includeUsage ? { stream_options: { include_usage: true } } : {}),
    // Native function-calling tool schemas, when the caller attached them (gated
    // on model support upstream). Additive — `openai-sse-pump` emits complete
    // native calls as structured `native_tool_call` events. `tool_choice:
    // 'auto'` keeps prose answers available. This serializer feeds neutral
    // OpenAI-compatible Worker paths (Vertex Gemini, Zen-Go) and the CLI
    // OpenAI-compat adapters; all ignore the field when no caller sets `tools`.
    ...(nativeTools.length > 0
      ? { tools: nativeTools.map(flatToolToOpenAITool), tool_choice: 'auto' }
      : {}),
    ...(req.responseFormat ? { response_format: toOpenAIResponseFormat(req.responseFormat) } : {}),
  };
}

/**
 * Expand the tool-bearing turns of an already-assembled `LlmMessage[]` into
 * OpenAI wire messages: the assistant tool-call turn becomes a `tool_calls[]`
 * message and each `tool_result` becomes a standalone
 * `{ role: 'tool', tool_call_id }` message. Non-tool turns pass through by
 * reference, untouched — so an adapter that already built its body keeps its
 * existing per-message serialization for everything except tool history.
 *
 * This is the seam for legacy raw-forward OpenAI-compat adapters (e.g. Ollama
 * Cloud's `/v1/chat/completions` proxy) that assemble their own body instead of
 * going through {@link toOpenAIChat}, yet need native tool-history shape when
 * function calling is active. Without it, tool results reach the model as
 * `role: 'user'` `[TOOL_RESULT]` text, which a weaker model can read as
 * untrusted user-injected data rather than its own tool output.
 *
 * Assumes tool sidecars were already materialized into `contentBlocks` upstream
 * (`toLLMMessages` with `emitContentBlocks: true`, which runs the whole-request
 * adjacency/pairing pass in `materializeToolContentBlocks`). A tool turn whose
 * pair failed that pass carries no tool `contentBlocks` and falls through to its
 * verbatim text form — the same graceful degradation {@link toOpenAIChat} uses.
 * Cache tagging is off: these adapters never opt into breakpoint tagging and the
 * upstream ignores `cache_control`.
 *
 * `geminiThoughtSignatureFallback` is forwarded to the flatten so a Gemini-fronted
 * compat upstream (Ollama Cloud / OpenRouter `google/gemini-*`) gets the
 * placeholder `thought_signature` on a first signatureless call instead of a 400;
 * the adapter sets it via `isGeminiModelId(req.model)`.
 */
export interface ToolExpandableMessage {
  role: string;
  contentBlocks?: LlmContentBlock[];
  /** Plain reasoning to replay on the flushed assistant turn. Both naming
   *  conventions are read so the neutral `LlmMessage` (`reasoningContent`) and
   *  the web adapter's wire-shaped message (`reasoning_content`) both satisfy
   *  this without a cast. */
  reasoningContent?: string;
  reasoning_content?: string;
}

export function expandToolMessagesForOpenAICompat<T extends ToolExpandableMessage>(
  messages: readonly T[],
  geminiThoughtSignatureFallback = false,
): Array<T | OpenAIMessage> {
  const out: Array<T | OpenAIMessage> = [];
  for (const m of messages) {
    const blocks = m.contentBlocks;
    if (blocks && blocks.length > 0) {
      const reasoning = m.reasoningContent ?? m.reasoning_content;
      const hasToolBlocks = blocks.some((b) => b.type === 'tool_use' || b.type === 'tool_result');
      if (hasToolBlocks) {
        out.push(
          ...flattenToolBearingBlocks(
            m.role,
            blocks,
            false,
            reasoning,
            geminiThoughtSignatureFallback,
          ),
        );
      } else {
        // Non-tool contentBlocks (multimodal / attachment turns). Downcast to
        // OpenAI content parts and DROP the Push-private `contentBlocks` field —
        // a strict OpenAI-compat transport may reject the unknown message field,
        // and these raw-forward adapters proxy the body verbatim. Mirrors
        // `toOpenAIChat`'s non-tool branch; a blunt strip would lose images that
        // live only in `contentBlocks` (attachment turns whose `content` is just
        // the text fallback).
        out.push(
          withReasoningContent(
            { role: m.role, content: llmContentBlocksToOpenAI(blocks, false) },
            reasoning,
          ),
        );
      }
    } else {
      out.push(m);
    }
  }
  return out;
}
