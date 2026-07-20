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
import {
  createCompactionMessage,
  nextCompactionCount,
  resolveMessageWriteBranch,
} from '@/lib/chat-message';
import { assertReadyForAssistantTurn } from '@push/lib/llm-message-invariants';
import {
  buildLinkedLibraryContext,
  spliceLinkedImagesIntoLastUser,
} from '@/lib/linked-library-context';
import { buildTodoContext } from '@/lib/todo-tools';
import { detectAnyToolCall } from '@/lib/tool-dispatch';
import { promoteReasoningAnswer } from '@/lib/tool-call-recovery';
import { getReasoningPhaseDisplay } from '@push/lib/role-display';
import { isReasoningHeavyModel } from '@push/lib/reasoning-models';
import { setOpenRouterSessionId } from '@/lib/openrouter-session';
import { getDefaultMemoryStore } from '@push/lib/context-memory-store';
import { type NativeToolCall, type ResponsesReasoningItem } from '@push/lib/provider-contract';
import { type SessionDigest, SESSION_DIGEST_HEADER } from '@push/lib/session-digest';

/** Threshold above which we eagerly pre-fetch memory records each round
 *  even without a compaction marker. Chosen well below the typical
 *  manageContext trigger so we don't ever miss a first-compaction turn,
 *  but high enough to skip the cost on warm-up turns. The actual
 *  compaction decision still happens in `manageContext`. */
