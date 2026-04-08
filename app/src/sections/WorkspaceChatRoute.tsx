import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Toaster } from '@/components/ui/sonner';
import { formatSnapshotAge, isSnapshotStale } from '@/hooks/useSnapshotManager';
import { usePinnedArtifacts } from '@/hooks/usePinnedArtifacts';
import { useWorkspaceChatComposerController } from '@/hooks/useWorkspaceChatComposerController';
import { useWorkspaceChatPanelsController } from '@/hooks/useWorkspaceChatPanelsController';
import { getRepoAppearanceColorHex, hexToRgba } from '@/lib/repo-appearance';
import { executeSandboxToolCall } from '@/lib/sandbox-tools';
import { cleanWorkspacePublishMessage } from '@/lib/workspace-publish';
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

const BranchCreateSheet = lazy(() => import('@/components/chat/BranchCreateSheet').then((module) => ({ default: module.BranchCreateSheet })));
const MergeFlowSheet = lazy(() => import('@/components/chat/MergeFlowSheet').then((module) => ({ default: module.MergeFlowSheet })));
const NewChatWorkspaceSheet = lazy(() => import('@/components/chat/NewChatWorkspaceSheet').then((module) => ({ default: module.NewChatWorkspaceSheet })));
const WorkspaceHubSheet = lazy(() => import('@/components/chat/WorkspaceHubSheet').then((module) => ({ default: module.WorkspaceHubSheet })));
const RepoLauncherSheet = lazy(() => import('@/components/launcher/RepoLauncherSheet').then((module) => ({ default: module.RepoLauncherSheet })));
const SettingsSheet = lazy(() => import('@/components/SettingsSheet').then((module) => ({ default: module.SettingsSheet })));

