import { asRecord } from './utils';
import { type CacheControl, EPHEMERAL_CACHE_CONTROL } from '@push/lib/provider-contract';
import type {
  OpenAIChatRequest,
  OpenAIContentPart,
  OpenAIMessage,
  OpenAIReasoningBlock,
  OpenAIToolCall,
} from '@push/lib/openai-chat-types';
export type {
  OpenAIChatRequest,
  OpenAIContentPart,
  OpenAIMessage,
  OpenAIReasoningBlock,
} from '@push/lib/openai-chat-types';
import type {
  AIProviderType,
  LlmContentBlock,
  LlmContentPart,
  LlmImageSource,
  LlmMessage,
  PushStreamRequest,
  ResponseFormatSpec,
  ToolFunctionSchema,
} from '@push/lib/provider-contract';
import { PUSH_STREAM_WIRE_CONTRACT } from '@push/lib/provider-wire';
import {
  readToolCallThoughtSignature,
  toolCallFunctionThoughtSignatureField,
  toolCallThoughtSignatureFields,
} from '@push/lib/gemini-thought-signature';

const MAX_REASONING_BLOCKS_PER_MESSAGE = 64;
const MAX_REASONING_BLOCK_SIGNATURE_LENGTH = 16_384;
/** Per-block cap on visible thinking text. Real Anthropic thinking budgets
 *  top out around 64K tokens (~256K chars at 4 chars/token); 512K is the
 *  upper bound for any one block we'd accept from a client request. Any
 *  larger and we'd waste upstream bandwidth or exhaust memory before the
 *  upstream itself complained. */
const MAX_REASONING_BLOCK_TEXT_LENGTH = 512_000;

/** Strip + validate the Push-private `reasoning_blocks` sidecar on an
 *  assistant message. Returns `undefined` (and silently drops the field)
 *  when the shape is wrong — this is metadata not user-authored input, so
 *  a malformed entry shouldn't 400 the entire turn; it just means this
 *  turn won't carry reasoning. The bridge layer is the only consumer that
 *  cares; OpenAI Chat / non-Anthropic Vertex ignore the field. */
function normalizeReasoningBlocks(raw: unknown): OpenAIReasoningBlock[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  if (raw.length === 0) return undefined;
  if (raw.length > MAX_REASONING_BLOCKS_PER_MESSAGE) return undefined;
  const out: OpenAIReasoningBlock[] = [];
  for (const entry of raw) {
    const rec = asRecord(entry);
    if (!rec) return undefined;
    if (rec.type === 'thinking') {
      if (typeof rec.text !== 'string') return undefined;
      if (rec.text.length > MAX_REASONING_BLOCK_TEXT_LENGTH) return undefined;
      if (typeof rec.signature !== 'string' || !rec.signature) return undefined;
      if (rec.signature.length > MAX_REASONING_BLOCK_SIGNATURE_LENGTH) return undefined;
      out.push({ type: 'thinking', text: rec.text, signature: rec.signature });
      continue;
    }
    if (rec.type === 'redacted_thinking') {
      if (typeof rec.data !== 'string' || !rec.data) return undefined;
      if (rec.data.length > MAX_REASONING_BLOCK_SIGNATURE_LENGTH) return undefined;
      out.push({ type: 'redacted_thinking', data: rec.data });
      continue;
    }
    return undefined;
  }
  return out.length > 0 ? out : undefined;
}

function normalizeReasoningContent(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  if (raw.length === 0) return undefined;
  if (raw.length > MAX_REASONING_BLOCK_TEXT_LENGTH) return undefined;
  return raw;
}

const MAX_ASSISTANT_CONTENT_BLOCKS = 256;
const MAX_TOOL_CALLS_PER_MESSAGE = 64;

/** Validate the Push-private `assistant_content_blocks` sidecar used for
 *  Anthropic `pause_turn` replay. Anthropic treats the replayed content
 *  as opaque continuation context, so we don't introspect block shape —
 *  just enforce that it's an array of objects within a sane bound.
 *  Returns `undefined` (silently dropping the field) on malformed input,
 *  same fail-closed posture as `normalizeReasoningBlocks` — bad metadata
 *  shouldn't 400 the turn, the replay just won't go through. */
function normalizeAssistantContentBlocks(raw: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(raw)) return undefined;
  if (raw.length === 0) return undefined;
  if (raw.length > MAX_ASSISTANT_CONTENT_BLOCKS) return undefined;
  const out: Array<Record<string, unknown>> = [];
  for (const entry of raw) {
    const rec = asRecord(entry);
    if (!rec) return undefined;
    out.push(rec);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Validate + normalize an assistant message's `tool_calls` (OpenAI native
 * function calling). The legacy raw-forward adapters (Ollama Cloud, OpenRouter)
 * build their own OpenAI body and proxy it through this normalizer, so without
 * preserving `tool_calls` here the field is silently dropped and the upstream
 * receives an assistant turn whose tool calls vanished (paired with a dangling
 * `role: 'tool'` result). Unlike the lenient `reasoning_blocks` / cache_control
 * helpers, this fails CLOSED with a discriminated result so the caller can 400
 * a malformed payload rather than forward a half-stripped tool exchange.
 * Returns `{ ok: true, value: undefined }` when the field is absent.
 */
