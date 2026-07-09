/**
 * Shared provider-contract types.
 *
 * Canonical home for the minimum surface an agent role needs to stream
 * tokens from a provider without importing Web shell state. Lives in `lib/`
 * so CLI (pushd, push-runtime-v2) and Web share one definition.
 */

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * Prompt-cache breakpoint marker — Anthropic's `cache_control` shape, centralized
 * here as the single neutral source so every content-block type and serializer
 * references ONE definition instead of re-declaring the inline `{ type:
 * 'ephemeral' }` literal across the bridges. Anthropic emits it ~verbatim; the
 * OpenAI serializer preserves it on cache-aware endpoints; Gemini drops it (no
 * cache markers). The lone `type` field keeps it forward-compatible if a
 * non-ephemeral tier ever lands.
 */
export interface CacheControl {
  type: 'ephemeral';
}

/** Canonical `cache_control` value — use instead of an inline `{ type: 'ephemeral' }`. */
export const EPHEMERAL_CACHE_CONTROL: CacheControl = { type: 'ephemeral' };

/**
 * A single content part for multimodal messages. Mirrors the OpenAI-compatible
 * `image_url` shape the rest of the codebase already uses (web `LLMMessage`,
 * `OpenAIContentPart`). `image_url.url` is a `data:` base64 URL or an `http(s)`
 * URL; both are carried losslessly to providers that accept images.
 */
export type LlmContentPart =
  | { type: 'text'; text: string; cache_control?: CacheControl }
  | { type: 'image_url'; image_url: { url: string }; cache_control?: CacheControl };

/**
 * Anthropic-canonical image source — base64 inline or a remote URL. This is the
 * shape Anthropic's Messages API speaks (`media_type` + `data`), chosen as the
 * neutral canonical form so adapters *downcast* from it (Anthropic ≈ identity,
 * OpenAI/Gemini translate) rather than the Anthropic bridge upcasting from
 * OpenAI's `image_url`. See
 * `docs/decisions/Provider Contract — Anthropic-Conceptual Neutral Hub.md`.
 */
export type LlmImageSource =
  | { type: 'base64'; media_type: string; data: string }
  | { type: 'url'; url: string };

/**
 * A single content block in the Anthropic-conceptual neutral message model —
 * the migration target that will eventually replace the flat
 * `content` / `contentParts` representation (see the decision doc:
 * `docs/decisions/Provider Contract — Anthropic-Conceptual Neutral Hub.md`).
 *
 * Carries `text`, `image`, the signed `thinking` / `redacted_thinking` blocks
 * (the {@link ReasoningBlock} variants, reused verbatim so the thinking
 * representation is unified — slice 2 began folding the sidecar
 * {@link LlmMessage.reasoningBlocks} into this block stream), and the
 * `tool_use` / `tool_result` blocks (slice 3) in their Anthropic-canonical
 * shapes — the rich provider concepts the Anthropic bridge currently
 * reconstructs, now first-class so every serializer downcasts from them.
 * Additive and optional: see {@link LlmMessage.contentBlocks}.
 */
export type LlmContentBlock =
  | { type: 'text'; text: string; cache_control?: CacheControl }
  | { type: 'image'; source: LlmImageSource; cache_control?: CacheControl }
  | ReasoningBlock
  | LlmToolUseBlock
  | LlmToolResultBlock;

/**
 * An assistant tool call in Anthropic-canonical shape: a flat `{ id, name,
 * input }` (input is the parsed argument object). The OpenAI downcast flattens
 * this onto the assistant message's `tool_calls[]` (stringifying `input` into
 * `function.arguments`); the Anthropic serializer emits it ~verbatim.
 */
export interface LlmToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  cache_control?: CacheControl;
  /**
   * Gemini-private signed-reasoning token (`thoughtSignature`) carried on the
   * model's function-call part. Gemini 3.x **requires** it to be replayed
   * verbatim on the prior call when the conversation continues, or the next
   * request 400s ("Function call is missing a thought_signature"). Captured by
   * the Gemini stream translator and re-attached by `toGeminiGenerateContent`;
   * every other serializer ignores it (the field has no slot on their wire).
   */
  thoughtSignature?: string;
}

