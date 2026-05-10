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

import { streamChat } from '@/lib/orchestrator';
import { assertReadyForAssistantTurn } from '@push/lib/llm-message-invariants';
import { buildTodoContext } from '@/lib/todo-tools';
import { setOpenRouterSessionId } from '@/lib/openrouter-session';
import type { ChatMessage, ReasoningBlock } from '@/types';
import type { SendLoopContext, StreamRoundResult } from './chat-send-types';

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
    setConversations,
    updateAgentStatus,
    emitRunEngineEvent,
  } = ctx;

  processedContentRef.current.clear();
  let accumulated = '';
  let thinkingAccumulated = '';
  const reasoningBlocks: ReasoningBlock[] = [];
  const hasSandboxThisRound = Boolean(sandboxIdRef.current);

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
    );
  });

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
