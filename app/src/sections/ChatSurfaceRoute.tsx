import { lazy, Suspense, useCallback, useState } from 'react';
import { toast } from 'sonner';
import { Toaster } from '@/components/ui/sonner';
import { usePinnedArtifacts } from '@/hooks/usePinnedArtifacts';
import { useChatModeAppearance } from '@/hooks/useChatModeAppearance';
import { useConnectedCliSessions } from '@/hooks/useConnectedCliSessions';
import { useWorkspaceChatComposerController } from '@/hooks/useWorkspaceChatComposerController';
import { useWorkspaceChatPanelsController } from '@/hooks/useWorkspaceChatPanelsController';
import { getRepoAppearanceColorHex } from '@/lib/repo-appearance';
import { getChatShellNav, resolveNavMode } from '@/lib/nav-transition';
import { ChatSurfaceScreen } from './ChatSurfaceScreen';
import {
  buildRepoChatDrawerProps,
  buildRepoLauncherSheetProps,
  buildSettingsAI,
  buildSettingsAuth,
  buildSettingsData,
  buildSettingsProfile,
  buildSettingsWorkspace,
  buildWorkspaceHubReviewModelOptions,
} from './workspace-chat-route-builders';
import type { DaemonCliSession } from '@/types';
import type { ChatRouteProps } from './workspace-chat-route-types';

const WorkspaceHubSheet = lazy(() =>
  import('@/components/chat/WorkspaceHubSheet').then((module) => ({
    default: module.WorkspaceHubSheet,
  })),
);
const RepoLauncherSheet = lazy(() =>
  import('@/components/launcher/RepoLauncherSheet').then((module) => ({
    default: module.RepoLauncherSheet,
  })),
);

