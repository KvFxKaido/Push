import { useCallback, useEffect } from 'react';
import { BranchCreateSheet } from '@/components/chat/BranchCreateSheet';
import { MergeFlowSheet } from '@/components/chat/MergeFlowSheet';
import { NewChatWorkspaceSheet } from '@/components/chat/NewChatWorkspaceSheet';
import { WorkspaceHubSheet } from '@/components/chat/WorkspaceHubSheet';
import { RepoLauncherSheet } from '@/components/launcher/RepoLauncherSheet';
import { Toaster } from '@/components/ui/sonner';
import { formatSnapshotAge, isSnapshotStale } from '@/hooks/useSnapshotManager';
import { usePinnedArtifacts } from '@/hooks/usePinnedArtifacts';
import { useWorkspaceChatComposerController } from '@/hooks/useWorkspaceChatComposerController';
import { useWorkspaceChatPanelsController } from '@/hooks/useWorkspaceChatPanelsController';
import { getRepoAppearanceColorHex, hexToRgba } from '@/lib/repo-appearance';
import { ChatScreen } from './ChatScreen';
import {
  buildRepoChatDrawerProps,
  buildRepoLauncherSheetProps,
  buildSettingsAI,
  buildSettingsAuth,
  buildSettingsData,
  buildSettingsProfile,
  buildSettingsWorkspace,
  buildWorkspaceHubBranchProps,
  buildWorkspaceHubCapabilities,
  buildWorkspaceHubReviewModelOptions,
  buildWorkspaceHubScratchActions,
} from './workspace-chat-route-builders';
import type { ChatRouteProps } from './workspace-chat-route-types';

