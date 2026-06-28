/**
 * Gemini's signed-reasoning token (`thoughtSignature`) on an OpenAI-compatible
 * tool call.
 *
 * Different Gemini-fronting compat upstreams carry it differently:
 *   - a top-level `thoughtSignature` sibling on the tool call (what
 *     `openai-sse-pump` historically observed),
 *   - Google's provider-metadata envelope `extra_content.google.thought_signature`
 *     (Google's OpenAI-compat surface, which ignores unknown top-level fields),
 *   - or NESTED inside the function object as `function.thought_signature`
 *     (Ollama Cloud's shape — it maps that field onto the Gemini `functionCall`
 *     it forwards and reads it back from the same place on replay; ref
 *     ollama/ollama#14676. The top-level sibling and `extra_content` are both
 *     dropped by Ollama, so without this shape the signature never reaches Gemini
 *     and the replay 400s).
 * Rather than bet on one shape, Push reads ANY on capture and emits ALL THREE on
 * replay, so the round-trip works regardless of which the upstream honors — the
 * unused fields are ignored.
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

/** The Ollama-native shape: the signature nested inside the tool call's
 *  `function` object. Spread into `function` (NOT the tool-call root) since
 *  Ollama reads `tool_calls[].function.thought_signature`. */
export interface ThoughtSignatureFunctionField {
  thought_signature?: string;
}

/**
 * Documented Gemini context-engineering fallback: a sentinel `thought_signature`
 * that bypasses Gemini 3.x's "Function call is missing a thought_signature"
 * validation when no real signature is available to replay. That happens when the
 * call was produced by text-dispatch (it never carried a signature), the upstream
 * (e.g. an Ollama-Cloud-fronted Gemini) didn't surface one, or Google's own API
 * omitted it on the turn's first parallel call (a known Gemini-3-Flash product
 * bug). Bypassing validation can slightly degrade reasoning continuity, so it is
 * a LAST RESORT: `resolveGeminiReplaySignature` only substitutes it for the turn's
 * FIRST function call (the only part Gemini validates), never overrides a real
 * captured signature, and never fills the trailing parallel calls that
 * legitimately carry none.
 * Ref: https://ai.google.dev/gemini-api/docs/thought-signatures
 */
export const GEMINI_MISSING_THOUGHT_SIGNATURE_PLACEHOLDER = 'skip_thought_signature_validator';

/** True when a model id names a Gemini model — the gate for the placeholder
 *  fallback on OpenAI-compat upstreams (Ollama Cloud, OpenRouter `google/gemini-*`)
 *  that front Gemini. Matches both bare (`gemini-3-flash`) and namespaced
 *  (`google/gemini-3-pro`) ids. Non-Gemini upstreams never need the field, so they
 *  pass `false` and keep byte-identical bodies. */
export function isGeminiModelId(model: string | undefined): boolean {
  return typeof model === 'string' && /gemini/i.test(model);
}

/**
 * Resolve the `thought_signature` to replay on a single function/tool call when
 * the serialization target is Gemini. Returns the real captured signature when
 * present; otherwise the placeholder sentinel for the turn's FIRST call (so the
 * request doesn't 400), or `undefined` for a non-first parallel call that
 * legitimately has none. Callers that don't target Gemini must not invoke this —
 * they emit `ownSignature` verbatim (and so never inject the placeholder).
 */
export function resolveGeminiReplaySignature(opts: {
  ownSignature: string | undefined;
  isFirstCallInTurn: boolean;
}): string | undefined {
  if (opts.ownSignature) return opts.ownSignature;
  return opts.isFirstCallInTurn ? GEMINI_MISSING_THOUGHT_SIGNATURE_PLACEHOLDER : undefined;
}

/** Read the signature off a tool call in any supported shape (top-level sibling
 *  first, then Google's `extra_content` envelope, then Ollama's nested
 *  `function.thought_signature`). Returns undefined when none carries a non-empty
 *  string. */
export function readToolCallThoughtSignature(toolCall: {
  thoughtSignature?: unknown;
  extra_content?: unknown;
  function?: unknown;
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
  const fnSig = (toolCall.function as { thought_signature?: unknown } | undefined)
    ?.thought_signature;
  if (typeof fnSig === 'string' && fnSig.length > 0) {
    return fnSig;
  }
  return undefined;
}

/** Spread the signature into the two TOOL-CALL-ROOT wire shapes (or nothing when
 *  absent), so a replayed tool call satisfies whichever shape the upstream
 *  honors. The third shape (Ollama's `function.thought_signature`) nests inside
 *  the function object — use {@link toolCallFunctionThoughtSignatureField} for
 *  that one. */
export function toolCallThoughtSignatureFields(
  signature: string | undefined,
): ThoughtSignatureToolCallFields {
  if (!signature) return {};
  return {
    thoughtSignature: signature,
    extra_content: { google: { thought_signature: signature } },
  };
}

/** Spread the signature into the `function` object (or nothing when absent) so a
 *  replayed tool call carries Ollama's `function.thought_signature` — the only
 *  shape an Ollama-Cloud-fronted Gemini reads back. Spread INTO `function`, not
 *  the tool-call root. */
export function toolCallFunctionThoughtSignatureField(
  signature: string | undefined,
): ThoughtSignatureFunctionField {
  if (!signature) return {};
  return { thought_signature: signature };
}
