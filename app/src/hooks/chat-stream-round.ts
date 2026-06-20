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
import { emitPromptCompositionCost } from '@push/lib/prompt-cost-telemetry';
import { drainRecentContextMetrics } from '@/lib/context-metrics';
import { assertReadyForAssistantTurn } from '@push/lib/llm-message-invariants';
import {
  buildLinkedLibraryContext,
  spliceLinkedImagesIntoLastUser,
} from '@/lib/linked-library-context';
import { buildTodoContext } from '@/lib/todo-tools';
import { detectAnyToolCall } from '@/lib/tool-dispatch';
import { promoteReasoningAnswer } from '@/lib/tool-call-recovery';
import { setOpenRouterSessionId } from '@/lib/openrouter-session';
import { getDefaultMemoryStore } from '@push/lib/context-memory-store';
import { type SessionDigest, SESSION_DIGEST_HEADER } from '@push/lib/session-digest';

/** Threshold above which we eagerly pre-fetch memory records each round
 *  even without a compaction marker. Chosen well below the typical
 *  manageContext trigger so we don't ever miss a first-compaction turn,
 *  but high enough to skip the cost on warm-up turns. The actual
 *  compaction decision still happens in `manageContext`. */
const MIN_MESSAGES_BEFORE_PREFETCH = 20;
import { shouldRetryStreamRound, streamRetryDelayMs } from '@/lib/stream-error';
import type { ChatMessage, ReasoningBlock, UrlCitation } from '@/types';
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
  /** Vibe-verb pool the bar rotates while streaming the response ("Responding…"
   *  opening). Resolved once per turn by the round loop and threaded in so the
   *  per-token status updates don't re-classify. */
  vibeVerbs: string[],
): Promise<StreamRoundResult> {
  const {
    chatId,
    lockedProvider,
    resolvedModel,
    abortRef,
    processedContentRef,
    scratchpadRef,
    todoRef,
    workspaceContextRef,
    abortControllerRef,
    sandboxIdRef,
    localDaemonBindingRef,
    conversationsRef,
    setConversations,
    updateAgentStatus,
    emitRunEngineEvent,
    appendRunEvent,
  } = ctx;

  processedContentRef.current.clear();
  let accumulated = '';
  let thinkingAccumulated = '';
  const reasoningBlocks: ReasoningBlock[] = [];
  // Web-search citations, deduped by url. Some engines resend the cumulative
  // list on every frame, so a Map keyed by url collapses repeats while
  // preserving first-seen order for the "Sources" footer.
  const citationsByUrl = new Map<string, UrlCitation>();
  // Sandbox tools are advertised in the prompt when ANY sandbox-shaped
  // transport is available: a cloud sandbox id (`sandboxIdRef`) or a
  // paired local-PC daemon binding (`localDaemonBindingRef`). Without
  // the binding check, a local-pc session would see only chat tools in
  // its system prompt and `sandbox_exec` / `sandbox_read_file` etc.
  // would never be emitted even though the dispatch fork exists.
  // Codex P2 on PR #516.
  const hasSandboxThisRound = Boolean(sandboxIdRef.current || localDaemonBindingRef.current);

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
  // stage — but only when the stage might actually fire. The IndexedDB
  // `list(predicate)` loads every record before filtering; on a hot path
  // that runs every round even though the digest no-ops until compaction,
  // the full read is wasted work (PR #574 review). Two cheap signals
  // indicate compaction is in play:
  //   (a) a durable compaction marker already in the transcript (a prior
  //       turn compacted; this turn likely will too and future-merge into
  //       that lineage)
  //   (b) message count is high enough that compaction is plausible this
  //       turn (rough threshold — the actual decision happens in
  //       `manageContext`; we just need a not-too-tight gate)
  // When neither holds, skip the prefetch and let the digest stage emit
  // an empty-records digest (or no digest at all if compaction doesn't
  // trigger). Persisted records get picked up on the first compacted turn.
  const compactionLikely =
    apiMessages.some(
      (m) =>
        typeof m.content === 'string' &&
        (m.content.includes('[CONTEXT DIGEST]') ||
          m.content.includes(SESSION_DIGEST_HEADER) ||
          m.content.includes('[USER_GOAL]')),
    ) || apiMessages.length > MIN_MESSAGES_BEFORE_PREFETCH;
  const memoryStore = getDefaultMemoryStore();
  let sessionDigestRecords: Awaited<ReturnType<typeof memoryStore.list>> = [];
  if (compactionLikely) {
    try {
      const listed = memoryStore.list((record) => record.scope.chatId === chatId);
      sessionDigestRecords = await Promise.resolve(listed);
    } catch {
      // Memory store is best-effort. A read failure shouldn't block the turn —
      // the digest just falls back to working-memory + goal only.
      sessionDigestRecords = [];
    }
  }

  // Library v2b/v2c — fetch + render content for libraries linked to
  // this chat. Fresh every turn (never persisted in chat history).
  // Returns two channels: `systemText` flows into the system message's
  // library_context section, `imageAttachments` are spliced into the
  // latest user message's attachments[] so vision-capable models can
  // see the pixels via the existing image_url-block path. Failures
  // are swallowed inside the helper so a single unreachable library
  // doesn't block the send.
  const linkedLibraryIds = conversationsRef.current[chatId]?.linkedLibraryIds ?? [];
  const linkedLibraryPayload =
    linkedLibraryIds.length > 0
      ? await buildLinkedLibraryContext(linkedLibraryIds)
      : { systemText: undefined, imageAttachments: [] };
  const linkedLibraryContent = linkedLibraryPayload.systemText;

  // v2c — graft linked-library image attachments onto a CLONE of the
  // latest user message in apiMessages so the model sees the pixels
  // on every turn (via the existing image_url-block path) without
  // mutating the conversation in IndexedDB. No-op when there are no
  // images or no user message.
  const apiMessagesForSend = spliceLinkedImagesIntoLastUser(
    apiMessages,
    linkedLibraryPayload.imageAttachments,
  );

  const attemptStream = (): Promise<Error | null> =>
    new Promise<Error | null>((resolve) => {
      // Set OpenRouter session_id so all requests in this conversation are
      // grouped. Re-armed per attempt because the getter is consume-and-clear,
      // so a retry would otherwise lose the grouping. Set unconditionally: the
      // orchestrator may resolve to OpenRouter even when lockedProvider differs,
      // and the consume-and-clear getter keeps it from leaking to other providers.
      setOpenRouterSessionId(chatId);
      streamChat(
        apiMessagesForSend,
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
          updateAgentStatus(
            { active: true, phase: 'Responding...', verbs: vibeVerbs },
            { chatId, log: false },
          );
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
        () => resolve(null),
        (err) => resolve(err),
        (thinkingToken) => {
          if (abortRef.current) return;
          if (thinkingToken === null) {
            updateAgentStatus(
              { active: true, phase: 'Responding...', verbs: vibeVerbs },
              { chatId, log: false },
            );
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
        linkedLibraryContent,
        (citations) => {
          if (abortRef.current) return;
          let added = false;
          for (const c of citations) {
            if (!citationsByUrl.has(c.url)) {
              citationsByUrl.set(c.url, c);
              added = true;
            }
          }
          if (!added) return;
          // Stamp the in-flight assistant message. Like the reasoningBlocks
          // stamp above, later setConversations updates spread `...msgs[lastIdx]`,
          // so this survives the post-stream status flips and persists for render.
          const next = [...citationsByUrl.values()];
          setConversations((prev) => {
            const conv = prev[chatId];
            if (!conv) return prev;
            const lastIdx = conv.messages.length - 1;
            // Bail before cloning when there's no assistant message to stamp —
            // avoids a no-op state update + re-render.
            if (conv.messages[lastIdx]?.role !== 'assistant') return prev;
            const msgs = [...conv.messages];
            msgs[lastIdx] = { ...msgs[lastIdx], citations: next };
            return { ...prev, [chatId]: { ...conv, messages: msgs } };
          });
        },
      ).catch((err: unknown) =>
        // Safety net: if streamChat rejects without having called onDone/onError
        // (e.g. a throw while building the stream), settle the attempt so it
        // never hangs. resolve is one-shot, so a late settle after onDone/onError
        // is a no-op.
        resolve(err instanceof Error ? err : new Error(String(err))),
      );
    });

  // Retry a transient stream failure (gateway 5xx, rate limit, stall/timeout)
  // — but ONLY before any output streamed this round. Tokens write into the
  // assistant message live (status:'streaming'), so retrying after partial
  // output would duplicate or visibly rewrite text the user already saw and
  // corrupt reasoning/tool-call coherence. A connect-time blip (the common
  // flaky-gateway case) fails with `accumulated`/`thinking` still empty, which
  // is exactly what we re-attempt. Mid-stream failures stay terminal.
  let error: Error | null;
  let retried = false;
  for (let attempt = 0; ; attempt++) {
    error = await attemptStream();
    // Any assistant-visible side effect this round — streamed text, thinking,
    // signed reasoning blocks, or web-search citations — makes a retry unsafe:
    // it would duplicate/rewrite what the user already saw, or leave a stale
    // signed-thinking sidecar on the message that the next turn forwards to the
    // model. Only a clean pre-output failure (the flaky-gateway connect blip)
    // is retried.
    const hasOutput =
      accumulated.length > 0 ||
      thinkingAccumulated.length > 0 ||
      reasoningBlocks.length > 0 ||
      citationsByUrl.size > 0;
    if (!shouldRetryStreamRound({ error, aborted: abortRef.current, hasOutput, attempt })) break;
    retried = true;
    console.log(
      JSON.stringify({
        level: 'warn',
        event: 'stream_round_retry',
        round,
        attempt: attempt + 1,
        status: (error as { status?: number }).status,
      }),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, streamRetryDelayMs(attempt)));
    if (abortRef.current) break; // user may have cancelled during backoff
  }
  // Gate the exhausted log on !aborted — an abort during backoff exits here too,
  // but the round loop handles that as a cancel, not a failure.
  if (error && retried && !abortRef.current) {
    console.log(
      JSON.stringify({
        level: 'warn',
        event: 'stream_round_retry_exhausted',
        round,
        status: (error as { status?: number }).status,
      }),
    );
  }

  // Emit a per-turn prompt-snapshot run event so a debug surface can answer
  // "what exactly went to the model on turn N?" without re-running the build.
  // The snapshot is populated by `toLLMMessages` inside the PushStream's
  // async-generator prelude (a microtask after streamChat() is called), so
  // peeking is only safe AFTER streamChat resolves. Hashes + sizes only —
  // the section content itself never leaves `_lastPromptSnapshots`, so this
  // is safe even when sections include sensitive context.
  //
  // The peek must use `apiMessagesForSend` (the post-splice clone), not
  // the original `apiMessages`: the snapshot was written during
  // streamChat's execution under the post-splice key. Peeking with the
  // original array would key-miss whenever v2c linked image attachments
  // were added, silently emitting an empty `assistant.prompt_snapshot`
  // event for those turns.
  const snapshotEntry = peekLastPromptSnapshot(
    apiMessagesForSend,
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

    // Measurement pass for the schema-deferral decision: one structured
    // `prompt_composition_cost` line per orchestrator prompt build, keyed by
    // chatId+round so it joins the github_tool_turn_* usage line emitted from
    // chat-send. Gated on the same consume-on-peek entry as the snapshot event
    // so an aborted round that never rebuilt the prompt doesn't re-emit a
    // stale cost against the wrong round.
    emitPromptCompositionCost(
      {
        surface: 'web',
        scopeId: chatId,
        round,
        mode: workspaceContextRef.current?.mode ?? 'unknown',
      },
      snapshotEntry.cost,
    );
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

  // Safety net: some providers (observed on Workers AI — Kimi-k2.7, GLM-4.7-flash)
  // emit a round's entire output on the reasoning channel — either via native
  // `reasoning_content` deltas or an unclosed `<think>` block that
  // `normalizeReasoning` flushes as `reasoning_delta` at stream end. The user
  // sees the final answer trapped inside a "Thought process" block and no
  // visible reply. When the stream completed without error and wasn't cancelled,
  // promote a stranded *answer* (empty content + reasoning text) to content so
  // it's delivered. Skipping on abort is load-bearing: `streamAssistantRound`
  // resolves with `error === null` on user cancel, so without the guard a
  // cancelled reasoning-only turn would surface partial reasoning as if it were
  // the final answer.
  //
  // Native tool calls already flush into content (so empty content implies no
  // native call), but a *text-form* `{"tool": ...}` call placed in the reasoning
  // channel does NOT flush — promoting it would feed it to `detectAnyToolCall`
  // downstream and execute an untrusted reasoning-channel call. The
  // `reasoningHasToolCall` guard in `promoteReasoningAnswer` excludes that case;
  // it instead falls through to the buried-call recovery, which re-prompts the
  // model to re-emit the call in content. Shares the helper with the kernel
  // salvage in `lib/coder-agent.ts`.
  const promotedReasoning =
    !error && !abortRef.current
      ? promoteReasoningAnswer(
          accumulated,
          thinkingAccumulated,
          Boolean(detectAnyToolCall(thinkingAccumulated)),
        )
      : null;
  if (promotedReasoning !== null) {
    // Symmetric structured log: greppable counterpart to the kernel's
    // `coder_reasoning_answer_promoted`; the drop is otherwise invisible to ops.
    console.log(
      JSON.stringify({
        level: 'warn',
        event: 'orchestrator_reasoning_answer_promoted',
        chatId,
        round,
        reasoningChars: promotedReasoning.length,
      }),
    );
    accumulated = promotedReasoning;
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
