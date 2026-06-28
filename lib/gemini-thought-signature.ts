/**
 * Gemini's signed-reasoning token (`thoughtSignature`) on an OpenAI-compatible
 * tool call.
 *
 * Different Gemini-fronting compat upstreams carry it differently: some as a
 * top-level `thoughtSignature` sibling on the tool call (what `openai-sse-pump`
 * historically observed), others in Google's provider-metadata envelope
 * `extra_content.google.thought_signature` (Google's OpenAI-compat surface, which
 * ignores unknown top-level fields). Rather than bet on one shape, Push reads
 * EITHER on capture and emits BOTH on replay, so the round-trip works regardless
 * of which the upstream honors — the unused field is ignored.
 *
 * The token must round-trip or the follow-up turn 400s ("Function call is missing
 * a thought_signature in functionCall parts"). Non-Gemini upstreams never set it.
 * This is the OpenAI-compat peer of `gemini-bridge`'s native
 * `functionCall.thoughtSignature` round-trip.
 */

export interface ThoughtSignatureToolCallFields {
  thoughtSignature?: string;
  extra_content?: { google: { thought_signature: string } };
}

/** Read the signature off a tool call in either supported shape (top-level
 *  sibling first, then Google's `extra_content` envelope). Returns undefined
 *  when neither carries a non-empty string. */
export function readToolCallThoughtSignature(toolCall: {
  thoughtSignature?: unknown;
  extra_content?: unknown;
}): string | undefined {
  if (typeof toolCall.thoughtSignature === 'string' && toolCall.thoughtSignature.length > 0) {
    return toolCall.thoughtSignature;
  }
  const google = (
    toolCall.extra_content as { google?: { thought_signature?: unknown } } | undefined
  )?.google;
  if (typeof google?.thought_signature === 'string' && google.thought_signature.length > 0) {
    return google.thought_signature;
  }
  return undefined;
}

/** Spread the signature into BOTH wire shapes (or nothing when absent), so a
 *  replayed tool call satisfies whichever shape the upstream honors. */
export function toolCallThoughtSignatureFields(
  signature: string | undefined,
): ThoughtSignatureToolCallFields {
  if (!signature) return {};
  return {
    thoughtSignature: signature,
    extra_content: { google: { thought_signature: signature } },
  };
}
