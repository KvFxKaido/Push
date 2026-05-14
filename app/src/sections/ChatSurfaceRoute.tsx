import { lazy, Suspense, useCallback, useState } from 'react';
import { Toaster } from '@/components/ui/sonner';
import { usePinnedArtifacts } from '@/hooks/usePinnedArtifacts';
import { useWorkspaceChatComposerController } from '@/hooks/useWorkspaceChatComposerController';
import { useWorkspaceChatPanelsController } from '@/hooks/useWorkspaceChatPanelsController';
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
    deleteChat,
    regenerateLastResponse,
    editMessageAndResend,
    handleCardAction,
    contextUsage,
    abortStream,
    interruptedCheckpoint,
    resumeInterruptedRun,
    dismissResume,
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
    handleStartLocalPc,
    handleStartRelay,
    handleCreateNewChat,
    handleDisconnect,
    selectedChatProvider,
    selectedChatModels,
    handleSelectBackend,
    handleSelectOllamaModelFromChat,
    handleSelectOpenRouterModelFromChat,
    handleSelectCloudflareModelFromChat,
    handleSelectZenModelFromChat,
    handleSelectNvidiaModelFromChat,
    handleSelectBlackboxModelFromChat,
    handleSelectKilocodeModelFromChat,
    handleSelectOpenAdapterModelFromChat,
    handleSelectAzureModelFromChat,
    handleSelectBedrockModelFromChat,
    handleSelectVertexModelFromChat,
    handleSelectRepoFromDrawer,
    resolveRepoAppearance,
    setRepoAppearance,
    clearRepoAppearance,
    validatedUser,
    snapshots,
    ensureSandbox,
    setCurrentBranch,
  } = props;

  const pinnedArtifacts = usePinnedArtifacts(activeRepo?.full_name ?? null);
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
    handleSelectCloudflareModelFromChat,
    handleSelectZenModelFromChat,
    handleSelectNvidiaModelFromChat,
    handleSelectBlackboxModelFromChat,
    handleSelectKilocodeModelFromChat,
    handleSelectOpenAdapterModelFromChat,
    handleSelectAzureModelFromChat,
    handleSelectBedrockModelFromChat,
    handleSelectVertexModelFromChat,
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
    handleSelectRepoFromDrawer,
    handleCreateNewChat,
    inspectNewChatWorkspace: props.inspectNewChatWorkspace,
    handleStartWorkspace,
    handleExitWorkspace: props.handleExitWorkspace,
    handleDisconnect,
    ensureSandbox,
    sendMessage,
    saveExpiryCheckpoint,
    isStreaming,
    isScratch: false,
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

  const chatsDrawerOffset = 'min(86vw, 24rem)';
  const workspaceHubOffset = '94vw';
  const chatShellTransform = isChatsDrawerOpen
    ? `translateX(${chatsDrawerOffset})`
    : isWorkspaceHubOpen
      ? `translateX(-${workspaceHubOffset})`
      : 'translateX(0px)';
  const chatShellShadow = isChatsDrawerOpen
    ? 'shadow-[-24px_0_56px_rgba(0,0,0,0.42)]'
    : isWorkspaceHubOpen
      ? 'shadow-[24px_0_56px_rgba(0,0,0,0.42)]'
      : '';

  const settingsAuth = buildSettingsAuth(props, handleDisconnectRequest);
  const settingsProfile = buildSettingsProfile(props);
  const settingsAI = buildSettingsAI(props);
  const settingsWorkspace = buildSettingsWorkspace(props);
  const settingsData = buildSettingsData(props);
  const reviewModelOptions = buildWorkspaceHubReviewModelOptions(catalog);
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
    handleSelectRepoFromDrawer,
    switchChat,
    handleCreateNewChatRequest: handleCreateNewChat,
    deleteChat,
    renameChat,
    currentBranch: undefined,
    defaultBranch: undefined,
    setCurrentBranch,
    displayBranches: [],
    repoBranchesLoading: false,
    repoBranchesError: null,
    loadRepoBranches: () => {},
    handleDeleteBranch: async () => false,
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
    handleStartLocalPc,
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
        onOpenLauncher={openLauncherWithMount}
        onOpenWorkspaceHub={openWorkspaceHubWithMount}
        drawerProps={drawerProps}
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
            todos={todo.todos}
            onTodoClear={todo.clear}
            branchProps={{
              currentBranch: undefined,
              defaultBranch: undefined,
              availableBranches: [],
              branchesLoading: false,
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
