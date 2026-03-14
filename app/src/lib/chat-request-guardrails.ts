import { asRecord } from './utils';

export type OpenAIContentPart =
  | { type: 'text'; text?: string }
  | { type: 'image_url'; image_url?: { url?: string } };

export type OpenAIMessage = {
  role?: string;
  content?: string | OpenAIContentPart[] | null;
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
    return validationError(`${policy.routeLabel} request must include a non-empty "messages" array.`);
  }

  const maxMessages = policy.maxMessages ?? DEFAULT_MAX_MESSAGES;
  if (parsed.messages.length > maxMessages) {
    return validationError(
      `${policy.routeLabel} request has too many messages (${parsed.messages.length}). Limit is ${maxMessages}.`,
    );
  }

  const normalizedMessages: OpenAIMessage[] = [];
  const maxContentPartsPerMessage = policy.maxContentPartsPerMessage ?? DEFAULT_MAX_CONTENT_PARTS_PER_MESSAGE;

  for (let index = 0; index < parsed.messages.length; index += 1) {
    const messageRecord = asRecord(parsed.messages[index]);
    if (!messageRecord) {
      return validationError(`${policy.routeLabel} request message ${index + 1} must be an object.`);
    }

    const role = typeof messageRecord.role === 'string' ? messageRecord.role.trim() : '';
    if (!ALLOWED_MESSAGE_ROLES.has(role)) {
      return validationError(
        `${policy.routeLabel} request message ${index + 1} has an invalid role.`,
      );
    }

    const rawContent = messageRecord.content;
    if (typeof rawContent === 'string' || rawContent === null || rawContent === undefined) {
      normalizedMessages.push({
        ...(Object.prototype.hasOwnProperty.call(messageRecord, 'content') ? { content: rawContent as string | null } : {}),
        role,
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
        normalizedParts.push({ type: 'text', text: rawPart.text });
        continue;
      }

      if (rawPart.type === 'image_url') {
        const imageUrl = asRecord(rawPart.image_url);
        if (typeof imageUrl?.url !== 'string' || !imageUrl.url.trim()) {
          return validationError(
            `${policy.routeLabel} request message ${index + 1} has an image part without a URL.`,
          );
        }
        normalizedParts.push({ type: 'image_url', image_url: { url: imageUrl.url } });
        continue;
      }

      return validationError(
        `${policy.routeLabel} request message ${index + 1} has an unsupported content part type.`,
      );
    }

    normalizedMessages.push({ role, content: normalizedParts });
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
      return validationError(`${policy.routeLabel} request field "${numericField}" must be a number.`);
    }
  }

  for (const tokenField of ['max_tokens', 'max_completion_tokens'] as const) {
    const rawValue = parsed[tokenField];
    if (rawValue === undefined) continue;
    if (typeof rawValue !== 'number' || !Number.isInteger(rawValue) || rawValue < 1) {
      return validationError(`${policy.routeLabel} request field "${tokenField}" must be a positive integer.`);
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

  return {
    ok: true,
    value: {
      parsed: normalized as OpenAIChatRequest,
      bodyText: JSON.stringify(normalized),
      adjustments,
    },
  };
}
