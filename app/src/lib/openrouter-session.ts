// OpenRouter session tracking for request grouping and observability.
// See: https://openrouter.ai/docs/guides/features/broadcast/overview#optional-trace-data
//
// session_id groups related requests (e.g. a conversation) so OpenRouter
// broadcast destinations can correlate them. Max 256 characters.

const MAX_SESSION_ID_LENGTH = 256;

let currentSessionId: string | null = null;

/**
 * Set the OpenRouter session_id for subsequent requests.
 * Typically called with the chat conversation ID before streaming.
 */
export function setOpenRouterSessionId(id: string | null): void {
  currentSessionId = id ? id.slice(0, MAX_SESSION_ID_LENGTH) : null;
}

/** Get the current OpenRouter session_id, if any. */
export function getOpenRouterSessionId(): string | null {
  return currentSessionId;
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
