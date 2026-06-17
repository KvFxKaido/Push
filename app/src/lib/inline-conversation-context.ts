import type { ChatMessage } from '@/types';
import { manageContext } from './message-context-manager';
import { getContextBudget } from './orchestrator-context';
import { estimateContextTokens } from './orchestrator-context';
import { buildAttachmentContentParts } from './attachment-content-parts';
import { estimateTokens as estimateRawTokens } from '@push/lib/context-budget';
import { transformContextBeforeLLM } from '@push/lib/context-transformer';
import { deriveUserGoalAnchor } from '@push/lib/user-goal-anchor';
import {
  isSyntheticDigestMessage,
  parseSessionDigest,
  type SessionDigest,
} from '@push/lib/session-digest';
import type { LlmMessage } from '@push/lib/provider-contract';
import type { MemoryRecord } from '@push/lib/runtime-contract';
import { createId } from '@push/lib/id-utils';

export interface InlineConversationContextOptions {
  provider?: Parameters<typeof getContextBudget>[0];
  model?: string;
  systemPromptOverhead?: string;
  sessionDigestRecords?: MemoryRecord[];
  priorSessionDigest?: SessionDigest;
  onEmitSessionDigest?: (digest: SessionDigest) => void;
}

/**
 * Materialize the inline lead's conversational seed with the same context
 * transform stages the Orchestrator uses: visibility filtering, budget-aware
 * compaction, USER_GOAL anchoring, session digest injection, and the gateway
 * safety net. The caller still supplies the lead's own system prompt; this
 * returns transcript messages only.
 */
export function buildInlineConversationMessages(
  apiMessages: readonly ChatMessage[],
  options: InlineConversationContextOptions,
): LlmMessage[] {
  const contextBudget = getContextBudget(options.provider, options.model);
  const userTurnContents = apiMessages
    .filter((m) => m.role === 'user' && !m.isToolResult)
    .map((m) => m.content);
  const userGoalAnchor =
    deriveUserGoalAnchor({
      firstUserTurn: userTurnContents[0],
      recentUserTurns: userTurnContents,
    }) ?? undefined;

  const transformed = transformContextBeforeLLM<ChatMessage>([...apiMessages], {
    surface: 'web',
    manageContext: (msgs) => {
      const result = manageContext(msgs, contextBudget, options.provider);
      const compactionApplied =
        result.length !== msgs.length || result.some((m, i) => m !== msgs[i]);
      return { messages: result, compactionApplied };
    },
    userGoalAnchor,
    createGoalMessage: (content): ChatMessage => ({
      id: `inline-user-goal-${createId()}`,
      role: 'user',
      content,
      timestamp: 0,
      status: 'done',
      isToolResult: true,
    }),
    sessionDigestInputs: {
      records: options.sessionDigestRecords ?? [],
      goal: userGoalAnchor?.currentWorkingGoal ?? userGoalAnchor?.initialAsk,
    },
    priorSessionDigest: options.priorSessionDigest,
    createSessionDigestMessage: (content): ChatMessage => ({
      id: `inline-session-digest-${createId()}`,
      role: 'user',
      content,
      timestamp: 0,
      status: 'done',
      isToolResult: true,
    }),
    safetyNet: {
      estimateTokens: (msgs) => estimateContextTokens(msgs as ChatMessage[]),
      budget: contextBudget.maxTokens,
      threshold: 0.85,
      preserveTail: 4,
      fixedOverheadTokens: estimateRawTokens(options.systemPromptOverhead ?? ''),
    },
  });

  const digestMsg = transformed.messages.find((m) => isSyntheticDigestMessage(m));
  const digestContent = typeof digestMsg?.content === 'string' ? digestMsg.content : null;
  const parsed = digestContent ? parseSessionDigest(digestContent) : null;
  if (parsed) {
    options.onEmitSessionDigest?.(parsed);
  }

  return transformed.messages.map(toLlmMessage);
}

function toLlmMessage(message: ChatMessage): LlmMessage {
  const contentParts =
    message.contentParts && message.contentParts.length > 0
      ? message.contentParts
      : message.role === 'user'
        ? buildAttachmentContentParts(message.content, message.attachments)
        : undefined;

  return {
    id: message.id,
    role: message.role,
    content: message.content,
    timestamp: message.timestamp,
    ...(contentParts && contentParts.length > 0 ? { contentParts } : {}),
    ...(message.reasoningBlocks && message.reasoningBlocks.length > 0
      ? { reasoningBlocks: message.reasoningBlocks }
      : {}),
  };
}
