import type { ChatMessage, WorkspaceContext } from '@/types';
import { formatVerificationPolicyBlock } from './verification-policy';
import { TOOL_PROTOCOL } from './github-tools';
import { getSandboxToolProtocol } from './sandbox-tools';
import { SCRATCHPAD_TOOL_PROTOCOL, buildScratchpadContext } from './scratchpad-tools';
import { TODO_TOOL_PROTOCOL } from './todo-tools';
import { WEB_SEARCH_TOOL_PROTOCOL } from './web-search-tools';
import { ASK_USER_TOOL_PROTOCOL } from './ask-user-tools';
import { KNOWN_TOOL_NAMES } from './tool-dispatch';
import { getUserProfile } from '@/hooks/useUserProfile';
import type { UserProfile } from '@/types';
import { buildUserIdentityBlock } from '@push/lib/user-identity';
import { REQUEST_ID_HEADER, createRequestId } from './request-id';
import { buildModelCapabilityAwarenessBlock } from './model-capabilities';
import { getApprovalMode, buildApprovalModeBlock } from './approval-mode';
import { buildSessionCapabilityBlock, buildSandboxEnvironmentBlock } from './workspace-context';
import { diffSnapshots, formatSnapshotDiff, type PromptSnapshot } from './system-prompt-builder';
import {
  buildOrchestratorBaseBuilder,
  buildOrchestratorBasePrompt,
} from './orchestrator-prompt-builder';
import { manageContext } from './message-context-manager';
import {
  getPushTracer,
  injectTraceHeaders,
  recordSpanError,
  setSpanAttributes,
  SpanKind,
  SpanStatusCode,
} from './tracing';
// --- Re-exports from orchestrator-streaming (break circular dependency) ---
export {
  parseProviderError,
  hasFinishReason,
  type StreamProviderConfig,
  type StreamUsage,
  type ChunkMetadata,
} from './orchestrator-streaming';

import type { StreamProviderConfig, StreamUsage, ChunkMetadata } from './orchestrator-streaming';
import { selectTimeoutMessage } from './orchestrator-streaming';
import type { ActiveProvider } from './orchestrator-provider-routing';

// --- Imports from extracted modules ---
import { getContextBudget } from './orchestrator-context';

// --- Barrel re-exports (preserve existing consumer import paths) ---
export {
  getContextMode,
  setContextMode,
  getContextBudget,
  estimateContextTokens,
  type ContextMode,
  type ContextBudget,
} from './orchestrator-context';

export {
  type ActiveProvider,
  getActiveProvider,
  isProviderAvailable,
  getProviderStreamFn,
  streamChat,
  streamOllamaChat,
  streamOpenRouterChat,
  streamCloudflareChat,
  streamZenChat,
  streamNvidiaChat,
  streamBlackboxChat,
  streamKilocodeChat,
  streamOpenAdapterChat,
  streamAzureChat,
  streamBedrockChat,
  streamVertexChat,
} from './orchestrator-provider-routing';

// ---------------------------------------------------------------------------
// Shared: system prompt, demo text, message builder
// ---------------------------------------------------------------------------

/**
 * Exported for backwards compatibility (tests reference this).
 *
 * Context management helpers (`manageContext`, `classifySummarizationCause`,
 * `buildContextDigest`) now live in `lib/message-context-manager.ts` and are
 * imported via the `./message-context-manager` shim.
 *
 * Orchestrator prompt builders (`buildOrchestratorGuidelines`,
 * `buildOrchestratorToolInstructions`, `buildOrchestratorDelegation`,
 * `buildOrchestratorBaseBuilder`, `buildOrchestratorBasePrompt`) now live in
 * `lib/orchestrator-prompt-builder.ts` and are imported via the
 * `./orchestrator-prompt-builder` shim.
 */
export const ORCHESTRATOR_SYSTEM_PROMPT = buildOrchestratorBasePrompt();

/**
 * Dev-only: previous prompt snapshots for diffing between turns.
 * Keyed by a conversation-ish snapshot key so multi-chat sessions do not
 * compare unrelated prompts against each other in the console.
 * Only read/written inside `import.meta.env.DEV` guards.
 */
const _lastPromptSnapshots = new Map<string, PromptSnapshot>();

function getPromptSnapshotKey(
  messages: ChatMessage[],
  workspaceContext?: WorkspaceContext,
): string {
  const firstUserMessage = messages.find(
    (message) => message.role === 'user' && !message.isToolResult,
  );
  if (firstUserMessage) {
    return `user:${firstUserMessage.id}`;
  }
  if (workspaceContext) {
    return `workspace:${workspaceContext.mode}:${workspaceContext.description}`;
  }
  return 'global';
}