/**
 * A tool result in Anthropic-canonical shape: `tool_use_id` ties it back to the
 * call, `content` is the result text, `is_error` flags a failed call. The
 * OpenAI downcast emits this as a standalone `{ role: 'tool', tool_call_id,
 * content }` message (OpenAI has no `is_error` slot, so the flag is conveyed
 * only via the content text there). `content` is modeled as a string — the
 * common case; richer block content is a future extension.
 */
export interface LlmToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
  cache_control?: CacheControl;
}

/**
 * Minimum portable message shape understood by all lib/-side agent roles.
 */
export interface LlmMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  /** Plain-text content. Always the text representation of the turn — every
   *  adapter and the context/summary machinery read this. When the turn also
   *  carries images, `contentParts` holds the rich representation and wins on
   *  multimodal-capable paths; `content` stays the text fallback. */
  content: string;
  /**
   * Multimodal parts (text + image) for turns that carry images. Additive and
   * optional: when set, `toAnthropicMessages` serializes these instead of
   * `content`, preserving image content end-to-end (e.g. the web transcript's
   * materialized messages) rather than flattening it to `content`'s text. A
   * part type a target can't represent fails loudly, never silently dropped.
   * Adapters that don't read this field simply use `content` (text-only).
   */
  contentParts?: LlmContentPart[];
  /**
   * Anthropic-conceptual block representation of the turn — the migration
   * target (slice 1; see
   * `docs/decisions/Provider Contract — Anthropic-Conceptual Neutral Hub.md`).
   * Additive and optional, with the same precedence pattern as `contentParts`:
   * a serializer that understands blocks prefers `contentBlocks` when present,
   * else `contentParts`, else the `content` text. Production paths emit this
   * incrementally as producers migrate off legacy `contentParts`, exactly as
   * `reasoningBlocks` was introduced before its producer.
   * Adapters that don't read it are unaffected.
   */
  contentBlocks?: LlmContentBlock[];
  timestamp: number;
  /** Signed reasoning blocks captured on prior assistant turns.
   *  Forwarded verbatim to providers that consume them (currently Anthropic
   *  via `lib/anthropic-bridge`); other adapters ignore the field
   *  because their upstreams would reject the Push-private parameter.
   *
   *  The OpenAI-compat CLI adapter (`cli/openai-stream.ts`) deliberately
   *  does NOT forward this on the wire — only the Anthropic-via-bridge
   *  paths do, and the bridge re-emits these as the FIRST entries of the
   *  upstream assistant `content[]` so signed thinking round-trips across
   *  chained turns. Without this, Anthropic + extended-thinking + tool-use
   *  combinations break with `invalid_request_error` on the second turn. */
  reasoningBlocks?: ReasoningBlock[];
  /** Plain unsigned reasoning text captured on a prior assistant turn.
   *  Some OpenAI-compatible reasoning models (DeepSeek thinking mode through
   *  Zen Go / OpenRouter) require this to be replayed verbatim as
   *  `reasoning_content` on that assistant message in the next request. Distinct from
   *  `reasoningBlocks`: this has no provider signature and is only emitted by
   *  route-gated OpenAI-compatible serializers that explicitly support it. */
  reasoningContent?: string;
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/**
 * The canonical provider-id vocabulary — the single source `AIProviderType`
 * derives from. Add an id here and the union (plus every `Record<AIProviderType,
 * …>` keyed off it) updates with it; the compiler then flags each site that
 * still needs a value for the new provider. Doubles as the runtime list for
 * validation and exhaustive-map construction (the type alone erases at runtime).
 *
 * Other provider unions derive from this too: `ActiveProvider` aliases
 * `AIProviderType` and `PreferredProvider` is `Exclude<AIProviderType, 'demo'>`
 * — so the id set lives in exactly one place.
 */
export const ALL_PROVIDERS = [
  'ollama',
  'openrouter',
  'cloudflare',
  'zen',
  'nvidia',
  'fireworks',
  'sakana',
  'deepseek',
  'anthropic',
  'openai',
  'google',
  'demo',
] as const;

