import type { ResponsesReasoningItem } from './provider-contract.js';

/** Validate and retain the documented replayable fields of a Responses
 * reasoning output item. Malformed or unencrypted items are not replayable. */
export function parseResponsesReasoningItem(value: unknown): ResponsesReasoningItem | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  if (
    item.type !== 'reasoning' ||
    typeof item.encrypted_content !== 'string' ||
    item.encrypted_content.length === 0
  ) {
    return null;
  }
  return {
    type: 'reasoning',
    encrypted_content: item.encrypted_content,
    ...(typeof item.id === 'string' && item.id ? { id: item.id } : {}),
    ...(Array.isArray(item.summary) ? { summary: item.summary } : {}),
    ...(Array.isArray(item.content) ? { content: item.content } : {}),
    ...(typeof item.status === 'string' ? { status: item.status } : {}),
  };
}
