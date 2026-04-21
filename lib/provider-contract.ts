/**
 * Shared provider-contract types.
 *
 * Canonical home for the minimum surface an agent role needs to stream
 * tokens from a provider without importing Web shell state. Lives in `lib/`
 * so CLI (pushd, push-runtime-v2) and Web share one definition.
 *
 * `ProviderStreamFn` is generic over the message shape and the workspace-
 * context shape. Agents that only need the four portable message fields
 * (`LlmMessage`) use the default; callers that carry a richer message type
 * (e.g. Web's `ChatMessage` with attachments/cards) narrow both generics
 * at the boundary.
 */

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * Minimum portable message shape understood by all lib/-side agent roles.
 *
 * Intentionally a subset of Web's `ChatMessage` so that reviewer/auditor/
 * explorer can operate on a strict 4-field envelope without dragging the
 * ChatCard / attachments / tool-result metadata universe into lib/.
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

/**
 * Stream a chat completion from a provider.
 *
 * Parameter order is preserved from the pre-extraction `StreamChatFn` so
 * existing Web call sites type-check unchanged via
 * `StreamChatFn = ProviderStreamFn<ChatMessage, WorkspaceContext>`.
 *
 * Runtime safety note for the generic `M` parameter: the concrete Web
 * implementation (`streamSSEChat` in `app/src/lib/orchestrator.ts`) reads
 * `ChatMessage`-only fields (`attachments`, `isToolResult`) via optional
 * chaining / truthy guards only. Passing a plain `LlmMessage[]` through
 * a `ProviderStreamFn<ChatMessage, WorkspaceContext>` is therefore runtime-
 * safe even though contravariance makes the assignment unsound in the
 * abstract. If anyone ever removes those optional-chain guards, the Web
 * shim layer for agents that default to `LlmMessage` needs to widen its
 * message construction to match.
 */
export type ProviderStreamFn<M extends LlmMessage = LlmMessage, W = unknown> = (
  messages: M[],
  onToken: (token: string, meta?: ChunkMetadata) => void,
  onDone: (usage?: StreamUsage) => void,
  onError: (error: Error) => void,
  onThinkingToken?: (token: string | null) => void,
  workspaceContext?: W,
  hasSandbox?: boolean,
  modelOverride?: string,
  systemPromptOverride?: string,
  scratchpadContent?: string,
  signal?: AbortSignal,
  onPreCompact?: (event: PreCompactEvent) => void,
) => Promise<void>;

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