// Multimodal content types (OpenAI-compatible)
interface LLMMessageContentText {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

interface LLMMessageContentImage {
  type: 'image_url';
  image_url: { url: string };
}

type LLMMessageContent = LLMMessageContentText | LLMMessageContentImage;

interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | LLMMessageContent[];
  intentHint?: string | null;
}

function isNonEmptyContent(content: string | LLMMessageContent[]): boolean {
  if (Array.isArray(content)) {
    return content.length > 0;
  }
  return content.trim().length > 0;
}

/**
 * Build a chat instructions block for the system prompt.
 * Only used in chat mode — workspace mode uses project instructions (AGENTS.md) instead.
 */
export function buildChatInstructionsBlock(profile?: UserProfile): string {
  const instructions = profile?.chatInstructions?.trim();
  if (!instructions) return '';
  const escaped = instructions
    .replace(/\[CHAT INSTRUCTIONS\]/gi, '[CHAT INSTRUCTIONS\u200B]')
    .replace(/\[\/CHAT INSTRUCTIONS\]/gi, '[/CHAT INSTRUCTIONS\u200B]');
  return `## Chat Instructions\n${escaped}`;
}

export { buildUserIdentityBlock };

/**
 * Exported so PushStream implementations (e.g. `openrouter-stream.ts`) can
 * compose messages client-side with the same prompt-assembly path the
 * legacy streamSSEChatOnce uses. Not part of the public runtime API.
 */