export function WorkspaceChatRoute(props: ChatRouteProps) {
  const {
    activeRepo,
    workspaceSession,
    resolveRepoAppearance,
    setRepoAppearance,
    clearRepoAppearance,
    handleWorkspacePromotion,
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
    branches,
    catalog,
    snapshots,
    instructions,
    scratchpad,
    protectMain,
    showToolActivity,
    handleStartWorkspace,
    handleStartChat,
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
  const [workspaceHubMounted, setWorkspaceHubMounted] = useState(false);
  const [newChatSheetMounted, setNewChatSheetMounted] = useState(false);
  const [launcherSheetMounted, setLauncherSheetMounted] = useState(false);
  const [branchCreateMounted, setBranchCreateMounted] = useState(false);
  const [mergeFlowMounted, setMergeFlowMounted] = useState(false);
  const [settingsMounted, setSettingsMounted] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const { markSnapshotActivity } = snapshots;

  const sandboxStart = sandbox.start;
  const sandboxStop = sandbox.stop;
  const startCurrentSandbox = useCallback(() => {
    if (isScratch) {
      void sandboxStart('', 'main');
      return;
    }
    if (activeRepo) {
      void sandboxStart(activeRepo.full_name, activeRepo.current_branch || activeRepo.default_branch);
    }
  }, [activeRepo, isScratch, sandboxStart]);

  const restartCurrentSandbox = useCallback(() => {
    if (isScratch) {
      void sandboxStop().then(() => sandboxStart('', 'main'));
      return;
    }
    if (activeRepo) {
      void sandboxStop().then(() => sandboxStart(activeRepo.full_name, activeRepo.current_branch || activeRepo.default_branch));
    }
  }, [activeRepo, isScratch, sandboxStart, sandboxStop]);

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

  const handleWorkspaceHubOpenChangeWithMount = useCallback((open: boolean) => {
    if (open) {
      setWorkspaceHubMounted(true);
    }
    handleWorkspaceHubOpenChange(open);
  }, [handleWorkspaceHubOpenChange]);

  const openWorkspaceHubWithMount = useCallback(() => {
    setWorkspaceHubMounted(true);
    openWorkspaceHub();
  }, [openWorkspaceHub]);

  const openLauncherWithMount = useCallback(() => {
    setLauncherSheetMounted(true);
    openLauncher();
  }, [openLauncher]);

  const setLauncherOpenWithMount = useCallback((open: boolean) => {
    if (open) {
      setLauncherSheetMounted(true);
    }
    setIsLauncherOpen(open);
  }, [setIsLauncherOpen]);

  const handleNewChatSheetOpenChangeWithMount = useCallback((open: boolean) => {
    if (open) {
      setNewChatSheetMounted(true);
    }
    handleNewChatSheetOpenChange(open);
  }, [handleNewChatSheetOpenChange]);

  const handleCreateNewChatRequestWithMount = useCallback(() => {
    setNewChatSheetMounted(true);
    return handleCreateNewChatRequest();
  }, [handleCreateNewChatRequest]);

  const handleReviewNewChatWorkspaceWithMount = useCallback(() => {
    setWorkspaceHubMounted(true);
    handleReviewNewChatWorkspace();
  }, [handleReviewNewChatWorkspace]);

  const setShowBranchCreateWithMount = useCallback((open: boolean) => {
    if (open) {
      setBranchCreateMounted(true);
    }
    setShowBranchCreate(open);
  }, [setShowBranchCreate]);

  const setShowMergeFlowWithMount = useCallback((open: boolean) => {
    if (open) {
      setMergeFlowMounted(true);
    }
    setShowMergeFlow(open);
  }, [setShowMergeFlow]);

  const setShowSettingsWithMount = useCallback((open: boolean) => {
    if (open) {
      setSettingsMounted(true);
    }
    setShowSettings(open);
  }, []);

  const handlePublishToGitHub = useCallback(async (args: {
    repoName: string;
    description?: string;
    isPrivate: boolean;
  }) => {
    if (!isScratch) {
      throw new Error('Workspace publishing is only available from scratch workspaces right now.');
    }
    if (!props.validatedUser) {
      throw new Error('Connect GitHub in Settings before publishing this workspace.');
    }
    if (isStreaming) {
      throw new Error('Wait for the current response to finish before publishing.');
    }

    const sandboxId = sandbox.sandboxId ?? await ensureSandbox();
    if (!sandboxId) {
      throw new Error('Sandbox is not ready yet. Try again in a moment.');
    }

    const result = await executeSandboxToolCall(
      {
        tool: 'promote_to_github',
        args: {
          repo_name: args.repoName,
          description: args.description,
          private: args.isPrivate,
        },
      },
      sandboxId,
    );

    if (!result.promotion?.repo) {
      throw new Error(cleanWorkspacePublishMessage(result.text) || 'Failed to publish workspace to GitHub.');
    }

    const promotedRepo = result.promotion.repo;
    handleWorkspacePromotion(promotedRepo, promotedRepo.default_branch, sandboxId);

    if (result.promotion.warning) {
      toast.warning(`${promotedRepo.full_name} created. ${result.promotion.warning}`);
    } else {
      toast.success(`Published to GitHub: ${promotedRepo.full_name}`);
    }
  }, [
    ensureSandbox,
    handleWorkspacePromotion,
    isScratch,
    isStreaming,
    props.validatedUser,
    sandbox.sandboxId,
  ]);

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
    setShowBranchCreate: setShowBranchCreateWithMount,
    setShowMergeFlow: setShowMergeFlowWithMount,
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
    handleCreateNewChatRequest: handleCreateNewChatRequestWithMount,
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
    isScratch,
    sandboxStatus: sandbox.status,
    sandboxCreatedAt: sandbox.createdAt,
    handleStartWorkspace: handleStartWorkspace ? handleStartWorkspaceRequest : undefined,
    handleStartChat,
    handleDisconnect: handleDisconnectRequest,
    validatedUser: props.validatedUser,
    mode: 'default',
  });
  const chatScreenWorkspace = {
    activeRepo,
    isScratch,
    activeRepoAppearance,
    sandboxStatus: sandbox.status,
    sandboxDownloading,
    onSandboxDownload: handleSandboxDownload,
    instructions,
    snapshots,
    snapshotAgeLabel,
    snapshotIsStale,
  };
  const chatScreenShell = {
    launcherLabel: isScratch ? 'Workspace' : currentBranch,
    hasWorkspaceActivityIndicator: scratchpad.hasContent || agentStatus.active,
    chatShellTransform,
    chatShellShadow,
    onOpenLauncher: openLauncherWithMount,
    onOpenWorkspaceHub: openWorkspaceHubWithMount,
    drawerProps,
  };
  const chatScreenChat = {
    containerProps: {
      messages,
      agentStatus,
      activeRepo,
      hasSandbox: Boolean(isScratch || activeRepo),
      isChat: false,
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
    },
    inputProps: {
      onSend: handleComposerSend,
      onStop: abortStream,
      isStreaming,
      queuedFollowUpCount,
      pendingSteerCount,
      repoName: activeRepo?.name,
      contextUsage,
      draftKey: activeChatId,
      prefillRequest: composerPrefillRequest,
      editState,
      providerControls,
    },
  };
  const chatScreenBanners = {
    sandboxStatusBannerProps: {
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
    },
    sandboxExpiryBannerProps: isScratch ? {
      createdAt: sandbox.createdAt,
      sandboxId: sandbox.sandboxId,
      sandboxStatus: sandbox.status,
      onRestart: handleSandboxRestart,
      onWarningThresholdReached: () => { void handleExpiryWarningReached(); },
    } : null,
  };

  return (
    <>
      <ChatScreen
        workspace={chatScreenWorkspace}
        shell={chatScreenShell}
        chat={chatScreenChat}
        banners={chatScreenBanners}
        onOpenSettings={setShowSettingsWithMount}
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
            onPublishToGitHub={isScratch && props.validatedUser ? handlePublishToGitHub : undefined}
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
        </Suspense>
      )}

      {newChatSheetMounted && (
        <Suspense fallback={null}>
          <NewChatWorkspaceSheet
            open={newChatSheetOpen}
            onOpenChange={handleNewChatSheetOpenChangeWithMount}
            workspace={newChatWorkspaceState}
            checking={checkingNewChatWorkspace}
            resetting={resettingWorkspaceForNewChat}
            onContinueCurrentWorkspace={handleContinueCurrentWorkspace}
            onStartFresh={handleStartFreshWorkspaceForNewChat}
            onReviewChanges={handleReviewNewChatWorkspaceWithMount}
          />
        </Suspense>
      )}

      {launcherSheetMounted && (
        <Suspense fallback={null}>
          <RepoLauncherSheet
            {...repoLauncherProps}
            onPublishToGitHub={isScratch && props.validatedUser ? handlePublishToGitHub : undefined}
          />
        </Suspense>
      )}

      <Toaster position="bottom-center" />

      {activeRepo && branchCreateMounted && (
        <Suspense fallback={null}>
          <BranchCreateSheet
            open={showBranchCreate}
            onOpenChange={setShowBranchCreateWithMount}
            activeRepo={activeRepo}
            setCurrentBranch={setCurrentBranch}
          />
        </Suspense>
      )}

      {activeRepo && mergeFlowMounted && (
        <Suspense fallback={null}>
          <MergeFlowSheet
            open={showMergeFlow}
            onOpenChange={setShowMergeFlowWithMount}
            activeRepo={activeRepo}
            sandboxId={sandbox.sandboxId}
            projectInstructions={instructions.agentsMdContent}
            setCurrentBranch={setCurrentBranch}
            lockedProvider={lockedProvider}
            lockedModel={lockedModel}
          />
        </Suspense>
      )}

      {settingsMounted && (
        <Suspense fallback={null}>
          <SettingsSheet
            open={showSettings}
            onOpenChange={setShowSettingsWithMount}
            auth={settingsAuth}
            profile={settingsProfile}
            workspace={settingsWorkspace}
            ai={settingsAI}
            data={settingsData}
          />
        </Suspense>
      )}
    </>
  );
}
