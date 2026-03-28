import { lazy, Suspense, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { Toaster } from '@/components/ui/sonner';
import { useChat } from '@/hooks/useChat';
import { useSandbox } from '@/hooks/useSandbox';
import { useScratchpad } from '@/hooks/useScratchpad';
import { useModelCatalog } from '@/hooks/useModelCatalog';
import { useSnapshotManager } from '@/hooks/useSnapshotManager';
import { useBranchManager } from '@/hooks/useBranchManager';
import { useProjectInstructions } from '@/hooks/useProjectInstructions';
import { useWorkspaceComposerState } from '@/hooks/useWorkspaceComposerState';
import { useWorkspacePreferences } from '@/hooks/useWorkspacePreferences';
import { useWorkspaceSandboxController } from '@/hooks/useWorkspaceSandboxController';
import { useWorkspaceSessionBridge } from './useWorkspaceSessionBridge';
import type {
  RepoWithActivity,
  WorkspaceScreenProps,
} from '@/types';

const FileBrowser = lazy(() => import('./FileBrowser').then((module) => ({ default: module.FileBrowser })));
const WorkspaceChatRoute = lazy(() => import('./WorkspaceChatRoute').then((module) => ({ default: module.WorkspaceChatRoute })));

const workspaceRouteFallback = <div className="h-dvh bg-[#000]" />;

export function WorkspaceSessionScreen({
  workspace,
  repoShell,
  auth,
  navigation,
  homeBridge,
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
    onEndWorkspace,
  } = navigation;
  const { pendingResumeChatId, onConversationIndexChange } = homeBridge;

  const isScratch = workspaceSession.kind === 'scratch';
  const workspaceRepo = workspaceSession.kind === 'repo' ? workspaceSession.repo : null;
  const scratchpad = useScratchpad(workspaceRepo?.full_name ?? null);
  const sandbox = useSandbox(
    isScratch ? '' : (workspaceRepo?.full_name ?? null),
    isScratch ? 'main' : (workspaceRepo?.current_branch || workspaceRepo?.default_branch || null),
  );
  const catalog = useModelCatalog();

  const skipBranchTeardownRef = useRef(false);
  const handleSandboxBranchSwitch = useCallback((branch: string) => {
    skipBranchTeardownRef.current = true;
    setCurrentBranch(branch);
  }, [setCurrentBranch]);

  const {
    messages,
    sendMessage,
    agentStatus,
    agentEvents,
    runEvents,
    isStreaming,
    queuedFollowUpCount,
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
        sandbox.rebindSessionRepo(repo.full_name, repo.default_branch);
        setActiveRepo(repo);
        onWorkspaceSessionChange({
          id: workspaceSession.id,
          kind: 'repo',
          repo,
          sandboxId: sandbox.sandboxId,
        });
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
  );

  const { protectMain } = useWorkspaceSessionBridge({
    conversations,
    onConversationIndexChange,
    pendingResumeChatId,
    workspaceSessionId: workspaceSession.id,
    switchChat,
    setIsMainProtected,
    repoFullName: workspaceRepo?.full_name ?? undefined,
  });

  const {
    selectedChatProvider,
    selectedChatModels,
    sendMessageWithChatDraft,
    handleCreateNewChat,
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

  const snapshots = useSnapshotManager(workspaceSession, sandbox, workspaceRepo, isStreaming);
  const branches = useBranchManager(workspaceRepo, workspaceSession);
  const {
    showFileBrowser,
    setShowFileBrowser,
    sandboxState,
    sandboxStateLoading,
    sandboxDownloading,
    fetchSandboxState,
    inspectNewChatWorkspace,
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

  const handleSelectRepoFromDrawer = useCallback((repo: RepoWithActivity, branch?: string) => {
    onSelectRepo(repo, branch);
  }, [onSelectRepo]);

  if (showFileBrowser && sandbox.sandboxId) {
    return (
      <div className="flex h-dvh flex-col bg-[#000] safe-area-top safe-area-bottom">
        <Suspense
          fallback={(
            <div className="flex flex-1 items-center justify-center text-sm text-push-fg-dim">
              Loading workspace files...
            </div>
          )}
        >
          <FileBrowser
            sandboxId={sandbox.sandboxId}
            workspaceLabel={workspaceRepo?.name || 'Workspace'}
            capabilities={fileBrowserCapabilities}
            scratchActions={fileBrowserScratchActions}
            onBack={() => setShowFileBrowser(false)}
            lockedProvider={lockedProvider}
            lockedModel={lockedModel}
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
    sandbox,
    handleStartWorkspace: isScratch ? undefined : onStartScratchWorkspace,
    handleExitWorkspace,
    handleDisconnect: handleDisconnectFromWorkspace,
    handleCreateNewChat,
    inspectNewChatWorkspace,
    handleSandboxRestart,
    handleSandboxDownload,
    sandboxDownloading,
    setCurrentBranch,
    onSandboxBranchSwitch: handleSandboxBranchSwitch,
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
    handleSelectZenModelFromChat,
    handleSelectNvidiaModelFromChat,
    handleSelectBlackboxModelFromChat,
    handleSelectKilocodeModelFromChat,
    handleSelectOpenAdapterModelFromChat,
    handleSelectAzureModelFromChat,
    handleSelectBedrockModelFromChat,
    handleSelectVertexModelFromChat,
  };

  const workspaceDataDomain = { snapshots, instructions, scratchpad, protectMain };

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
  };

  return (
    <Suspense fallback={workspaceRouteFallback}>
      <WorkspaceChatRoute
        key={workspaceSession.id}
        {...workspaceDomain}
        {...conversationDomain}
        {...repositoryDomain}
        {...catalogDomain}
        {...workspaceDataDomain}
        {...authDomain}
        {...uiStateDomain}
        {...profileDomain}
      />
    </Suspense>
  );
}

export default WorkspaceSessionScreen;
