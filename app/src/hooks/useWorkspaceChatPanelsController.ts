import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { restoreResumeBranchIfNeeded } from '@/lib/resume-branch-restore';
import { fetchSandboxDiff } from '@/lib/sandbox-client';
import type { ChatRouteProps } from '@/sections/workspace-chat-route-types';

type PanelsControllerArgs = Pick<
  ChatRouteProps,
  | 'activeRepo'
  | 'sandbox'
  | 'conversations'
  | 'repos'
  | 'switchChat'
  | 'switchBranchFromUI'
  | 'handleSelectRepoFromDrawer'
  | 'handleOpenDraftComposer'
  | 'handleStartWorkspace'
  | 'handleExitWorkspace'
  | 'handleDisconnect'
  | 'ensureSandbox'
  | 'sendMessage'
  | 'saveExpiryCheckpoint'
  | 'isStreaming'
> & {
  isScratch: boolean;
  isChat?: boolean;
  markSnapshotActivity: () => void;
};

export function useWorkspaceChatPanelsController({
  activeRepo,
  sandbox,
  conversations,
  repos,
  switchChat,
  switchBranchFromUI,
  handleSelectRepoFromDrawer,
  handleOpenDraftComposer,
  handleStartWorkspace,
  handleExitWorkspace,
  handleDisconnect,
  ensureSandbox,
  sendMessage,
  saveExpiryCheckpoint,
  isStreaming,
  isScratch,
  isChat,
  markSnapshotActivity,
}: PanelsControllerArgs) {
  const [isWorkspaceHubOpen, setIsWorkspaceHubOpen] = useState(false);
  const [isLauncherOpen, setIsLauncherOpen] = useState(false);
  const [isChatsDrawerOpen, setIsChatsDrawerOpen] = useState(false);
  // `hubTabRequest` stays a controlled value (consumed by
  // `WorkspaceHubSheet` as `externalTabRequest`) but no longer has a
  // writer — the "review changes from new chat" deep-link that used
  // to flip it was deleted with the new-chat sheet. A future
  // pre-flight "review changes" path can re-add the setter when it
  // needs one.
  const [hubTabRequest] = useState<{
    tab: 'files' | 'diff';
    requestKey: number;
  } | null>(null);

  const closePanels = useCallback(() => {
    setIsLauncherOpen(false);
    setIsChatsDrawerOpen(false);
    setIsWorkspaceHubOpen(false);
  }, []);

  const handleWorkspaceHubOpenChange = useCallback((open: boolean) => {
    if (open) {
      setIsChatsDrawerOpen(false);
    }
    setIsWorkspaceHubOpen(open);
  }, []);

  const openWorkspaceHub = useCallback(() => {
    setIsChatsDrawerOpen(false);
    setIsWorkspaceHubOpen(true);
  }, []);

  const openLauncher = useCallback(() => {
    setIsChatsDrawerOpen(false);
    setIsWorkspaceHubOpen(false);
    setIsLauncherOpen(true);
  }, []);

  const handleCreateNewChatRequest = useCallback(() => {
    // Route every new-chat intent through the pre-flight composer,
    // seeded with the current workspace so the common "stay here, new
    // chat" case is one tap away after the user types. The composer
    // detects same-context commits and keeps the sandbox alive.
    handleOpenDraftComposer({
      mode: isChat ? 'chat' : isScratch ? 'scratch' : 'repo',
      repoFullName: activeRepo?.full_name ?? null,
      branch: activeRepo?.current_branch ?? activeRepo?.default_branch ?? null,
    });
  }, [activeRepo, handleOpenDraftComposer, isChat, isScratch]);

  const handleExpiryWarningReached = useCallback(async () => {
    if (!sandbox.sandboxId) return;
    try {
      const diff = await fetchSandboxDiff(sandbox.sandboxId);
      saveExpiryCheckpoint(diff);
    } catch {
      saveExpiryCheckpoint('');
    }
  }, [sandbox.sandboxId, saveExpiryCheckpoint]);

  const handleFixReviewFinding = useCallback(
    async (prompt: string) => {
      if (isStreaming) {
        toast.error('Wait for the current response to finish before sending a fix request.');
        return;
      }

      markSnapshotActivity();
      handleWorkspaceHubOpenChange(false);

      if (!sandbox.sandboxId) {
        try {
          await ensureSandbox();
        } catch {
          // Best effort — still send the fix request so the agent can explain next steps.
        }
      }

      await sendMessage(prompt);
    },
    [
      ensureSandbox,
      handleWorkspaceHubOpenChange,
      isStreaming,
      markSnapshotActivity,
      sandbox.sandboxId,
      sendMessage,
    ],
  );

  const handleResumeConversationFromLauncher = useCallback(
    async (chatId: string) => {
      const conversation = conversations[chatId];
      if (!conversation) return;

      // Chat/scratch conversations have no repo — just switch to them directly.
      if (!conversation.repoFullName) {
        closePanels();
        switchChat(chatId);
        return;
      }

      // Repo conversations — select the repo first, then switch.
      const repo = repos.find((candidate) => candidate.full_name === conversation.repoFullName);
      if (!repo) return;
      if (activeRepo?.full_name === conversation.repoFullName) {
        closePanels();
        switchChat(chatId);
        await restoreResumeBranchIfNeeded({
          chatId,
          repoFullName: conversation.repoFullName,
          activeRepoFullName: activeRepo.full_name,
          savedBranch: conversation.branch,
          currentBranch: activeRepo.current_branch || activeRepo.default_branch,
          surface: 'launcher',
          switchBranchFromUI,
        });
        return;
      }

      handleSelectRepoFromDrawer(repo, conversation.branch);
      requestAnimationFrame(() => {
        switchChat(chatId);
      });
    },
    [
      activeRepo,
      closePanels,
      conversations,
      handleSelectRepoFromDrawer,
      repos,
      switchChat,
      switchBranchFromUI,
    ],
  );

  const handleStartWorkspaceRequest = useCallback(() => {
    closePanels();
    handleStartWorkspace?.();
  }, [closePanels, handleStartWorkspace]);

  const handleExitWorkspaceRequest = useCallback(() => {
    closePanels();
    handleExitWorkspace();
  }, [closePanels, handleExitWorkspace]);

  const handleDisconnectRequest = useCallback(() => {
    closePanels();
    handleDisconnect();
  }, [closePanels, handleDisconnect]);

  return {
    isWorkspaceHubOpen,
    isLauncherOpen,
    isChatsDrawerOpen,
    hubTabRequest,
    setIsChatsDrawerOpen,
    setIsLauncherOpen,
    handleWorkspaceHubOpenChange,
    openWorkspaceHub,
    openLauncher,
    handleCreateNewChatRequest,
    handleExpiryWarningReached,
    handleFixReviewFinding,
    handleResumeConversationFromLauncher,
    handleStartWorkspaceRequest,
    handleExitWorkspaceRequest,
    handleDisconnectRequest,
  };
}