export function toLLMMessages(
  messages: ChatMessage[],
  workspaceContext?: WorkspaceContext,
  hasSandbox?: boolean,
  systemPromptOverride?: string,
  scratchpadContent?: string,
  providerType?: Exclude<ActiveProvider, 'demo'>,
  providerModel?: string,
  onPreCompact?: (event: import('@/types').PreCompactEvent) => void,
  intentHint?: string | null,
  todoContent?: string,
): LLMMessage[] {
  // When a systemPromptOverride is provided (Auditor, Coder), the caller has already
  // composed a complete system prompt — don't append Orchestrator-specific protocols.
  let systemContent: string;
  const promptSnapshotKey = getPromptSnapshotKey(messages, workspaceContext);

  if (systemPromptOverride) {
    systemContent = systemPromptOverride;
    _lastPromptSnapshots.delete(promptSnapshotKey);
  } else {
    // Build the full orchestrator prompt using the sectioned builder.
    // Start from the shared base and layer in runtime-dependent blocks.
    const builder = buildOrchestratorBaseBuilder();

    // Chat mode — strip orchestrator tool instructions and delegation (plain
    // conversation). Web search is layered back in below so chat can still
    // ground answers on fresh information.
    if (workspaceContext?.mode === 'chat') {
      builder.set('tool_instructions', null);
      builder.set('delegation', null);
    }

    // User identity (name, bio) when configured
    const profile = getUserProfile();
    const identityBlock = buildUserIdentityBlock(profile);
    const approvalBlock = buildApprovalModeBlock(getApprovalMode());
    const chatInstructionsBlock =
      workspaceContext?.mode === 'chat' ? buildChatInstructionsBlock(profile) : '';
    builder.set(
      'user_context',
      [identityBlock, chatInstructionsBlock, approvalBlock].filter(Boolean).join('\n\n'),
    );

    // Model capability awareness
    if (providerType && providerModel) {
      const hasImageAttachments = messages.some((message) =>
        Boolean(message.attachments?.some((attachment) => attachment.type === 'image')),
      );
      builder.set(
        'capabilities',
        buildModelCapabilityAwarenessBlock(providerType, providerModel, {
          hasImageAttachments,
        }),
      );
    }

    // Workspace description + GitHub tool protocol
    if (workspaceContext) {
      let envContent = workspaceContext.description;
      const capabilityBlock = buildSessionCapabilityBlock(workspaceContext, hasSandbox);
      if (capabilityBlock) {
        envContent += '\n\n' + capabilityBlock;
      }
      if (workspaceContext.includeGitHubTools) {
        envContent += '\n' + TOOL_PROTOCOL;
      }
      builder.set('environment', envContent);

      if (hasSandbox) {
        builder.set('sandbox_environment', buildSandboxEnvironmentBlock(true));
      }
    }

    // Session-level verification policy (from workspace context)
    const verificationPolicyBlock = formatVerificationPolicyBlock(
      workspaceContext?.verificationPolicy,
    );
    if (verificationPolicyBlock) {
      builder.append('guidelines', verificationPolicyBlock);
    }

    // Tool protocols — session-stable instructions about how to use tools.
    // Chat mode gets only the web_search protocol — no sandbox, delegation,
    // scratchpad, or ask_user — so it stays a plain conversation that can
    // still look things up on the web when the user asks.
    // Use set() to replace the base tool_instructions with the full set,
    // avoiding duplication if this code path runs more than once.
    if (workspaceContext?.mode === 'chat') {
      builder.set('tool_instructions', WEB_SEARCH_TOOL_PROTOCOL);
    } else {
      const baseToolInstructions = builder.get('tool_instructions') ?? '';
      const toolProtocols: string[] = [];
      if (hasSandbox) {
        toolProtocols.push(getSandboxToolProtocol());
      }
      toolProtocols.push(SCRATCHPAD_TOOL_PROTOCOL);
      toolProtocols.push(TODO_TOOL_PROTOCOL);
      toolProtocols.push(WEB_SEARCH_TOOL_PROTOCOL);
      toolProtocols.push(ASK_USER_TOOL_PROTOCOL);
      builder.set('tool_instructions', baseToolInstructions + '\n' + toolProtocols.join('\n'));

      // Memory block — the model's working-memory surfaces. Scratchpad holds
      // user-visible notes/context; todo holds the current step plan. Both
      // are volatile and change between turns.
      const memoryBlocks: string[] = [];
      if (scratchpadContent !== undefined) {
        memoryBlocks.push(buildScratchpadContext(scratchpadContent));
      }
      if (todoContent !== undefined) {
        memoryBlocks.push(todoContent);
      }
      if (memoryBlocks.length > 0) {
        builder.set('memory', memoryBlocks.join('\n\n'));
      }
    }

    // Intent hint (last so it overrides)
    builder.set('last_instructions', intentHint);

    systemContent = builder.build();

    // --- Log prompt-size breakdown and section diffs (dev only) ---
    if (import.meta.env.DEV) {
      const fmt = (n: number) => n.toLocaleString();
      const sizes = builder.sizes();
      const parts = Object.entries(sizes)
        .map(([k, v]) => `${k}=${fmt(v)}`)
        .join(' ');
      console.log(`[Context Budget] System prompt: ${fmt(systemContent.length)} chars (${parts})`);

      const currentSnap = builder.snapshot();
      const previousSnap = _lastPromptSnapshots.get(promptSnapshotKey);
      if (previousSnap) {
        const diff = diffSnapshots(previousSnap, currentSnap);
        const diffStr = formatSnapshotDiff(diff);
        if (diffStr) console.log(diffStr);
      }
      _lastPromptSnapshots.set(promptSnapshotKey, currentSnap);
    }
  }

  // Prompt caching: wrap the system message as a content-array with cache_control
  // for providers that support it (currently OpenRouter/Anthropic). Other
  // providers harmlessly ignore the extra field.
  const cacheable = providerType === 'openrouter';
  const llmMessages: LLMMessage[] = [
    cacheable
      ? {
          role: 'system',
          content: [
            { type: 'text', text: systemContent, cache_control: { type: 'ephemeral' } },
          ] as LLMMessageContent[],
        }
      : { role: 'system', content: systemContent },
  ];

  // Smart context management — summarize old messages instead of dropping
  const contextBudget = getContextBudget(providerType, providerModel);
  const windowedMessages = manageContext(messages, contextBudget, providerType, onPreCompact);

  for (const msg of windowedMessages) {
    // Check for attachments (multimodal message)
    if (msg.attachments && msg.attachments.length > 0) {
      const contentParts: LLMMessageContent[] = [];

      // Add text first (if any)
      if (msg.content) {
        contentParts.push({ type: 'text', text: msg.content });
      }

      // Add attachments
      for (const att of msg.attachments) {
        if (att.type === 'image') {
          // Image: use image_url format with base64 data URL
          contentParts.push({
            type: 'image_url',
            image_url: { url: att.content },
          });
        } else {
          // Code/document: embed as text block
          contentParts.push({
            type: 'text',
            text: `[Attached file: ${att.filename}]\n\`\`\`\n${att.content}\n\`\`\``,
          });
        }
      }

      llmMessages.push({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: contentParts,
      });
    } else {
      // Simple text message (existing behavior)
      // Guard against provider-side validation errors:
      // some OpenAI-compatible backends reject empty assistant turns.
      if (msg.role === 'assistant' && !msg.content.trim()) {
        continue;
      }
      llmMessages.push({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.content,
      });
    }
  }

  // Prompt Caching: cache the entire prefix up to the last user message.
  // Active for providers that support cache_control (OpenRouter, Mistral).
  if (cacheable && llmMessages.length > 0) {
    for (let i = llmMessages.length - 1; i >= 0; i--) {
      if (llmMessages[i].role === 'user') {
        const lastMsg = llmMessages[i];
        if (typeof lastMsg.content === 'string') {
          lastMsg.content = [
            { type: 'text', text: lastMsg.content, cache_control: { type: 'ephemeral' } },
          ];
        } else if (Array.isArray(lastMsg.content)) {
          // Already an array (e.g. from attachments), tag the last part
          const lastPart = lastMsg.content[lastMsg.content.length - 1];
          if (lastPart.type === 'text') {
            lastPart.cache_control = { type: 'ephemeral' };
          }
        }
        break;
      }
    }
  }

  // Final sanitize pass: never send empty assistant messages.
  return llmMessages.filter((msg) => {
    if (msg.role !== 'assistant') return true;
    return isNonEmptyContent(msg.content);
  });
}