export type AIProviderType = (typeof ALL_PROVIDERS)[number];

export function isKnownProvider(value: unknown): value is AIProviderType {
  return typeof value === 'string' && (ALL_PROVIDERS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Streaming envelope
// ---------------------------------------------------------------------------

export interface StreamUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /**
   * Cache-read input tokens reported by the provider (a subset of
   * `inputTokens` that was served from a prompt cache). OpenAI-compatible
   * upstreams report this as `usage.prompt_tokens_details.cached_tokens`;
   * DeepSeek-shaped ones use `usage.prompt_cache_hit_tokens`. Left
   * `undefined` when the provider reports no cache field at all, so callers
   * can tell "provider doesn't surface caching" (undefined) apart from
   * "cache supported but cold this turn" (0).
   */
  cachedInputTokens?: number;
}

export interface ChunkMetadata {
  chunkIndex: number;
}

/** Emitted before the orchestrator summarizes or drops old messages. */
export interface PreCompactEvent {
  /** Estimated total tokens before compaction. */
  totalTokens: number;
  /** Token threshold that triggered compaction. */
  budgetThreshold: number;
  /** Number of messages in the window before compaction. */
  messageCount: number;
}

// ---------------------------------------------------------------------------
// Reasoning blocks (structured, signed)
// ---------------------------------------------------------------------------

/**
 * A structured reasoning block from a provider that returns extended
 * thinking with cryptographic signatures (currently Anthropic). Unlike the
 * `reasoning_delta` text channel — which is display-only — these blocks
 * MUST round-trip verbatim on chained turns: Anthropic's API requires the
 * `signature` (or `redacted_thinking.data`) to be re-sent in the next
 * request's assistant content[] when extended thinking + tool use are
 * combined, otherwise the request 400s or silently degrades.
 *
 * Captured at `content_block_stop` boundaries by the Anthropic stream
 * translator, persisted on the assistant `ChatMessage` / CLI `Message`
 * alongside the existing `thinking` text accumulator, and re-emitted as
 * the FIRST blocks of the assistant `content[]` array when the next
 * request hits the bridge.
 */
export type ReasoningBlock =
  | { type: 'thinking'; text: string; signature: string }
  | { type: 'redacted_thinking'; data: string };

/**
 * A single web-search citation surfaced by a provider's native search tool.
 * Normalized (flat, camelCase) from the OpenAI-compatible wire shape
 * (`delta.annotations[].url_citation`, which OpenRouter emits for its
 * `openrouter:web_search` server tool). Display-only — citations are never
 * sent back to the model, so they don't need wire-fidelity round-tripping
 * the way `ReasoningBlock` does.
 */
export interface UrlCitation {
  url: string;
  title: string;
  /** Excerpt the search engine pulled from the page. May be '' when the
   *  engine omits per-result content. */
  content: string;
  /** Character span in the assistant message this citation supports. Both
   *  default to 0 when the engine doesn't provide offsets. */
  startIndex: number;
  endIndex: number;
}

// ---------------------------------------------------------------------------
// Gateway Abstraction (New Wire Model)
// ---------------------------------------------------------------------------

export type PushStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'reasoning_end' }
  /**
   * Emitted once per complete structured reasoning block when the upstream
   * signals `content_block_stop`. Adapters that don't surface signed
   * reasoning never emit this event — consumers should treat it as
   * additive to the existing `reasoning_delta` text channel, not a
   * replacement.
   */
  | { type: 'reasoning_block'; block: ReasoningBlock }
  /**
   * Emitted when a provider's native web search returns `url_citation`
   * annotations (OpenRouter's `openrouter:web_search` server tool). Additive
   * to the `text_delta` channel — the grounded answer still streams as text;
   * this carries the structured sources for a "Sources" UI affordance.
   * Adapters without native search never emit it. May arrive more than once
   * (some engines send the cumulative list per frame), so consumers should
   * dedupe by `url`.
   */
  | { type: 'citations'; citations: UrlCitation[] }
  // Native `delta.tool_calls` fragment from an OpenAI-shaped provider.
  // Streams emit one per fragment so the adapter's content timer can see
  // progress while a model is mid-way through a long tool-arg payload.
  // The fragment payload itself stays internal to the provider stream; the
  // assembled call is surfaced separately as `native_tool_call` on flush.
  | { type: 'tool_call_delta' }
  /**
   * Complete provider-native function/tool call. Native-tool providers emit
   * this once the provider has assembled the full call name + arguments, so
   * dispatch consumers can validate and execute the structured payload without
   * first round-tripping it through fenced assistant text.
   */
  | { type: 'native_tool_call'; call: NativeToolCall }
  /**
   * Emitted by the Anthropic bridge when the upstream returns
   * `stop_reason: pause_turn` — the server-side sampling loop hit its
   * iteration cap mid-turn and needs the assistant's content array
   * replayed in a follow-up request to continue. The stream adapter
   * handles the replay internally; consumers should never see
   * `finishReason: 'pause_turn'` reach the round loop. The opaque
   * `assistantBlocks` payload is the Anthropic content array verbatim,
   * sent back through `OpenAIMessage.assistant_content_blocks` on the
   * continuation request.
   */
  | { type: 'pause_turn'; assistantBlocks: Array<Record<string, unknown>> }
  | {
      type: 'done';
      finishReason: 'stop' | 'length' | 'tool_calls' | 'aborted' | 'unknown';
      usage?: StreamUsage;
    };

