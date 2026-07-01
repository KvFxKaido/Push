/**
 * Pre-turn LLM context compaction (web).
 *
 * Coordinator that runs the model-written "handoff summary" compaction at the
 * turn boundary, before the round loop streams a response. This is the
 * higher-quality complement to the always-on synchronous heuristic in
 * `message-context-manager.ts`: when the working set approaches the model's
 * budget, we ask the model itself to summarize the older span and swap that
 * span out of the wire context.
 *
 * Home: this is the "name the coordinator's home first" guardrail (new-feature
 * checklist #2) — the state + model-call cluster lives here as a sibling of the
 * round loop, NOT appended to `useChat.ts`.
 *
 * Losslessness (LCM): nothing is deleted. The summarized span stays in the
 * durable transcript (still rendered in the UI, still in the verbatim log) and
 * is only marked `visibleToModel: false` so the existing wire-filter drops it
 * from the prompt. A model-visible `[CONTEXT HANDOFF]` message carries the
 * summary forward; a `kind: 'compaction'` divider marks the seam in the UI.
 *
 * Fails soft: any error (no provider, timeout, empty summary) leaves the
 * transcript untouched and returns the original messages — the synchronous
 * heuristic downstream is the guaranteed backstop, so a failed summarizer call
 * never lets a turn overflow the window.
 */

import type { ChatMessage } from '@/types';
import type { LlmMessage, PushStream } from '@push/lib/provider-contract';
import type { ActiveProvider } from '@/lib/orchestrator';
import {
  buildHandoffBlock,
  isHandoffBlock,
  partitionForLlmCompaction,
  resolveLlmCompactionPolicy,
  shouldRunLlmCompaction,
  summarizeContextViaModel,
  renderSpanForSummary,
  type CompactableMessage,
} from '@push/lib/llm-compaction';
import {
  estimateContextTokens,
  estimateMessageTokens,
  getContextBudget,
} from '@/lib/orchestrator-context';
import { getProviderPushStream } from '@/lib/orchestrator';
import {
  createCompactionMessage,
  filterModelVisibleMessages,
  nextCompactionCount,
  resolveMessageWriteBranch,
} from '@/lib/chat-message';
import type { SendLoopContext } from './chat-send-types';

export interface MaybeCompactArgs {
  apiMessages: ChatMessage[];
  provider: ActiveProvider;
  model: string | undefined;
}

function log(event: string, ctx: Record<string, unknown>): void {
  console.log(JSON.stringify({ level: 'info', event, ...ctx }));
}

/** Adapt a `ChatMessage` to the partitioner's minimal shape. */
function asCompactable(m: ChatMessage): CompactableMessage {
  return {
    role: m.role,
    content: typeof m.content === 'string' ? m.content : '',
    isToolResult: m.isToolResult,
  };
}

/**
 * Run LLM compaction if the working set is over budget. Returns the (possibly
 * compacted) `apiMessages` for the round and mutates the durable transcript in
 * lockstep. Never throws — failures log and return the input unchanged.
 */
