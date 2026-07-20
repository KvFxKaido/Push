/**
 * Pre-turn LLM context compaction for the CLI lead turn — CLI parity for the
 * web's `app/src/hooks/chat-compaction.ts` (Agent Runtime Decisions §14).
 *
 * The CLI lead turn feeds the model a *bounded* preamble: `buildLeadTurnPreamble`
 * renders only the last `PRIOR_TURNS_MAX` conversational turns (each clipped),
 * silently dropping everything older. So on a long session the model forgets
 * the early thread entirely. This coordinator closes that gap exactly the way
 * the web does: when the durable history grows past the budget, it asks the
 * model itself to write a Codex-style handoff summary of the older span and
 * collapses that span into a single `[CONTEXT HANDOFF]` message — which the
 * preamble then renders un-clipped (see `buildLeadTurnPreamble`).
 *
 * It reuses the shared, provider-agnostic engine (`lib/llm-compaction.ts`) — the
 * same prompt, partition, and one-shot summarizer call the web uses — so the two
 * surfaces stay in lockstep (new-feature checklist #3). The model call goes
 * through a `createProviderStream` of the locked provider/model/key.
 *
 * Difference from web: the CLI `Message` has no `visibleToModel` flag, so this
 * mirrors the CLI's existing `compactContext` model — the summarized span is
 * *replaced* by the handoff in `state.messages` (durably rewritten by
 * `saveSessionState`/`rewriteMessagesLog`) rather than hidden. Tool-output
 * losslessness is already covered by the verbatim log (LCM Phase 3).
 *
 * Fails soft: any error/timeout/empty summary leaves `state.messages` untouched;
 * the shared kernel's own context management backstops the within-turn wire.
 */

import {
  buildHandoffBlock,
  isHandoffBlock,
  partitionForLlmCompaction,
  renderSpanForSummary,
  resolveLlmCompactionPolicy,
  shouldRunLlmCompaction,
  summarizeContextViaModel,
  type CompactableMessage,
} from '../lib/llm-compaction.ts';
import type { AIProviderType, LlmMessage, PushStream } from '../lib/provider-contract.ts';
import { retainCompactedSpan } from '../lib/verbatim-retain.ts';
import { resolveWorkspaceIdentity } from '../lib/workspace-identity.ts';
import {
  estimateContextTokens,
  estimateMessageTokens,
  getContextBudget,
  isToolResultMessage,
  type Message,
} from './context-manager.js';
import { createProviderStream } from './provider.js';
import type { ProviderConfig } from './provider.js';
import { rewriteMessagesLog } from './session-store.js';
import type { SessionState } from './session-store.js';
import { seedUserGoalFile, type SeedUserGoalInputs } from './user-goal-file.js';

function log(level: 'info' | 'warn', event: string, ctx: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, event, ...ctx }));
}

interface LeadCompactableMessage extends CompactableMessage {
  reasoningContent?: string;
  responsesReasoningItems?: Message['responsesReasoningItems'];
}

