import { asRecord } from './utils';

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

export type OpenAIContentPart =
  | { type: 'text'; text?: string; cache_control?: { type: 'ephemeral' } }
  | { type: 'image_url'; image_url?: { url?: string }; cache_control?: { type: 'ephemeral' } };

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

/** Structured reasoning blocks attached to a prior assistant message.
 *  Push-private extension — not part of OpenAI's public schema. The
 *  Anthropic bridge consumes these and re-emits them as the first entries
 *  of the upstream Anthropic `content[]` so signed thinking round-trips
 *  correctly across chained turns. Other backends (OpenAI Chat, Vertex
 *  non-Anthropic) ignore the field entirely. See
 *  `lib/provider-contract.ts` `ReasoningBlock` for the canonical shape. */
export type OpenAIReasoningBlock =
  | { type: 'thinking'; text: string; signature: string }
  | { type: 'redacted_thinking'; data: string };

export type OpenAIMessage = {
  role?: string;
  content?: string | OpenAIContentPart[] | null;
  reasoning_blocks?: OpenAIReasoningBlock[];
};

export interface OpenAIChatRequest {
  model?: string;
  messages?: OpenAIMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stream?: boolean;
  n?: number;
}

export interface ChatRequestPolicy {
  routeLabel: string;
  maxOutputTokens: number;
  maxMessages?: number;
  maxContentPartsPerMessage?: number;
  maxChoices?: number;
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

    const rawContent = messageRecord.content;
    if (typeof rawContent === 'string' || rawContent === null || rawContent === undefined) {
      normalizedMessages.push({
        ...(Object.prototype.hasOwnProperty.call(messageRecord, 'content')
          ? { content: rawContent as string | null }
          : {}),
        role,
        ...(reasoningBlocks ? { reasoning_blocks: reasoningBlocks } : {}),
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
    });
  }

  const normalized: Record<string, unknown> = {
    ...parsed,
    model,
    messages: normalizedMessages,
    stream: true,
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
  // The Push-private `reasoning_blocks` sidecar would be an unknown message
  // parameter to strict OpenAI-compatible endpoints (Azure, OpenAI Chat,
  // legacy Vertex) and may be rejected. Strip it here. The Anthropic bridge
  // consumes from `parsed` (which still carries the field) and re-emits the
  // blocks as Anthropic-shape `content[]` entries on its own wire.
  const stripped = {
    ...normalized,
    messages: normalizedMessages.map((msg) => {
      if (msg.reasoning_blocks === undefined) return msg;
      const { reasoning_blocks: _stripped, ...rest } = msg;
      void _stripped;
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
