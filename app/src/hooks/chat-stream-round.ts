/**
 * chat-stream-round.ts
 *
 * Streams one LLM round, accumulates tokens, and updates the UI in real
 * time. Extracted from chat-send.ts so the dispatcher (`processAssistantTurn`)
 * stays focused on post-stream tool routing.
 *
 * On each delta this writes the latest accumulated content/thinking into
 * conversation state via `setConversations` and emits an
 * `ACCUMULATED_UPDATED` engine event. The function does NOT touch
 * `checkpointRefs` — `processAssistantTurn` writes apiMessages to the
 * checkpoint after the round resolves.
 */

import { streamChat, peekLastPromptSnapshot } from '@/lib/orchestrator';
import { drainRecentContextMetrics } from '@/lib/context-metrics';
import { assertReadyForAssistantTurn } from '@push/lib/llm-message-invariants';
import { buildTodoContext } from '@/lib/todo-tools';
import { setOpenRouterSessionId } from '@/lib/openrouter-session';
import { getDefaultMemoryStore } from '@push/lib/context-memory-store';
import type { SessionDigest } from '@push/lib/session-digest';
import type { ChatMessage, ReasoningBlock } from '@/types';
import type { SendLoopContext, StreamRoundResult } from './chat-send-types';

/**
 * Cross-turn cache for the last `SessionDigest` emitted per chat. The
 * synthetic digest message lives only in the transformer's output and is
 * not written back into the canonical conversation transcript, so without
 * this cache the digest stage would re-emit a fresh digest every
 * compaction (Copilot review on PR #574). Caller persistence here is what
 * makes the cumulative-merge behavior reach production.
 *
 * Module-scoped, keyed by `chatId`. Page reload clears it — that's
 * acceptable for v1 since the digest is a compaction-time anchor, not
 * durable session state. Capped to bound memory.
 */
const MAX_CACHED_DIGESTS = 64;
const _lastSessionDigests = new Map<string, SessionDigest>();

function recordSessionDigest(chatId: string, digest: SessionDigest): void {
  if (_lastSessionDigests.has(chatId)) {
    _lastSessionDigests.delete(chatId);
  } else if (_lastSessionDigests.size >= MAX_CACHED_DIGESTS) {
    const oldest = _lastSessionDigests.keys().next().value;
    if (oldest !== undefined) _lastSessionDigests.delete(oldest);
  }
  _lastSessionDigests.set(chatId, digest);
}