export interface NativeToolCall {
  /** Provider-supplied tool-call id when the upstream exposes one. */
  id?: string;
  /** Provider-native function/tool name. */
  name: string;
  /** Provider-native argument payload. Tool dispatch validates this shape. */
  args: unknown;
  /**
   * Gemini-private `thoughtSignature` lifted off the function-call part during
   * stream translation. Threaded through so it lands on the stored
   * `LlmToolUseBlock` and round-trips on replay (see that type). Absent for
   * every non-Gemini provider.
   */
  thoughtSignature?: string;
}

/**
 * Provider-agnostic request for a JSON-Schema-constrained response. OpenAI-
 * compatible routes map it to
 * `response_format: { type: 'json_schema', json_schema }`; Anthropic Messages
 * routes map it to native `output_config.format` where supported, with the
 * forced-tool fallback for older routes. When set, the adapter asks the
 * upstream to constrain generation to `schema` server-side, so the model emits
 * conforming JSON in the first place rather than relying solely on the post-hoc
 * `parseStructured` repair/validate pass. Adapters that can't honor it (for
 * example Gemini native serializers) ignore the field.
 */
/** JSON-schema scalar/compound types used in tool-parameter schemas. */
export type JsonSchemaType = 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object';

/** One tool parameter's JSON-schema shape (arrays carry an `items` type). */
export interface ToolFunctionParameterSchema {
  type: JsonSchemaType;
  items?: { type: JsonSchemaType };
  /** Human/model-facing hint. Used to steer context-bound args (e.g. the
   *  active repo) that the bare type can't convey. */
  description?: string;
  /** Closed value set. Used to pin a context-bound arg to its only valid
   *  value (e.g. the lead's single active repository) so constrained decoding
   *  emits it correctly instead of a placeholder. */
  enum?: string[];
}

/**
 * Anthropic-style custom-tool schema. The neutral wire shape for native tool
 * calling; adapters that support it serialize it into the `tools` array. Built
 * from the tool registry by `lib/tool-function-schemas.ts`.
 */
export interface ToolFunctionSchema {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, ToolFunctionParameterSchema>;
    required: string[];
    additionalProperties: false;
  };
}

export interface ResponseFormatSpec {
  /** Schema name reported to the provider (e.g. `'auditor_verdict'`). */
  name: string;
  /** JSON Schema the response must satisfy. Strict mode requires every object
   *  to carry `additionalProperties: false` and a full `required` array — see
   *  `zodToStrictJsonSchema` in `lib/structured-output.ts`. */
  schema: Record<string, unknown>;
  /** Enforce strict adherence. Defaults to `true` at the wire builder. */
  strict?: boolean;
}

