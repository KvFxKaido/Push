import { useCallback, useEffect, useState } from 'react';
import { Loader2, Download, Save, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { LauncherGridIcon, WorkspaceDockIcon } from '@/components/icons/push-custom-icons';
import { RepoAppearanceBadge } from '@/components/repo/repo-appearance';
import { Toaster } from '@/components/ui/sonner';
import { ChatContainer } from '@/components/chat/ChatContainer';
import { ChatInput } from '@/components/chat/ChatInput';
import { RepoChatDrawer } from '@/components/chat/RepoChatDrawer';
import { WorkspaceHubSheet } from '@/components/chat/WorkspaceHubSheet';
import { SandboxExpiryBanner } from '@/components/chat/SandboxExpiryBanner';
import { SandboxStatusBanner } from '@/components/chat/SandboxStatusBanner';
import { NewChatWorkspaceSheet } from '@/components/chat/NewChatWorkspaceSheet';
import { BranchCreateSheet } from '@/components/chat/BranchCreateSheet';
import { MergeFlowSheet } from '@/components/chat/MergeFlowSheet';
import { RepoLauncherSheet } from '@/components/launcher/RepoLauncherSheet';
import {
  HUB_MATERIAL_PILL_BUTTON_CLASS,
  HUB_PANEL_SUBTLE_SURFACE_CLASS,
  HubControlGlow,
} from '@/components/chat/hub-styles';
import type { PreferredProvider } from '@/lib/providers';
import { getRepoAppearanceColorHex, hexToRgba, type RepoAppearance } from '@/lib/repo-appearance';
import type { SandboxStatus } from '@/hooks/useSandbox';
import { formatSnapshotAge, isSnapshotStale, snapshotStagePercent } from '@/hooks/useSnapshotManager';
import type { ModelCatalog } from '@/hooks/useModelCatalog';
import type { SnapshotManager } from '@/hooks/useSnapshotManager';
import type { BranchManager } from '@/hooks/useBranchManager';
import type { ProjectInstructionsManager } from '@/hooks/useProjectInstructions';
import type { RepoOverride } from '@/hooks/useProtectMain';
import type { ScratchpadMemory } from '@/hooks/useScratchpad';
import { usePinnedArtifacts } from '@/hooks/usePinnedArtifacts';
import type {
  ActiveRepo,
  RepoWithActivity,
  ChatMessage,
  AIProviderType,
  AgentStatus,
  AgentStatusEvent,
  Conversation,
  CardAction,
  CIStatus,
  RunCheckpoint,
  GitHubUser,
  UserProfile,
  SandboxStateCardData,
  NewChatWorkspaceState,
  AttachmentData,
} from '@/types';
import type { ContextMode } from '@/lib/orchestrator';
import type { SandboxStartMode } from '@/lib/sandbox-start-mode';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ChatScreenProps {
  // Repo & sandbox
  activeRepo: ActiveRepo | null;
  isSandboxMode: boolean;
  resolveRepoAppearance: (repoFullName?: string | null) => RepoAppearance;
  setRepoAppearance: (repoFullName: string, appearance: RepoAppearance) => void;
  clearRepoAppearance: (repoFullName: string) => void;
  sandbox: {
    sandboxId: string | null;
    status: SandboxStatus;
    error: string | null;
    createdAt: number | null;
    start: (repo: string, branch?: string) => Promise<string | null>;
    stop: () => Promise<void>;
    refresh: () => Promise<boolean>;
    markUnreachable: (reason: string) => void;
  };

  // Chat
  messages: ChatMessage[];
  sendMessage: (message: string, attachments?: AttachmentData[]) => Promise<void> | void;
  agentStatus: AgentStatus;
  agentEvents: AgentStatusEvent[];
  isStreaming: boolean;
  lockedProvider: AIProviderType | null;
  isProviderLocked: boolean;
  lockedModel: string | null;
  isModelLocked: boolean;
  conversations: Record<string, Conversation>;
  activeChatId: string | null;
  switchChat: (id: string) => void;
  renameChat: (id: string, name: string) => void;
  deleteChat: (id: string) => void;
  deleteAllChats: () => void;
  handleCardAction: (action: CardAction) => void;
  contextUsage: { used: number; max: number; percent: number };
  abortStream: () => void;
  interruptedCheckpoint: RunCheckpoint | null;
  resumeInterruptedRun: () => void;
  dismissResume: () => void;
  ciStatus: CIStatus | null;
  diagnoseCIFailure: () => void;

  // Repos
  repos: RepoWithActivity[];
  reposLoading: boolean;
  reposError: string | null;

  // Branches
  branches: BranchManager;

  // Model catalog
  catalog: ModelCatalog;

  // Snapshots
  snapshots: SnapshotManager;

  // Project instructions
  instructions: ProjectInstructionsManager;

  // Scratchpad
  scratchpad: {
    content: string;
    hasContent: boolean;
    setContent: (c: string) => void;
    clear: () => void;
    memories: ScratchpadMemory[];
    activeMemoryId: string | null;
    saveMemory: (label: string) => void;
    loadMemory: (id: string | null) => void;
    deleteMemory: (id: string) => void;
  };

  // Protect main
  protectMain: {
    isProtected: boolean;
    globalDefault: boolean;
    setGlobalDefault: (v: boolean) => void;
    repoOverride: RepoOverride;
    setRepoOverride: (v: RepoOverride) => void;
  };

  // User profile & settings
  profile: UserProfile;
  updateProfile: (updates: Partial<UserProfile>) => void;
  clearProfile: () => void;

  // Auth
  token: string | null;
  patToken: string | null;
  isAppAuth: boolean;
  installationId: string | null;
  validatedUser: GitHubUser | null;
  appLoading: boolean;
  appError: string | null;
  connectApp: () => void;
  installApp: () => void;
  isDemo: boolean;

  // Workspace hub
  isWorkspaceHubOpen: boolean;
  setIsWorkspaceHubOpen: (open: boolean) => void;
  showToolActivity: boolean;

  // File browser
  setShowFileBrowser: (show: boolean) => void;

  // Sandbox mode controls
  handleSandboxMode: (() => void) | undefined;
  handleExitSandboxMode: () => void;

  // Chat creation
  handleCreateNewChat: () => void;
  inspectNewChatWorkspace: () => Promise<NewChatWorkspaceState | null>;

  handleDisconnect: () => void;

  // Sandbox controls
  handleSandboxRestart: () => Promise<void>;
  handleSandboxDownload: () => Promise<void>;
  sandboxDownloading: boolean;

  // Provider/model selection from chat
  selectedChatProvider: PreferredProvider | null;
  selectedChatModels: Record<PreferredProvider, string>;
  handleSelectBackend: (provider: PreferredProvider) => void;
  handleSelectOllamaModelFromChat: (model: string) => void;
  handleSelectOpenRouterModelFromChat: (model: string) => void;
  handleSelectZenModelFromChat: (model: string) => void;
  handleSelectNvidiaModelFromChat: (model: string) => void;
  handleSelectAzureModelFromChat: (model: string) => void;
  handleSelectBedrockModelFromChat: (model: string) => void;
  handleSelectVertexModelFromChat: (model: string) => void;

  // Repo selection
  handleSelectRepoFromDrawer: (repo: RepoWithActivity, branch?: string) => void;
  setCurrentBranch: (branch: string) => void;
  onSandboxBranchSwitch: (branch: string) => void;

  // Sandbox state (for settings)
  sandboxState: SandboxStateCardData | null;
  sandboxStateLoading: boolean;
  fetchSandboxState: (id: string) => void;

  // Settings sheet extra
  contextMode: ContextMode;
  updateContextMode: (mode: ContextMode) => void;
  sandboxStartMode: SandboxStartMode;
  updateSandboxStartMode: (mode: SandboxStartMode) => void;
  updateShowToolActivity: (v: boolean) => void;
  showInstallIdInput: boolean;
  setShowInstallIdInput: (v: boolean) => void;
  installIdInput: string;
  setInstallIdInput: (v: string) => void;
  setInstallationIdManually: (id: string) => Promise<boolean>;
  allowlistSecretCmd: string;
  copyAllowlistCommand: () => void;

  // Profile drafts
  displayNameDraft: string;
  setDisplayNameDraft: (v: string) => void;
  handleDisplayNameBlur: () => void;
  bioDraft: string;
  setBioDraft: (v: string) => void;
  handleBioBlur: () => void;

  // Ensure sandbox
  ensureSandbox: () => Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ChatScreen(props: ChatScreenProps) {
  const {
    activeRepo,
    isSandboxMode,
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
    deleteAllChats,
    handleCardAction,
    contextUsage,
    abortStream,
    interruptedCheckpoint,
    resumeInterruptedRun,
    dismissResume,
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
    profile,
    clearProfile,
    token,
    patToken,
    isAppAuth,
    installationId,
    validatedUser,
    appLoading,
    appError,
    connectApp,
    installApp,
    isDemo,
    isWorkspaceHubOpen,
    setIsWorkspaceHubOpen,
    showToolActivity,
    handleSandboxMode,
    handleExitSandboxMode,
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
    handleSelectAzureModelFromChat,
    handleSelectBedrockModelFromChat,
    handleSelectVertexModelFromChat,
    handleSelectRepoFromDrawer,
    setCurrentBranch,
    onSandboxBranchSwitch,
    sandboxState,
    sandboxStateLoading,
    fetchSandboxState,
    contextMode,
    updateContextMode,
    sandboxStartMode,
    updateSandboxStartMode,
    updateShowToolActivity,
    showInstallIdInput,
    setShowInstallIdInput,
    installIdInput,
    setInstallIdInput,
    setInstallationIdManually,
    allowlistSecretCmd,
    copyAllowlistCommand,
    displayNameDraft,
    setDisplayNameDraft,
    handleDisplayNameBlur,
    bioDraft,
    setBioDraft,
    handleBioBlur,
    ensureSandbox,
  } = props;
  const pinnedArtifacts = usePinnedArtifacts(activeRepo?.full_name ?? null);
  const [isLauncherOpen, setIsLauncherOpen] = useState(false);
  const [isHistoryDrawerOpen, setIsHistoryDrawerOpen] = useState(false);
  const [newChatSheetOpen, setNewChatSheetOpen] = useState(false);
  const [newChatWorkspaceState, setNewChatWorkspaceState] = useState<NewChatWorkspaceState | null>(null);
  const [checkingNewChatWorkspace, setCheckingNewChatWorkspace] = useState(false);
  const [resettingWorkspaceForNewChat, setResettingWorkspaceForNewChat] = useState(false);
  const [hubTabRequest, setHubTabRequest] = useState<{ tab: 'files' | 'diff'; requestKey: number } | null>(null);
  const activeRepoAppearance = activeRepo && !isSandboxMode
    ? resolveRepoAppearance(activeRepo.full_name)
    : null;
  const activeRepoAccentHex = activeRepoAppearance
    ? getRepoAppearanceColorHex(activeRepoAppearance.color)
    : null;

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

  const isConnected = Boolean(token) || isDemo || isSandboxMode;
  const historyDrawerOffset = 'min(86vw, 24rem)';
  const workspaceHubOffset = '94vw';
  const chatShellTransform = isHistoryDrawerOpen
    ? `translateX(${historyDrawerOffset})`
    : isWorkspaceHubOpen
    ? `translateX(-${workspaceHubOffset})`
    : 'translateX(0px)';
  const chatShellShadow = isHistoryDrawerOpen
    ? 'shadow-[-24px_0_56px_rgba(0,0,0,0.42)]'
    : isWorkspaceHubOpen
    ? 'shadow-[24px_0_56px_rgba(0,0,0,0.42)]'
    : '';
  const headerSurfaceClass =
    'relative overflow-hidden rounded-full border border-push-edge-subtle bg-push-grad-input shadow-[0_12px_34px_rgba(0,0,0,0.5),0_3px_10px_rgba(0,0,0,0.28)] backdrop-blur-xl';
  const headerInteractiveClass =
    'transition-all duration-200 hover:border-push-edge-hover hover:text-push-fg hover:brightness-110 spring-press';
  const headerRoundButtonClass =
    `relative flex h-9 w-9 items-center justify-center text-push-fg-secondary ${headerSurfaceClass} ${headerInteractiveClass}`;
  const headerPillButtonClass =
    `pointer-events-auto flex h-9 items-center gap-2 px-3 text-push-fg-secondary ${headerSurfaceClass} ${headerInteractiveClass}`;

  // Destructure stable function refs to avoid depending on the whole object
  const { markSnapshotActivity } = snapshots;

  // Snapshot heartbeat wrappers
  const sendMessageWithSnapshotHeartbeat = useCallback((message: string, attachments?: AttachmentData[]) => {
    markSnapshotActivity();
    return sendMessage(message, attachments);
  }, [markSnapshotActivity, sendMessage]);

  const handleWorkspaceHubOpenChange = useCallback((open: boolean) => {
    if (open) {
      setIsHistoryDrawerOpen(false);
    }
    setIsWorkspaceHubOpen(open);
  }, [setIsWorkspaceHubOpen]);

  const openWorkspaceHub = useCallback(() => {
    setIsHistoryDrawerOpen(false);
    setIsWorkspaceHubOpen(true);
  }, [setIsWorkspaceHubOpen]);

  const openLauncher = useCallback(() => {
    setIsHistoryDrawerOpen(false);
    setIsWorkspaceHubOpen(false);
    setIsLauncherOpen(true);
  }, [setIsWorkspaceHubOpen]);

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
      tab: newChatWorkspaceState.mode === 'sandbox' ? 'files' : 'diff',
      requestKey: Date.now(),
    });
    setIsLauncherOpen(false);
    setIsHistoryDrawerOpen(false);
    handleWorkspaceHubOpenChange(true);
  }, [handleWorkspaceHubOpenChange, newChatWorkspaceState]);

  const handleStartFreshWorkspaceForNewChat = useCallback(async () => {
    if (resettingWorkspaceForNewChat) return;

    setResettingWorkspaceForNewChat(true);
    try {
      await sandbox.stop();

      let freshSandboxId: string | null = null;
      if (isSandboxMode) {
        freshSandboxId = await sandbox.start('', 'main');
      } else if (activeRepo) {
        freshSandboxId = await sandbox.start(
          activeRepo.full_name,
          activeRepo.current_branch || activeRepo.default_branch,
        );
      }

      if ((isSandboxMode || activeRepo) && !freshSandboxId) {
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
  }, [activeRepo, handleCreateNewChat, isSandboxMode, resettingWorkspaceForNewChat, sandbox]);

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
  }, [handleWorkspaceHubOpenChange, isStreaming, markSnapshotActivity, sandbox.sandboxId, ensureSandbox, sendMessage]);

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

  const handleCardActionWithSnapshotHeartbeat = useCallback((action: CardAction) => {
    markSnapshotActivity();
    return handleCardAction(action);
  }, [markSnapshotActivity, handleCardAction]);

  // Snapshot display values
  const snapshotAgeLabel = snapshots.latestSnapshot ? formatSnapshotAge(snapshots.latestSnapshot.createdAt) : null;
  const snapshotIsStale = snapshots.latestSnapshot
    ? isSnapshotStale(snapshots.latestSnapshot.createdAt)
    : false;

  // Provider locked states
  const isOllamaModelLocked = isModelLocked && lockedProvider === 'ollama';
  const isZenModelLocked = isModelLocked && lockedProvider === 'zen';
  const isNvidiaModelLocked = isModelLocked && lockedProvider === 'nvidia';
  const isAzureModelLocked = isModelLocked && lockedProvider === 'azure';
  const isBedrockModelLocked = isModelLocked && lockedProvider === 'bedrock';
  const isVertexModelLocked = isModelLocked && lockedProvider === 'vertex';

  const handleSelectAzureDeploymentFromChat = useCallback((id: string) => {
    const dep = catalog.azure.deployments.find((deployment) => deployment.id === id);
    if (!dep) return;
    catalog.azure.selectDeployment(id);
    handleSelectAzureModelFromChat(dep.model);
  }, [catalog.azure, handleSelectAzureModelFromChat]);

  const handleSelectBedrockDeploymentFromChat = useCallback((id: string) => {
    const dep = catalog.bedrock.deployments.find((deployment) => deployment.id === id);
    if (!dep) return;
    catalog.bedrock.selectDeployment(id);
    handleSelectBedrockModelFromChat(dep.model);
  }, [catalog.bedrock, handleSelectBedrockModelFromChat]);

  const settingsAuth = {

        isConnected,
        isDemo,
        isAppAuth,
        installationId: installationId ?? '',
        token: token ?? '',
        patToken: patToken ?? '',
        validatedUser,
        appLoading,
        appError,
        connectApp,
        installApp,
        showInstallIdInput,
        setShowInstallIdInput,
        installIdInput,
        setInstallIdInput,
        setInstallationIdManually,
        allowlistSecretCmd,
        copyAllowlistCommand,
        onDisconnect: handleDisconnect,
  };

  const settingsProfile = {

        displayNameDraft,
        setDisplayNameDraft,
        onDisplayNameBlur: handleDisplayNameBlur,
        bioDraft,
        setBioDraft,
        onBioBlur: handleBioBlur,
        profile,
        clearProfile,
        validatedUser,
  };

  const settingsAI = {

        activeProviderLabel: catalog.activeProviderLabel,
        activeBackend: catalog.activeBackend,
        setActiveBackend: catalog.setActiveBackend,
        isProviderLocked,
        lockedProvider,
        lockedModel,
        availableProviders: catalog.availableProviders,
        setPreferredProvider: catalog.setPreferredProvider,
        clearPreferredProvider: catalog.clearPreferredProvider,
        hasOllamaKey: catalog.ollama.hasKey,
        ollamaModel: catalog.ollama.model,
        setOllamaModel: catalog.ollama.setModel,
        ollamaModelOptions: catalog.ollamaModelOptions,
        ollamaModelsLoading: catalog.ollamaModels.loading,
        ollamaModelsError: catalog.ollamaModels.error,
        ollamaModelsUpdatedAt: catalog.ollamaModels.updatedAt,
        isOllamaModelLocked,
        refreshOllamaModels: catalog.refreshOllamaModels,
        ollamaKeyInput: catalog.ollama.keyInput,
        setOllamaKeyInput: catalog.ollama.setKeyInput,
        setOllamaKey: catalog.ollama.setKey,
        clearOllamaKey: catalog.ollama.clearKey,
        hasOpenRouterKey: catalog.openRouter.hasKey,
        openRouterModel: catalog.openRouter.model,
        setOpenRouterModel: catalog.openRouter.setModel,
        openRouterModelOptions: catalog.openRouterModelOptions,
        openRouterModelsLoading: catalog.openRouterModels.loading,
        openRouterModelsError: catalog.openRouterModels.error,
        openRouterModelsUpdatedAt: catalog.openRouterModels.updatedAt,
        isOpenRouterModelLocked: isProviderLocked && lockedProvider === 'openrouter',
        refreshOpenRouterModels: catalog.refreshOpenRouterModels,
        openRouterKeyInput: catalog.openRouter.keyInput,
        setOpenRouterKeyInput: catalog.openRouter.setKeyInput,
        setOpenRouterKey: catalog.openRouter.setKey,
        clearOpenRouterKey: catalog.openRouter.clearKey,
        hasZenKey: catalog.zen.hasKey,
        zenModel: catalog.zen.model,
        setZenModel: catalog.zen.setModel,
        zenModelOptions: catalog.zenModelOptions,
        zenModelsLoading: catalog.zenModels.loading,
        zenModelsError: catalog.zenModels.error,
        zenModelsUpdatedAt: catalog.zenModels.updatedAt,
        isZenModelLocked,
        refreshZenModels: catalog.refreshZenModels,
        zenKeyInput: catalog.zen.keyInput,
        setZenKeyInput: catalog.zen.setKeyInput,
        setZenKey: catalog.zen.setKey,
        clearZenKey: catalog.zen.clearKey,
        hasNvidiaKey: catalog.nvidia.hasKey,
        nvidiaModel: catalog.nvidia.model,
        setNvidiaModel: catalog.nvidia.setModel,
        nvidiaModelOptions: catalog.nvidiaModelOptions,
        nvidiaModelsLoading: catalog.nvidiaModels.loading,
        nvidiaModelsError: catalog.nvidiaModels.error,
        nvidiaModelsUpdatedAt: catalog.nvidiaModels.updatedAt,
        isNvidiaModelLocked,
        refreshNvidiaModels: catalog.refreshNvidiaModels,
        nvidiaKeyInput: catalog.nvidia.keyInput,
        setNvidiaKeyInput: catalog.nvidia.setKeyInput,
        setNvidiaKey: catalog.nvidia.setKey,
        clearNvidiaKey: catalog.nvidia.clearKey,
        hasAzureKey: catalog.azure.hasKey,
        azureKeyInput: catalog.azure.keyInput,
        setAzureKeyInput: catalog.azure.setKeyInput,
        setAzureKey: catalog.azure.setKey,
        clearAzureKey: catalog.azure.clearKey,
        azureBaseUrl: catalog.azure.baseUrl,
        azureBaseUrlInput: catalog.azure.baseUrlInput,
        setAzureBaseUrlInput: catalog.azure.setBaseUrlInput,
        azureBaseUrlError: catalog.azure.baseUrlError,
        setAzureBaseUrl: catalog.azure.setBaseUrl,
        clearAzureBaseUrl: catalog.azure.clearBaseUrl,
        azureModel: catalog.azure.model,
        azureModelInput: catalog.azure.modelInput,
        setAzureModelInput: catalog.azure.setModelInput,
        setAzureModel: catalog.azure.setModel,
        clearAzureModel: catalog.azure.clearModel,
        azureDeployments: catalog.azure.deployments,
        azureActiveDeploymentId: catalog.azure.activeDeploymentId,
        saveAzureDeployment: catalog.azure.saveDeployment,
        selectAzureDeployment: catalog.azure.selectDeployment,
        removeAzureDeployment: catalog.azure.removeDeployment,
        clearAzureDeployments: catalog.azure.clearDeployments,
        isAzureDeploymentLimitReached: catalog.azure.deploymentLimitReached,
        isAzureConfigured: catalog.azure.isConfigured,
        hasBedrockKey: catalog.bedrock.hasKey,
        bedrockKeyInput: catalog.bedrock.keyInput,
        setBedrockKeyInput: catalog.bedrock.setKeyInput,
        setBedrockKey: catalog.bedrock.setKey,
        clearBedrockKey: catalog.bedrock.clearKey,
        bedrockBaseUrl: catalog.bedrock.baseUrl,
        bedrockBaseUrlInput: catalog.bedrock.baseUrlInput,
        setBedrockBaseUrlInput: catalog.bedrock.setBaseUrlInput,
        bedrockBaseUrlError: catalog.bedrock.baseUrlError,
        setBedrockBaseUrl: catalog.bedrock.setBaseUrl,
        clearBedrockBaseUrl: catalog.bedrock.clearBaseUrl,
        bedrockModel: catalog.bedrock.model,
        bedrockModelInput: catalog.bedrock.modelInput,
        setBedrockModelInput: catalog.bedrock.setModelInput,
        setBedrockModel: catalog.bedrock.setModel,
        clearBedrockModel: catalog.bedrock.clearModel,
        bedrockDeployments: catalog.bedrock.deployments,
        bedrockActiveDeploymentId: catalog.bedrock.activeDeploymentId,
        saveBedrockDeployment: catalog.bedrock.saveDeployment,
        selectBedrockDeployment: catalog.bedrock.selectDeployment,
        removeBedrockDeployment: catalog.bedrock.removeDeployment,
        clearBedrockDeployments: catalog.bedrock.clearDeployments,
        isBedrockDeploymentLimitReached: catalog.bedrock.deploymentLimitReached,
        isBedrockConfigured: catalog.bedrock.isConfigured,
        hasVertexKey: catalog.vertex.hasKey,
        vertexKeyInput: catalog.vertex.keyInput,
        setVertexKeyInput: catalog.vertex.setKeyInput,
        setVertexKey: catalog.vertex.setKey,
        clearVertexKey: catalog.vertex.clearKey,
        vertexKeyError: catalog.vertex.keyError,
        vertexRegion: catalog.vertex.region,
        vertexRegionInput: catalog.vertex.regionInput,
        setVertexRegionInput: catalog.vertex.setRegionInput,
        vertexRegionError: catalog.vertex.regionError,
        vertexModel: catalog.vertex.model,
        vertexModelInput: catalog.vertex.modelInput,
        setVertexModelInput: catalog.vertex.setModelInput,
        vertexModelOptions: catalog.vertex.modelOptions,
        setVertexRegion: catalog.vertex.setRegion,
        clearVertexRegion: catalog.vertex.clearRegion,
        setVertexModel: catalog.vertex.setModel,
        clearVertexModel: catalog.vertex.clearModel,
        vertexMode: catalog.vertex.mode,
        vertexTransport: catalog.vertex.transport,
        vertexProjectId: catalog.vertex.projectId,
        hasLegacyVertexConfig: catalog.vertex.hasLegacyConfig,
        isVertexConfigured: catalog.vertex.isConfigured,
        hasTavilyKey: catalog.tavily.hasKey,
        tavilyKeyInput: catalog.tavily.keyInput,
        setTavilyKeyInput: catalog.tavily.setKeyInput,
        setTavilyKey: catalog.tavily.setKey,
        clearTavilyKey: catalog.tavily.clearKey,
  };

  const settingsWorkspace = {

        contextMode,
        updateContextMode,
        sandboxStartMode,
        updateSandboxStartMode,
        sandboxStatus: sandbox.status,
        sandboxId: sandbox.sandboxId,
        sandboxError: sandbox.error,
        sandboxState,
        sandboxStateLoading,
        fetchSandboxState,
        protectMainGlobal: protectMain.globalDefault,
        setProtectMainGlobal: protectMain.setGlobalDefault,
        protectMainRepoOverride: protectMain.repoOverride,
        setProtectMainRepoOverride: protectMain.setRepoOverride,
        showToolActivity,
        setShowToolActivity: updateShowToolActivity,
        activeRepoFullName: activeRepo?.full_name ?? null,
  };

  const settingsData = {

        activeRepo,
        deleteAllChats,
  };

  return (
    <div className="relative flex h-dvh flex-col overflow-hidden bg-[#000] safe-area-top safe-area-bottom">
      <div
        className={`relative z-10 flex min-h-0 flex-1 flex-col bg-[#000] transition-[transform,box-shadow] duration-500 ease-in-out will-change-transform ${chatShellShadow}`}
        style={{
          transform: chatShellTransform,
        }}
      >
      {/* Top bar */}
      <header className="relative z-10 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 px-3 pt-3 pb-2">
        <div className="relative z-20 flex min-w-0 items-center gap-2">
          <div className={`flex h-[34px] min-w-0 items-center gap-1 pl-0.5 pr-2.5 ${headerSurfaceClass}`}>
            <div className="pointer-events-none absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/[0.05] to-transparent" />
            <RepoChatDrawer
              open={isHistoryDrawerOpen}
              onOpenChange={setIsHistoryDrawerOpen}
              repos={repos}
              activeRepo={activeRepo}
              conversations={conversations}
              activeChatId={activeChatId ?? ''}
              resolveRepoAppearance={resolveRepoAppearance}
              setRepoAppearance={setRepoAppearance}
              clearRepoAppearance={clearRepoAppearance}
              onSelectRepo={handleSelectRepoFromDrawer}
              onSwitchChat={switchChat}
              onNewChat={handleCreateNewChatRequest}
              onDeleteChat={deleteChat}
              onRenameChat={renameChat}
              currentBranch={activeRepo?.current_branch || activeRepo?.default_branch}
              defaultBranch={activeRepo?.default_branch}
              setCurrentBranch={setCurrentBranch}
              availableBranches={displayBranches}
              branchesLoading={repoBranchesLoading}
              branchesError={repoBranchesError}
              onRefreshBranches={
                activeRepo
                  ? () => { void loadRepoBranches(activeRepo.full_name); }
                  : undefined
              }
              onDeleteBranch={handleDeleteBranch}
            />
            {activeRepoAppearance && (
              <RepoAppearanceBadge
                appearance={activeRepoAppearance}
                className="relative z-10 -ml-1.5 h-[18px] w-[18px] shrink-0 rounded-md"
                iconClassName="h-[11px] w-[11px]"
              />
            )}
            <div className={`${activeRepoAppearance ? '-ml-1.5' : '-ml-2.5'} flex min-w-0 items-center self-stretch`}>
              <p className="truncate text-sm font-medium leading-tight text-[#f5f7ff]">
                {isSandboxMode ? 'Sandbox' : activeRepo?.name || 'Push'}
              </p>
            </div>
          </div>
          {isSandboxMode && (
              <>
                <span className="text-push-2xs text-push-fg-dim">ephemeral</span>
                {snapshots.latestSnapshot && (
                  <span
                    className={`text-push-2xs ${snapshotIsStale ? 'text-amber-400' : 'text-push-fg-dim'}`}
                    title={`Latest snapshot: ${new Date(snapshots.latestSnapshot.createdAt).toLocaleString()}`}
                  >
                    {snapshotIsStale ? `snapshot stale (${snapshotAgeLabel})` : `snapshot ${snapshotAgeLabel}`}
                  </span>
                )}
                {sandbox.status === 'ready' && (
                  <button
                    onClick={() => snapshots.captureSnapshot('manual')}
                    disabled={snapshots.snapshotSaving || snapshots.snapshotRestoring}
                    className="flex h-7 items-center gap-1 rounded-lg px-2 text-push-xs text-push-fg-dim transition-colors hover:bg-push-surface-hover hover:text-emerald-400 active:scale-95 disabled:opacity-50"
                    title="Save Snapshot Now"
                    aria-label="Save Snapshot Now"
                  >
                    {snapshots.snapshotSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                    Save
                  </button>
                )}
                {snapshots.latestSnapshot && (
                  <button
                    onClick={snapshots.handleRestoreFromSnapshot}
                    disabled={snapshots.snapshotSaving || snapshots.snapshotRestoring || sandbox.status === 'creating'}
                    className="flex h-7 items-center gap-1 rounded-lg px-2 text-push-xs text-push-fg-dim transition-colors hover:bg-push-surface-hover hover:text-emerald-400 active:scale-95 disabled:opacity-50"
                    title="Restore from Last Snapshot"
                    aria-label="Restore from Last Snapshot"
                  >
                    {snapshots.snapshotRestoring ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                    Restore
                  </button>
                )}
                {sandbox.status === 'ready' && (
                  <button
                    onClick={handleSandboxDownload}
                    disabled={sandboxDownloading}
                    className="flex h-7 w-7 items-center justify-center rounded-lg text-push-fg-dim transition-colors hover:bg-push-surface-hover hover:text-emerald-400 active:scale-95 disabled:opacity-50"
                    title="Download workspace"
                    aria-label="Download workspace"
                  >
                    {sandboxDownloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                  </button>
                )}
                {snapshots.snapshotRestoring && snapshots.snapshotRestoreProgress && (
                  <div className="flex min-w-[120px] flex-col gap-1">
                    <span className="text-push-2xs text-push-fg-muted">{snapshots.snapshotRestoreProgress.message}</span>
                    <div className="h-1 w-full overflow-hidden rounded bg-[#1a2130]">
                      <div
                        className="h-full bg-emerald-500 transition-all duration-300"
                        style={{ width: `${snapshotStagePercent(snapshots.snapshotRestoreProgress.stage)}%` }}
                      />
                    </div>
                  </div>
                )}
              </>
            )}
        </div>
        {/* Centered launcher trigger with repo or sandbox context */}
        {(activeRepo || isSandboxMode) && (
          <div className="flex min-w-0 justify-center">
            <button
              onClick={openLauncher}
              className={`${headerPillButtonClass} group min-w-0 max-w-full`}
              aria-label="Open launcher"
              title="Launcher"
            >
              <div className="pointer-events-none absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/[0.05] to-transparent" />
              <LauncherGridIcon className="relative z-10 h-3.5 w-3.5 text-push-fg-secondary transition-colors group-hover:text-push-fg" />
              <span className="relative z-10 max-w-[92px] truncate text-xs font-medium text-push-fg-secondary transition-colors group-hover:text-push-fg sm:max-w-[128px]">
                {isSandboxMode ? 'Sandbox' : currentBranch}
              </span>
            </button>
          </div>
        )}
        <div className="relative z-20 flex min-w-0 items-center justify-end gap-2">
          {(activeRepo || isSandboxMode) && (
            <button
              onClick={() => openWorkspaceHub()}
              className={headerRoundButtonClass}
              aria-label="Open workspace hub"
              title="Workspace"
            >
              <div className="pointer-events-none absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/[0.05] to-transparent" />
              <WorkspaceDockIcon className="relative z-10 h-3.5 w-3.5" />
              {(scratchpad.hasContent || agentStatus.active) && (
                <span
                  className={`absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-push-sky ${
                    agentStatus.active ? 'animate-pulse shadow-[0_0_6px_rgba(56,189,248,0.5)]' : ''
                  }`}
                />
              )}
            </button>
          )}
        </div>
        <div className="pointer-events-none absolute inset-x-0 top-full h-8 bg-gradient-to-b from-black to-transparent" />
      </header>

      {/* Sandbox status banner (idle/creating/error) */}
      <SandboxStatusBanner
        status={sandbox.status}
        error={sandbox.error}
        hasMessages={messages.length > 0}
        isStreaming={isStreaming}
        sandboxId={sandbox.sandboxId}
        isSandboxMode={isSandboxMode}
        onStart={() => {
          if (isSandboxMode) {
            void sandbox.start('', 'main');
          } else if (activeRepo) {
            void sandbox.start(activeRepo.full_name, activeRepo.current_branch || activeRepo.default_branch);
          }
        }}
        onRetry={() => void sandbox.refresh()}
        onNewSandbox={() => {
          if (isSandboxMode) {
            void sandbox.stop().then(() => sandbox.start('', 'main'));
          } else if (activeRepo) {
            void sandbox.stop().then(() => sandbox.start(activeRepo.full_name, activeRepo.current_branch || activeRepo.default_branch));
          }
        }}
        onExitSandboxMode={handleExitSandboxMode}
      />

      {/* Sandbox expiry warning */}
      {isSandboxMode && (
        <SandboxExpiryBanner
          createdAt={sandbox.createdAt}
          sandboxId={sandbox.sandboxId}
          sandboxStatus={sandbox.status}
          onRestart={handleSandboxRestart}
        />
      )}

      {!isSandboxMode && activeRepo && instructions.projectInstructionsChecked && !instructions.projectInstructionsCheckFailed && !instructions.agentsMdContent && (
        <div className={`mx-4 mt-4 animate-fade-in px-3.5 py-3.5 ${HUB_PANEL_SUBTLE_SURFACE_CLASS}`}>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-medium text-push-fg">No AGENTS.md found</p>
              <p className="text-push-xs text-push-fg-muted">Add project instructions so the agent understands your repo conventions.</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                onClick={instructions.handleCreateAgentsMdWithAI}
                disabled={instructions.creatingAgentsMdWithAI || isStreaming}
                className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} px-3 text-emerald-300`}
              >
                <HubControlGlow />
                <span className="relative z-10">
                  {instructions.creatingAgentsMdWithAI ? 'Drafting...' : 'Create with AI'}
                </span>
              </button>
              <button
                onClick={instructions.handleCreateAgentsMd}
                disabled={instructions.creatingAgentsMd || instructions.creatingAgentsMdWithAI}
                className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} px-3 text-[#8ad4ff]`}
              >
                <HubControlGlow />
                <span className="relative z-10">
                  {instructions.creatingAgentsMd ? 'Creating...' : 'Create Template'}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Chat */}
      <ChatContainer
        messages={messages}
        agentStatus={agentStatus}
        activeRepo={activeRepo}
        isSandboxMode={isSandboxMode}
        onSuggestion={sendMessageWithSnapshotHeartbeat}
        onCardAction={handleCardActionWithSnapshotHeartbeat}
        onPin={pinnedArtifacts.pin}
        interruptedCheckpoint={interruptedCheckpoint}
        onResumeRun={resumeInterruptedRun}
        onDismissResume={dismissResume}
        ciStatus={ciStatus}
        onDiagnoseCI={diagnoseCIFailure}
      />

      {/* Input */}
      <ChatInput
        onSend={sendMessageWithSnapshotHeartbeat}
        onStop={abortStream}
        isStreaming={isStreaming}
        repoName={activeRepo?.name}
        contextUsage={contextUsage}
        providerControls={{
          selectedProvider: selectedChatProvider,
          availableProviders: catalog.availableProviders,
          isProviderLocked,
          lockedProvider,
          lockedModel,
          onSelectBackend: handleSelectBackend,
          ollamaModel: selectedChatModels.ollama,
          ollamaModelOptions: catalog.ollamaModelOptions,
          ollamaModelsLoading: catalog.ollamaModels.loading,
          ollamaModelsError: catalog.ollamaModels.error,
          ollamaModelsUpdatedAt: catalog.ollamaModels.updatedAt,
          isOllamaModelLocked,
          refreshOllamaModels: catalog.refreshOllamaModels,
          onSelectOllamaModel: handleSelectOllamaModelFromChat,
          openRouterModel: selectedChatModels.openrouter,
          openRouterModelOptions: catalog.openRouterModelOptions,
          isOpenRouterModelLocked: isProviderLocked && lockedProvider === 'openrouter',
          onSelectOpenRouterModel: handleSelectOpenRouterModelFromChat,
          zenModel: selectedChatModels.zen,
          zenModelOptions: catalog.zenModelOptions,
          zenModelsLoading: catalog.zenModels.loading,
          zenModelsError: catalog.zenModels.error,
          zenModelsUpdatedAt: catalog.zenModels.updatedAt,
          isZenModelLocked,
          refreshZenModels: catalog.refreshZenModels,
          onSelectZenModel: handleSelectZenModelFromChat,
          nvidiaModel: selectedChatModels.nvidia,
          nvidiaModelOptions: catalog.nvidiaModelOptions,
          nvidiaModelsLoading: catalog.nvidiaModels.loading,
          nvidiaModelsError: catalog.nvidiaModels.error,
          nvidiaModelsUpdatedAt: catalog.nvidiaModels.updatedAt,
          isNvidiaModelLocked,
          refreshNvidiaModels: catalog.refreshNvidiaModels,
          onSelectNvidiaModel: handleSelectNvidiaModelFromChat,
          azureModel: selectedChatModels.azure,
          azureDeployments: catalog.azure.deployments,
          azureActiveDeploymentId: catalog.azure.activeDeploymentId,
          isAzureModelLocked,
          onSelectAzureModel: handleSelectAzureModelFromChat,
          onSelectAzureDeployment: handleSelectAzureDeploymentFromChat,
          bedrockModel: selectedChatModels.bedrock,
          bedrockDeployments: catalog.bedrock.deployments,
          bedrockActiveDeploymentId: catalog.bedrock.activeDeploymentId,
          isBedrockModelLocked,
          onSelectBedrockModel: handleSelectBedrockModelFromChat,
          onSelectBedrockDeployment: handleSelectBedrockDeploymentFromChat,
          vertexModel: selectedChatModels.vertex,
          vertexModelOptions: catalog.vertex.modelOptions,
          isVertexModelLocked,
          onSelectVertexModel: handleSelectVertexModelFromChat,
        }}
      />
      </div>

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
        onStartSandbox={() => {
          if (isSandboxMode) {
            void sandbox.start('', 'main');
          } else if (activeRepo) {
            void sandbox.start(activeRepo.full_name, activeRepo.current_branch || activeRepo.default_branch);
          }
        }}
        onRetrySandbox={() => void sandbox.refresh()}
        onNewSandbox={() => {
          if (isSandboxMode) {
            void sandbox.stop().then(() => sandbox.start('', 'main'));
          } else if (activeRepo) {
            void sandbox.stop().then(() => sandbox.start(activeRepo.full_name, activeRepo.current_branch || activeRepo.default_branch));
          }
        }}
        reviewProviders={catalog.availableProviders}
        reviewActiveProvider={catalog.activeProviderLabel}
        reviewProviderModels={{
          ollama: catalog.ollama.model,
          openrouter: catalog.openRouter.model,
          zen: catalog.zen.model,
          nvidia: catalog.nvidia.model,
          azure: catalog.azure.model,
          bedrock: catalog.bedrock.model,
          vertex: catalog.vertex.model,
        }}
        lockedProvider={lockedProvider}
        lockedModel={lockedModel}
        repoName={activeRepo?.name || (isSandboxMode ? 'Sandbox' : undefined)}
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
        branchProps={{
          currentBranch: activeRepo?.current_branch || activeRepo?.default_branch,
          defaultBranch: activeRepo?.default_branch,
          availableBranches: displayBranches,
          branchesLoading: repoBranchesLoading,
          onSwitchBranch: setCurrentBranch,
          onRefreshBranches: activeRepo
            ? () => { void loadRepoBranches(activeRepo.full_name); }
            : () => {},
          onShowBranchCreate: () => setShowBranchCreate(true),
          onShowMergeFlow: () => setShowMergeFlow(true),
          onDeleteBranch: handleDeleteBranch,
        }}
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
        open={isLauncherOpen}
        onOpenChange={setIsLauncherOpen}
        repos={repos}
        loading={reposLoading}
        error={reposError}
        conversations={conversations}
        activeRepo={activeRepo}
        resolveRepoAppearance={resolveRepoAppearance}
        setRepoAppearance={setRepoAppearance}
        clearRepoAppearance={clearRepoAppearance}
        onSelectRepo={handleSelectRepoFromDrawer}
        onResumeConversation={handleResumeConversationFromLauncher}
        sandboxSession={isSandboxMode ? { status: sandbox.status, createdAt: sandbox.createdAt } : null}
        onSandboxMode={handleSandboxMode}
      />

      {/* Toast notifications */}
      <Toaster position="bottom-center" />

      {/* Branch creation sheet */}
      {activeRepo && (
        <BranchCreateSheet
          open={showBranchCreate}
          onOpenChange={setShowBranchCreate}
          activeRepo={activeRepo}
          setCurrentBranch={setCurrentBranch}
        />
      )}

      {/* Merge flow sheet */}
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
    </div>
  );
}