export async function streamAssistantRound(
  round: number,
  apiMessages: ChatMessage[],
  ctx: SendLoopContext,
): Promise<StreamRoundResult> {
  const {
    chatId,
    lockedProvider,
    resolvedModel,
    abortRef,
    processedContentRef,
    scratchpadRef,
    todoRef,
    usageHandlerRef,
    workspaceContextRef,
    abortControllerRef,
    sandboxIdRef,
    localDaemonBindingRef,
    setConversations,
    updateAgentStatus,
    emitRunEngineEvent,
    appendRunEvent,
  } = ctx;

  processedContentRef.current.clear();
  let accumulated = '';
  let thinkingAccumulated = '';
  const reasoningBlocks: ReasoningBlock[] = [];
  // Sandbox tools are advertised in the prompt when ANY sandbox-shaped
  // transport is available: a cloud sandbox id (`sandboxIdRef`) or a
  // paired local-PC daemon binding (`localDaemonBindingRef`). Without
  // the binding check, a local-pc session would see only chat tools in
  // its system prompt and `sandbox_exec` / `sandbox_read_file` etc.
  // would never be emitted even though the dispatch fork exists.
  // Codex P2 on PR #516.
  const hasSandboxThisRound = Boolean(sandboxIdRef.current || localDaemonBindingRef.current);

  // Set OpenRouter session_id so all requests in this conversation are grouped.
  // Set unconditionally: the orchestrator may resolve to OpenRouter even when
  // lockedProvider is something else, and the getter is consume-and-clear so
  // it won't leak into non-OpenRouter requests.
  setOpenRouterSessionId(chatId);

  let invariantError: Error | null = null;
  try {
    assertReadyForAssistantTurn(apiMessages, 'web/streamAssistantRound');
  } catch (err) {
    invariantError = err instanceof Error ? err : new Error(String(err));
  }
  if (invariantError) {
    return { accumulated, thinkingAccumulated, reasoningBlocks, error: invariantError };
  }

  // Pre-fetch the scope-filtered MemoryRecord rows for the session-digest
  // stage. The production memory store (`createPolicyEnforcedStore(
  // createIndexedDbStore())`) returns a Promise from `list()`, so this MUST
  // be awaited up here rather than narrowed sync inside the synchronous
  // `toLLMMessages` (which is what the pre-#574 code did, and Copilot
  // flagged as always falling through to `[]`).
  //
  // Scope filter: by chatId only. `WorkspaceContext` doesn't carry
  // repoFullName/branch today; chatId alone is durable and scopes the
  // digest to this conversation's history. When workspace context grows
  // repo/branch fields, narrow the predicate further here.
  const memoryStore = getDefaultMemoryStore();
  let sessionDigestRecords: Awaited<ReturnType<typeof memoryStore.list>> = [];
  try {
    const listed = memoryStore.list((record) => record.scope.chatId === chatId);
    sessionDigestRecords = await Promise.resolve(listed);
  } catch {
    // Memory store is best-effort. A read failure shouldn't block the turn —
    // the digest just falls back to working-memory + goal only.
    sessionDigestRecords = [];
  }

  const error = await new Promise<Error | null>((resolve) => {
    streamChat(
      apiMessages,
      (token) => {
        if (abortRef.current) return;
        const contentKey = `${round}:${accumulated.length}:${token}`;
        if (processedContentRef.current.has(contentKey)) return;
        processedContentRef.current.add(contentKey);
        accumulated += token;
        emitRunEngineEvent({
          type: 'ACCUMULATED_UPDATED',
          timestamp: Date.now(),
          text: accumulated,
          thinking: thinkingAccumulated,
        });
        updateAgentStatus({ active: true, phase: 'Responding...' }, { chatId, log: false });
        setConversations((prev) => {
          const conv = prev[chatId];
          if (!conv) return prev;
          const msgs = [...conv.messages];
          const lastIdx = msgs.length - 1;
          if (msgs[lastIdx]?.role === 'assistant') {
            msgs[lastIdx] = { ...msgs[lastIdx], content: accumulated, status: 'streaming' };
          }
          return { ...prev, [chatId]: { ...conv, messages: msgs } };
        });
      },
      (usage) => {
        if (usage && usageHandlerRef.current) {
          usageHandlerRef.current.trackUsage('k2p5', usage.inputTokens, usage.outputTokens);
        }
        resolve(null);
      },
      (err) => resolve(err),
      (thinkingToken) => {
        if (abortRef.current) return;
        if (thinkingToken === null) {
          updateAgentStatus({ active: true, phase: 'Responding...' }, { chatId, log: false });
          return;
        }
        const thinkingKey = `think:${round}:${thinkingAccumulated.length}:${thinkingToken}`;
        if (processedContentRef.current.has(thinkingKey)) return;
        processedContentRef.current.add(thinkingKey);
        thinkingAccumulated += thinkingToken;
        emitRunEngineEvent({
          type: 'ACCUMULATED_UPDATED',
          timestamp: Date.now(),
          text: accumulated,
          thinking: thinkingAccumulated,
        });
        updateAgentStatus({ active: true, phase: 'Reasoning...' }, { chatId, log: false });
        setConversations((prev) => {
          const conv = prev[chatId];
          if (!conv) return prev;
          const msgs = [...conv.messages];
          const lastIdx = msgs.length - 1;
          if (msgs[lastIdx]?.role === 'assistant') {
            msgs[lastIdx] = {
              ...msgs[lastIdx],
              thinking: thinkingAccumulated,
              status: 'streaming',
            };
          }
          return { ...prev, [chatId]: { ...conv, messages: msgs } };
        });
      },
      workspaceContextRef.current ?? undefined,
      hasSandboxThisRound,
      scratchpadRef.current?.content,
      abortControllerRef.current?.signal,
      lockedProvider,
      resolvedModel,
      undefined,
      todoRef.current ? buildTodoContext(todoRef.current.todos) : undefined,
      (block) => {
        if (abortRef.current) return;
        reasoningBlocks.push(block);
        // Stamp the in-flight assistant message immediately. Subsequent
        // setConversations updates in chat-tool-execution / chat-no-tool-path
        // spread `...msgs[lastIdx]`, so this stamp survives every post-stream
        // status flip and is what the next `buildLLMMessages` reads.
        setConversations((prev) => {
          const conv = prev[chatId];
          if (!conv) return prev;
          const msgs = [...conv.messages];
          const lastIdx = msgs.length - 1;
          if (msgs[lastIdx]?.role === 'assistant') {
            msgs[lastIdx] = {
              ...msgs[lastIdx],
              reasoningBlocks: [...reasoningBlocks],
            };
          }
          return { ...prev, [chatId]: { ...conv, messages: msgs } };
        });
      },
      {
        records: sessionDigestRecords,
        prior: _lastSessionDigests.get(chatId),
        onEmit: (digest) => {
          // Persist the digest the model actually saw so next turn's
          // `priorSessionDigest` is non-empty — what makes the merge
          // accumulate across turns. `null` means no digest this turn
          // (no compaction), so don't overwrite an existing entry.
          if (digest) recordSessionDigest(chatId, digest);
        },
      },
    );
  });

  // Emit a per-turn prompt-snapshot run event so a debug surface can answer
  // "what exactly went to the model on turn N?" without re-running the build.
  // The snapshot is populated by `toLLMMessages` inside the PushStream's
  // async-generator prelude (a microtask after streamChat() is called), so
  // peeking is only safe AFTER streamChat resolves. Hashes + sizes only —
  // the section content itself never leaves `_lastPromptSnapshots`, so this
  // is safe even when sections include sensitive context.
  const snapshotEntry = peekLastPromptSnapshot(
    apiMessages,
    workspaceContextRef.current ?? undefined,
  );
  if (snapshotEntry) {
    appendRunEvent(chatId, {
      type: 'assistant.prompt_snapshot',
      round,
      role: 'orchestrator',
      totalChars: snapshotEntry.totalChars,
      sections: snapshotEntry.snapshot,
    });
  }

  // Drain any context-compaction events that fired during this turn's
  // prompt build (token-budget trimming, tool-output summarization,
  // digest-grouping). Before this event existed, compaction was a
  // silent operation — the model saw a context different from prior
  // turns and couldn't tell why. Audit item #8 from the OpenCode
  // silent-failure inventory.
  for (const metric of drainRecentContextMetrics()) {
    appendRunEvent(chatId, {
      type: 'context.compaction',
      round,
      phase: metric.phase,
      beforeTokens: metric.beforeTokens,
      afterTokens: metric.afterTokens,
      messagesDropped: metric.messagesDropped ?? 0,
      ...(metric.provider ? { provider: metric.provider } : {}),
      ...(metric.cause ? { cause: metric.cause } : {}),
    });
  }

  // Safety net: some providers (observed on Workers AI / GLM-4.7-flash) emit a
  // round's entire output on the reasoning channel — either via native
  // `reasoning_content` deltas or an unclosed `<think>` block that
  // `normalizeReasoning` flushes as `reasoning_delta` at stream end. The user
  // sees the final answer trapped inside a "Thought process" block and no
  // visible reply. If the stream completed without error, wasn't cancelled by
  // the user, emitted no content, and produced no native tool call (those
  // flush through the content parser via `flushNativeToolCalls`), promote the
  // reasoning tail to content. Skipping the promotion on abort is load-bearing:
  // `streamAssistantRound` resolves with `error === null` on user cancel, so
  // without the guard a cancelled turn with only reasoning tokens would
  // surface that partial reasoning as if it were the model's final answer.
  if (!error && !abortRef.current && !accumulated && thinkingAccumulated) {
    console.warn(
      `[Push] Round ${round}: no content emitted, promoting reasoning tail (${thinkingAccumulated.length} chars) to content.`,
    );
    accumulated = thinkingAccumulated;
    thinkingAccumulated = '';
    setConversations((prev) => {
      const conv = prev[chatId];
      if (!conv) return prev;
      const msgs = [...conv.messages];
      const lastIdx = msgs.length - 1;
      if (msgs[lastIdx]?.role === 'assistant') {
        msgs[lastIdx] = {
          ...msgs[lastIdx],
          content: accumulated,
          thinking: undefined,
          status: 'streaming',
        };
      }
      return { ...prev, [chatId]: { ...conv, messages: msgs } };
    });
    emitRunEngineEvent({
      type: 'ACCUMULATED_UPDATED',
      timestamp: Date.now(),
      text: accumulated,
      thinking: '',
    });
  }

  return { accumulated, thinkingAccumulated, reasoningBlocks, error };
}
