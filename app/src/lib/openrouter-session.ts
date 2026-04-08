// OpenRouter session tracking for request grouping and observability.
// See: https://openrouter.ai/docs/guides/features/broadcast/overview#optional-trace-data
//
// session_id groups related requests (e.g. a conversation) so OpenRouter
// broadcast destinations can correlate them.

import { OPENROUTER_MAX_SESSION_ID_LENGTH } from '@push/lib/provider-models';

let currentSessionId: string | null = null;

function normalizeSessionId(id: string | null): string | null {
  return id ? id.slice(0, OPENROUTER_MAX_SESSION_ID_LENGTH) : null;
}

/**
 * Set the OpenRouter session_id for the next request.
 * Typically called with the chat conversation ID immediately before streaming.
 */
export function setOpenRouterSessionId(id: string | null): void {
  currentSessionId = normalizeSessionId(id);
}

/**
 * Get and clear the current OpenRouter session_id, if any.
 * Consumes the value so it cannot leak into unrelated later requests
 * (e.g. reviewer-agent or auditor-agent flows that bypass chat-send).
 */
export function getOpenRouterSessionId(): string | null {
  const sessionId = currentSessionId;
  currentSessionId = null;
  return sessionId;
}

/**
 * Build the OpenRouter trace metadata object.
 * Known keys get special handling by broadcast destinations (Langfuse, Datadog, etc.).
 */
export function buildOpenRouterTrace(generationName?: string): Record<string, string> {
  return {
    generation_name: generationName ?? 'push-chat',
    trace_name: 'push',
  };
}
