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
 * OpenAI snake_case sidecar shape, except for upstream-native fields such as
 * DeepSeek's `reasoning_content`. Deliberately excluded vs `PushStreamRequest`:
 * `signal`, the callbacks (`onPreCompact`, `onSessionDigestEmitted`), and the
 * opaque `workspaceContext` — none are serializable, and prompt materialization
 * (`toLLMMessages`) stays client-side, so `messages` arrive already materialized
 * and `systemPromptOverride` is baked in (never sent, or it would double the
 * system prompt).
 */

import type {
  AIProviderType,
  LlmContentBlock,
  LlmContentPart,
  ReasoningBlock,
  ResponseFormatSpec,
  ToolFunctionSchema,
} from './provider-contract.js';

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
  /** Anthropic-conceptual content blocks. Preferred by neutral serializers when present. */
  contentBlocks?: LlmContentBlock[];
  /** Signed reasoning blocks from a prior assistant turn (round-tripped to Anthropic). */
  reasoningBlocks?: ReasoningBlock[];
  /** Plain unsigned reasoning text from a prior assistant turn (DeepSeek replay). */
  reasoning_content?: string;
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
  /**
   * Native function-calling tool schemas (OpenAI-compatible shape). Carried so a
   * neutral OpenAI-compat client (OpenCode Zen Go) keeps native FC after flipping
   * off the legacy passthrough — the Worker re-serializes via `toOpenAIChat`,
   * which only emits `tools`/`tool_choice` when `dual.request.tools` is present.
   */
  tools?: ToolFunctionSchema[];
  /**
   * Escalation for native function calling — forces a structured tool call
   * instead of a free-text reply. See `PushStreamRequest.toolChoice`. Carried
   * so the flipped Zen Go client can force compliance after a model announces
   * a tool action without emitting one; the Worker forwards it to
   * `toOpenAIChat`'s `tool_choice`. Ignored by the Anthropic transport (no
   * `tools`-shaped forcing path wired for it yet).
   */
  toolChoice?: 'auto' | 'required';
  /**
   * Native structured-output JSON-Schema constraint. Carried so the flipped
   * Zen Go client keeps structured outputs the legacy passthrough used to
   * preserve; Workers re-serialize it to each transport's native shape
   * (`response_format`, Anthropic `output_config.format`, or forced-tool
   * fallback).
   */
  responseFormat?: ResponseFormatSpec;
  /**
   * Pause-turn continuation: prior paused assistant content[] arrays
   * (oldest-first), replayed verbatim. Anthropic-only; opaque passthrough. The
   * legacy OpenAI-shape path carried this inline as `assistant_content_blocks`
   * messages. See `PushStreamRequest.replayAssistantTurns`.
   */
  replayAssistantTurns?: Array<Array<Record<string, unknown>>>;
}

/**
 * The materialized-message shape {@link toPushStreamWire} reads. Matches the
 * web `toLLMMessages` output: `content` is plain text or an ordered content-part
 * array, signed reasoning rides as snake_case `reasoning_blocks` (the
 * materializer's OpenAI-ish convention), and plain DeepSeek reasoning may ride
 * as either neutral `reasoningContent` or OpenAI-native `reasoning_content`.
 * The serializer renames signed blocks to the wire's camelCase
 * `reasoningBlocks` and keeps DeepSeek's upstream-native field snake_case.
 * `id` / `timestamp` (present on the CLI's `LlmMessage`) are not required —
 * they never cross the wire.
 */
export interface WireSerializableMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | LlmContentPart[];
  contentBlocks?: LlmContentBlock[];
  reasoning_blocks?: ReasoningBlock[];
  reasoningContent?: string;
  reasoning_content?: string;
}

/** Fields a caller supplies to {@link toPushStreamWire} alongside the already
 *  materialized messages. The serializable subset of `PushStreamRequest`. */
export interface ToPushStreamWireOptions {
  model: string;
  /** Carried for the future provider-agnostic endpoint; handlers ignore it today. */
  provider?: AIProviderType;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  cacheBreakpointIndices?: number[];
  anthropicWebSearch?: boolean;
  googleSearchGrounding?: boolean;
  tools?: ToolFunctionSchema[];
  toolChoice?: 'auto' | 'required';
  responseFormat?: ResponseFormatSpec;
  replayAssistantTurns?: Array<Array<Record<string, unknown>>>;
}

/**
 * Serialize already-materialized messages + neutral scalars into the
 * `push.stream.v1` wire body — the inverse of `validateAndNormalizeWireRequest`.
 *
 * Prompt materialization (`toLLMMessages`) stays client-side, so callers pass
 * the materialized `LlmMessage[]` here; this only drops the non-wire bookkeeping
 * (`id` / `timestamp`) and collapses `content` vs `contentParts` to the wire's
 * `content: string | LlmContentPart[]` union. Only assistant turns keep
 * `reasoningBlocks` (matching the validator's posture). Optional scalars are
 * omitted when unset so the body stays minimal and round-trips cleanly.
 *
 * Single source of truth for the forward wire shape, shared by every client
 * adapter that flips to neutral (Anthropic today, Gemini next). Pinned against
 * the validator by a round-trip drift test.
 */
export function toPushStreamWire(
  messages: readonly WireSerializableMessage[],
  options: ToPushStreamWireOptions,
): PushStreamRequestWire {
  const wireMessages: PushStreamWireMessage[] = messages.map((m) => {
    const reasoningContent =
      m.role === 'assistant' ? (m.reasoningContent ?? m.reasoning_content) : undefined;
    return {
      role: m.role,
      content: m.content,
      ...(m.contentBlocks && m.contentBlocks.length > 0 ? { contentBlocks: m.contentBlocks } : {}),
      // Only assistant turns carry signed reasoning blocks (validator posture);
      // rename the materializer's snake_case field to the wire's camelCase.
      ...(m.role === 'assistant' && m.reasoning_blocks && m.reasoning_blocks.length > 0
        ? { reasoningBlocks: m.reasoning_blocks }
        : {}),
      ...(typeof reasoningContent === 'string' && reasoningContent.length > 0
        ? { reasoning_content: reasoningContent }
        : {}),
    };
  });

  return {
    contract: PUSH_STREAM_WIRE_CONTRACT,
    ...(options.provider ? { provider: options.provider } : {}),
    model: options.model,
    messages: wireMessages,
    ...(typeof options.maxTokens === 'number' ? { maxTokens: options.maxTokens } : {}),
    ...(typeof options.temperature === 'number' ? { temperature: options.temperature } : {}),
    ...(typeof options.topP === 'number' ? { topP: options.topP } : {}),
    ...(options.cacheBreakpointIndices
      ? { cacheBreakpointIndices: options.cacheBreakpointIndices }
      : {}),
    ...(options.anthropicWebSearch ? { anthropicWebSearch: true } : {}),
    ...(options.googleSearchGrounding ? { googleSearchGrounding: true } : {}),
    ...(options.tools && options.tools.length > 0 ? { tools: options.tools } : {}),
    ...(options.toolChoice ? { toolChoice: options.toolChoice } : {}),
    ...(options.responseFormat ? { responseFormat: options.responseFormat } : {}),
    ...(options.replayAssistantTurns && options.replayAssistantTurns.length > 0
      ? { replayAssistantTurns: options.replayAssistantTurns }
      : {}),
  };
}