const MIN_MESSAGES_BEFORE_PREFETCH = 20;
import { STREAM_RETRY_MAX, isRetryableStreamError, streamRetryDelayMs } from '@/lib/stream-error';
import { decideStreamFailover } from '@push/lib/provider-failover';
import {
  resolveFailoverCandidates,
  type ActiveProvider,
} from '@/lib/orchestrator-provider-routing';
import { getSetting, SETTINGS_KEYS } from '@/lib/settings-store';
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
  const responsesReasoningItems: ResponsesReasoningItem[] = [];
  const nativeToolCalls: NativeToolCall[] = [];
  // Web-search citations, deduped by url. Some engines resend the cumulative
  // list on every frame, so a Map keyed by url collapses repeats while
  // preserving first-seen order for the "Sources" footer.
  const citationsByUrl = new Map<string, UrlCitation>();
  // Sandbox tools are advertised in the prompt when ANY sandbox-shaped
  // transport is available: a cloud sandbox id (`sandboxIdRef`) or a paired
  // daemon binding (`localDaemonBindingRef`). Without the binding check, a
  // Remote daemon session would see only chat tools in its system prompt and
  // `sandbox_exec` / `sandbox_read_file` etc. would never be emitted even
  // though the dispatch fork exists.
  // Codex P2 on PR #516.
  const hasSandboxThisRound = Boolean(sandboxIdRef.current || localDaemonBindingRef.current);

  let invariantError: Error | null = null;
  try {
    assertReadyForAssistantTurn(apiMessages, 'web/streamAssistantRound');
  } catch (err) {
    invariantError = err instanceof Error ? err : new Error(String(err));
  }
  if (invariantError) {
    return {
      accumulated,
      thinkingAccumulated,
      reasoningBlocks,
      ...(responsesReasoningItems.length > 0 ? { responsesReasoningItems } : {}),
      nativeToolCalls,
      error: invariantError,
    };
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

  const attemptStream = (
    provider: ActiveProvider | undefined,
    model: string | undefined,
  ): Promise<Error | null> =>
    new Promise<Error | null>((resolve) => {
      // Set OpenRouter session_id so all requests in this conversation are
      // grouped. Re-armed per attempt because the getter is consume-and-clear,
      // so a retry would otherwise lose the grouping. Set unconditionally: the
      // orchestrator may resolve to OpenRouter even when lockedProvider differs,
      // and the consume-and-clear getter keeps it from leaking to other providers.
      setOpenRouterSessionId(chatId);
      // Known heavy reasoners (glm-5.x, kimi-k2.x, …) think on the reasoning
      // channel for tens of seconds before any text. Resolved once per attempt
      // so the per-token thinking handler below can rotate a liveness verb
      // instead of freezing on a static label during that dead air — `model` is
      // the best signal available at this seam (the orchestrator may still
      // resolve a different backend, but the locked pick is the common case).
      const reasoningHeavy = isReasoningHeavyModel(model);
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
          // Phase label comes from the role-display seam, never hand-spelled.
          // For a known heavy reasoner, pass the vibe verbs so the bar rotates
          // through them during reasoning dead air (the same liveness
          // affordance "Responding..." gets) — a long glm/kimi think reads as
          // alive, not stalled. Non-heavy models keep the static phase.
          updateAgentStatus(
            {
              active: true,
              phase: `${getReasoningPhaseDisplay().phase}…`,
              ...(reasoningHeavy ? { verbs: vibeVerbs } : {}),
            },
            { chatId, log: false },
          );
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
        provider,
        model,
        // onPreCompact — fired by `manageContext` the instant it decides the
        // working set is over budget, before any message is rewritten. Surface
        // it as a transient "Compacting context…" status so the user sees the
        // runtime trimming the window (matches the Codex "Compacting context"
        // pill). `log: false` keeps it out of the persisted agent-event log —
        // the durable record is the `context.compaction` run event drained
        // after the stream resolves (rendered inline in the transcript).
        () => {
          if (abortRef.current) return;
          updateAgentStatus({ active: true, phase: 'Compacting context…' }, { chatId, log: false });
        },
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
        (item) => {
          if (abortRef.current) return;
          responsesReasoningItems.push(item);
          setConversations((prev) => {
            const conv = prev[chatId];
            if (!conv) return prev;
            const lastIdx = conv.messages.length - 1;
            if (conv.messages[lastIdx]?.role !== 'assistant') return prev;
            const msgs = [...conv.messages];
            msgs[lastIdx] = {
              ...msgs[lastIdx],
              responsesReasoningItems: [...responsesReasoningItems],
            };
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
        (call) => {
          if (abortRef.current) return;
          nativeToolCalls.push(call);
        },
      ).catch((err: unknown) =>
        // Safety net: if streamChat rejects without having called onDone/onError
        // (e.g. a throw while building the stream), settle the attempt so it
        // never hangs. resolve is one-shot, so a late settle after onDone/onError
        // is a no-op.
        resolve(err instanceof Error ? err : new Error(String(err))),
      );
    });

  // Recover from a transient stream failure (gateway 5xx, rate limit,
  // stall/timeout) — but ONLY before any output streamed this round. Tokens
  // write into the assistant message live (status:'streaming'), so retrying
  // after partial output would duplicate or visibly rewrite text the user
  // already saw and corrupt reasoning/tool-call coherence. A connect-time blip
  // (the common flaky-gateway case) fails with `accumulated`/`thinking` still
  // empty, which is exactly what we re-attempt. Mid-stream failures stay
  // terminal.
  //
  // Two recovery tiers (decision #13): (1) same-provider transient retry, then
  // (2) round-scoped failover to an alternate configured provider of the SAME
  // wire shape, when the failover setting is on. Failover does NOT mutate the
  // chat lock — it rescues this round only; the next round re-tries the locked
  // provider first. With failover disabled the candidate list is empty, so
  // `decideStreamFailover` collapses to the prior same-provider-retry behavior.
  const failoverEnabled = getSetting<boolean>(SETTINGS_KEYS.providerFailover) === true;
  let currentProvider: ActiveProvider = lockedProvider;
  // The locked round uses its resolved model; a failover provider passes
  // `undefined` so `streamChat` resolves that provider's own default model.
  let currentModel: string | undefined = resolvedModel;
  const tried = new Set<string>([currentProvider]);
  let error: Error | null;
  let recovered = false;
  let sameProviderAttempt = 0;
  for (;;) {
    error = await attemptStream(currentProvider, currentModel);
    if (!error) break;
    // Any assistant-visible side effect this round — streamed text, thinking,
    // signed reasoning blocks, or web-search citations — makes re-attempting
    // unsafe on ANY provider: it would duplicate/rewrite what the user already
    // saw, or leave a stale signed-thinking sidecar the next turn forwards to
    // the model. Only a clean pre-output failure is recoverable.
    const hasOutput =
      accumulated.length > 0 ||
      thinkingAccumulated.length > 0 ||
      reasoningBlocks.length > 0 ||
      responsesReasoningItems.length > 0 ||
      nativeToolCalls.length > 0 ||
      citationsByUrl.size > 0;
    const decision = decideStreamFailover({
      classification: {
        retryable: isRetryableStreamError(error),
        status: (error as { status?: number }).status,
      },
      aborted: abortRef.current,
      hasOutput,
      sameProviderAttempt,
      sameProviderMax: STREAM_RETRY_MAX,
      tried,
      // Isolation/shape keys on the LOCKED route (where any signed-block
      // history originates), not the current failover target.
      candidates: failoverEnabled
        ? resolveFailoverCandidates(lockedProvider, resolvedModel, tried)
        : [],
      retryDelayMs: streamRetryDelayMs(sameProviderAttempt),
    });
    if (decision.action === 'give-up') break;
    recovered = true;
    if (decision.action === 'retry-same') {
      console.log(
        JSON.stringify({
          level: 'warn',
          event: 'stream_round_retry',
          round,
          provider: currentProvider,
          attempt: sameProviderAttempt + 1,
          status: (error as { status?: number }).status,
        }),
      );
      sameProviderAttempt++;
      await new Promise<void>((resolve) => setTimeout(resolve, decision.delayMs));
      if (abortRef.current) break; // user may have cancelled during backoff
      continue;
    }
    // decision.action === 'failover'
    console.log(
      JSON.stringify({
        level: 'warn',
        event: 'stream_failover',
        round,
        from: currentProvider,
        to: decision.provider,
        status: (error as { status?: number }).status,
      }),
    );
    currentProvider = decision.provider as ActiveProvider;
    currentModel = undefined; // resolve the failover provider's own default model
    tried.add(decision.provider);
    sameProviderAttempt = 0;
  }
  // Gate the exhausted log on !aborted — an abort during backoff exits here too,
  // but the round loop handles that as a cancel, not a failure.
  if (error && recovered && !abortRef.current) {
    console.log(
      JSON.stringify({
        level: 'warn',
        event: 'stream_recovery_exhausted',
        round,
        provider: currentProvider,
        triedCount: tried.size,
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
  const compactionMetrics = drainRecentContextMetrics();
  for (const metric of compactionMetrics) {
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
  // Drop a single durable transcript marker for the turn's compaction so the
  // user can see, in-line, that the window was trimmed and by how much — the
  // persistent counterpart to the transient "Compacting context…" status pill.
  // One marker per turn: the net is the first stage's `beforeTokens` to the
  // last stage's `afterTokens` (phases run oldest→newest: summarization →
  // digest_drop → hard_trim), and the heaviest phase is whichever ran last.
  if (compactionMetrics.length > 0 && !abortRef.current) {
    const first = compactionMetrics[0];
    const last = compactionMetrics[compactionMetrics.length - 1];
    const messagesDropped = compactionMetrics.reduce((sum, m) => sum + (m.messagesDropped ?? 0), 0);
    setConversations((prev) => {
      const conv = prev[chatId];
      if (!conv) return prev;
      const msgs = [...conv.messages];
      // Stamp the ordinal from the live conversation so this heuristic path feeds
      // the same running compaction count as the pre-turn LLM handoff — a thread
      // trimmed only by hard-trim/digest still surfaces the degradation nudge.
      const marker = createCompactionMessage({
        beforeTokens: first.beforeTokens,
        afterTokens: last.afterTokens,
        phase: last.phase,
        messagesDropped,
        compactionCount: nextCompactionCount(msgs),
        branch: resolveMessageWriteBranch(ctx.branchInfoRef.current, conv.branch),
      });
      // Compaction logically happened before this turn's response was
      // generated, so the marker belongs just before the trailing assistant
      // message. Inserting *before* (not after) it also keeps the assistant
      // message last, preserving the `msgs[msgs.length - 1].role === 'assistant'`
      // assumption the streaming/finalization callbacks rely on this round.
      let insertAt = msgs.length;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'assistant') {
          insertAt = i;
          break;
        }
      }
      msgs.splice(insertAt, 0, marker);
      return { ...prev, [chatId]: { ...conv, messages: msgs } };
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
  // Don't promote when the turn carried a tool call — empty visible content then
  // means "the call is elsewhere", not "the answer is stranded in reasoning":
  //   - native tool calls flush to `nativeToolCalls`, NOT `content` (a DeepSeek
  //     thinking turn + a native call emits reasoning and no prose). Promoting
  //     would mislabel the reasoning as the answer AND clear `thinking`, which
  //     drops the `reasoning_content` DeepSeek requires on the next tool-result
  //     turn → 400 (Codex P1, #1193).
  //   - a *text-form* `{"tool": ...}` call in the reasoning channel does NOT
  //     flush either; promoting it would feed it to `detectAnyToolCall`
  //     downstream and execute an untrusted reasoning-channel call.
  // Both fall through to the buried-call recovery. Mirrors the kernel guard in
  // `lib/coder-agent.ts`, which already includes `nativeToolCalls`.
  const promotedReasoning =
    !error && !abortRef.current
      ? promoteReasoningAnswer(
          accumulated,
          thinkingAccumulated,
          Boolean(detectAnyToolCall(thinkingAccumulated)) || nativeToolCalls.length > 0,
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

  return {
    accumulated,
    thinkingAccumulated,
    reasoningBlocks,
    ...(responsesReasoningItems.length > 0 ? { responsesReasoningItems } : {}),
    nativeToolCalls,
    error,
  };
}
