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
 * Minimum portable message shape understood by all lib/-side agent roles.
 */
export interface LlmMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
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

// ---------------------------------------------------------------------------
// Streaming envelope
// ---------------------------------------------------------------------------

export interface StreamUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
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
  // Native `delta.tool_calls` fragment from an OpenAI-shaped provider.
  // Streams emit one per fragment so the adapter's content timer can see
  // progress while a model is mid-way through a long tool-arg payload.
  // The fragment payload itself stays internal to the provider stream — by
  // the time a consumer cares about tool dispatch, the stream has flushed
  // the assembled call as fenced JSON `text_delta` on finish.
  | { type: 'tool_call_delta' }
  | {
      type: 'done';
      finishReason: 'stop' | 'length' | 'tool_calls' | 'aborted' | 'unknown';
      usage?: StreamUsage;
    };

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
}