function normalizeToolCalls(
  raw: unknown,
): { ok: true; value: OpenAIToolCall[] | undefined } | { ok: false } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_TOOL_CALLS_PER_MESSAGE) {
    return { ok: false };
  }
  const out: OpenAIToolCall[] = [];
  for (const entry of raw) {
    const rec = asRecord(entry);
    const fn = asRecord(rec?.function);
    if (
      !rec ||
      typeof rec.id !== 'string' ||
      rec.id.trim().length === 0 ||
      rec.type !== 'function' ||
      !fn ||
      typeof fn.name !== 'string' ||
      fn.name.trim().length === 0 ||
      typeof fn.arguments !== 'string'
    ) {
      return { ok: false };
    }
    // Round-trip Gemini's `thoughtSignature` when present — an OpenAI-compat
    // upstream fronting Gemini (Ollama Cloud) 400s on replay without it.
    // Model-generated and low-risk; read ANY wire shape (top-level sibling,
    // Google's `extra_content` envelope, or Ollama's nested
    // `function.thought_signature`) and re-emit ALL THREE so the field survives
    // whichever the upstream honors. Crucially the nested shape must be
    // re-emitted into the rebuilt `function` object here too — Ollama Cloud reads
    // ONLY `function.thought_signature`, so dropping it on this proxy normalizer
    // would strip the one shape that reaches the forwarded Gemini and the replay
    // would still 400 (the production web path runs through here). Drop silently
    // when absent (a missing signature isn't a 400-able request shape on its own).
    const sig = readToolCallThoughtSignature(rec);
    out.push({
      id: rec.id,
      type: 'function',
      function: {
        name: fn.name,
        arguments: fn.arguments,
        ...toolCallFunctionThoughtSignatureField(sig),
      },
      ...toolCallThoughtSignatureFields(sig),
    });
  }
  return { ok: true, value: out };
}

/** Extract a `cache_control` field from a raw content part and return the
 *  normalized shape Push emits today, or `undefined` if the field is absent
 *  or malformed. Fail-closed by design: an unrecognized cache_control shape
 *  is dropped silently rather than passed through unchecked, so the request
 *  still succeeds upstream (just without that breakpoint contributing to
 *  the cached prefix).
 *
 *  Push currently only emits `{ type: 'ephemeral' }`. Future variants
 *  (`ttl`, `{ type: 'persistent' }`) can extend this without changing the
 *  upstream contract; just add the new keys here. */
function pickCacheControl(rawPart: Record<string, unknown>): CacheControl | undefined {
  const cc = asRecord(rawPart.cache_control);
  if (!cc) return undefined;
  if (cc.type === 'ephemeral') return EPHEMERAL_CACHE_CONTROL;
  return undefined;
}

export interface ChatRequestPolicy {
  routeLabel: string;
  maxOutputTokens: number;
  maxMessages?: number;
  maxContentPartsPerMessage?: number;
  maxChoices?: number;
  /**
   * Provider stamped onto the validated neutral request. The endpoint is
   * provider-specific today (it already commits to an upstream + key), so the
   * ROUTE is authoritative — a body `provider` can't redirect where the request
   * goes. Each wire-accepting handler passes its own; defaults to `'anthropic'`
   * (the first dual-accept route) when unset. Ignored by the legacy validator.
   */
  provider?: AIProviderType;
}

export interface ValidatedChatRequest {
  parsed: OpenAIChatRequest;
  bodyText: string;
  adjustments: string[];
}

const DEFAULT_MAX_MESSAGES = 400;
const DEFAULT_MAX_CONTENT_PARTS_PER_MESSAGE = 64;
const DEFAULT_MAX_CHOICES = 1;
const ALLOWED_MESSAGE_ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool']);

function validationError(error: string): { ok: false; status: number; error: string } {
  return { ok: false, status: 400, error };
}

