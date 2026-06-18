import { asRecord } from './utils';
import type {
  OpenAIChatRequest,
  OpenAIContentPart,
  OpenAIMessage,
  OpenAIReasoningBlock,
} from '@push/lib/openai-chat-types';
export type {
  OpenAIChatRequest,
  OpenAIContentPart,
  OpenAIMessage,
  OpenAIReasoningBlock,
} from '@push/lib/openai-chat-types';
import type {
  AIProviderType,
  LlmContentPart,
  LlmMessage,
  PushStreamRequest,
  ResponseFormatSpec,
  ToolFunctionSchema,
} from '@push/lib/provider-contract';
import { PUSH_STREAM_WIRE_CONTRACT } from '@push/lib/provider-wire';

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

const MAX_ASSISTANT_CONTENT_BLOCKS = 256;

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
function pickCacheControl(rawPart: Record<string, unknown>): { type: 'ephemeral' } | undefined {
  const cc = asRecord(rawPart.cache_control);
  if (!cc) return undefined;
  if (cc.type === 'ephemeral') return { type: 'ephemeral' };
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
    const assistantContentBlocks =
      role === 'assistant'
        ? normalizeAssistantContentBlocks(messageRecord.assistant_content_blocks)
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
        ...(assistantContentBlocks ? { assistant_content_blocks: assistantContentBlocks } : {}),
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
      ...(assistantContentBlocks ? { assistant_content_blocks: assistantContentBlocks } : {}),
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
    // the legacy validator.
    const reasoningBlocks =
      role === 'assistant' ? normalizeReasoningBlocks(messageRecord.reasoningBlocks) : undefined;

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
      timestamp: 0,
      ...(reasoningBlocks ? { reasoningBlocks } : {}),
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

  // Native function-calling tool schemas (OpenAI-compatible shape). Shape-check
  // the discriminant + function name so a malformed payload can't reach the
  // provider serializers; the schemas themselves are generated server-internally
  // (the registry), so deeper validation isn't warranted.
  let tools: ToolFunctionSchema[] | undefined;
  if (parsed.tools !== undefined) {
    const raw = parsed.tools;
    const valid =
      Array.isArray(raw) &&
      raw.every((t) => {
        const tool = asRecord(t);
        const fn = tool ? asRecord(tool.function) : null;
        return tool?.type === 'function' && fn !== null && typeof fn.name === 'string';
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
