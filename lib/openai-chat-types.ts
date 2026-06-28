/**
 * Shared OpenAI Chat Completions wire-shape types.
 *
 * Lives in `lib/` so both the Worker's request validator
 * (`app/src/lib/chat-request-guardrails.ts`) and the cross-surface bridges
 * (`anthropic-bridge`, `gemini-bridge`) can consume one
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
 *   - `anthropic_web_search` on the request root (consumed by the
 *     Anthropic bridge; other bridges ignore it).
 *
 * Validation lives where the request actually enters Push (the Worker
 * guardrails). Library consumers — adapters, bridges, and the CLI —
 * trust this shape; they don't re-validate.
 */

import type { CacheControl, ToolFunctionSchema } from './provider-contract.js';

export type OpenAIContentPart =
  | { type: 'text'; text?: string; cache_control?: CacheControl }
  | { type: 'image_url'; image_url?: { url?: string }; cache_control?: CacheControl };

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

/** OpenAI assistant tool call. `function.arguments` is a JSON-encoded string
 *  (OpenAI's wire shape), unlike the parsed object an Anthropic `tool_use`
 *  block carries — the serializer stringifies on the way out. */
export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
  /**
   * Gemini-private signed-reasoning token, carried as a sibling field on the
   * tool call. When an OpenAI-compatible upstream fronts a Gemini model (Ollama
   * Cloud serving Gemini), the model emits it on the streamed `tool_calls` delta
   * and REQUIRES it back on replay, or the follow-up 400s ("Function call is
   * missing a thought_signature in functionCall parts"). The peer of the
   * `gemini-bridge`'s native `functionCall.thoughtSignature` round-trip. Absent
   * for every non-Gemini upstream. See `lib/provider-contract.ts` `NativeToolCall`.
   */
  thoughtSignature?: string;
}

/** OpenAI's NESTED function-tool wire shape for the request `tools` array.
 *  The canonical `ToolFunctionSchema` is now Anthropic-flat (`{ name,
 *  description, input_schema }`); `flatToolToOpenAITool` downcasts each one into
 *  this nested `{ type:'function', function:{ name, description, parameters } }`
 *  for OpenAI-compatible request bodies (`parameters` ← `input_schema`). */
export interface OpenAIFunctionTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: ToolFunctionSchema['input_schema'];
  };
}

export type OpenAIMessage = {
  role?: string;
  content?: string | OpenAIContentPart[] | null;
  reasoning_blocks?: OpenAIReasoningBlock[];
  /** OpenAI-compatible DeepSeek thinking-mode replay field. Unlike
   *  `reasoning_blocks`, this is an upstream field for routes that explicitly
   *  require plain unsigned reasoning text to be echoed verbatim. */
  reasoning_content?: string;
  /** Assistant tool calls (OpenAI native function calling). Set by the
   *  `toOpenAIChat` downcast when a message's `contentBlocks` carry `tool_use`
   *  blocks. */
  tool_calls?: OpenAIToolCall[];
  /** Links a `role: 'tool'` result message back to the assistant `tool_calls[]`
   *  entry it answers. Set on the standalone tool-result messages the downcast
   *  emits from `tool_result` blocks. */
  tool_call_id?: string;
  /**
   * Push-private sidecar for replaying an Anthropic `pause_turn`
   * continuation. When set on an assistant message, the Anthropic bridge
   * uses these blocks as the upstream `content[]` array verbatim
   * (bypassing the text + reasoning_blocks reconstruction) so the
   * server-side sampling loop can resume from where it paused. Other
   * bridges ignore the field. The blocks are stored opaquely because
   * Anthropic treats the replayed content as continuation context, not
   * something the client needs to interpret.
   */
  assistant_content_blocks?: Array<Record<string, unknown>>;
};

/** Push-private native-web-search extensions. Each provider's bridge
 *  consumes the matching field and emits the upstream's native search
 *  tool; bridges for other providers ignore the field. */
export interface OpenAIChatRequestNativeWebSearch {
  /** Enable Gemini's native `googleSearch` grounding tool. */
  google_search_grounding?: boolean;
  /** Enable Anthropic's native `web_search_20250305` server-side tool. */
  anthropic_web_search?: boolean;
}

/** OpenAI `response_format` JSON-Schema constraint. OpenRouter and the
 *  OpenAI-compat routes pass it through to constrain generation server-side. */
export interface OpenAIJsonSchemaResponseFormat {
  type: 'json_schema';
  json_schema: {
    name: string;
    strict?: boolean;
    schema: Record<string, unknown>;
  };
}

export interface OpenAIChatRequest extends OpenAIChatRequestNativeWebSearch {
  model?: string;
  messages?: OpenAIMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stream?: boolean;
  /** Request the trailing usage chunk on a streamed response (token + prompt-cache
   *  accounting). OpenAI-compat upstreams omit `usage` on streams unless this is set. */
  stream_options?: { include_usage?: boolean };
  n?: number;
  response_format?: OpenAIJsonSchemaResponseFormat;
  /** Native function-calling tool schemas + selection mode. Serialized by
   *  `toOpenAIChat` for callers that attach them (gated on model support); the
   *  legacy guardrail validator preserves them on the forwarded body. */
  tools?: OpenAIFunctionTool[];
  tool_choice?: 'auto' | 'none' | 'required';
}