// ---------------------------------------------------------------------------
// Shared: <think> tag parser
// ---------------------------------------------------------------------------

interface ThinkTokenParser {
  push(token: string): void;
  flush(): void;
}

function createThinkTokenParser(
  onToken: (token: string, meta?: ChunkMetadata) => void,
  onThinkingToken?: (token: string | null) => void,
): ThinkTokenParser {
  let insideThink = false;
  let tagBuffer = '';

  return {
    push(token: string) {
      tagBuffer += token;

      // Detect <think> opening
      if (!insideThink && tagBuffer.includes('<think>')) {
        const before = tagBuffer.split('<think>')[0];
        if (before) onToken(before);
        insideThink = true;
        tagBuffer = '';
        return;
      }

      // Inside thinking — emit thinking tokens, watch for </think>
      if (insideThink) {
        if (tagBuffer.includes('</think>')) {
          const thinkContent = tagBuffer.split('</think>')[0];
          if (thinkContent) onThinkingToken?.(thinkContent);
          onThinkingToken?.(null); // signal thinking done

          const after = tagBuffer.split('</think>').slice(1).join('</think>');
          insideThink = false;
          tagBuffer = '';
          const cleaned = after.replace(/^\s+/, '');
          if (cleaned) onToken(cleaned);
        } else {
          // Emit thinking tokens as they arrive, keep tail for tag detection
          const safe = tagBuffer.slice(0, -10);
          if (safe) onThinkingToken?.(safe);
          tagBuffer = tagBuffer.slice(-10);
        }
        return;
      }

      // Normal content — emit when we're sure there's no partial <think
      if (tagBuffer.length > 50 || !tagBuffer.includes('<')) {
        onToken(tagBuffer);
        tagBuffer = '';
      }
    },

    flush() {
      if (tagBuffer && !insideThink) {
        onToken(tagBuffer);
      }
      tagBuffer = '';
    },
  };
}

// ---------------------------------------------------------------------------
// Smart Chunking — reduces UI updates on mobile by batching tokens
// ---------------------------------------------------------------------------

/**
 * Creates a chunked emitter that batches tokens for smoother mobile UI.
 *
 * Tokens are buffered and emitted when:
 * 1. A word boundary (space/newline) is encountered
 * 2. Buffer reaches MIN_CHUNK_SIZE characters
 * 3. FLUSH_INTERVAL_MS passes without emission
 *
 * This reduces React setState calls from per-character to per-word,
 * dramatically improving performance on slower mobile devices.
 */
export interface ChunkedEmitter {
  push(token: string): void;
  flush(): void;
}

