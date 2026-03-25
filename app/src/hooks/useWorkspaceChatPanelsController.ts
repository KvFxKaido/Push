import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { fetchSandboxDiff } from '@/lib/sandbox-client';
import type { ChatRouteProps } from '@/sections/workspace-chat-route-types';

type PanelsControllerArgs = Pick<
  ChatRouteProps,
  | 'activeRepo'
  | 'sandbox'
  | 'conversations'
  | 'repos'
  | 'switchChat'
  | 'handleSelectRepoFromDrawer'
  | 'handleCreateNewChat'
  | 'inspectNewChatWorkspace'
  | 'handleStartWorkspace'
  | 'handleExitWorkspace'
  | 'handleDisconnect'
  | 'ensureSandbox'
  | 'sendMessage'
  | 'saveExpiryCheckpoint'
  | 'isStreaming'
> & {
  isScratch: boolean;
  markSnapshotActivity: () => void;
};

export function useWorkspaceChatPanelsController({
  activeRepo,
  sandbox,
  conversations,
  repos,
  switchChat,
  handleSelectRepoFromDrawer,
  handleCreateNewChat,
  inspectNewChatWorkspace,
  handleStartWorkspace,
  handleExitWorkspace,
  handleDisconnect,
  ensureSandbox,
  sendMessage,
  saveExpiryCheckpoint,
  isStreaming,
  isScratch,
  markSnapshotActivity,
}: PanelsControllerArgs) {
  const [isWorkspaceHubOpen, setIsWorkspaceHubOpen] = useState(false);
  const [isLauncherOpen, setIsLauncherOpen] = useState(false);
  const [isChatsDrawerOpen, setIsChatsDrawerOpen] = useState(false);
  const [newChatSheetOpen, setNewChatSheetOpen] = useState(false);
  const [newChatWorkspaceState, setNewChatWorkspaceState] = useState<ChatRouteProps['inspectNewChatWorkspace'] extends () => Promise<infer T> ? T : never>(null);
  const [checkingNewChatWorkspace, setCheckingNewChatWorkspace] = useState(false);
  const [resettingWorkspaceForNewChat, setResettingWorkspaceForNewChat] = useState(false);
  const [hubTabRequest, setHubTabRequest] = useState<{ tab: 'files' | 'diff'; requestKey: number } | null>(null);

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

  const handleNewChatSheetOpenChange = useCallback((open: boolean) => {
    setNewChatSheetOpen(open);
    if (!open && !resettingWorkspaceForNewChat) {
      setNewChatWorkspaceState(null);
      setCheckingNewChatWorkspace(false);
    }
  }, [resettingWorkspaceForNewChat]);

  const handleCreateNewChatRequest = useCallback(async () => {
    if (checkingNewChatWorkspace || resettingWorkspaceForNewChat) return;

    if (sandbox.status !== 'ready' || !sandbox.sandboxId) {
      handleCreateNewChat();
      return;
    }

    setNewChatWorkspaceState(null);
    setCheckingNewChatWorkspace(true);
    setNewChatSheetOpen(true);

    const workspaceState = await inspectNewChatWorkspace();
    if (!workspaceState) {
      setNewChatSheetOpen(false);
      setCheckingNewChatWorkspace(false);
      handleCreateNewChat();
      return;
    }

    setNewChatWorkspaceState(workspaceState);
    setCheckingNewChatWorkspace(false);
  }, [
    checkingNewChatWorkspace,
    handleCreateNewChat,
    inspectNewChatWorkspace,
    resettingWorkspaceForNewChat,
    sandbox.sandboxId,
    sandbox.status,
  ]);

  const handleContinueCurrentWorkspace = useCallback(() => {
    setNewChatSheetOpen(false);
    setNewChatWorkspaceState(null);
    setCheckingNewChatWorkspace(false);
    handleCreateNewChat();
  }, [handleCreateNewChat]);

  const handleReviewNewChatWorkspace = useCallback(() => {
    if (!newChatWorkspaceState) return;
    setNewChatSheetOpen(false);
    setCheckingNewChatWorkspace(false);
    setHubTabRequest({
      tab: newChatWorkspaceState.mode === 'scratch' ? 'files' : 'diff',
      requestKey: Date.now(),
    });
    setIsLauncherOpen(false);
    setIsChatsDrawerOpen(false);
    handleWorkspaceHubOpenChange(true);
  }, [handleWorkspaceHubOpenChange, newChatWorkspaceState]);

  const handleStartFreshWorkspaceForNewChat = useCallback(async () => {
    if (resettingWorkspaceForNewChat) return;

    setResettingWorkspaceForNewChat(true);
    try {
      await sandbox.stop();

      let freshSandboxId: string | null = null;
      if (isScratch) {
        freshSandboxId = await sandbox.start('', 'main');
      } else if (activeRepo) {
        freshSandboxId = await sandbox.start(
          activeRepo.full_name,
          activeRepo.current_branch || activeRepo.default_branch,
        );
      }

      if ((isScratch || activeRepo) && !freshSandboxId) {
        toast.error('Failed to start a fresh workspace.');
        return;
      }

      setNewChatSheetOpen(false);
      setNewChatWorkspaceState(null);
      setCheckingNewChatWorkspace(false);
      handleCreateNewChat();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to start a fresh workspace.');
    } finally {
      setResettingWorkspaceForNewChat(false);
    }
  }, [activeRepo, handleCreateNewChat, isScratch, resettingWorkspaceForNewChat, sandbox]);

  const handleExpiryWarningReached = useCallback(async () => {
    if (!sandbox.sandboxId) return;
    try {
      const diff = await fetchSandboxDiff(sandbox.sandboxId);
      saveExpiryCheckpoint(diff);
    } catch {
      saveExpiryCheckpoint('');
    }
  }, [sandbox.sandboxId, saveExpiryCheckpoint]);

  const handleFixReviewFinding = useCallback(async (prompt: string) => {
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
  }, [ensureSandbox, handleWorkspaceHubOpenChange, isStreaming, markSnapshotActivity, sandbox.sandboxId, sendMessage]);

  const handleResumeConversationFromLauncher = useCallback((chatId: string) => {
    const conversation = conversations[chatId];
    if (!conversation?.repoFullName) return;
    const repo = repos.find((candidate) => candidate.full_name === conversation.repoFullName);
    if (!repo) return;
    handleSelectRepoFromDrawer(repo, conversation.branch);
    requestAnimationFrame(() => {
      switchChat(chatId);
    });
  }, [conversations, handleSelectRepoFromDrawer, repos, switchChat]);

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
    newChatSheetOpen,
    newChatWorkspaceState,
    checkingNewChatWorkspace,
    resettingWorkspaceForNewChat,
    hubTabRequest,
    setIsChatsDrawerOpen,
    setIsLauncherOpen,
    handleWorkspaceHubOpenChange,
    openWorkspaceHub,
    openLauncher,
    handleNewChatSheetOpenChange,
    handleCreateNewChatRequest,
    handleContinueCurrentWorkspace,
    handleReviewNewChatWorkspace,
    handleStartFreshWorkspaceForNewChat,
    handleExpiryWarningReached,
    handleFixReviewFinding,
    handleResumeConversationFromLauncher,
    handleStartWorkspaceRequest,
    handleExitWorkspaceRequest,
    handleDisconnectRequest,
  };
}