export async function maybeCompactBeforeTurn(
  ctx: SendLoopContext,
  args: MaybeCompactArgs,
): Promise<ChatMessage[]> {
  const { apiMessages, provider, model } = args;
  if (provider === 'demo' || !model) return apiMessages;
  if (ctx.abortRef.current) return apiMessages;

  const budget = getContextBudget(provider, model);
  const policy = resolveLlmCompactionPolicy({ surface: 'web', budget });
  const triggerTokens = policy.triggerTokens;

  // Partition (and all downstream token math) runs over ONLY the model-visible
  // subset. A prior compaction's folded span is still in `apiMessages` with
  // `visibleToModel: false`; partitioning the full array would re-summarize
  // those hidden raw turns (a huge, redundant summarizer request) and subtract
  // their tokens from `beforeTokens` — which counts visible-only — producing
  // bogus or negative after-token figures. `filterModelVisibleMessages` returns
  // the same object references, so span ids still map back into `apiMessages`.
  const visible = filterModelVisibleMessages(apiMessages);
  const totalTokens = estimateContextTokens(visible);
  if (!shouldRunLlmCompaction(totalTokens, { triggerTokens })) return apiMessages;

  const partition = partitionForLlmCompaction(visible.map(asCompactable), {
    estimateMessageTokens: (m) => estimateMessageTokens(m as ChatMessage),
    preserveTailTokens: policy.preserveTailTokens,
    minSummarizeTokens: policy.minSummarizeTokens,
  });
  if (partition.summarize.length === 0) {
    log('llm_compaction_skipped', { reason: 'span_too_small', totalTokens, triggerTokens });
    return apiMessages;
  }

  // The partition preserves order over the visible array, so the summarize slice
  // is the corresponding contiguous run of visible messages. Map back to the
  // real ChatMessages by id (not position into the full array, which may have
  // hidden messages interleaved).
  const headLen = partition.head.length;
  const spanLen = partition.summarize.length;
  const spanMsgs = visible.slice(headLen, headLen + spanLen);
  const spanIds = new Set(spanMsgs.map((m) => m.id));
  const lastSpanId = spanMsgs[spanMsgs.length - 1]?.id;

  // Carry forward a prior handoff so repeated compactions stay coherent.
  const priorHandoff = visible.find((m) =>
    isHandoffBlock(typeof m.content === 'string' ? m.content : ''),
  )?.content;

  ctx.updateAgentStatus(
    { active: true, phase: 'Compacting context…' },
    { chatId: ctx.chatId, log: false },
  );

  const stream = getProviderPushStream(provider) as unknown as PushStream<LlmMessage>;
  const { summary, error } = await summarizeContextViaModel({
    provider,
    model,
    stream,
    spanText: renderSpanForSummary(spanMsgs.map(asCompactable)),
    priorHandoff: typeof priorHandoff === 'string' ? priorHandoff : undefined,
  });

  if (error || !summary) {
    // Fail soft — the synchronous heuristic in the wire path is the backstop.
    log('llm_compaction_failed', {
      reason: error?.message ?? 'empty_summary',
      totalTokens,
      spanMessages: spanMsgs.length,
    });
    return apiMessages;
  }
  if (ctx.abortRef.current) return apiMessages;

  const beforeTokens = totalTokens;
  // The model-visible result after compaction: everything except the hidden
  // span, plus the handoff. Estimate it for the marker / run event.
  const handoffContent = buildHandoffBlock(summary);
  const currentWriteBranch = resolveMessageWriteBranch(
    ctx.branchInfoRef?.current,
    ctx.conversationsRef?.current?.[ctx.chatId]?.branch,
  );
  const handoffMessage: ChatMessage = {
    id: `context-handoff-${Date.now()}`,
    role: 'user',
    content: handoffContent,
    timestamp: Date.now(),
    status: 'done',
    ...(currentWriteBranch !== undefined ? { branch: currentWriteBranch } : {}),
    // Hidden in the UI, still sent to the model (same trick as the digest /
    // goal-anchor synthetic messages). The compaction divider below is the
    // user-facing marker.
    isToolResult: true,
    visibleToModel: true,
  };
  const afterTokens =
    beforeTokens - partition.summarizeTokens + estimateMessageTokens(handoffMessage);

  // Ordinal of this compaction in the conversation; drives the degradation nudge
  // once "multiple compactions" becomes true. Shared with the heuristic drain in
  // chat-stream-round.ts so both paths count toward the same running total.
  const compactionCount = nextCompactionCount(apiMessages);
  const marker = createCompactionMessage({
    beforeTokens,
    afterTokens,
    phase: 'summarization',
    messagesDropped: spanMsgs.length,
    compactionCount,
    branch: currentWriteBranch,
  });

  // Build the transform once and apply it to both the durable transcript and
  // the round's `apiMessages`, keyed by message id so interleaved UI-only
  // messages (e.g. a streaming placeholder) are preserved untouched.
  const applyCompaction = (msgs: ChatMessage[]): ChatMessage[] => {
    const out: ChatMessage[] = [];
    for (const m of msgs) {
      if (spanIds.has(m.id)) {
        out.push({ ...m, visibleToModel: false });
        if (m.id === lastSpanId) {
          // Seam: the model-visible handoff, then the UI divider, sit between
          // the (now hidden) span and the preserved tail.
          out.push(handoffMessage, marker);
        }
      } else {
        out.push(m);
      }
    }
    return out;
  };

  ctx.setConversations((prev) => {
    const conv = prev[ctx.chatId];
    if (!conv) return prev;
    return { ...prev, [ctx.chatId]: { ...conv, messages: applyCompaction(conv.messages) } };
  });
  ctx.dirtyConversationIdsRef.current.add(ctx.chatId);

  ctx.appendRunEvent(ctx.chatId, {
    type: 'context.compaction',
    round: 0,
    phase: 'summarization',
    beforeTokens,
    afterTokens,
    messagesDropped: spanMsgs.length,
    provider,
  });
  log('llm_compaction_applied', {
    provider,
    beforeTokens,
    afterTokens,
    spanMessages: spanMsgs.length,
    reclaimedTokens: partition.summarizeTokens,
  });

  return applyCompaction(apiMessages);
}
