/**
 * Shared OpenAI Chat Completions wire-shape types.
 *
 * Lives in `lib/` so both the Worker's request validator
 * (`app/src/lib/chat-request-guardrails.ts`) and the cross-surface bridges
 * (`openai-anthropic-bridge`, `openai-gemini-bridge`) can consume one
 * definition. Without this, promoting either bridge from `app/src/lib/` →
 * `lib/` (so the CLI can consume it too) would either drag the entire
 * guardrails module along or duplicate the types.
 *
 * Push-private fields kept here:
 *   - `cache_control` on content parts (Anthropic-style prompt-caching
 *     marker; Gemini's bridge ignores it).
 *   - `reasoning_blocks` on messages (signed thinking sidecar consumed by
 *     the Anthropic bridge; other bridges ignore it).
 *   - `google_search_grounding` on the request root (consumed by the
 *     Gemini bridge; other bridges ignore it).
 *
 * Validation lives where the request actually enters Push (the Worker
 * guardrails). Library consumers — adapters, bridges, and the CLI —
 * trust this shape; they don't re-validate.
 */

export type OpenAIContentPart =
  | { type: 'text'; text?: string; cache_control?: { type: 'ephemeral' } }
  | { type: 'image_url'; image_url?: { url?: string }; cache_control?: { type: 'ephemeral' } };

/** Structured reasoning blocks attached to a prior assistant message.
 *  Push-private extension — not part of OpenAI's public schema. The
 *  Anthropic bridge consumes these and re-emits them as the first entries
 *  of the upstream Anthropic `content[]` so signed thinking round-trips
 *  correctly across chained turns. Other backends (OpenAI Chat, Vertex
 *  non-Anthropic, Gemini) ignore the field entirely. See
 *  `lib/provider-contract.ts` `ReasoningBlock` for the canonical shape. */
export type OpenAIReasoningBlock =
  | { type: 'thinking'; text: string; signature: string }
  | { type: 'redacted_thinking'; data: string };

export type OpenAIMessage = {
  role?: string;
  content?: string | OpenAIContentPart[] | null;
  reasoning_blocks?: OpenAIReasoningBlock[];
};

/** Push-private google search grounding extension */
export interface OpenAIChatRequestGoogleSearchGrounding {
  google_search_grounding?: boolean;
}

export interface OpenAIChatRequest extends OpenAIChatRequestGoogleSearchGrounding {
  model?: string;
  messages?: OpenAIMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stream?: boolean;
  n?: number;
}