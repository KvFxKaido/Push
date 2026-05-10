import type { ChatMessage, WorkspaceContext } from '@/types';
import { formatVerificationPolicyBlock } from './verification-policy';
import { TOOL_PROTOCOL } from './github-tools';
import { getSandboxToolProtocol } from './sandbox-tools';
import { SCRATCHPAD_TOOL_PROTOCOL, buildScratchpadContext } from './scratchpad-tools';
import { TODO_TOOL_PROTOCOL } from './todo-tools';
import { WEB_SEARCH_TOOL_PROTOCOL } from './web-search-tools';
import { ASK_USER_TOOL_PROTOCOL } from './ask-user-tools';
import { getUserProfile } from '@/hooks/useUserProfile';
import type { UserProfile } from '@/types';
import { buildUserIdentityBlock } from '@push/lib/user-identity';
import { buildModelCapabilityAwarenessBlock } from './model-capabilities';
import { getApprovalMode, buildApprovalModeBlock } from './approval-mode';
import { buildSessionCapabilityBlock, buildSandboxEnvironmentBlock } from './workspace-context';
import { diffSnapshots, formatSnapshotDiff, type PromptSnapshot } from './system-prompt-builder';
import {
  buildOrchestratorBaseBuilder,
  buildOrchestratorBasePrompt,
} from './orchestrator-prompt-builder';
import { manageContext } from './message-context-manager';
import { transformContextBeforeLLM } from '@push/lib/context-transformer';
// --- Re-exports from orchestrator-streaming (break circular dependency) ---
export {
  parseProviderError,
  type StreamUsage,
  type ChunkMetadata,
} from './orchestrator-streaming';

import type { ChunkMetadata } from './orchestrator-streaming';
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
  getProviderPushStream,
  streamChat,
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

/** Push-private extension. Sent only on assistant messages routed through
 *  the Anthropic bridge; other backends ignore the field. See
 *  `chat-request-guardrails.ts` `OpenAIReasoningBlock` and
 *  `lib/provider-contract.ts` `ReasoningBlock` for the canonical shape. */
type LLMReasoningBlock =
  | { type: 'thinking'; text: string; signature: string }
  | { type: 'redacted_thinking'; data: string };

interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | LLMMessageContent[];
  intentHint?: string | null;
  reasoning_blocks?: LLMReasoningBlock[];
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
 * Exported so PushStream implementations (`openrouter-stream.ts`,
 * `cloudflare-stream.ts`, etc.) can compose messages client-side via the
 * same prompt-assembly path. Not part of the public runtime API.
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

  // Single boundary transform: visibility filter + smart context management.
  // Both stages were previously inline here. Consolidating into one pure
  // function keeps the prefix sent to the LLM byte-stable across turns when
  // only new messages were appended (cache hit rate). Pipeline order is
  // fixed inside the transformer; we cannot reorder filter vs. compaction
  // from this call site.
  const contextBudget = getContextBudget(providerType, providerModel);
  const transformed = transformContextBeforeLLM<ChatMessage>(messages, {
    surface: 'web',
    manageContext: (msgs) => {
      const result = manageContext(msgs, contextBudget, providerType, onPreCompact);
      // Don't infer compaction from array identity — manageContext may return
      // a fresh array (`[...messages]`) without rewriting any element, e.g.
      // when every message is already under the compaction threshold.
      // Detect actual structural change.
      const compactionApplied =
        result.length !== msgs.length || result.some((m, i) => m !== msgs[i]);
      return { messages: result, compactionApplied };
    },
  });
  const windowedMessages = transformed.messages;

  for (const msg of windowedMessages) {
    // Anthropic requires signed thinking blocks to be re-sent verbatim on
    // the assistant turn that produced them, ahead of any text/tool_use.
    // The wire field rides as a sidecar on the assistant LLMMessage; the
    // bridge layer (worker → openai-anthropic-bridge.ts) prepends them to
    // the upstream `content[]`, and non-Anthropic backends ignore the field.
    const reasoningBlocks =
      msg.role === 'assistant' && msg.reasoningBlocks && msg.reasoningBlocks.length > 0
        ? msg.reasoningBlocks
        : undefined;

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
        ...(reasoningBlocks ? { reasoning_blocks: reasoningBlocks } : {}),
      });
    } else {
      // Simple text message (existing behavior)
      // Guard against provider-side validation errors:
      // some OpenAI-compatible backends reject empty assistant turns.
      // Exception: an assistant turn with no text but with signed
      // reasoning blocks is legitimate (Anthropic returns this when the
      // model thinks then immediately tool_uses) — keep it so the next
      // turn's request can echo the signature back.
      if (msg.role === 'assistant' && !msg.content.trim() && !reasoningBlocks) {
        continue;
      }
      llmMessages.push({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.content,
        ...(reasoningBlocks ? { reasoning_blocks: reasoningBlocks } : {}),
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

  // Final sanitize pass: never send empty assistant messages — except
  // assistant turns that carry signed reasoning blocks (the bridge will
  // emit them as the upstream `content[]`, so the message is not actually
  // empty on the wire).
  return llmMessages.filter((msg) => {
    if (msg.role !== 'assistant') return true;
    if (msg.reasoning_blocks && msg.reasoning_blocks.length > 0) return true;
    return isNonEmptyContent(msg.content);
  });
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
