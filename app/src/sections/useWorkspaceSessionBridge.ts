import { useEffect, useRef } from 'react';
import { toConversationIndex } from '@/lib/conversation-index';
import { useProtectMain } from '@/hooks/useProtectMain';
import type { Conversation, ConversationIndex } from '@/types';

interface UseWorkspaceSessionBridgeOptions {
  conversations: Record<string, Conversation>;
  onConversationIndexChange: (index: ConversationIndex) => void;
  pendingResumeChatId: string | null;
  workspaceSessionId: string;
  switchChat: (id: string) => void;
  setIsMainProtected: (value: boolean) => void;
  repoFullName: string | undefined;
}

/**
 * Manages the bridge effects between the workspace session and the chat system:
 * - Emits conversation index updates when conversations change
 * - Handles pending resume: switches to the target chat once it exists
 * - Syncs main-branch protection state into the chat system
 *
 * Returns the protectMain controller, which is needed for the WorkspaceChatRoute
 * prop handoff.
 */
export function useWorkspaceSessionBridge({
  conversations,
  onConversationIndexChange,
  pendingResumeChatId,
  workspaceSessionId,
  switchChat,
  setIsMainProtected,
  repoFullName,
}: UseWorkspaceSessionBridgeOptions) {
  // Emit conversation index whenever conversations change
  useEffect(() => {
    onConversationIndexChange(toConversationIndex(conversations));
  }, [conversations, onConversationIndexChange]);

  // Handle pending resume: switch to the target chat once it exists in conversations
  const handledResumeKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!pendingResumeChatId || !conversations[pendingResumeChatId]) return;
    const resumeKey = `${workspaceSessionId}:${pendingResumeChatId}`;
    if (handledResumeKeyRef.current === resumeKey) return;
    handledResumeKeyRef.current = resumeKey;
    switchChat(pendingResumeChatId);
  }, [conversations, pendingResumeChatId, switchChat, workspaceSessionId]);

  // Sync main-branch protection state into the chat system
  const protectMain = useProtectMain(repoFullName);
  useEffect(() => {
    setIsMainProtected(protectMain.isProtected);
  }, [protectMain.isProtected, setIsMainProtected]);

  return { protectMain };
}