export interface PushStreamRequest<M extends LlmMessage = LlmMessage> {
  provider: AIProviderType;
  model: string;
  messages: M[];
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  signal?: AbortSignal;
  systemPromptOverride?: string;
  scratchpadContent?: string;
  todoContent?: string;
  /**
   * Library v2b — pre-rendered text block for each library linked to
   * the current chat (web app only, CLI ignores). Baked into the
   * system message via the `library_context` section. Caller pre-
   * fetches and formats; the provider stream is a passthrough.
   */
  linkedLibraryContent?: string;
  /**
   * Runtime context passed through unchanged by the adapter. Opaque at the
   * contract level — different runtimes carry different shapes (Web's
   * `WorkspaceContext`, CLI's `SessionContext`, etc.). Gateways that need
   * workspace-aware prompt assembly narrow this with a local cast.
   */
  workspaceContext?: unknown;
  /** Forwarded through the adapter for gateways that compose sandbox-aware prompts. */
  hasSandbox?: boolean;
  /** Forwarded through the adapter so gateways can signal context compaction. */
  onPreCompact?: (event: PreCompactEvent) => void;
  /**
   * Indices into `messages` to tag with Anthropic-style
   * `cache_control: { type: 'ephemeral' }`, as computed by
   * `transformContextBeforeLLM`'s `cacheBreakpointIndices`. The wire adapter
   * pairs these with a separate marker on the system message for the Hermes
   * `system_and_3` shape — at most 4 cached prefixes per request.
   *
   * Ordered oldest-first. Disabled states (gateway must NOT tag):
   * - `undefined` — caller did not opt in
   * - `[]` — sentinel when the transformed messages contain no non-system
   *   role (e.g. system-only transcript on the very first turn before the
   *   user sends anything)
   *
   * Gateways that don't support prefix caching ignore this field entirely.
   */
  cacheBreakpointIndices?: number[];
  /** Scope-filtered `MemoryRecord` rows pre-fetched by the caller for the
   *  session-digest transformer stage. Pre-fetched (not resolved inside the
   *  sync wire path) because the production memory stores
   *  (`createIndexedDbStore`, `createFileMemoryStore`) return Promises from
   *  `list()`. Gateways forward this verbatim to `toLLMMessages` /
   *  equivalent; consumers without session-digest wiring ignore. */
  sessionDigestRecords?: ReadonlyArray<import('./runtime-contract.js').MemoryRecord>;
  /** Most-recent `SessionDigest` emitted by the previous turn, persisted by
   *  the caller out of band of the transcript. The transformer's digest
   *  stage merges into this when a transcript-resident `[SESSION_DIGEST]`
   *  message isn't available — what makes cross-turn cumulative behavior
   *  reach production. See `lib/session-digest.ts` and the digest stage in
   *  `lib/context-transformer.ts`. */
  priorSessionDigest?: import('./session-digest.js').SessionDigest;
  /** Invoked synchronously by the gateway after `toLLMMessages` materializes
   *  the digest for this turn, so the caller can persist it as the next
   *  turn's `priorSessionDigest`. Receives the merged digest the model is
   *  actually about to see; `null` when no digest was emitted (no compaction
   *  this turn). The whole cross-turn merge chain depends on the caller
   *  wiring this callback — without it the session digest cannot accumulate
   *  across turns. */
  onSessionDigestEmitted?: (digest: import('./session-digest.js').SessionDigest | null) => void;
  /** Google-specific flag to enable search grounding */
  googleSearchGrounding?: boolean;
  /** Anthropic-specific flag to enable native `web_search_20250305` tool */
  anthropicWebSearch?: boolean;
  /** OpenRouter-specific flag to enable the native `openrouter:web_search`
   *  server tool. OpenRouter executes the search server-side (engine `auto`:
   *  native provider search when available, else Exa) and feeds grounded,
   *  cited results back to the model. */
  openrouterWebSearch?: boolean;
  /** Responses-API flag to enable OpenAI's native `web_search` server tool on
   *  the `/v1/responses` adapters (direct OpenAI, Sakana Fugu, Fireworks). The
   *  provider runs the search server-side and feeds grounded, `url_citation`-
   *  annotated results back to the model. */
  responsesWebSearch?: boolean;
  /**
   * Constrain the response to a JSON Schema. Honored by provider adapters whose
   * capability profile advertises structured outputs; ignored by adapters that
   * do not have a confirmed structured-output wire. See `ResponseFormatSpec`.
   */
  responseFormat?: ResponseFormatSpec;
  /**
   * Native function-calling tool schemas (OpenAI `tools` array). Attached only
   * for models that support native function calling; adapters serialize it
   * alongside `tool_choice: 'auto'`. Purely additive to the text-dispatch tool
   * protocol — provider streams surface complete native calls as
   * `native_tool_call` events, while non-native/text-dispatch models keep using
   * fenced JSON in assistant text.
   * Adapters that don't support it ignore the field. See `ToolFunctionSchema`
   * and `lib/tool-function-schemas.ts`.
   */
  tools?: ToolFunctionSchema[];
  /**
   * Escalation for native function-calling requests: forces the model to emit
   * a structured tool call instead of a free-text reply. Defaults to `'auto'`
   * (prose answers remain available) when unset. Set to `'required'` for one
   * round after a model announces an imminent tool action but emits no call
   * (`detectTrailingActionIntent`) — a text-only re-prompt can't stop a model
   * from repeating the same announce-without-act pattern, but `tool_choice:
   * 'required'` closes that loophole at the API level. Ignored by adapters
   * whose wire has no `tools` attached (nothing to force) or that don't
   * support the field.
   */
  toolChoice?: 'auto' | 'required';
  /**
   * Pause-turn continuation blocks for the neutral wire. Anthropic's server-side
   * sampling loop can return `stop_reason: pause_turn` (web search hitting its
   * iteration cap); the client replays the paused assistant content[] verbatim
   * on the follow-up request so the model resumes. Each entry is one prior
   * paused turn's raw Anthropic content array (oldest-first). The Worker forwards
   * these to `toAnthropicMessages`' `replayAssistantTurns` option, which appends
   * them as trailing assistant turns. Opaque passthrough — only the Anthropic
   * neutral path reads it; other gateways ignore it. The legacy OpenAI-shape
   * path carried the same data inline as `assistant_content_blocks` messages.
   */
  replayAssistantTurns?: Array<Array<Record<string, unknown>>>;
}