export function WorkspaceChatRoute(props: ChatRouteProps) {
  const {
    activeRepo,
    workspaceSession,
    resolveRepoAppearance,
    setRepoAppearance,
    clearRepoAppearance,
    sandbox,
    messages,
    sendMessage,
    agentStatus,
    agentEvents,
    isStreaming,
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
    branches,
    catalog,
    snapshots,
    instructions,
    scratchpad,
    protectMain,
    showToolActivity,
    handleStartWorkspace,
    handleExitWorkspace,
    handleCreateNewChat,
    inspectNewChatWorkspace,
    handleDisconnect,
    handleSandboxRestart,
    handleSandboxDownload,
    sandboxDownloading,
    selectedChatProvider,
    selectedChatModels,
    handleSelectBackend,
    handleSelectOllamaModelFromChat,
    handleSelectOpenRouterModelFromChat,
    handleSelectZenModelFromChat,
    handleSelectNvidiaModelFromChat,
    handleSelectBlackboxModelFromChat,
    handleSelectKilocodeModelFromChat,
    handleSelectOpenAdapterModelFromChat,
    handleSelectAzureModelFromChat,
    handleSelectBedrockModelFromChat,
    handleSelectVertexModelFromChat,
    handleSelectRepoFromDrawer,
    setCurrentBranch,
    onSandboxBranchSwitch,
    ensureSandbox,
  } = props;

  const isScratch = workspaceSession?.kind === 'scratch';
  const activeRepoAppearance = activeRepo && !isScratch
    ? resolveRepoAppearance(activeRepo.full_name)
    : null;
  const activeRepoAccentHex = activeRepoAppearance
    ? getRepoAppearanceColorHex(activeRepoAppearance.color)
    : null;
  const pinnedArtifacts = usePinnedArtifacts(activeRepo?.full_name ?? null);

  useEffect(() => {
    const root = document.documentElement;

    if (!activeRepoAccentHex) {
      root.removeAttribute('data-repo-theme');
      root.style.removeProperty('--repo-theme-accent');
      root.style.removeProperty('--repo-theme-accent-soft');
      root.style.removeProperty('--repo-theme-accent-ultra-soft');
      root.style.removeProperty('--repo-theme-accent-border');
      root.style.removeProperty('--repo-theme-accent-glow');
      return;
    }

    root.setAttribute('data-repo-theme', 'active');
    root.style.setProperty('--repo-theme-accent', activeRepoAccentHex);
    root.style.setProperty('--repo-theme-accent-soft', hexToRgba(activeRepoAccentHex, 0.10));
    root.style.setProperty('--repo-theme-accent-ultra-soft', hexToRgba(activeRepoAccentHex, 0.06));
    root.style.setProperty('--repo-theme-accent-border', hexToRgba(activeRepoAccentHex, 0.38));
    root.style.setProperty('--repo-theme-accent-glow', hexToRgba(activeRepoAccentHex, 0.45));

    return () => {
      root.removeAttribute('data-repo-theme');
      root.style.removeProperty('--repo-theme-accent');
      root.style.removeProperty('--repo-theme-accent-soft');
      root.style.removeProperty('--repo-theme-accent-ultra-soft');
      root.style.removeProperty('--repo-theme-accent-border');
      root.style.removeProperty('--repo-theme-accent-glow');
    };
  }, [activeRepoAccentHex]);

  const {
    currentBranch,
    displayBranches,
    repoBranchesLoading,
    repoBranchesError,
    showBranchCreate,
    setShowBranchCreate,
    showMergeFlow,
    setShowMergeFlow,
    loadRepoBranches,
    handleDeleteBranch,
  } = branches;

  const { markSnapshotActivity } = snapshots;

  const startCurrentSandbox = useCallback(() => {
    if (isScratch) {
      void sandbox.start('', 'main');
      return;
    }
    if (activeRepo) {
      void sandbox.start(activeRepo.full_name, activeRepo.current_branch || activeRepo.default_branch);
    }
  }, [activeRepo, isScratch, sandbox]);

  const restartCurrentSandbox = useCallback(() => {
    if (isScratch) {
      void sandbox.stop().then(() => sandbox.start('', 'main'));
      return;
    }
    if (activeRepo) {
      void sandbox.stop().then(() => sandbox.start(activeRepo.full_name, activeRepo.current_branch || activeRepo.default_branch));
    }
  }, [activeRepo, isScratch, sandbox]);

  const {
    composerPrefillRequest,
    editState,
    handleComposerSend,
    handleQuickPrompt,
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
    markSnapshotActivity,
  });

  const {
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
  } = useWorkspaceChatPanelsController({
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
  });

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

  const snapshotAgeLabel = snapshots.latestSnapshot ? formatSnapshotAge(snapshots.latestSnapshot.createdAt) : null;
  const snapshotIsStale = snapshots.latestSnapshot
    ? isSnapshotStale(snapshots.latestSnapshot.createdAt)
    : false;

  const settingsAuth = buildSettingsAuth(props, handleDisconnectRequest);
  const settingsProfile = buildSettingsProfile(props);
  const settingsAI = buildSettingsAI(props);
  const settingsWorkspace = buildSettingsWorkspace(props);
  const settingsData = buildSettingsData(props);
  const workspaceHubCapabilities = buildWorkspaceHubCapabilities(isScratch, activeRepo);
  const workspaceHubScratchActions = buildWorkspaceHubScratchActions({
    isScratch,
    snapshots,
    sandboxStatus: sandbox.status,
    sandboxDownloading,
    onDownloadWorkspace: () => {
      void handleSandboxDownload();
    },
  });
  const reviewModelOptions = buildWorkspaceHubReviewModelOptions(catalog);
  const branchProps = buildWorkspaceHubBranchProps({
    activeRepo,
    displayBranches,
    repoBranchesLoading,
    loadRepoBranches,
    setCurrentBranch,
    setShowBranchCreate,
    setShowMergeFlow,
    handleDeleteBranch,
  });
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
    handleCreateNewChatRequest,
    deleteChat,
    renameChat,
    currentBranch: activeRepo?.current_branch || activeRepo?.default_branch,
    defaultBranch: activeRepo?.default_branch,
    setCurrentBranch,
    displayBranches,
    repoBranchesLoading,
    repoBranchesError,
    loadRepoBranches,
    handleDeleteBranch,
  });
  const repoLauncherProps = buildRepoLauncherSheetProps({
    open: isLauncherOpen,
    setOpen: setIsLauncherOpen,
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
    isScratch,
    sandboxStatus: sandbox.status,
    sandboxCreatedAt: sandbox.createdAt,
    handleStartWorkspace: handleStartWorkspace ? handleStartWorkspaceRequest : undefined,
  });

  return (
    <>
      <ChatScreen
        activeRepo={activeRepo}
        isScratch={isScratch}
        activeRepoAppearance={activeRepoAppearance}
        launcherLabel={isScratch ? 'Workspace' : currentBranch}
        hasWorkspaceActivityIndicator={scratchpad.hasContent || agentStatus.active}
        chatShellTransform={chatShellTransform}
        chatShellShadow={chatShellShadow}
        sandboxStatus={sandbox.status}
        sandboxDownloading={sandboxDownloading}
        onSandboxDownload={handleSandboxDownload}
        onOpenLauncher={openLauncher}
        onOpenWorkspaceHub={openWorkspaceHub}
        drawerProps={drawerProps}
        chatContainerProps={{
          messages,
          agentStatus,
          activeRepo,
          hasSandbox: Boolean(isScratch || activeRepo),
          onSuggestion: handleQuickPrompt,
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
        chatInputProps={{
          onSend: handleComposerSend,
          onStop: abortStream,
          isStreaming,
          repoName: activeRepo?.name,
          contextUsage,
          draftKey: activeChatId,
          prefillRequest: composerPrefillRequest,
          editState,
          providerControls,
        }}
        instructions={instructions}
        snapshots={snapshots}
        snapshotAgeLabel={snapshotAgeLabel}
        snapshotIsStale={snapshotIsStale}
        sandboxStatusBannerProps={{
          status: sandbox.status,
          error: sandbox.error,
          hasMessages: messages.length > 0,
          isStreaming,
          sandboxId: sandbox.sandboxId,
          isInScratchWorkspace: Boolean(isScratch),
          onStart: startCurrentSandbox,
          onRetry: () => { void sandbox.refresh(); },
          onNewSandbox: restartCurrentSandbox,
          onExitWorkspace: handleExitWorkspaceRequest,
        }}
        sandboxExpiryBannerProps={isScratch ? {
          createdAt: sandbox.createdAt,
          sandboxId: sandbox.sandboxId,
          sandboxStatus: sandbox.status,
          onRestart: handleSandboxRestart,
          onWarningThresholdReached: () => { void handleExpiryWarningReached(); },
        } : null}
      />

      <WorkspaceHubSheet
        open={isWorkspaceHubOpen}
        onOpenChange={handleWorkspaceHubOpenChange}
        externalTabRequest={hubTabRequest}
        messages={messages}
        agentEvents={agentEvents}
        sandboxId={sandbox.sandboxId}
        sandboxStatus={sandbox.status}
        sandboxError={sandbox.error}
        ensureSandbox={ensureSandbox}
        onStartSandbox={startCurrentSandbox}
        onRetrySandbox={() => { void sandbox.refresh(); }}
        onNewSandbox={restartCurrentSandbox}
        reviewProviders={catalog.availableProviders}
        reviewActiveProvider={catalog.activeProviderLabel}
        reviewModelOptions={reviewModelOptions}
        lockedProvider={lockedProvider}
        lockedModel={lockedModel}
        workspaceMode={isScratch ? 'scratch' : 'repo'}
        capabilities={workspaceHubCapabilities}
        scratchActions={workspaceHubScratchActions}
        repoName={activeRepo?.name || (isScratch ? 'Workspace' : undefined)}
        repoFullName={activeRepo?.full_name}
        projectInstructions={instructions.agentsMdContent}
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
        branchProps={branchProps}
        onSandboxBranchSwitch={onSandboxBranchSwitch}
        onFixReviewFinding={handleFixReviewFinding}
        pinnedArtifacts={pinnedArtifacts.artifacts}
        onUnpinArtifact={pinnedArtifacts.unpin}
        onUpdateArtifactLabel={pinnedArtifacts.updateLabel}
      />

      <NewChatWorkspaceSheet
        open={newChatSheetOpen}
        onOpenChange={handleNewChatSheetOpenChange}
        workspace={newChatWorkspaceState}
        checking={checkingNewChatWorkspace}
        resetting={resettingWorkspaceForNewChat}
        onContinueCurrentWorkspace={handleContinueCurrentWorkspace}
        onStartFresh={handleStartFreshWorkspaceForNewChat}
        onReviewChanges={handleReviewNewChatWorkspace}
      />

      <RepoLauncherSheet
        {...repoLauncherProps}
      />

      <Toaster position="bottom-center" />

      {activeRepo && (
        <BranchCreateSheet
          open={showBranchCreate}
          onOpenChange={setShowBranchCreate}
          activeRepo={activeRepo}
          setCurrentBranch={setCurrentBranch}
        />
      )}

      {activeRepo && (
        <MergeFlowSheet
          open={showMergeFlow}
          onOpenChange={setShowMergeFlow}
          activeRepo={activeRepo}
          sandboxId={sandbox.sandboxId}
          projectInstructions={instructions.agentsMdContent}
          setCurrentBranch={setCurrentBranch}
          lockedProvider={lockedProvider}
          lockedModel={lockedModel}
        />
      )}
    </>
  );
}