export function validateAndNormalizeChatRequest(
  bodyText: string,
  policy: ChatRequestPolicy,
): { ok: true; value: ValidatedChatRequest } | { ok: false; status: number; error: string } {
  let parsedUnknown: unknown;
  try {
    parsedUnknown = JSON.parse(bodyText);
  } catch {
    return validationError(`${policy.routeLabel} request: invalid JSON body`);
  }

  const parsed = asRecord(parsedUnknown);
  if (!parsed) {
    return validationError(`${policy.routeLabel} request must be a JSON object.`);
  }

  const model = typeof parsed.model === 'string' ? parsed.model.trim() : '';
  if (!model) {
    return validationError(`${policy.routeLabel} request is missing "model".`);
  }

  if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) {
    return validationError(
      `${policy.routeLabel} request must include a non-empty "messages" array.`,
    );
  }

  const maxMessages = policy.maxMessages ?? DEFAULT_MAX_MESSAGES;
  if (parsed.messages.length > maxMessages) {
    return validationError(
      `${policy.routeLabel} request has too many messages (${parsed.messages.length}). Limit is ${maxMessages}.`,
    );
  }

  const normalizedMessages: OpenAIMessage[] = [];
  const maxContentPartsPerMessage =
    policy.maxContentPartsPerMessage ?? DEFAULT_MAX_CONTENT_PARTS_PER_MESSAGE;

  for (let index = 0; index < parsed.messages.length; index += 1) {
    const messageRecord = asRecord(parsed.messages[index]);
    if (!messageRecord) {
      return validationError(
        `${policy.routeLabel} request message ${index + 1} must be an object.`,
      );
    }

    const role = typeof messageRecord.role === 'string' ? messageRecord.role.trim() : '';
    if (!ALLOWED_MESSAGE_ROLES.has(role)) {
      return validationError(
        `${policy.routeLabel} request message ${index + 1} has an invalid role.`,
      );
    }

    const reasoningBlocks =
      role === 'assistant' ? normalizeReasoningBlocks(messageRecord.reasoning_blocks) : undefined;
    const reasoningContent =
      role === 'assistant' ? normalizeReasoningContent(messageRecord.reasoning_content) : undefined;
    const assistantContentBlocks =
      role === 'assistant'
        ? normalizeAssistantContentBlocks(messageRecord.assistant_content_blocks)
        : undefined;

    // Native function-calling round-trip on the legacy raw-forward adapters
    // (Ollama Cloud, OpenRouter): the assistant turn carries `tool_calls[]` and
    // each `role: 'tool'` result carries the `tool_call_id` linking it back.
    // Preserve both (validated) — dropping them desyncs the exchange and the
    // upstream rejects a tool result with no preceding call.
    let toolCalls: OpenAIToolCall[] | undefined;
    if (role === 'assistant' && messageRecord.tool_calls !== undefined) {
      const result = normalizeToolCalls(messageRecord.tool_calls);
      if (!result.ok) {
        return validationError(
          `${policy.routeLabel} request message ${index + 1} has invalid "tool_calls".`,
        );
      }
      toolCalls = result.value;
    }
    const toolCallId =
      role === 'tool' && typeof messageRecord.tool_call_id === 'string'
        ? messageRecord.tool_call_id
        : undefined;

    const rawContent = messageRecord.content;
    // Allow undefined `content` on assistant turns that carry the pause_turn
    // sidecar — the bridge uses `assistant_content_blocks` verbatim and the
    // text content is never read. Without this branch we'd push a
    // content-less assistant message and the bridge's text path would
    // synthesize an empty `[{ type: 'text', text: '' }]` content[], shadowing
    // the sidecar.
    if (typeof rawContent === 'string' || rawContent === null || rawContent === undefined) {
      normalizedMessages.push({
        ...(Object.prototype.hasOwnProperty.call(messageRecord, 'content')
          ? { content: rawContent as string | null }
          : {}),
        role,
        ...(reasoningBlocks ? { reasoning_blocks: reasoningBlocks } : {}),
        ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
        ...(assistantContentBlocks ? { assistant_content_blocks: assistantContentBlocks } : {}),
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
        ...(toolCallId ? { tool_call_id: toolCallId } : {}),
      });
      continue;
    }

    if (!Array.isArray(rawContent)) {
      return validationError(
        `${policy.routeLabel} request message ${index + 1} has invalid "content".`,
      );
    }

    if (rawContent.length === 0) {
      return validationError(
        `${policy.routeLabel} request message ${index + 1} has an empty content parts array.`,
      );
    }

    if (rawContent.length > maxContentPartsPerMessage) {
      return validationError(
        `${policy.routeLabel} request message ${index + 1} has too many content parts (${rawContent.length}). Limit is ${maxContentPartsPerMessage}.`,
      );
    }

    const normalizedParts: OpenAIContentPart[] = [];
    for (let partIndex = 0; partIndex < rawContent.length; partIndex += 1) {
      const rawPart = asRecord(rawContent[partIndex]);
      if (!rawPart) {
        return validationError(
          `${policy.routeLabel} request message ${index + 1} has an invalid content part.`,
        );
      }

      if (rawPart.type === 'text') {
        if (typeof rawPart.text !== 'string') {
          return validationError(
            `${policy.routeLabel} request message ${index + 1} has a text part without "text".`,
          );
        }
        const cacheControl = pickCacheControl(rawPart);
        normalizedParts.push({
          type: 'text',
          text: rawPart.text,
          ...(cacheControl ? { cache_control: cacheControl } : {}),
        });
        continue;
      }

      if (rawPart.type === 'image_url') {
        const imageUrl = asRecord(rawPart.image_url);
        if (typeof imageUrl?.url !== 'string' || !imageUrl.url.trim()) {
          return validationError(
            `${policy.routeLabel} request message ${index + 1} has an image part without a URL.`,
          );
        }
        const cacheControl = pickCacheControl(rawPart);
        normalizedParts.push({
          type: 'image_url',
          image_url: { url: imageUrl.url },
          ...(cacheControl ? { cache_control: cacheControl } : {}),
        });
        continue;
      }

      return validationError(
        `${policy.routeLabel} request message ${index + 1} has an unsupported content part type.`,
      );
    }

    normalizedMessages.push({
      role,
      content: normalizedParts,
      ...(reasoningBlocks ? { reasoning_blocks: reasoningBlocks } : {}),
      ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
      ...(assistantContentBlocks ? { assistant_content_blocks: assistantContentBlocks } : {}),
      ...(toolCalls ? { tool_calls: toolCalls } : {}),
      ...(toolCallId ? { tool_call_id: toolCallId } : {}),
    });
  }

  const normalized: Record<string, unknown> = {
    ...parsed,
    model,
    messages: normalizedMessages,
    stream: true,
    // Always request the trailing usage chunk. OpenAI-compatible upstreams
    // omit `usage` (and `usage.prompt_tokens_details.cached_tokens`) on
    // streamed responses unless `stream_options.include_usage` is set, so
    // without this every Worker-proxied web turn loses token + prompt-cache
    // accounting (the `push.usage.*` span attributes, the CoderJob usage
    // log). Providers that don't support the field ignore it; the
    // Anthropic-transport bridge rebuilds the body and never forwards it.
    // Default it on, but let an explicit client `stream_options` win.
    stream_options: {
      include_usage: true,
      ...(parsed.stream_options && typeof parsed.stream_options === 'object'
        ? (parsed.stream_options as Record<string, unknown>)
        : {}),
    },
  };
  const adjustments: string[] = [];

  if (parsed.stream !== undefined && parsed.stream !== true) {
    adjustments.push('forced_stream');
  }
  if (parsed.stream !== undefined && typeof parsed.stream !== 'boolean') {
    return validationError(`${policy.routeLabel} request field "stream" must be a boolean.`);
  }

  for (const numericField of ['temperature', 'top_p'] as const) {
    const rawValue = parsed[numericField];
    if (rawValue !== undefined && (!Number.isFinite(rawValue) || typeof rawValue !== 'number')) {
      return validationError(
        `${policy.routeLabel} request field "${numericField}" must be a number.`,
      );
    }
  }

  for (const tokenField of ['max_tokens', 'max_completion_tokens'] as const) {
    const rawValue = parsed[tokenField];
    if (rawValue === undefined) continue;
    if (typeof rawValue !== 'number' || !Number.isInteger(rawValue) || rawValue < 1) {
      return validationError(
        `${policy.routeLabel} request field "${tokenField}" must be a positive integer.`,
      );
    }
    if (rawValue > policy.maxOutputTokens) {
      normalized[tokenField] = policy.maxOutputTokens;
      adjustments.push(`${tokenField}_clamped`);
    }
  }

  if (parsed.n !== undefined) {
    const maxChoices = policy.maxChoices ?? DEFAULT_MAX_CHOICES;
    if (typeof parsed.n !== 'number' || !Number.isInteger(parsed.n) || parsed.n < 1) {
      return validationError(`${policy.routeLabel} request field "n" must be a positive integer.`);
    }
    if (parsed.n > maxChoices) {
      normalized.n = maxChoices;
      adjustments.push('n_clamped');
    }
  }

  // `bodyText` is what non-Anthropic transports forward upstream verbatim.
  // Push-private sidecars (`reasoning_blocks`, `assistant_content_blocks`)
  // would be unknown message parameters to strict OpenAI-compatible
  // endpoints (Azure, OpenAI Chat, legacy Vertex) and may be rejected.
  // Strip them here. The Anthropic bridge consumes from `parsed` (which
  // still carries the fields) and re-emits the blocks as Anthropic-shape
  // `content[]` entries on its own wire.
  const stripped = {
    ...normalized,
    messages: normalizedMessages.map((msg) => {
      if (msg.reasoning_blocks === undefined && msg.assistant_content_blocks === undefined) {
        return msg;
      }
      const {
        reasoning_blocks: _stripped,
        assistant_content_blocks: _strippedBlocks,
        ...rest
      } = msg;
      void _stripped;
      void _strippedBlocks;
      return rest;
    }),
  };

  return {
    ok: true,
    value: {
      parsed: normalized as OpenAIChatRequest,
      bodyText: JSON.stringify(stripped),
      adjustments,
    },
  };
}