export function createChunkedEmitter(
  emit: (chunk: string, meta?: ChunkMetadata) => void,
  options?: { minChunkSize?: number; flushIntervalMs?: number },
): ChunkedEmitter {
  const MIN_CHUNK_SIZE = options?.minChunkSize ?? 4; // Min chars before emitting
  const FLUSH_INTERVAL_MS = options?.flushIntervalMs ?? 50; // Max time to hold tokens

  let buffer = '';
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let chunkIndex = 0;

  const doEmit = () => {
    if (buffer) {
      chunkIndex++;
      emit(buffer, { chunkIndex });
      buffer = '';
    }
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
  };

  const scheduleFlush = () => {
    if (!flushTimer) {
      flushTimer = setTimeout(doEmit, FLUSH_INTERVAL_MS);
    }
  };

  return {
    push(token: string) {
      buffer += token;

      // Emit on word boundaries (space, newline) if we have enough content
      const hasWordBoundary = /[\s\n]/.test(token);
      if (hasWordBoundary && buffer.length >= MIN_CHUNK_SIZE) {
        doEmit();
        return;
      }

      // Emit if buffer is getting large (long word without spaces)
      if (buffer.length >= MIN_CHUNK_SIZE * 4) {
        doEmit();
        return;
      }

      // Otherwise, schedule a flush to ensure tokens don't get stuck
      scheduleFlush();
    },

    flush() {
      doEmit();
    },
  };
}

// ---------------------------------------------------------------------------
// Shared: generic SSE streaming with timeouts
// ---------------------------------------------------------------------------

interface AutoRetryConfig {
  maxAttempts?: number;
  backoffMs?: number;
}

export async function streamSSEChat(
  config: StreamProviderConfig,
  messages: ChatMessage[],
  onToken: (token: string, meta?: ChunkMetadata) => void,
  onDone: (usage?: StreamUsage) => void,
  onError: (error: Error) => void,
  onThinkingToken?: (token: string | null) => void,
  workspaceContext?: WorkspaceContext,
  hasSandbox?: boolean,
  systemPromptOverride?: string,
  scratchpadContent?: string,
  signal?: AbortSignal,
  autoRetry?: AutoRetryConfig,
  onPreCompact?: (event: import('@/types').PreCompactEvent) => void,
  todoContent?: string,
): Promise<void> {
  const maxAttempts = autoRetry?.maxAttempts ?? 1;
  const backoffMs = autoRetry?.backoffMs ?? 1000;

  let lastError: Error | undefined;
  let tokensEmitted = false;

  // Wrap onToken to track whether any content reached the UI
  const trackedOnToken: typeof onToken = (token, meta) => {
    tokensEmitted = true;
    onToken(token, meta);
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    tokensEmitted = false;
    try {
      return await streamSSEChatOnce(
        config,
        messages,
        trackedOnToken,
        onDone,
        onError,
        onThinkingToken,
        workspaceContext,
        hasSandbox,
        systemPromptOverride,
        scratchpadContent,
        signal,
        onPreCompact,
        todoContent,
      );
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Don't retry on auth errors or user aborts
      if (
        lastError.message.includes('key') ||
        lastError.message.includes('auth') ||
        lastError.message.includes('Unauthorized') ||
        signal?.aborted
      ) {
        throw lastError;
      }

      // Don't retry if tokens already reached the UI — retrying would
      // produce duplicate or interleaved content in the response.
      if (tokensEmitted) {
        throw lastError;
      }

      // Check if this is a timeout error worth retrying
      const isTimeout =
        lastError.message.includes('timeout') ||
        lastError.message.includes('stall') ||
        lastError.message.includes('no data');

      if (attempt < maxAttempts && isTimeout) {
        console.log(`[Push] Retry attempt ${attempt}/${maxAttempts} after ${backoffMs}ms...`);
        await new Promise((r) => setTimeout(r, backoffMs * attempt));
        continue;
      }

      throw lastError;
    }
  }
}

/**
 * Single-attempt SSE streaming call.
 *
 * Exported so tests can drive the timer + abort machinery directly without
 * mocking the full provider routing stack — the production retry wrapper
 * `streamSSEChat` is still the right entry point for production code.
 */
