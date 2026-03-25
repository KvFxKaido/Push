/**
 * conversationOps.ts
 *
 * Extracted from useChat.ts — typed helpers for the repeated pattern of
 * setConversations(...) + dirtyConversationIdsRef.current.add(chatId).
 *
 * makeConversationOps is a plain factory (not a hook) because it has no
 * lifecycle — it closes over two stable values and returns synchronous helpers.
 *
 * Design constraint: helpers read dirtyRef.current at call time (not at
 * construction time) to avoid stale-closure issues in async paths.
 */

import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { ChatMessage, Conversation } from '@/types';
import { createId } from '@/hooks/chat-persistence';

export function makeConversationOps(
  setConversations: Dispatch<SetStateAction<Record<string, Conversation>>>,
  dirtyRef: MutableRefObject<Set<string>>,
) {
  /** Append a message to the end of a conversation and mark it dirty. */
  function appendMessage(chatId: string, msg: ChatMessage): void {
    setConversations((prev) => {
      const conv = prev[chatId];
      if (!conv) return prev;
      const updated = {
        ...prev,
        [chatId]: {
          ...conv,
          messages: [...conv.messages, msg],
          lastMessageAt: Date.now(),
        },
      };
      dirtyRef.current.add(chatId);
      return updated;
    });
  }

  /** Replace the last assistant message's content (and optionally thinking) in place. */
  function replaceLastAssistantContent(chatId: string, content: string, thinking?: string): void {
    setConversations((prev) => {
      const conv = prev[chatId];
      if (!conv) return prev;
      const msgs = [...conv.messages];
      const lastIdx = msgs.length - 1;
      if (msgs[lastIdx]?.role !== 'assistant') return prev;
      msgs[lastIdx] = {
        ...msgs[lastIdx],
        content,
        thinking: thinking !== undefined ? thinking : msgs[lastIdx].thinking,
        status: 'done',
      };
      const updated = {
        ...prev,
        [chatId]: { ...conv, messages: msgs, lastMessageAt: Date.now() },
      };
      dirtyRef.current.add(chatId);
      return updated;
    });
  }

  /** Shallow-merge a patch into a conversation's top-level fields and mark it dirty. */
  function markConversationMeta(chatId: string, patch: Partial<Conversation>): void {
    setConversations((prev) => {
      const conv = prev[chatId];
      if (!conv) return prev;
      const updated = { ...prev, [chatId]: { ...conv, ...patch } };
      dirtyRef.current.add(chatId);
      return updated;
    });
  }

  /** Mark a conversation as dirty without mutating it (triggers a save). */
  function markDirty(chatId: string): void {
    dirtyRef.current.add(chatId);
  }

  /** Inject a synthetic assistant message and mark dirty. */
  function injectAssistantMessage(chatId: string, content: string): void {
    const msg: ChatMessage = {
      id: createId(),
      role: 'assistant',
      content,
      timestamp: Date.now(),
      status: 'done',
    };
    appendMessage(chatId, msg);
  }

  return { appendMessage, replaceLastAssistantContent, markConversationMeta, markDirty, injectAssistantMessage };
}

export type ConversationOps = ReturnType<typeof makeConversationOps>;
