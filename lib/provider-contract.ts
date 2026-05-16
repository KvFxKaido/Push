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