// ---------------------------------------------------------------------------
// Neutral wire validator (push.stream.v1)
//
// Validates the forward `PushStreamRequestWire` body and normalizes it into a
// `PushStreamRequest<LlmMessage>` the Worker hands to `toAnthropicMessages`.
// Shares this file's policy (token clamp, message/part caps) and helpers
// (`normalizeReasoningBlocks`, `pickCacheControl`) with the legacy OpenAI-shape
// validator, so both paths enforce the same ceilings. See
// `docs/runbooks/Anthropic Worker Contract Migration.md`.
// ---------------------------------------------------------------------------

const WIRE_ALLOWED_MESSAGE_ROLES = new Set(['system', 'user', 'assistant']);

export interface ValidatedWireRequest {
  request: PushStreamRequest<LlmMessage>;
  adjustments: string[];
}

/** Validate + normalize a content-part array (text/image) into `LlmContentPart[]`,
 *  or return a validation error. Mirrors the legacy validator's part rules so the
 *  two paths accept the same shapes; `toAnthropicMessages` performs the deeper
 *  image-URL conversion (and loud-fails on an unrepresentable source). */
function normalizeWireContentParts(
  raw: unknown[],
  messageNumber: number,
  routeLabel: string,
): { ok: true; parts: LlmContentPart[] } | { ok: false; status: number; error: string } {
  const parts: LlmContentPart[] = [];
  for (let partIndex = 0; partIndex < raw.length; partIndex += 1) {
    const rawPart = asRecord(raw[partIndex]);
    if (!rawPart) {
      return validationError(
        `${routeLabel} request message ${messageNumber} has an invalid content part.`,
      );
    }
    const cacheControl = pickCacheControl(rawPart);
    if (rawPart.type === 'text') {
      if (typeof rawPart.text !== 'string') {
        return validationError(
          `${routeLabel} request message ${messageNumber} has a text part without "text".`,
        );
      }
      parts.push({
        type: 'text',
        text: rawPart.text,
        ...(cacheControl ? { cache_control: cacheControl } : {}),
      });
      continue;
    }
    if (rawPart.type === 'image_url') {
      const imageUrl = asRecord(rawPart.image_url);
      if (typeof imageUrl?.url !== 'string' || !imageUrl.url.trim()) {
        return validationError(
          `${routeLabel} request message ${messageNumber} has an image part without a URL.`,
        );
      }
      parts.push({
        type: 'image_url',
        image_url: { url: imageUrl.url },
        ...(cacheControl ? { cache_control: cacheControl } : {}),
      });
      continue;
    }
    return validationError(
      `${routeLabel} request message ${messageNumber} has an unsupported content part type.`,
    );
  }
  return { ok: true, parts };
}

