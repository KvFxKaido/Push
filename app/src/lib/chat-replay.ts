import type { AttachmentData, ChatMessage } from '@/types';

export interface ReplaySnapshot {
  baseMessages: ChatMessage[];
  existingUserMessage: ChatMessage;
}

function isReplayableUserMessage(message: ChatMessage): boolean {
  return message.role === 'user' && !message.isToolResult;
}

function normalizeMessageContent(text: string): string {
  return text.trim();
}

function normalizeDisplayContent(displayText: string | undefined, content: string): string | undefined {
  const trimmed = displayText?.trim();
  if (!trimmed || trimmed === content) return undefined;
  return trimmed;
}

function normalizeAttachments(attachments?: AttachmentData[]): AttachmentData[] | undefined {
  return attachments && attachments.length > 0 ? attachments : undefined;
}

export function buildRegeneratedReplay(messages: ChatMessage[]): ReplaySnapshot | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const candidate = messages[index];
    if (!isReplayableUserMessage(candidate)) continue;

    return {
      baseMessages: messages.slice(0, index + 1),
      existingUserMessage: {
        ...candidate,
        status: 'done',
      },
    };
  }

  return null;
}

export function buildEditedReplay(
  messages: ChatMessage[],
  messageId: string,
  text: string,
  attachments?: AttachmentData[],
  displayText?: string,
): ReplaySnapshot | null {
  const content = normalizeMessageContent(text);
  const nextAttachments = normalizeAttachments(attachments);
  if (!content && !nextAttachments) return null;

  const targetIndex = messages.findIndex((message) => message.id === messageId && isReplayableUserMessage(message));
  if (targetIndex === -1) return null;

  const original = messages[targetIndex];
  const updatedMessage: ChatMessage = {
    ...original,
    content,
    displayContent: normalizeDisplayContent(displayText, content),
    attachments: nextAttachments,
    status: 'done',
    timestamp: Date.now(),
  };

  return {
    baseMessages: [...messages.slice(0, targetIndex), updatedMessage],
    existingUserMessage: updatedMessage,
  };
}
