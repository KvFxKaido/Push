import { lazy, Suspense, useCallback, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { Toaster } from '@/components/ui/sonner';
import { useChat } from '@/hooks/useChat';
import { conversationBelongsToWorkspace } from '@/hooks/chat-management';
import { useSandbox } from '@/hooks/useSandbox';
import { useScratchpad } from '@/hooks/useScratchpad';
import { useTodo } from '@/hooks/useTodo';
import { useSnapshotManager } from '@/hooks/useSnapshotManager';
import { useBranchManager } from '@/hooks/useBranchManager';
import { useProjectInstructions } from '@/hooks/useProjectInstructions';
import { useWorkspaceComposerState } from '@/hooks/useWorkspaceComposerState';
import { useWorkspacePreferences } from '@/hooks/useWorkspacePreferences';
import { useWorkspaceSandboxController } from '@/hooks/useWorkspaceSandboxController';
import { perfMark } from '@/lib/perf-marks';
import { useWorkspaceSessionBridge } from './useWorkspaceSessionBridge';
import { getDefaultMemoryStore } from '@/lib/context-memory-store';
import type { ActiveRepo, RepoWithActivity, WorkspaceScreenProps } from '@/types';

const FileBrowser = lazy(() =>
  import('./FileBrowser').then((module) => ({ default: module.FileBrowser })),
);
const ChatSurfaceRoute = lazy(() =>
  import('./ChatSurfaceRoute').then((module) => ({ default: module.ChatSurfaceRoute })),
);
const WorkspaceChatRoute = lazy(() =>
  import('./WorkspaceChatRoute').then((module) => ({ default: module.WorkspaceChatRoute })),
);

const workspaceRouteFallback = <div className="h-dvh bg-[#000]" />;

export function WorkspaceSessionScreen({
  workspace,
  repoShell,
  auth,
  navigation,
  homeBridge,
  catalog,
}: WorkspaceScreenProps) {
  const { workspaceSession, onWorkspaceSessionChange } = workspace;
  const {
    setActiveRepo,
    setCurrentBranch,
    repos,
    reposLoading,
    reposError,
    resolveRepoAppearance,
    setRepoAppearance,
    clearRepoAppearance,
  } = repoShell;
  const {
    token,
    patToken,
    validatedUser,
    isAppAuth,
    installationId,
    appLoading,
    appError,
    connectApp,
    installApp,
    setInstallationIdManually,
  } = auth;
  const {
    onDisconnect,
    onSelectRepo,
    onStartScratchWorkspace,
    onStartChat,
    onStartLocalPc,
    onStartRelay,
    onEndWorkspace,
    onOpenDraftComposer,
  } = navigation;
  const {
    pendingResumeChatId,
    onConversationIndexChange,
    pendingNewChat,
    onPendingNewChatConsumed,
  } = homeBridge;

  const isScratch = workspaceSession.kind === 'scratch';
  const isChat = workspaceSession.kind === 'chat';
  const workspaceRepo = workspaceSession.kind === 'repo' ? workspaceSession.repo : null;
  const scratchpad = useScratchpad(workspaceRepo?.full_name ?? null);
  const todo = useTodo(workspaceRepo?.full_name ?? null);
  const sandbox = useSandbox(
    isChat ? null : isScratch ? '' : (workspaceRepo?.full_name ?? null),
    isChat
      ? null
      : isScratch
        ? 'main'
        : workspaceRepo?.current_branch || workspaceRepo?.default_branch || null,
  );

  const handleWorkspacePromotion = useCallback(
    (repo: ActiveRepo, branch?: string, sandboxIdOverride?: string | null) => {
      const promotedRepo =
        branch && branch !== repo.default_branch ? { ...repo, current_branch: branch } : repo;

      sandbox.rebindSessionRepo(repo.full_name, branch ?? repo.default_branch);
      setActiveRepo(promotedRepo);
      onWorkspaceSessionChange({
        id: workspaceSession.id,
        kind: 'repo',
        repo: promotedRepo,
        sandboxId: sandboxIdOverride ?? sandbox.sandboxId,
      });
    },
    [onWorkspaceSessionChange, sandbox, setActiveRepo, workspaceSession.id],
  );

  const skipBranchTeardownRef = useRef(false);
  const handleSandboxBranchSwitch = useCallback(
    (branch: string) => {
      skipBranchTeardownRef.current = true;
      setCurrentBranch(branch);
    },
    [setCurrentBranch],
  );

  const {
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
    createNewChat,
    deleteChat,
    deleteAllChats,
    regenerateLastResponse,
    editMessageAndResend,
    setWorkspaceContext,
    setWorkspaceMode,
    setSandboxId,
    setWorkspaceSessionId,
    setEnsureSandbox,
    setAgentsMd,
    setInstructionFilename,
    handleCardAction,
    contextUsage,
    abortStream,
    setIsMainProtected,
    interruptedCheckpoint,
    resumeInterruptedRun,
    dismissResume,
    saveExpiryCheckpoint,
    ciStatus,
    diagnoseCIFailure,
    forkBranchFromUI,
    mergeBranchInUI,
    replayOnFreshSandbox,
  } = useChat(
    workspaceRepo?.full_name ?? null,
    {
      content: scratchpad.content,
      replace: scratchpad.replace,
      append: scratchpad.append,
    },
    undefined,
    {
      bindSandboxSessionToRepo: (repoFullName, branch) => {
        sandbox.rebindSessionRepo(repoFullName, branch);
      },
      onSandboxPromoted: (repo) => {
        handleWorkspacePromotion(repo, repo.default_branch);
        toast.success(`Promoted to GitHub: ${repo.full_name}`);
      },
      onBranchSwitch: handleSandboxBranchSwitch,
      onSandboxUnreachable: (reason) => {
        sandbox.markUnreachable(reason);
      },
    },
    {
      currentBranch: workspaceRepo?.current_branch || workspaceRepo?.default_branch,
      defaultBranch: workspaceRepo?.default_branch,
    },
    {
      todos: todo.todos,
      replace: todo.replace,
      clear: todo.clear,
    },
  );

  // Synchronously set workspace mode so createNewChat tags conversations correctly
  // during workspace transitions (before the async useProjectInstructions effect fires).
  setWorkspaceMode(
    workspaceSession.kind === 'chat'
      ? 'chat'
      : workspaceSession.kind === 'scratch'
        ? 'scratch'
        : 'repo',
  );

  useEffect(() => {
    perfMark(workspaceSession.kind === 'chat' ? 'surface:chat' : 'surface:workspace');
  }, [workspaceSession.id, workspaceSession.kind]);

  // Workspace-patch replay (persist-diffs PR 3). Two signals must
  // align before replay fires:
  //
  //  1. `creating → ready` status transition. Snapshot restore takes
  //     the `reconnecting → ready` path and brings the working tree
  //     back as-is; replay would double-apply.
  //
  //  2. The sandbox id must also have *changed* since the last replay.
  //     `useSandbox.refresh()` re-enters `creating` as a transient
  //     "checking" state on the *same* container (see useSandbox.ts:532)
  //     — a non-silent refresh on a live container would otherwise
  //     trigger replay against the already-applied working tree and
  //     drag the card to `applied('already-applied')` prematurely,
  //     leaving nothing to replay when a *real* new container later
  //     replaces this one.
  const prevSandboxStatusRef = useRef(sandbox.status);
  const lastReplayedSandboxIdRef = useRef<string | null>(null);
  useEffect(() => {
    const prevStatus = prevSandboxStatusRef.current;
    const currStatus = sandbox.status;
    prevSandboxStatusRef.current = currStatus;
    if (prevStatus !== 'creating' || currStatus !== 'ready') return;
    if (!sandbox.sandboxId) return;
    if (sandbox.sandboxId === lastReplayedSandboxIdRef.current) return;
    lastReplayedSandboxIdRef.current = sandbox.sandboxId;
    void replayOnFreshSandbox(sandbox.sandboxId, activeChatId, conversations);
  }, [sandbox.status, sandbox.sandboxId, replayOnFreshSandbox, activeChatId, conversations]);

  useEffect(() => {
    if (pendingResumeChatId) return;

    const activeConversation = conversations[activeChatId];
    const workspaceMode =
      workspaceSession.kind === 'chat'
        ? 'chat'
        : workspaceSession.kind === 'scratch'
          ? 'scratch'
          : 'repo';
    const repoFullName = workspaceRepo?.full_name ?? null;

    if (
      activeConversation &&
      conversationBelongsToWorkspace(activeConversation, repoFullName, workspaceMode)
    ) {
      return;
    }

    const matchingConversations = Object.values(conversations)
      .filter((conversation) =>
        conversationBelongsToWorkspace(conversation, repoFullName, workspaceMode),
      )
      .sort((a, b) => b.lastMessageAt - a.lastMessageAt);

    if (matchingConversations.length > 0) {
      switchChat(matchingConversations[0].id);
      return;
    }

    createNewChat();
  }, [
    activeChatId,
    conversations,
    createNewChat,
    pendingResumeChatId,
    switchChat,
    workspaceRepo?.full_name,
    workspaceSession.kind,
  ]);

  const { protectMain } = useWorkspaceSessionBridge({
    conversations,
    onConversationIndexChange,
    pendingResumeChatId,
    workspaceSessionId: workspaceSession.id,
    switchChat,
    setIsMainProtected,
    repoFullName: workspaceRepo?.full_name ?? undefined,
  });

  const clearMemoryByRepo = useCallback(() => {
    if (!workspaceRepo?.full_name) return;
    void Promise.resolve(getDefaultMemoryStore().clearByRepo(workspaceRepo.full_name)).catch(
      (e: unknown) => console.warn('[Settings] Failed to clear memory by repo', e),
    );
  }, [workspaceRepo]);

  const clearMemoryByBranch = useCallback(() => {
    if (!workspaceRepo?.full_name || !workspaceRepo.current_branch) return;
    void Promise.resolve(
      getDefaultMemoryStore().clearByBranch(workspaceRepo.full_name, workspaceRepo.current_branch),
    ).catch((e: unknown) => console.warn('[Settings] Failed to clear memory by branch', e));
  }, [workspaceRepo]);
  const {
    selectedChatProvider,
    selectedChatModels,
    sendMessageWithChatDraft,
    handleCreateNewChat,
    upsertChatDraft,
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
    handleSelectAnthropicModelFromChat,
    handleSelectOpenAIModelFromChat,
    handleSelectGoogleModelFromChat,
  } = useWorkspaceComposerState({
    catalog,
    conversations,
    activeChatId,
    isProviderLocked,
    isModelLocked,
    createNewChat,
    switchChat,
    sendMessage,
  });

  // Drain `pendingNewChat` set by the pre-flight menu on confirm.
  // Cross-context commits already mint via the chat-management auto-
  // create effect because the workspace remounts and the existing
  // chats don't match the new context. Same-context commits keep the
  // session, so without this drain the user would stay on whatever
  // chat they were on. When the menu picked a provider/model
  // override, we apply it to the target chat's draft so the first
  // send anchors the chat there — the catalog-wide default is left
  // alone.
  const drainedNewChatKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!pendingNewChat) return;
    if (drainedNewChatKeyRef.current === pendingNewChat.key) return;
    const activeConv = conversations[activeChatId];
    if (!activeConv) return; // wait for chat-management auto-create to settle
    drainedNewChatKeyRef.current = pendingNewChat.key;
    // Mint a fresh chat if the active one already has history, then
    // hold the draft override for the new id. Otherwise the active
    // chat is empty already (cross-context auto-create or user
    // confirmed in a fresh workspace), so we apply the override to
    // it directly.
    const targetChatId = activeConv.messages.length > 0 ? createNewChat() : activeChatId;
    if (pendingNewChat.provider) {
      const provider = pendingNewChat.provider;
      upsertChatDraft(targetChatId, {
        provider,
        models: pendingNewChat.model ? { [provider]: pendingNewChat.model } : undefined,
      });
    }
    onPendingNewChatConsumed();
  }, [
    activeChatId,
    conversations,
    createNewChat,
    onPendingNewChatConsumed,
    pendingNewChat,
    upsertChatDraft,
  ]);

  const snapshots = useSnapshotManager(workspaceSession, sandbox, workspaceRepo, isStreaming);
  const branches = useBranchManager(workspaceRepo, workspaceSession);
  const {
    showFileBrowser,
    setShowFileBrowser,
    sandboxState,
    sandboxStateLoading,
    sandboxDownloading,
    fetchSandboxState,
    ensureSandbox,
    handleSandboxRestart,
    handleSandboxDownload,
    fileBrowserCapabilities,
    fileBrowserScratchActions,
    handleExitWorkspace,
    handleDisconnectFromWorkspace,
  } = useWorkspaceSandboxController({
    workspaceSession,
    workspaceRepo,
    isScratch,
    sandbox,
    snapshots,
    isStreaming,
    abortStream,
    createNewChat,
    onWorkspaceSessionChange,
    onEndWorkspace,
    onDisconnect,
    setEnsureSandbox,
    setSandboxId,
    setWorkspaceSessionId,
    skipBranchTeardownRef,
  });

  const instructions = useProjectInstructions(
    workspaceRepo,
    repos,
    workspaceSession,
    sandbox,
    setAgentsMd,
    setInstructionFilename,
    setWorkspaceContext,
    sendMessageWithChatDraft,
    isStreaming,
    setShowFileBrowser,
    snapshots.markSnapshotActivity,
  );

  const {
    profile,
    updateProfile,
    clearProfile,
    displayNameDraft,
    setDisplayNameDraft,
    handleDisplayNameBlur,
    bioDraft,
    setBioDraft,
    handleBioBlur,
    chatInstructionsDraft,
    setChatInstructionsDraft,
    handleChatInstructionsBlur,
    installIdInput,
    setInstallIdInput,
    showInstallIdInput,
    setShowInstallIdInput,
    showToolActivity,
    updateShowToolActivity,
    sandboxStartMode,
    updateSandboxStartMode,
    contextMode,
    updateContextMode,
    approvalMode,
    updateApprovalMode,
    allowlistSecretCmd,
    copyAllowlistCommand,
  } = useWorkspacePreferences(validatedUser?.login);

  const handleSelectRepoFromDrawer = useCallback(
    (repo: RepoWithActivity, branch?: string) => {
      onSelectRepo(repo, branch);
    },
    [onSelectRepo],
  );

  const handleCommitSandboxExpired = useCallback(async (): Promise<string | null> => {
    if (!workspaceRepo?.full_name) return null;
    const branch = workspaceRepo.current_branch || workspaceRepo.default_branch || 'main';
    await sandbox.stop();
    return sandbox.start(workspaceRepo.full_name, branch);
  }, [sandbox, workspaceRepo]);

  if (showFileBrowser && sandbox.sandboxId) {
    return (
      <div className="flex h-dvh flex-col bg-[#000] safe-area-top safe-area-bottom">
        <Suspense
          fallback={
            <div className="flex flex-1 items-center justify-center text-sm text-push-fg-dim">
              Loading workspace files...
            </div>
          }
        >
          <FileBrowser
            sandboxId={sandbox.sandboxId}
            workspaceLabel={workspaceRepo?.name || 'Workspace'}
            capabilities={fileBrowserCapabilities}
            scratchActions={fileBrowserScratchActions}
            onBack={() => setShowFileBrowser(false)}
            lockedProvider={lockedProvider}
            lockedModel={lockedModel}
            onSandboxExpired={handleCommitSandboxExpired}
          />
        </Suspense>
        <Toaster position="bottom-center" />
      </div>
    );
  }

  // Assemble route domains — each group maps to a ChatRoute*Props interface
  const workspaceDomain = {
    activeRepo: workspaceRepo,
    workspaceSession,
    resolveRepoAppearance,
    setRepoAppearance,
    clearRepoAppearance,
    handleWorkspacePromotion,
    sandbox,
    handleStartWorkspace: onStartScratchWorkspace,
    handleStartChat: onStartChat,
    handleStartLocalPc: onStartLocalPc,
    handleStartRelay: onStartRelay,
    handleExitWorkspace,
    handleDisconnect: handleDisconnectFromWorkspace,
    handleCreateNewChat,
    handleOpenDraftComposer: onOpenDraftComposer,
    handleSandboxRestart,
    handleSandboxDownload,
    sandboxDownloading,
    setCurrentBranch,
    sandboxState,
    sandboxStateLoading,
    fetchSandboxState,
    ensureSandbox,
  };

  const conversationDomain = {
    messages,
    sendMessage: sendMessageWithChatDraft,
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
    deleteAllChats,
    clearMemoryByRepo,
    clearMemoryByBranch,
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
    forkBranchFromUI,
    mergeBranchInUI,
  };

  const repositoryDomain = {
    repos,
    reposLoading,
    reposError,
    branches,
    handleSelectRepoFromDrawer,
  };

  const catalogDomain = {
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
    handleSelectAnthropicModelFromChat,
    handleSelectOpenAIModelFromChat,
    handleSelectGoogleModelFromChat,
  };

  const workspaceDataDomain = { snapshots, instructions, scratchpad, todo, protectMain };

  const authDomain = {
    token,
    patToken,
    isAppAuth,
    installationId,
    validatedUser,
    appLoading,
    appError,
    connectApp,
    installApp,
    setInstallationIdManually,
  };

  const uiStateDomain = {
    showToolActivity,
    approvalMode,
    updateApprovalMode,
    contextMode,
    updateContextMode,
    sandboxStartMode,
    updateSandboxStartMode,
    updateShowToolActivity,
    showInstallIdInput,
    setShowInstallIdInput,
    installIdInput,
    setInstallIdInput,
    allowlistSecretCmd,
    copyAllowlistCommand,
  };

  const profileDomain = {
    profile,
    updateProfile,
    clearProfile,
    displayNameDraft,
    setDisplayNameDraft,
    handleDisplayNameBlur,
    bioDraft,
    setBioDraft,
    handleBioBlur,
    chatInstructionsDraft,
    setChatInstructionsDraft,
    handleChatInstructionsBlur,
  };

  const routeProps = {
    ...workspaceDomain,
    ...conversationDomain,
    ...repositoryDomain,
    ...catalogDomain,
    ...workspaceDataDomain,
    ...authDomain,
    ...uiStateDomain,
    ...profileDomain,
  };

  return (
    <Suspense fallback={workspaceRouteFallback}>
      {workspaceSession.kind === 'chat' ? (
        <ChatSurfaceRoute key={workspaceSession.id} {...routeProps} />
      ) : (
        <WorkspaceChatRoute key={workspaceSession.id} {...routeProps} />
      )}
    </Suspense>
  );
}

export default WorkspaceSessionScreen;