function normalizeWireImageSource(
  raw: unknown,
  messageNumber: number,
  routeLabel: string,
): { ok: true; source: LlmImageSource } | { ok: false; status: number; error: string } {
  const source = asRecord(raw);
  if (!source) {
    return validationError(
      `${routeLabel} request message ${messageNumber} has an image block without a source.`,
    );
  }
  if (source.type === 'base64') {
    if (typeof source.media_type !== 'string' || typeof source.data !== 'string') {
      return validationError(
        `${routeLabel} request message ${messageNumber} has a malformed base64 image block.`,
      );
    }
    return {
      ok: true,
      source: { type: 'base64', media_type: source.media_type, data: source.data },
    };
  }
  if (source.type === 'url') {
    if (typeof source.url !== 'string' || !source.url.trim()) {
      return validationError(
        `${routeLabel} request message ${messageNumber} has a malformed URL image block.`,
      );
    }
    return { ok: true, source: { type: 'url', url: source.url } };
  }
  return validationError(
    `${routeLabel} request message ${messageNumber} has an unsupported image block source.`,
  );
}

function normalizeWireContentBlocks(
  raw: unknown[],
  messageNumber: number,
  routeLabel: string,
): { ok: true; blocks: LlmContentBlock[] } | { ok: false; status: number; error: string } {
  const blocks: LlmContentBlock[] = [];
  for (let blockIndex = 0; blockIndex < raw.length; blockIndex += 1) {
    const rawBlock = asRecord(raw[blockIndex]);
    if (!rawBlock) {
      return validationError(
        `${routeLabel} request message ${messageNumber} has an invalid content block.`,
      );
    }
    const cacheControl = pickCacheControl(rawBlock);
    if (rawBlock.type === 'text') {
      if (typeof rawBlock.text !== 'string') {
        return validationError(
          `${routeLabel} request message ${messageNumber} has a text block without "text".`,
        );
      }
      blocks.push({
        type: 'text',
        text: rawBlock.text,
        ...(cacheControl ? { cache_control: cacheControl } : {}),
      });
      continue;
    }
    if (rawBlock.type === 'image') {
      const source = normalizeWireImageSource(rawBlock.source, messageNumber, routeLabel);
      if (!source.ok) return source;
      blocks.push({
        type: 'image',
        source: source.source,
        ...(cacheControl ? { cache_control: cacheControl } : {}),
      });
      continue;
    }
    if (rawBlock.type === 'thinking') {
      if (
        typeof rawBlock.text !== 'string' ||
        rawBlock.text.length > MAX_REASONING_BLOCK_TEXT_LENGTH
      ) {
        return validationError(
          `${routeLabel} request message ${messageNumber} has a malformed thinking block.`,
        );
      }
      if (
        typeof rawBlock.signature !== 'string' ||
        !rawBlock.signature ||
        rawBlock.signature.length > MAX_REASONING_BLOCK_SIGNATURE_LENGTH
      ) {
        return validationError(
          `${routeLabel} request message ${messageNumber} has a malformed thinking signature.`,
        );
      }
      blocks.push({ type: 'thinking', text: rawBlock.text, signature: rawBlock.signature });
      continue;
    }
    if (rawBlock.type === 'redacted_thinking') {
      if (
        typeof rawBlock.data !== 'string' ||
        !rawBlock.data ||
        rawBlock.data.length > MAX_REASONING_BLOCK_SIGNATURE_LENGTH
      ) {
        return validationError(
          `${routeLabel} request message ${messageNumber} has a malformed redacted thinking block.`,
        );
      }
      blocks.push({ type: 'redacted_thinking', data: rawBlock.data });
      continue;
    }
    if (rawBlock.type === 'tool_use') {
      const input = asRecord(rawBlock.input);
      if (
        typeof rawBlock.id !== 'string' ||
        !rawBlock.id ||
        typeof rawBlock.name !== 'string' ||
        !rawBlock.name ||
        !input
      ) {
        return validationError(
          `${routeLabel} request message ${messageNumber} has a malformed tool_use block.`,
        );
      }
      // Gemini's signed-reasoning `thoughtSignature` must round-trip on the
      // replay turn or Gemini 3.x 400s ("Function call is missing a
      // thought_signature"). Model-generated, low-risk; pass through when it's a
      // sane non-empty string, else drop the field (fail-closed, like reasoning
      // signatures) rather than 400 the turn.
      const thoughtSignature =
        typeof rawBlock.thoughtSignature === 'string' &&
        rawBlock.thoughtSignature.length > 0 &&
        rawBlock.thoughtSignature.length <= MAX_REASONING_BLOCK_SIGNATURE_LENGTH
          ? rawBlock.thoughtSignature
          : undefined;
      blocks.push({
        type: 'tool_use',
        id: rawBlock.id,
        name: rawBlock.name,
        input,
        ...(thoughtSignature ? { thoughtSignature } : {}),
        ...(cacheControl ? { cache_control: cacheControl } : {}),
      });
      continue;
    }
    if (rawBlock.type === 'tool_result') {
      if (
        typeof rawBlock.tool_use_id !== 'string' ||
        !rawBlock.tool_use_id ||
        typeof rawBlock.content !== 'string'
      ) {
        return validationError(
          `${routeLabel} request message ${messageNumber} has a malformed tool_result block.`,
        );
      }
      if (rawBlock.is_error !== undefined && typeof rawBlock.is_error !== 'boolean') {
        return validationError(
          `${routeLabel} request message ${messageNumber} has a malformed tool_result error flag.`,
        );
      }
      blocks.push({
        type: 'tool_result',
        tool_use_id: rawBlock.tool_use_id,
        content: rawBlock.content,
        ...(rawBlock.is_error !== undefined ? { is_error: rawBlock.is_error } : {}),
        ...(cacheControl ? { cache_control: cacheControl } : {}),
      });
      continue;
    }
    return validationError(
      `${routeLabel} request message ${messageNumber} has an unsupported content block type.`,
    );
  }
  return { ok: true, blocks };
}

