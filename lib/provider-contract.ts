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
 * A single content part for multimodal messages. Mirrors the OpenAI-compatible
 * `image_url` shape the rest of the codebase already uses (web `LLMMessage`,
 * `OpenAIContentPart`). `image_url.url` is a `data:` base64 URL or an `http(s)`
 * URL; both are carried losslessly to providers that accept images.
 */
export type LlmContentPart =
  | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
  | { type: 'image_url'; image_url: { url: string }; cache_control?: { type: 'ephemeral' } };

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
  timestamp: number;
  /** Signed reasoning blocks captured on prior assistant turns.
   *  Forwarded verbatim to providers that consume them (currently Anthropic
   *  via `lib/openai-anthropic-bridge`); other adapters ignore the field
   *  because their upstreams would reject the Push-private parameter.
   *
   *  The OpenAI-compat CLI adapter (`cli/openai-stream.ts`) deliberately
   *  does NOT forward this on the wire — only the Anthropic-via-bridge
   *  paths do, and the bridge re-emits these as the FIRST entries of the
   *  upstream assistant `content[]` so signed thinking round-trips across
   *  chained turns. Without this, Anthropic + extended-thinking + tool-use
   *  combinations break with `invalid_request_error` on the second turn. */
  reasoningBlocks?: ReasoningBlock[];
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export type AIProviderType =
  | 'ollama'
  | 'openrouter'
  | 'cloudflare'
  | 'zen'
  | 'nvidia'
  | 'blackbox'
  | 'azure'
  | 'kilocode'
  | 'openadapter'
  | 'bedrock'
  | 'vertex'
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'demo';

/** Every member of `AIProviderType`, for runtime validation and exhaustive
 * map construction (the type alone erases at runtime). `satisfies` pins
 * membership (no stray entries); the `_AllProvidersCovered` assertion below
 * pins exhaustiveness (no missing entries) — adding a provider to the union
 * without listing it here is a compile error, not a silent omission. */
export const ALL_PROVIDERS = [
  'ollama',
  'openrouter',
  'cloudflare',
  'zen',
  'nvidia',
  'blackbox',
  'azure',
  'kilocode',
  'openadapter',
  'bedrock',
  'vertex',
  'anthropic',
  'openai',
  'google',
  'demo',
] as const satisfies readonly AIProviderType[];

// Compile-time exhaustiveness: `Exclude<...>` is `never` only when every
// union member appears in ALL_PROVIDERS; a missing member fails the
// `extends never` constraint with its name in the error. Exported solely so
// noUnusedLocals doesn't reject the compile-time-only assertion.
type AssertNever<T extends never> = T;
export type _AllProvidersCovered = AssertNever<
  Exclude<AIProviderType, (typeof ALL_PROVIDERS)[number]>
>;

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
  // The fragment payload itself stays internal to the provider stream — by
  // the time a consumer cares about tool dispatch, the stream has flushed
  // the assembled call as fenced JSON `text_delta` on finish.
  | { type: 'tool_call_delta' }
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

/**
 * Provider-agnostic request for a JSON-Schema-constrained response, mapping to
 * the OpenAI `response_format: { type: 'json_schema', json_schema }` field that
 * OpenRouter and the OpenAI-compat routes honor. When set, the adapter asks the
 * upstream to constrain generation to `schema` server-side, so the model emits
 * conforming JSON in the first place rather than relying solely on the post-hoc
 * `parseStructured` repair/validate pass. Adapters that can't honor it (the
 * Anthropic / Gemini native serializers) ignore the field.
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
 * OpenAI-style function-calling tool schema. The neutral wire shape for native
 * tool calling; adapters that support it serialize it into the `tools` array.
 * Built from the tool registry by `lib/tool-function-schemas.ts`.
 */
export interface ToolFunctionSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, ToolFunctionParameterSchema>;
      required: string[];
      additionalProperties: false;
    };
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
  /**
   * Constrain the response to a JSON Schema (OpenAI `response_format`). Honored
   * by the OpenRouter adapter and the OpenAI-compat serializer (`toOpenAIChat`);
   * ignored by the Anthropic / Gemini native serializers. See `ResponseFormatSpec`.
   */
  responseFormat?: ResponseFormatSpec;
  /**
   * Native function-calling tool schemas (OpenAI `tools` array). Attached only
   * for models that support native function calling; adapters serialize it
   * alongside `tool_choice: 'auto'`. Purely additive to the text-dispatch tool
   * protocol — `openai-sse-pump` normalizes any native `tool_calls` back into
   * the fenced JSON the dispatcher consumes, so the two paths converge.
   * Adapters that don't support it ignore the field. See `ToolFunctionSchema`
   * and `lib/tool-function-schemas.ts`.
   */
  tools?: ToolFunctionSchema[];
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