export type PushStream<M extends LlmMessage = LlmMessage> = (
  req: PushStreamRequest<M>,
) => AsyncIterable<PushStreamEvent>;

// ---------------------------------------------------------------------------
// Review result types
// ---------------------------------------------------------------------------

export interface ReviewComment {
  file: string;
  severity: 'critical' | 'warning' | 'suggestion' | 'note';
  comment: string;
  /** Line number in the new file (RIGHT side) — present when the model targeted a specific added line */
  line?: number;
}

export interface ReviewResult {
  summary: string;
  comments: ReviewComment[];
  /** Files included in the diff that was actually sent to the model */
  filesReviewed: number;
  /** Total files in the full diff (may exceed filesReviewed when truncated) */
  totalFiles: number;
  /** True when the diff was sliced before review — coverage is partial */
  truncated: boolean;
  provider: string;
  model: string;
  reviewedAt: number;
  /** Token usage accumulated across the review's model rounds. Optional —
   * present only when the provider stream reported usage (OpenAI-compatible
   * endpoints with `stream_options.include_usage`, or the Anthropic-transport
   * bridge). Absent when the upstream emitted no usage, so consumers should
   * treat a missing value as "unknown" (render `—`), not zero. */
  usage?: StreamUsage;
  /** True when the run ended WITHOUT structured output (no parseable
   * `[REVIEW_COMPLETE]` payload — round exhaustion, a dead forced-output
   * turn, or unparseable JSON) and the result is a fallback. A degraded
   * result carries zero findings by construction; consumers must present it
   * as an incomplete review, never as a clean pass. */
  degraded?: boolean;
}