export function ChatSurfaceRoute(props: ChatRouteProps) {
  const {
    activeRepo,
    sandbox,
    messages,
    sendMessage,
    agentStatus,
    agentEvents,
    runEvents,
    isStreaming,
    queuedFollowUpCount,
    pendingSteerCount,
    lockedProvider,
    isProviderLocked,
    lockedModel,
    isModelLocked,
    conversations,
    activeChatId,
    switchChat,
    renameChat,
    setChatLinkedLibraries,
    deleteChat,
    regenerateLastResponse,
    editMessageAndResend,
    handleCardAction,
    contextUsage,
    abortStream,
    interruptedCheckpoint,
    resumeInterruptedRun,
    dismissResume,
    runHostAttach,
    saveExpiryCheckpoint,
    ciStatus,
    diagnoseCIFailure,
    repos,
    reposLoading,
    reposError,
    catalog,
    scratchpad,
    todo,
    protectMain,
    showToolActivity,
    handleStartWorkspace,
    handleStartRelay,
    handleResumeRelaySession,
    handleOpenDraftComposer,
    handleDisconnect,
    selectedChatProvider,
    selectedChatModels,
    handleSelectBackend,
    handleSelectOllamaModelFromChat,
    handleSelectOpenRouterModelFromChat,
    handleSelectZaiModelFromChat,
    handleSelectKimiModelFromChat,
    handleSelectHuggingFaceModelFromChat,
    handleSelectCloudflareModelFromChat,
    handleSelectZenModelFromChat,
    handleSelectNvidiaModelFromChat,
    handleSelectFireworksModelFromChat,
    handleSelectSakanaModelFromChat,
    handleSelectDeepSeekModelFromChat,
    handleSelectAnthropicModelFromChat,
    handleSelectOpenAIModelFromChat,
    handleSelectXAIModelFromChat,
    handleSelectGoogleModelFromChat,
    handleSelectRepoFromDrawer,
    handleResumeChatFromDrawer,
    resolveRepoAppearance,
    setRepoAppearance,
    clearRepoAppearance,
    validatedUser,
    snapshots,
    ensureSandbox,
  } = props;

  const pinnedArtifacts = usePinnedArtifacts(activeRepo?.full_name ?? null);
  const {
    appearance: chatModeAppearance,
    setAppearance: setChatModeAppearance,
    resetAppearance: resetChatModeAppearance,
  } = useChatModeAppearance();
  const chatModeAccentHex = getRepoAppearanceColorHex(chatModeAppearance.color);
  const [workspaceHubMounted, setWorkspaceHubMounted] = useState(false);
  const [launcherSheetMounted, setLauncherSheetMounted] = useState(false);

  const {
    composerPrefillRequest,
    editState,
    handleComposerSend,
    handleEditUserMessage,
    handleRegenerateLastResponse,
    handleCardActionWithSnapshotHeartbeat,
    providerControls,
  } = useWorkspaceChatComposerController({
    messages,
    sendMessage,
    editMessageAndResend,
    regenerateLastResponse,
    handleCardAction,
    catalog,
    selectedChatProvider,
    selectedChatModels,
    handleSelectBackend,
    handleSelectOllamaModelFromChat,
    handleSelectOpenRouterModelFromChat,
    handleSelectZaiModelFromChat,
    handleSelectKimiModelFromChat,
    handleSelectHuggingFaceModelFromChat,
    handleSelectCloudflareModelFromChat,
    handleSelectZenModelFromChat,
    handleSelectNvidiaModelFromChat,
    handleSelectFireworksModelFromChat,
    handleSelectSakanaModelFromChat,
    handleSelectDeepSeekModelFromChat,
    handleSelectAnthropicModelFromChat,
    handleSelectOpenAIModelFromChat,
    handleSelectXAIModelFromChat,
    handleSelectGoogleModelFromChat,
    isProviderLocked,
    lockedProvider,
    lockedModel,
    isModelLocked,
    markSnapshotActivity: snapshots.markSnapshotActivity,
  });

  const {
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
    handleFixReviewFinding,
    handleResumeConversationFromLauncher,
    handleStartWorkspaceRequest,
    handleDisconnectRequest,
  } = useWorkspaceChatPanelsController({
    activeRepo,
    sandbox,
    conversations,
    repos,
    switchChat,
    switchBranchFromUI: props.switchBranchFromUI,
    handleSelectRepoFromDrawer,
    handleOpenDraftComposer,
    handleStartWorkspace,
    handleExitWorkspace: props.handleExitWorkspace,
    handleDisconnect,
    ensureSandbox,
    sendMessage,
    saveExpiryCheckpoint,
    isStreaming,
    isScratch: false,
    isChat: true,
    markSnapshotActivity: snapshots.markSnapshotActivity,
  });

  const handleWorkspaceHubOpenChangeWithMount = useCallback(
    (open: boolean) => {
      if (open) {
        setWorkspaceHubMounted(true);
      }
      handleWorkspaceHubOpenChange(open);
    },
    [handleWorkspaceHubOpenChange],
  );

  const openWorkspaceHubWithMount = useCallback(() => {
    setWorkspaceHubMounted(true);
    openWorkspaceHub();
  }, [openWorkspaceHub]);

  const openLauncherWithMount = useCallback(() => {
    setLauncherSheetMounted(true);
    openLauncher();
  }, [openLauncher]);

  const setLauncherOpenWithMount = useCallback(
    (open: boolean) => {
      if (open) {
        setLauncherSheetMounted(true);
      }
      setIsLauncherOpen(open);
    },
    [setIsLauncherOpen],
  );

  const chatShellNav = getChatShellNav(resolveNavMode(), {
    drawerOpen: isChatsDrawerOpen,
    hubOpen: isWorkspaceHubOpen,
  });
  const chatShellTransform = chatShellNav.transform;
  const chatShellShadow = chatShellNav.shadowClass;
  const chatShellStyle = chatShellNav.style;

  const settingsAuth = buildSettingsAuth(props, handleDisconnectRequest);
  const settingsProfile = buildSettingsProfile(props);
  const settingsAI = buildSettingsAI(props);
  const settingsWorkspace = buildSettingsWorkspace(props);
  const settingsData = buildSettingsData(props);
  const reviewModelOptions = buildWorkspaceHubReviewModelOptions(catalog);
  // Paired remote daemon (CLI/TUI) sessions for the drawer's Connected
  // section — dialed lazily while the drawer is open. See /rc.
  const { sessions: connectedCliSessions, grantSessionAttach } =
    useConnectedCliSessions(isChatsDrawerOpen);
  // Tap-to-resume: grant the session's bearer over the drawer's open
  // connection, then hand off to App's relay entry. A `stale` grant
  // means the user moved on mid-round-trip (closed the drawer /
  // navigated away — the hook's activation was superseded), so a slow
  // grant can't yank them into Remote after the fact (Codex P2 on
  // #1310) and doesn't toast either. On a live failure the drawer
  // stays open (the toast is the only signal; navigating away would
  // hide it).
  const handleResumeConnectedCliSession = useCallback(
    async (session: DaemonCliSession) => {
      if (!handleResumeRelaySession) return;
      const grant = await grantSessionAttach(session.sessionId);
      if (grant.stale) return; // user moved on
      if (grant.token) {
        handleResumeRelaySession(session.sessionId, grant.token);
        return;
      }
      toast.error('Could not reach the daemon to resume this session.');
    },
    [handleResumeRelaySession, grantSessionAttach],
  );
  const drawerProps = buildRepoChatDrawerProps({
    open: isChatsDrawerOpen,
    setOpen: setIsChatsDrawerOpen,
    repos,
    activeRepo,
    conversations,
    activeChatId,
    resolveRepoAppearance,
    setRepoAppearance,
    clearRepoAppearance,
    handleResumeChatFromDrawer,
    handleCreateNewChatRequest,
    deleteChat,
    renameChat,
    cliSessions: connectedCliSessions,
    cliSessionsLabel: 'relay',
    onResumeCliSession: handleResumeRelaySession
      ? (session) => void handleResumeConnectedCliSession(session)
      : undefined,
  });
  const repoLauncherProps = buildRepoLauncherSheetProps({
    open: isLauncherOpen,
    setOpen: setLauncherOpenWithMount,
    repos,
    reposLoading,
    reposError,
    conversations,
    activeRepo,
    resolveRepoAppearance,
    setRepoAppearance,
    clearRepoAppearance,
    handleSelectRepoFromDrawer,
    handleResumeConversationFromLauncher,
    isScratch: false,
    sandboxStatus: sandbox.status,
    sandboxCreatedAt: sandbox.createdAt,
    handleStartWorkspace: handleStartWorkspace ? handleStartWorkspaceRequest : undefined,
    handleStartRelay,
    handleDisconnect: handleDisconnectRequest,
    validatedUser,
    mode: 'chat',
  });

  return (
    <>
      <ChatSurfaceScreen
        chatShellTransform={chatShellTransform}
        chatShellShadow={chatShellShadow}
        chatShellStyle={chatShellStyle}
        onOpenLauncher={openLauncherWithMount}
        onOpenWorkspaceHub={openWorkspaceHubWithMount}
        drawerProps={drawerProps}
        appearance={chatModeAppearance}
        accentHex={chatModeAccentHex}
        onSaveAppearance={setChatModeAppearance}
        onResetAppearance={resetChatModeAppearance}
        containerProps={{
          messages,
          agentStatus,
          activeRepo,
          hasSandbox: false,
          isChat: true,
          onSuggestion: undefined,
          onCardAction: handleCardActionWithSnapshotHeartbeat,
          onPin: pinnedArtifacts.pin,
          interruptedCheckpoint,
          onResumeRun: resumeInterruptedRun,
          onDismissResume: dismissResume,
          runHostAttach,
          ciStatus,
          onDiagnoseCI: diagnoseCIFailure,
          onEditUserMessage: !isStreaming ? handleEditUserMessage : undefined,
          onRegenerateLastResponse: !isStreaming ? handleRegenerateLastResponse : undefined,
        }}
        inputProps={{
          onSend: handleComposerSend,
          onStop: abortStream,
          isStreaming,
          queuedFollowUpCount,
          pendingSteerCount,
          placeholder: 'Message',
          contextUsage,
          libraryEnabled: true,
          linkedLibraryIds:
            (activeChatId && conversations[activeChatId]?.linkedLibraryIds) || undefined,
          onSetLinkedLibraries: activeChatId
            ? (ids) => setChatLinkedLibraries(activeChatId, ids)
            : undefined,
          draftKey: activeChatId,
          prefillRequest: composerPrefillRequest,
          editState,
          providerControls,
        }}
      />

      {workspaceHubMounted && (
        <Suspense fallback={null}>
          <WorkspaceHubSheet
            open={isWorkspaceHubOpen}
            onOpenChange={handleWorkspaceHubOpenChangeWithMount}
            externalTabRequest={hubTabRequest}
            messages={messages}
            agentEvents={agentEvents}
            runEvents={runEvents}
            sandboxId={sandbox.sandboxId}
            sandboxStatus={sandbox.status}
            sandboxError={sandbox.error}
            ensureSandbox={ensureSandbox}
            onStartSandbox={() => {}}
            onRetrySandbox={() => {}}
            onNewSandbox={() => {}}
            reviewProviders={catalog.availableProviders}
            reviewActiveProvider={catalog.activeProviderLabel}
            reviewModelOptions={reviewModelOptions}
            lockedProvider={lockedProvider}
            lockedModel={lockedModel}
            workspaceMode="chat"
            capabilities={{
              canManageBranches: false,
              canBrowsePullRequests: false,
              canCommitAndPush: false,
            }}
            scratchActions={null}
            repoName="Chat"
            projectInstructions={null}
            protectMainEnabled={protectMain.isProtected}
            showToolActivity={showToolActivity}
            settingsAuth={settingsAuth}
            settingsProfile={settingsProfile}
            settingsAI={settingsAI}
            settingsWorkspace={settingsWorkspace}
            settingsData={settingsData}
            scratchpadContent={scratchpad.content}
            scratchpadMemories={scratchpad.memories}
            activeMemoryId={scratchpad.activeMemoryId}
            onScratchpadContentChange={scratchpad.setContent}
            onScratchpadClear={scratchpad.clear}
            onScratchpadSaveMemory={scratchpad.saveMemory}
            onScratchpadLoadMemory={scratchpad.loadMemory}
            onScratchpadDeleteMemory={scratchpad.deleteMemory}
            appearance={chatModeAppearance}
            accentHex={chatModeAccentHex}
            todos={todo.todos}
            onTodoClear={todo.clear}
            branchProps={{
              currentBranch: undefined,
              defaultBranch: undefined,
              availableBranches: [],
              branchesLoading: false,
              branchesError: null,
              onSwitchBranch: () => {},
              onRefreshBranches: () => {},
              onShowBranchCreate: () => {},
              onShowBranchFork: () => {},
              onShowMergeFlow: () => {},
              onDeleteBranch: async () => false,
            }}
            onFixReviewFinding={handleFixReviewFinding}
            pinnedArtifacts={pinnedArtifacts.artifacts}
            onUnpinArtifact={pinnedArtifacts.unpin}
            onUpdateArtifactLabel={pinnedArtifacts.updateLabel}
          />
        </Suspense>
      )}

      {launcherSheetMounted && (
        <Suspense fallback={null}>
          <RepoLauncherSheet {...repoLauncherProps} />
        </Suspense>
      )}

      <Toaster position="bottom-center" />
    </>
  );
}
