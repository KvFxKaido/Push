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

/**
 * Stream a chat completion from a provider.
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
// Gateway Abstraction (New Wire Model)
// ---------------------------------------------------------------------------

export type PushStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'done'; finishReason: 'stop' | 'length' | 'tool_calls' | 'aborted' | 'unknown'; usage?: StreamUsage };

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
}

export type PushStream<M extends LlmMessage = LlmMessage> =
  (req: PushStreamRequest<M>) => AsyncIterable<PushStreamEvent>;

/**
 * Bridge an async-iterable PushStream back to the legacy callback shape.
 * Helps migrate call sites incrementally.
 */
export function createProviderStreamAdapter<M extends LlmMessage = LlmMessage>(
  gatewayStream: PushStream<M>,
  provider: AIProviderType,
  options?: { defaultModel?: string }
): ProviderStreamFn<M> {
  return async (
    messages,
    onToken,
    onDone,
    onError,
    onThinkingToken,
    _workspaceContext,
    _hasSandbox,
    modelOverride,
    systemPromptOverride,
    scratchpadContent,
    signal,
    _onPreCompact
  ) => {
    if (signal?.aborted) {
      onDone();
      return;
    }

    try {
      const stream = gatewayStream({
        provider,
        model: modelOverride || options?.defaultModel || 'unknown',
        messages,
        signal,
        systemPromptOverride,
        scratchpadContent,
      });

      for await (const event of stream) {
        if (signal?.aborted) {
          onDone();
          return;
        }

        switch (event.type) {
          case 'text_delta':
            onToken(event.text);
            break;
          case 'reasoning_delta':
            onThinkingToken?.(event.text);
            break;
          case 'done':
            onDone(event.usage);
            return;
        }
      }
    } catch (err) {
      if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
        onDone();
        return;
      }
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  };
}

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