export function validateAndNormalizeWireRequest(
  bodyText: string,
  policy: ChatRequestPolicy,
): { ok: true; value: ValidatedWireRequest } | { ok: false; status: number; error: string } {
  let parsedUnknown: unknown;
  try {
    parsedUnknown = JSON.parse(bodyText);
  } catch {
    return validationError(`${policy.routeLabel} request: invalid JSON body`);
  }

  const parsed = asRecord(parsedUnknown);
  if (!parsed) {
    return validationError(`${policy.routeLabel} request must be a JSON object.`);
  }
  if (parsed.contract !== PUSH_STREAM_WIRE_CONTRACT) {
    return validationError(
      `${policy.routeLabel} request has an unrecognized contract (expected "${PUSH_STREAM_WIRE_CONTRACT}").`,
    );
  }

  const model = typeof parsed.model === 'string' ? parsed.model.trim() : '';
  if (!model) {
    return validationError(`${policy.routeLabel} request is missing "model".`);
  }

  if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) {
    return validationError(
      `${policy.routeLabel} request must include a non-empty "messages" array.`,
    );
  }
  const maxMessages = policy.maxMessages ?? DEFAULT_MAX_MESSAGES;
  if (parsed.messages.length > maxMessages) {
    return validationError(
      `${policy.routeLabel} request has too many messages (${parsed.messages.length}). Limit is ${maxMessages}.`,
    );
  }
  const maxContentPartsPerMessage =
    policy.maxContentPartsPerMessage ?? DEFAULT_MAX_CONTENT_PARTS_PER_MESSAGE;

  const normalizedMessages: LlmMessage[] = [];
  for (let index = 0; index < parsed.messages.length; index += 1) {
    const messageRecord = asRecord(parsed.messages[index]);
    if (!messageRecord) {
      return validationError(
        `${policy.routeLabel} request message ${index + 1} must be an object.`,
      );
    }
    const role = typeof messageRecord.role === 'string' ? messageRecord.role.trim() : '';
    if (!WIRE_ALLOWED_MESSAGE_ROLES.has(role)) {
      return validationError(
        `${policy.routeLabel} request message ${index + 1} has an invalid role.`,
      );
    }
    // Only assistant turns may carry signed reasoning blocks — same posture as
    // the legacy validator. DeepSeek's plain reasoning_content follows the same
    // role restriction, but remains a distinct unsigned text replay field.
    const reasoningBlocks =
      role === 'assistant' ? normalizeReasoningBlocks(messageRecord.reasoningBlocks) : undefined;
    const reasoningContent =
      role === 'assistant' ? normalizeReasoningContent(messageRecord.reasoning_content) : undefined;
    let contentBlocks: LlmContentBlock[] | undefined;
    if (messageRecord.contentBlocks !== undefined) {
      if (!Array.isArray(messageRecord.contentBlocks) || messageRecord.contentBlocks.length === 0) {
        return validationError(
          `${policy.routeLabel} request message ${index + 1} has invalid "contentBlocks".`,
        );
      }
      if (messageRecord.contentBlocks.length > maxContentPartsPerMessage) {
        return validationError(
          `${policy.routeLabel} request message ${index + 1} has too many content blocks (${messageRecord.contentBlocks.length}). Limit is ${maxContentPartsPerMessage}.`,
        );
      }
      const blocksResult = normalizeWireContentBlocks(
        messageRecord.contentBlocks,
        index + 1,
        policy.routeLabel,
      );
      if (!blocksResult.ok) return blocksResult;
      contentBlocks = blocksResult.blocks;
    }

    const rawContent = messageRecord.content;
    let content = '';
    let contentParts: LlmContentPart[] | undefined;
    if (typeof rawContent === 'string') {
      content = rawContent;
    } else if (Array.isArray(rawContent)) {
      if (rawContent.length === 0) {
        return validationError(
          `${policy.routeLabel} request message ${index + 1} has an empty content parts array.`,
        );
      }
      if (rawContent.length > maxContentPartsPerMessage) {
        return validationError(
          `${policy.routeLabel} request message ${index + 1} has too many content parts (${rawContent.length}). Limit is ${maxContentPartsPerMessage}.`,
        );
      }
      const partsResult = normalizeWireContentParts(rawContent, index + 1, policy.routeLabel);
      if (!partsResult.ok) return partsResult;
      contentParts = partsResult.parts;
    } else {
      return validationError(
        `${policy.routeLabel} request message ${index + 1} has invalid "content".`,
      );
    }

    normalizedMessages.push({
      id: `wire-${index}`,
      role: role as LlmMessage['role'],
      content,
      ...(contentParts ? { contentParts } : {}),
      ...(contentBlocks ? { contentBlocks } : {}),
      timestamp: 0,
      ...(reasoningBlocks ? { reasoningBlocks } : {}),
      ...(reasoningContent ? { reasoningContent } : {}),
    });
  }

  const adjustments: string[] = [];

  // Sampling params — finite numbers only (the per-model sampling capability
  // gate lives in `toAnthropicMessages`, the same single choke point the legacy
  // path uses; this is just shape validation).
  for (const field of ['temperature', 'topP'] as const) {
    const value = parsed[field];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
      return validationError(`${policy.routeLabel} request field "${field}" must be a number.`);
    }
  }

  let maxTokens: number | undefined;
  if (parsed.maxTokens !== undefined) {
    if (
      typeof parsed.maxTokens !== 'number' ||
      !Number.isInteger(parsed.maxTokens) ||
      parsed.maxTokens < 1
    ) {
      return validationError(
        `${policy.routeLabel} request field "maxTokens" must be a positive integer.`,
      );
    }
    maxTokens = parsed.maxTokens;
    if (maxTokens > policy.maxOutputTokens) {
      maxTokens = policy.maxOutputTokens;
      adjustments.push('maxTokens_clamped');
    }
  }

  let cacheBreakpointIndices: number[] | undefined;
  if (parsed.cacheBreakpointIndices !== undefined) {
    if (
      !Array.isArray(parsed.cacheBreakpointIndices) ||
      !parsed.cacheBreakpointIndices.every(
        (n) => typeof n === 'number' && Number.isInteger(n) && n >= 0,
      )
    ) {
      return validationError(
        `${policy.routeLabel} request field "cacheBreakpointIndices" must be an array of non-negative integers.`,
      );
    }
    cacheBreakpointIndices = parsed.cacheBreakpointIndices as number[];
  }

  for (const flag of ['anthropicWebSearch', 'googleSearchGrounding'] as const) {
    if (parsed[flag] !== undefined && typeof parsed[flag] !== 'boolean') {
      return validationError(`${policy.routeLabel} request field "${flag}" must be a boolean.`);
    }
  }

  // Native function-calling tool schemas (Anthropic-compatible flat shape).
  // Shape-check the tool name + input schema so a malformed payload can't reach the
  // provider serializers; the schemas themselves are generated server-internally
  // (the registry), so deeper validation isn't warranted.
  let tools: ToolFunctionSchema[] | undefined;
  if (parsed.tools !== undefined) {
    const raw = parsed.tools;
    const valid =
      Array.isArray(raw) &&
      raw.every((t) => {
        const tool = asRecord(t);
        return (
          typeof tool?.name === 'string' &&
          tool.name.trim().length > 0 &&
          asRecord(tool.input_schema) !== null
        );
      });
    if (!valid) {
      return validationError(
        `${policy.routeLabel} request field "tools" must be an array of function tool schemas.`,
      );
    }
    tools = raw as ToolFunctionSchema[];
  }

  // Native structured-output constraint. Shape-check `{ name, schema }` so the
  // provider serializer (`toOpenAIResponseFormat`) gets a well-formed spec.
  let responseFormat: ResponseFormatSpec | undefined;
  if (parsed.responseFormat !== undefined) {
    const rf = asRecord(parsed.responseFormat);
    if (!rf || typeof rf.name !== 'string' || !asRecord(rf.schema)) {
      return validationError(
        `${policy.routeLabel} request field "responseFormat" must be a { name, schema } object.`,
      );
    }
    responseFormat = rf as unknown as ResponseFormatSpec;
  }

  // Pause-turn replay turns ride through as an opaque passthrough — each entry is
  // one prior paused turn's raw Anthropic content[] array. Shape-check (array of
  // arrays of objects) so a malformed field can't reach `toAnthropicMessages`,
  // but don't inspect the block contents (provider-internal).
  let replayAssistantTurns: Array<Array<Record<string, unknown>>> | undefined;
  if (parsed.replayAssistantTurns !== undefined) {
    const raw = parsed.replayAssistantTurns;
    const valid =
      Array.isArray(raw) &&
      raw.every(
        (turn) =>
          Array.isArray(turn) && turn.every((block) => typeof block === 'object' && block !== null),
      );
    if (!valid) {
      return validationError(
        `${policy.routeLabel} request field "replayAssistantTurns" must be an array of content-block arrays.`,
      );
    }
    replayAssistantTurns = raw as Array<Array<Record<string, unknown>>>;
  }

  const request: PushStreamRequest<LlmMessage> = {
    // Route-authoritative (see ChatRequestPolicy.provider). The wire's own
    // `provider` field is advisory — carried for a future provider-agnostic
    // endpoint — and is not consumed here.
    provider: policy.provider ?? 'anthropic',
    model,
    messages: normalizedMessages,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(typeof parsed.temperature === 'number' ? { temperature: parsed.temperature } : {}),
    ...(typeof parsed.topP === 'number' ? { topP: parsed.topP } : {}),
    ...(cacheBreakpointIndices ? { cacheBreakpointIndices } : {}),
    ...(typeof parsed.anthropicWebSearch === 'boolean'
      ? { anthropicWebSearch: parsed.anthropicWebSearch }
      : {}),
    ...(typeof parsed.googleSearchGrounding === 'boolean'
      ? { googleSearchGrounding: parsed.googleSearchGrounding }
      : {}),
    ...(tools ? { tools } : {}),
    ...(responseFormat ? { responseFormat } : {}),
    ...(replayAssistantTurns ? { replayAssistantTurns } : {}),
  };

  return { ok: true, value: { request, adjustments } };
}

