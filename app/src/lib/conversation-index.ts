import type { Conversation, ConversationIndex } from '@/types';

export function toConversationIndex(
  conversations: Record<string, Conversation>,
): ConversationIndex {
  const index: ConversationIndex = {};
  for (const [chatId, conversation] of Object.entries(conversations)) {
    index[chatId] = Object.fromEntries(
      Object.entries(conversation).filter(([key]) => key !== 'messages' && key !== 'runState'),
    ) as ConversationIndex[string];
  }
  return index;
}
