/**
 * App compatibility wrapper for the shared message-context manager.
 *
 * The canonical module now lives in `lib/message-context-manager.ts` and is
 * generic over a minimal `Message` interface. This shim binds the generic
 * parameter to the concrete web `ChatMessage` and wires the web-side
 * dependencies (token estimation, semantic compaction, context metrics,
 * digest factory) so call sites can keep importing the same named helpers.
 *
 * Matches the pattern used by `task-graph.ts`: re-export the types from
 * `@push/lib/...` and add the concrete specialisation on top.
 */

import type { ChatMessage } from '@/types';
import {
  createContextManager,
  type ContextBudget,
  type Message,
  type PreCompactEventLike,
  type SummarizationCause,
} from '@push/lib/message-context-manager';
import { buildContextSummaryBlock, compactChatMessage } from './context-compaction';
import {
  DEFAULT_CONTEXT_BUDGET,
  estimateContextTokens,
  estimateMessageTokens,
  getContextMode,
} from './orchestrator-context';
import { recordContextMetric } from './context-metrics';

export type { ContextBudget, Message, PreCompactEventLike, SummarizationCause };
export {
  createContextManager,
  DEFAULT_CONTEXT_BUDGET as LIB_DEFAULT_CONTEXT_BUDGET,
} from '@push/lib/message-context-manager';

const _manager = createContextManager<ChatMessage>({
  getContextMode,
  estimateMessageTokens,
  estimateContextTokens,
  compactMessage: (msg) => compactChatMessage(msg),
  buildContextDigestBlock: (removed) =>
    buildContextSummaryBlock(removed, {
      header: '[CONTEXT DIGEST]',
      intro: 'Earlier messages were condensed to fit the context budget.',
      footerLines: ['[/CONTEXT DIGEST]'],
    }),
  createDigestMessage: (content): ChatMessage => ({
    id: `context-digest-${digestIdHash(content)}`,
    role: 'user',
    content,
    timestamp: 0,
    status: 'done',
    isToolResult: true, // hidden in UI, still sent to model
  }),
  recordContextMetric,
});

// djb2 over the digest content keeps the synthetic id stable across calls so
// `transformContextBeforeLLM` is a pure function of (messages, options). The
// id never reaches the wire (orchestrator forwards only role+content), but
// determinism is required for the cache-stability invariant tests.
function digestIdHash(content: string): string {
  let hash = 5381;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) + hash + content.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

export function manageContext(
  messages: ChatMessage[],
  budget: ContextBudget = DEFAULT_CONTEXT_BUDGET,
  provider?: string,
  onPreCompact?: (event: import('@/types').PreCompactEvent) => void,
): ChatMessage[] {
  return _manager.manageContext(messages, budget, provider, onPreCompact);
}

export function classifySummarizationCause(
  messages: ChatMessage[],
  recentBoundary: number,
): SummarizationCause {
  return _manager.classifySummarizationCause(messages, recentBoundary);
}

export function buildContextDigest(removed: ChatMessage[]): string {
  return _manager.buildContextDigest(removed);
}