function asCompactable(m: Message): LeadCompactableMessage {
  return {
    role: (m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user') as
      | 'user'
      | 'assistant'
      | 'system',
    content: typeof m.content === 'string' ? m.content : '',
    isToolResult: isToolResultMessage(m),
    ...(typeof m.reasoningContent === 'string' && m.reasoningContent.length > 0
      ? { reasoningContent: m.reasoningContent }
      : {}),
    ...(m.responsesReasoningItems && m.responsesReasoningItems.length > 0
      ? { responsesReasoningItems: m.responsesReasoningItems }
      : {}),
  };
}

export interface MaybeCompactLeadDeps {
  /** Surface a transient "Compacting context…" status, mirroring the web pill. */
  onStatus?: (phase: string) => void;
  /** Persist a `context_compacted` session event (lead-turn's `persistEvent`). */
  persistEvent?: (type: string, payload: unknown) => void | Promise<void>;
  /** Injectable provider-stream factory (tests pass a fake). Defaults to the
   *  real `createProviderStream` of the locked provider/model/key. */
  streamFactory?: (
    config: ProviderConfig,
    apiKey: string,
    options: { sessionId?: string },
  ) => PushStream<LlmMessage>;
  /** Injectable workspace-scope resolver for span retention (tests pass a
   *  fake). Defaults to `resolveWorkspaceIdentity` over the session cwd. */
  resolveScope?: (cwd: string) => Promise<{ repoFullName?: string; branch?: string }>;
  /** Injectable one-time goal-file seed. The real writer never overwrites. */
  seedGoalFile?: (
    cwd: string,
    inputs: SeedUserGoalInputs,
  ) => Promise<{ wrote: boolean; path: string }>;
}

/**
 * Compact the lead session's durable history with a model-written handoff when
 * it exceeds the budget. Mutates `state.messages` in place and persists the
 * rewrite. Returns true when a compaction was applied. Never throws.
 */
export async function maybeCompactLeadHistory(
  state: SessionState,
  providerConfig: ProviderConfig,
  apiKey: string,
  deps: MaybeCompactLeadDeps = {},
): Promise<boolean> {
  const model = state.model || providerConfig.defaultModel;
  if (!model) return false;

  const messages = (Array.isArray(state.messages) ? state.messages : []) as Message[];
  const budget = getContextBudget(providerConfig.id as AIProviderType, model);
  const policy = resolveLlmCompactionPolicy({ surface: 'cli-lead', budget });
  const triggerTokens = policy.triggerTokens;

  const totalTokens = estimateContextTokens(messages);
  if (!shouldRunLlmCompaction(totalTokens, { triggerTokens })) return false;

  const partition = partitionForLlmCompaction(messages.map(asCompactable), {
    estimateMessageTokens: (m) => estimateMessageTokens(m as Message),
    preserveTailTokens: policy.preserveTailTokens,
    minSummarizeTokens: policy.minSummarizeTokens,
  });
  if (partition.summarize.length === 0) {
    log('info', 'cli_llm_compaction_skipped', {
      sessionId: state.sessionId,
      reason: 'span_too_small',
      totalTokens,
      triggerTokens,
    });
    return false;
  }

  // The partition preserves order, so the summarize slice maps to the same
  // contiguous run in `state.messages`.
  const headLen = partition.head.length;
  const spanMsgs = messages.slice(headLen, headLen + partition.summarize.length);
  const lastSpanIdx = headLen + spanMsgs.length;

  const priorHandoff = messages.find((m) =>
    isHandoffBlock(typeof m.content === 'string' ? m.content : ''),
  )?.content;

  deps.onStatus?.('Compacting context…');

  const streamFactory = deps.streamFactory ?? createProviderStream;
  const stream = streamFactory(providerConfig, apiKey, {
    sessionId: state.sessionId,
  }) as unknown as PushStream<LlmMessage>;
  const spanText = renderSpanForSummary(spanMsgs.map(asCompactable));
  const { summary, error } = await summarizeContextViaModel({
    provider: providerConfig.id as AIProviderType,
    model,
    stream,
    spanText,
    priorHandoff: typeof priorHandoff === 'string' ? priorHandoff : undefined,
  });

  if (error || !summary) {
    log('warn', 'cli_llm_compaction_failed', {
      sessionId: state.sessionId,
      reason: error?.message ?? 'empty_summary',
      totalTokens,
      spanMessages: spanMsgs.length,
    });
    return false;
  }

  const firstUserTurn = messages.find(
    (message) =>
      message.role === 'user' &&
      typeof message.content === 'string' &&
      message.content.trim().length > 0 &&
      !isToolResultMessage(message) &&
      !isHandoffBlock(message.content),
  )?.content;
  if (typeof firstUserTurn === 'string') {
    // Best-effort, matching this compactor's documented never-throws contract:
    // the real writer already soft-fails, but an injected seed (or a future
    // writer change) must not be able to reject the whole compaction after the
    // LLM summary succeeded and before history is collapsed (fugu on #1521).
    try {
      const seedGoal = deps.seedGoalFile ?? seedUserGoalFile;
      await seedGoal(state.cwd, { firstUserTurn, workingGoalSeed: summary });
    } catch (err) {
      log('warn', 'cli_goal_seed_failed', {
        sessionId: state.sessionId,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Retain the raw span in the verbatim log BEFORE the destructive collapse —
  // on the CLI the span is *replaced* in `state.messages`, so the log entry is
  // the only place the original turns survive for the model to recall. Best-
  // effort: a failing resolver skips retention and the handoff omits the recall
  // line. (A gitless workspace does NOT skip — `resolveWorkspaceIdentity` falls
  // back to `repoFullName: 'unknown'`, so retention still happens, scoped to
  // that pseudo-repo.)
  let recallRef: string | undefined;
  try {
    const resolveScope =
      deps.resolveScope ??
      (async (cwd: string) => {
        const identity = await resolveWorkspaceIdentity(cwd);
        return {
          repoFullName: identity.repoFullName ?? undefined,
          branch: identity.branch ?? undefined,
        };
      });
    const scope = await resolveScope(state.cwd);
    ({ ref: recallRef } = await retainCompactedSpan({
      spanText,
      scope,
      label: `context compaction (${spanMsgs.length} messages)`,
    }));
  } catch (err) {
    // `retainCompactedSpan` never throws; this guards an injected resolver.
    log('warn', 'cli_compaction_retain_failed', {
      sessionId: state.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Replace the summarized span with the handoff. The CLI has no
  // `visibleToModel` flag, so this is a destructive collapse (matching the
  // existing `compactContext`/`[CONTEXT DIGEST]` model) — the handoff carries
  // the thread forward and the preamble renders it un-clipped.
  const handoffMessage: Message = {
    role: 'user',
    content: buildHandoffBlock(summary, recallRef ? { recallRef } : undefined),
  };
  const next = [...messages.slice(0, headLen), handoffMessage, ...messages.slice(lastSpanIdx)];
  state.messages = next;
  const afterTokens = estimateContextTokens(next);
  await rewriteMessagesLog(state);

  await deps.persistEvent?.('context_compacted', {
    mode: 'llm_handoff',
    beforeTokens: totalTokens,
    afterTokens,
    compactedMessages: spanMsgs.length,
    removedCount: spanMsgs.length - 1,
  });
  log('info', 'cli_llm_compaction_applied', {
    sessionId: state.sessionId,
    provider: providerConfig.id,
    beforeTokens: totalTokens,
    afterTokens,
    spanMessages: spanMsgs.length,
    reclaimedTokens: partition.summarizeTokens,
    recallRef: recallRef ?? null,
  });

  return true;
}
