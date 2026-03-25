/**
 * chat-replay.ts
 *
 * Extracted from useChat.ts — thin wrappers over sendMessage that replay
 * conversation history: regenerate, editAndResend, diagnoseCIFailure.
 */

import { useCallback } from 'react';
import type { MutableRefObject } from 'react';
import type { AIProviderType, AttachmentData, CIStatus, ChatMessage, Conversation, ChatSendOptions } from '@/types';
import { buildEditedReplay, buildRegeneratedReplay } from '@/lib/chat-replay';

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

export interface ChatReplayParams {
  conversations: Record<string, Conversation>;
  activeChatIdRef: MutableRefObject<string>;
  isStreaming: boolean;
  ciStatus: CIStatus | null;
  lockedProvider: AIProviderType | null;
  lockedModel: string | null;
  sendMessage: (
    text: string,
    attachments?: AttachmentData[],
    options?: {
      chatId?: string;
      baseMessages?: ChatMessage[];
      existingUserMessage?: ChatMessage;
      titleOverride?: string;
      provider?: AIProviderType | null;
      model?: string | null;
    },
  ) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useChatReplay({
  conversations,
  activeChatIdRef,
  isStreaming,
  ciStatus,
  lockedProvider,
  lockedModel,
  sendMessage,
}: ChatReplayParams) {
  const regenerateLastResponse = useCallback(async () => {
    if (isStreaming) return;

    const chatId = activeChatIdRef.current;
    if (!chatId) return;
    const conversation = conversations[chatId];
    if (!conversation) return;

    const replay = buildRegeneratedReplay(conversation.messages);
    if (!replay) return;

    await sendMessage(
      replay.existingUserMessage.content,
      replay.existingUserMessage.attachments,
      {
        chatId,
        baseMessages: replay.baseMessages,
        existingUserMessage: replay.existingUserMessage,
        titleOverride: conversation.title,
      },
    );
  }, [activeChatIdRef, conversations, isStreaming, sendMessage]);

  const editMessageAndResend = useCallback(
    async (
      messageId: string,
      text: string,
      attachments?: AttachmentData[],
      options?: ChatSendOptions,
    ) => {
      if (isStreaming) return;

      const chatId = activeChatIdRef.current;
      if (!chatId) return;
      const conversation = conversations[chatId];
      if (!conversation) return;

      const replay = buildEditedReplay(
        conversation.messages,
        messageId,
        text,
        attachments,
        options?.displayText,
      );
      if (!replay) return;

      await sendMessage(
        replay.existingUserMessage.content,
        replay.existingUserMessage.attachments,
        {
          chatId,
          baseMessages: replay.baseMessages,
          existingUserMessage: replay.existingUserMessage,
          titleOverride: conversation.title,
        },
      );
    },
    [activeChatIdRef, conversations, isStreaming, sendMessage],
  );

  const diagnoseCIFailure = useCallback(async () => {
    if (!ciStatus || ciStatus.overall !== 'failure') return;
    const failedChecks = ciStatus.checks
      .filter((c) => c.conclusion === 'failure')
      .map((c) => c.name)
      .join(', ');
    await sendMessage(
      `CI is failing on ${ciStatus.ref}. Failed checks: ${failedChecks}. Diagnose and fix the failures.`,
      undefined,
      {
        provider: lockedProvider || undefined,
        model: lockedModel || undefined,
      },
    );
  }, [ciStatus, lockedModel, lockedProvider, sendMessage]);

  return { regenerateLastResponse, editMessageAndResend, diagnoseCIFailure };
}