// ---------------------------------------------------------------------------
// Dual-accept dispatch
//
// Shared peek + validator selection for the `push.stream.v1` dual-accept used by
// the provider chat handlers. Routes on the PRESENCE of a `contract` field (a
// legacy OpenAI body never carries one, so any request that includes one is
// declaring neutral intent and a wrong value fails loudly via the wire
// validator). Each handler does its own provider serialization off the
// discriminated result — model-in-body vs model-in-URL, transport selection, and
// the loud-fail→400 are provider-specific. See
// `docs/runbooks/Anthropic Worker Contract Migration.md`.
// ---------------------------------------------------------------------------

export type DualAcceptRequest =
  | {
      ok: true;
      contractKind: 'neutral';
      request: PushStreamRequest<LlmMessage>;
      adjustments: string[];
    }
  | {
      ok: true;
      contractKind: 'legacy';
      parsed: OpenAIChatRequest;
      bodyText: string;
      adjustments: string[];
    }
  | { ok: false; status: number; error: string };

export function parseDualAcceptRequest(
  bodyText: string,
  policy: ChatRequestPolicy,
): DualAcceptRequest {
  let isNeutral = false;
  try {
    const peeked = JSON.parse(bodyText) as { contract?: unknown } | null;
    isNeutral = peeked !== null && typeof peeked === 'object' && peeked.contract !== undefined;
  } catch {
    // Malformed JSON — fall through to the legacy validator for the canonical
    // 400 (the wire validator would produce the same, but legacy is the
    // historical owner of this error string).
  }

  if (isNeutral) {
    const wire = validateAndNormalizeWireRequest(bodyText, policy);
    if (!wire.ok) return wire;
    return {
      ok: true,
      contractKind: 'neutral',
      request: wire.value.request,
      adjustments: wire.value.adjustments,
    };
  }

  const legacy = validateAndNormalizeChatRequest(bodyText, policy);
  if (!legacy.ok) return legacy;
  return {
    ok: true,
    contractKind: 'legacy',
    parsed: legacy.value.parsed,
    bodyText: legacy.value.bodyText,
    adjustments: legacy.value.adjustments,
  };
}
