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
// Gateway Abstraction (New Wire Model)
// ---------------------------------------------------------------------------

export type PushStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'reasoning_end' }
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
   * Index into `messages` of the last user-role message, as computed by
   * `transformContextBeforeLLM`. When set to a non-negative integer,
   * gateways MAY use it to attach Anthropic-style
   * `cache_control: { type: 'ephemeral' }` markers at the prompt prefix
   * boundary so the cached prefix stays byte-stable across turns when
   * only new messages were appended.
   *
   * Disabled states (gateway must NOT tag):
   * - `undefined` — caller did not opt in
   * - `-1` — sentinel returned by `transformContextBeforeLLM` when the
   *   transformed messages contain no user role
   *
   * Gateways that don't support prefix caching ignore this field
   * entirely.
   */
  cacheBreakpointIndex?: number;
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
