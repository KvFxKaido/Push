/**
 * Neutral request wire contract (`push.stream.v1`).
 *
 * The forward shape for the web client↔Worker request body — the serializable
 * subset of `PushStreamRequest` the browser sends instead of an OpenAI Chat
 * Completions body, so the Worker can serialize to the provider via the neutral
 * `toAnthropicMessages` (and later `toGemini…`) rather than
 * `buildAnthropicMessagesRequest`. See
 * `docs/runbooks/Anthropic Worker Contract Migration.md`.
 *
 * This file holds ONLY the wire types + the discriminator constant so client and
 * Worker share one definition (and a drift test can pin it). Validation lives in
 * `app/src/lib/chat-request-guardrails.ts` (`validateAndNormalizeWireRequest`),
 * beside the legacy OpenAI-shape validator, so both enforce the same token-clamp
 * and model policy.
 *
 * Naming is the neutral camelCase convention (`maxTokens`, `topP`,
 * `cacheBreakpointIndices`, `anthropicWebSearch`, `reasoningBlocks`) — not the
 * OpenAI snake_case sidecar shape. Deliberately excluded vs `PushStreamRequest`:
 * `signal`, the callbacks (`onPreCompact`, `onSessionDigestEmitted`), and the
 * opaque `workspaceContext` — none are serializable, and prompt materialization
 * (`toLLMMessages`) stays client-side, so `messages` arrive already materialized
 * and `systemPromptOverride` is baked in (never sent, or it would double the
 * system prompt).
 */

import type { AIProviderType, LlmContentPart, ReasoningBlock } from './provider-contract.js';

/** The discriminator value the client sets and the Worker branches on. */
export const PUSH_STREAM_WIRE_CONTRACT = 'push.stream.v1' as const;
export type PushStreamWireContract = typeof PUSH_STREAM_WIRE_CONTRACT;

/**
 * A materialized transcript message on the wire. `content` is plain text or an
 * ordered array of text/image parts (the web's `toLLMMessages` output shape);
 * the validator normalizes the array form onto `LlmMessage.contentParts`. Unlike
 * `LlmMessage`, no `id` / `timestamp` — those are transcript bookkeeping the
 * serializer never reads, so they don't cross the wire.
 */
export interface PushStreamWireMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | LlmContentPart[];
  /** Signed reasoning blocks from a prior assistant turn (round-tripped to Anthropic). */
  reasoningBlocks?: ReasoningBlock[];
}

/** The `push.stream.v1` request body. */
export interface PushStreamRequestWire {
  contract: PushStreamWireContract;
  /** Optional — the endpoint is provider-specific today; carried for the future
   *  provider-agnostic endpoint. The Anthropic handler ignores it. */
  provider?: AIProviderType;
  model: string;
  messages: PushStreamWireMessage[];
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  cacheBreakpointIndices?: number[];
  /** Enable Anthropic's native `web_search_20250305` server tool. */
  anthropicWebSearch?: boolean;
  /** Enable Gemini's native `googleSearch` grounding tool. */
  googleSearchGrounding?: boolean;
}