export async function streamSSEChatOnce(
  config: StreamProviderConfig,
  messages: ChatMessage[],
  onToken: (token: string, meta?: ChunkMetadata) => void,
  onDone: (usage?: StreamUsage) => void,
  onError: (error: Error) => void,
  onThinkingToken?: (token: string | null) => void,
  workspaceContext?: WorkspaceContext,
  hasSandbox?: boolean,
  systemPromptOverride?: string,
  scratchpadContent?: string,
  signal?: AbortSignal,
  onPreCompact?: (event: import('@/types').PreCompactEvent) => void,
  todoContent?: string,
): Promise<void> {
  const {
    name,
    apiUrl,
    apiKey,
    authHeader,
    model,
    connectTimeoutMs,
    idleTimeoutMs,
    progressTimeoutMs,
    stallTimeoutMs,
    totalTimeoutMs,
    errorMessages,
    parseError,
    checkFinishReason,
    shouldResetStallOnReasoning = false,
    providerType,
    apiUrlOverride,
    bodyTransform,
    extraHeaders,
  } = config;

  const tracer = getPushTracer('push.model');
  return tracer.startActiveSpan(
    'model.stream',
    {
      kind: SpanKind.CLIENT,
      attributes: {
        'push.provider': providerType || 'unknown',
        'push.model': model,
        'push.message_count': messages.length,
        'push.has_sandbox': Boolean(hasSandbox),
        'push.workspace_mode': workspaceContext?.mode || 'unknown',
      },
    },
    async (span) => {
      const controller = new AbortController();
      type AbortReason = 'connect' | 'idle' | 'user' | 'progress' | 'stall' | 'total' | null;
      let abortReason: AbortReason = null;

      const onExternalAbort = () => {
        abortReason = 'user';
        controller.abort();
      };
      signal?.addEventListener('abort', onExternalAbort);

      // Timers
      let connectTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
        abortReason = 'connect';
        controller.abort();
      }, connectTimeoutMs);

      let totalTimer: ReturnType<typeof setTimeout> | undefined;
      if (totalTimeoutMs) {
        totalTimer = setTimeout(() => {
          abortReason = 'total';
          controller.abort();
        }, totalTimeoutMs);
      }

      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const resetIdleTimer = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          abortReason = 'idle';
          controller.abort();
        }, idleTimeoutMs);
      };

      let progressTimer: ReturnType<typeof setTimeout> | undefined;
      const resetProgressTimer = () => {
        if (!progressTimeoutMs) return;
        clearTimeout(progressTimer);
        progressTimer = setTimeout(() => {
          abortReason = 'progress';
          controller.abort();
        }, progressTimeoutMs);
      };

      let stallTimer: ReturnType<typeof setTimeout> | undefined;
      const resetStallTimer = () => {
        if (!stallTimeoutMs) return;
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          abortReason = 'stall';
          controller.abort();
        }, stallTimeoutMs);
      };

      let chunkCount = 0;
      let contentChars = 0;
      let thinkingChars = 0;
      let nativeToolCallCount = 0;

      const finishSuccess = (spanUsage?: StreamUsage) => {
        setSpanAttributes(span, {
          'push.abort_reason': abortReason || undefined,
          'push.stream.chunk_count': chunkCount,
          'push.stream.content_chars': contentChars,
          'push.stream.thinking_chars': thinkingChars,
          'push.stream.native_tool_call_count': nativeToolCallCount,
          'push.usage.input_tokens': spanUsage?.inputTokens,
          'push.usage.output_tokens': spanUsage?.outputTokens,
          'push.usage.total_tokens': spanUsage?.totalTokens,
        });
        span.setStatus({ code: SpanStatusCode.OK });
      };

      try {
        const requestUrl = apiUrlOverride || apiUrl;
        const requestId = createRequestId('chat');
        setSpanAttributes(span, {
          'push.request_id': requestId,
          'push.request_url': requestUrl,
        });
        console.log(`[Push] POST ${requestUrl} (model: ${model}, request: ${requestId})`);

        let requestBody: Record<string, unknown> = {
          model,
          messages: toLLMMessages(
            messages,
            workspaceContext,
            hasSandbox,
            systemPromptOverride,
            scratchpadContent,
            providerType,
            model,
            onPreCompact,
            undefined,
            todoContent,
          ),
          stream: true,
        };

        if (bodyTransform) {
          requestBody = bodyTransform(requestBody);
        }

        const requestHeaders: Record<string, string> = {
          'Content-Type': 'application/json',
          [REQUEST_ID_HEADER]: requestId,
          ...(extraHeaders ?? {}),
        };
        if (authHeader !== null) {
          requestHeaders.Authorization = authHeader ?? `Bearer ${apiKey}`;
        }
        injectTraceHeaders(requestHeaders);

        const response = await fetch(requestUrl, {
          method: 'POST',
          headers: requestHeaders,
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });

        clearTimeout(connectTimer);
        connectTimer = undefined;
        resetIdleTimer();
        if (stallTimeoutMs) resetStallTimer();
        // progressTimer is deliberately NOT armed here — it only starts on
        // the first parseable SSE frame (see the JSON.parse branch below).
        // Arming it pre-body meant a response that succeeds but yields no
        // body bytes could race progress against idle and surface the
        // "data is arriving" message when no data had actually arrived.

        if (!response.ok) {
          span.setAttribute('http.response.status_code', response.status);
          const body = await response.text().catch(() => '');
          let detail = '';
          try {
            const parsed = JSON.parse(body);
            detail = parseError(parsed, body.slice(0, 200));
          } catch {
            detail = body ? body.slice(0, 200) : 'empty body';
          }
          // Strip HTML error pages (e.g. Cloudflare 403/503 pages) — show a clean message instead
          if (/<\s*html[\s>]/i.test(detail) || /<\s*!doctype/i.test(detail)) {
            detail = `HTTP ${response.status} (the server returned an HTML error page instead of JSON)`;
          }
          console.error(`[Push] ${name} error: ${response.status}`, detail);
          const alreadyPrefixed = detail.toLowerCase().startsWith(name.toLowerCase());
          throw new Error(alreadyPrefixed ? detail : `${name} ${response.status}: ${detail}`);
        }

        span.setAttribute('http.response.status_code', response.status);

        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error('No response body');
        }

        const decoder = new TextDecoder();
        let buffer = '';
        const chunker = createChunkedEmitter(onToken);
        const parser = createThinkTokenParser((token) => chunker.push(token), onThinkingToken);
        let usage: StreamUsage | undefined;

        // Compatibility bridge: some providers may emit OpenAI-style `delta.tool_calls`
        // even when we are not sending `tools[]` (prompt-engineered mode). Accumulate
        // those deltas and re-emit them as our fenced JSON tool blocks so the existing
        // text-based tool dispatch path still works.
        // Only tool names in KNOWN_TOOL_NAMES are converted — anything else (e.g.
        // Google Gemini's internal "node_source") is silently dropped to prevent
        // leaking raw API data into the chat.

        const pendingNativeToolCalls = new Map<number, { name: string; args: string }>();
        const flushNativeToolCalls = () => {
          if (pendingNativeToolCalls.size === 0) return;
          for (const [, tc] of pendingNativeToolCalls) {
            if (!tc.name && !tc.args) continue;
            if (tc.name) {
              // Only convert tool calls that match our prompt-engineered tool
              // protocol.  Unknown names (e.g. Gemini's "node_source") are
              // internal model machinery — drop them regardless of payload size.
              if (!KNOWN_TOOL_NAMES.has(tc.name)) {
                console.warn(`[Push] Native tool call "${tc.name}" is not a known tool — dropped`);
                continue;
              }
              try {
                const parsedArgs = tc.args ? JSON.parse(tc.args) : {};
                parser.push(
                  `\n\`\`\`json\n${JSON.stringify({ tool: tc.name, args: parsedArgs })}\n\`\`\`\n`,
                );
              } catch {
                // If arguments are malformed/incomplete, still emit a tool shell so
                // malformed-call diagnostics can guide the model to retry.
                parser.push(
                  `\n\`\`\`json\n${JSON.stringify({ tool: tc.name, args: {} })}\n\`\`\`\n`,
                );
              }
            } else if (tc.args) {
              // No function name — never push raw args directly to the parser.
              // That leaks unformatted API data into the chat output.
              console.warn(
                '[Push] Native tool call with no function name — args dropped:',
                tc.args.slice(0, 200),
              );
            }
          }
          pendingNativeToolCalls.clear();
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          chunkCount++;
          resetIdleTimer();
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            if (trimmed === 'data: [DONE]' || trimmed === 'data:[DONE]') {
              flushNativeToolCalls();
              parser.flush();
              chunker.flush();
              finishSuccess(usage);
              onDone(usage);
              return;
            }

            if (!trimmed.startsWith('data:')) continue;
            const jsonStr = trimmed[5] === ' ' ? trimmed.slice(6) : trimmed.slice(5);

            try {
              const parsed = JSON.parse(jsonStr);
              if (progressTimeoutMs) resetProgressTimer();

              if (parsed.usage) {
                usage = {
                  inputTokens: parsed.usage.prompt_tokens || 0,
                  outputTokens: parsed.usage.completion_tokens || 0,
                  totalTokens: parsed.usage.total_tokens || 0,
                };
                const cacheWrite = parsed.usage.cache_creation_input_tokens;
                const cacheRead = parsed.usage.cache_read_input_tokens;
                if (cacheWrite || cacheRead) {
                  console.log(
                    `[Push] cache — write: ${cacheWrite ?? 0} tokens, read: ${cacheRead ?? 0} tokens`,
                  );
                }
              }

              const choice = parsed.choices?.[0];
              if (!choice) continue;

              const reasoningToken = choice.delta?.reasoning_content;
              if (reasoningToken) {
                thinkingChars += reasoningToken.length;
                onThinkingToken?.(reasoningToken);
                if (shouldResetStallOnReasoning) resetStallTimer();
              }

              const rawToken = choice.delta?.content;
              if (rawToken) {
                // Strip model chat-template control tokens (e.g. <|start|>, <|im_end|>,
                // <|call|>) that some models leak into the content stream.
                const token = rawToken.replace(/<\|[a-z_]+\|>/gi, '');
                if (token) {
                  contentChars += token.length;
                  parser.push(token);
                }
                if (stallTimeoutMs) resetStallTimer();
              }

              // Some providers may emit native tool call deltas even in prompt-engineered mode.
              const toolCalls = choice.delta?.tool_calls;
              if (toolCalls) {
                for (const tc of toolCalls) {
                  const idx = typeof tc.index === 'number' ? tc.index : 0;
                  const fnCall = tc.function;
                  if (!fnCall) continue;
                  if (!pendingNativeToolCalls.has(idx)) {
                    pendingNativeToolCalls.set(idx, { name: '', args: '' });
                    nativeToolCallCount++;
                    console.log(
                      `[Push] Native tool call delta detected (idx=${idx}, name=${fnCall.name || '(none)'})`,
                    );
                  }
                  const entry = pendingNativeToolCalls.get(idx)!;
                  if (typeof fnCall.name === 'string') entry.name = fnCall.name;
                  if (typeof fnCall.arguments === 'string') entry.args += fnCall.arguments;
                }
                // Native tool-call argument streams count as model progress —
                // they're user-visible output, just in a different channel than
                // delta.content. Without this reset, large tool-call argument
                // payloads (big write_file / edit_file blobs) can hit the stall
                // timeout mid-generation even while the model is making progress.
                if (stallTimeoutMs) resetStallTimer();
              }

              if (checkFinishReason(choice)) {
                flushNativeToolCalls();
                parser.flush();
                chunker.flush();
                finishSuccess(usage);
                onDone(usage);
                return;
              }
            } catch {
              // Skip malformed SSE data
            }
          }
        }

        flushNativeToolCalls();
        parser.flush();
        chunker.flush();
        finishSuccess(usage);
        onDone(usage);
      } catch (err) {
        clearTimeout(connectTimer);
        clearTimeout(idleTimer);
        clearTimeout(progressTimer);
        clearTimeout(stallTimer);
        clearTimeout(totalTimer);
        signal?.removeEventListener('abort', onExternalAbort);

        if (err instanceof DOMException && err.name === 'AbortError') {
          if (abortReason === 'user') {
            setSpanAttributes(span, {
              'push.abort_reason': abortReason,
              'push.cancelled': true,
            });
            onDone();
            return;
          }
          const timeoutMsg = selectTimeoutMessage(
            (abortReason ?? 'idle') as Parameters<typeof selectTimeoutMessage>[0],
            errorMessages,
            {
              connectTimeoutMs,
              idleTimeoutMs,
              progressTimeoutMs,
              stallTimeoutMs,
              totalTimeoutMs,
            },
          );
          recordSpanError(span, new Error(timeoutMsg), {
            'push.abort_reason': abortReason || undefined,
            'push.stream.chunk_count': chunkCount,
            'push.stream.content_chars': contentChars,
            'push.stream.thinking_chars': thinkingChars,
            'push.stream.native_tool_call_count': nativeToolCallCount,
          });
          console.error(`[Push] ${name} timeout (${abortReason}):`, timeoutMsg);
          onError(new Error(timeoutMsg));
          return;
        }

        const msg = err instanceof Error ? err.message : String(err);
        recordSpanError(span, err, {
          'push.abort_reason': abortReason || undefined,
          'push.stream.chunk_count': chunkCount,
          'push.stream.content_chars': contentChars,
          'push.stream.thinking_chars': thinkingChars,
          'push.stream.native_tool_call_count': nativeToolCallCount,
        });
        console.error(`[Push] ${name} chat error:`, msg);
        if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
          onError(new Error(errorMessages.network));
        } else {
          onError(err instanceof Error ? err : new Error(msg));
        }
      } finally {
        clearTimeout(connectTimer);
        clearTimeout(idleTimer);
        clearTimeout(progressTimer);
        clearTimeout(stallTimer);
        clearTimeout(totalTimer);
        signal?.removeEventListener('abort', onExternalAbort);
        span.end();
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Provider streaming — consolidated via registry + factory
  // ---------------------------------------------------------------------------
}
