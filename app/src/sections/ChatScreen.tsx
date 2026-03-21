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
  HUB_TOP_BANNER_STRIP_CLASS,
  HubControlGlow,
} from '@/components/chat/hub-styles';
import type { PreferredProvider } from '@/lib/providers';
import { getRepoAppearanceColorHex, hexToRgba, type RepoAppearance } from '@/lib/repo-appearance';
import type { SandboxStatus } from '@/hooks/useSandbox';
import { buildWorkspaceScratchActions, formatSnapshotAge, isSnapshotStale, snapshotStagePercent } from '@/hooks/useSnapshotManager';
import type { ModelCatalog } from '@/hooks/useModelCatalog';
import type { SnapshotManager } from '@/hooks/useSnapshotManager';
import type { BranchManager } from '@/hooks/useBranchManager';
import type { ProjectInstructionsManager } from '@/hooks/useProjectInstructions';
import type { RepoOverride } from '@/hooks/useProtectMain';
import type { ScratchpadMemory } from '@/hooks/useScratchpad';
import { usePinnedArtifacts } from '@/hooks/usePinnedArtifacts';
import { getVisionCapabilityNotice } from '@/lib/model-capabilities';
import { buildQuickPromptMessage } from '@/lib/quick-prompts';
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
  ChatSendOptions,
  QuickPrompt,
  WorkspaceCapabilities,
  WorkspaceScratchActions,
  WorkspaceSession,
} from '@/types';
import type { ContextMode } from '@/lib/orchestrator';
import type { SandboxStartMode } from '@/lib/sandbox-start-mode';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ChatScreenProps {
  // Repo & workspace
  activeRepo: ActiveRepo | null;
  workspaceSession?: WorkspaceSession | null;
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
  sendMessage: (message: string, attachments?: AttachmentData[], options?: ChatSendOptions) => Promise<void> | void;
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
  regenerateLastResponse: () => Promise<void> | void;
  editMessageAndResend: (messageId: string, text: string, attachments?: AttachmentData[], options?: ChatSendOptions) => Promise<void> | void;
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

  // Workspace hub
  isWorkspaceHubOpen: boolean;
  setIsWorkspaceHubOpen: (open: boolean) => void;
  showToolActivity: boolean;

  // File browser
  setShowFileBrowser: (show: boolean) => void;

  // Workspace controls
  handleStartWorkspace: (() => void) | undefined;
  handleExitWorkspace: () => void;

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
  handleSelectBlackboxModelFromChat: (model: string) => void;
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

const CHAT_PROVIDER_LABELS: Record<AIProviderType, string> = {
  ollama: 'Ollama',
  openrouter: 'OpenRouter',
  zen: 'OpenCode Zen',
  nvidia: 'Nvidia NIM',
  blackbox: 'Blackbox AI',
  azure: 'Azure OpenAI',
  bedrock: 'AWS Bedrock',
  kilocode: 'Kilo Code',
  vertex: 'Google Vertex',
  demo: 'Demo',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ChatScreen(props: ChatScreenProps) {
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
    deleteAllChats,
    regenerateLastResponse,
    editMessageAndResend,
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
    isWorkspaceHubOpen,
    setIsWorkspaceHubOpen,
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
  const isScratch = workspaceSession?.kind === 'scratch';
  const pinnedArtifacts = usePinnedArtifacts(activeRepo?.full_name ?? null);
  const [isLauncherOpen, setIsLauncherOpen] = useState(false);
  const [isChatsDrawerOpen, setIsChatsDrawerOpen] = useState(false);
  const [newChatSheetOpen, setNewChatSheetOpen] = useState(false);
  const [newChatWorkspaceState, setNewChatWorkspaceState] = useState<NewChatWorkspaceState | null>(null);
  const [checkingNewChatWorkspace, setCheckingNewChatWorkspace] = useState(false);
  const [resettingWorkspaceForNewChat, setResettingWorkspaceForNewChat] = useState(false);
  const [hubTabRequest, setHubTabRequest] = useState<{ tab: 'files' | 'diff'; requestKey: number } | null>(null);
  const [editingUserMessageId, setEditingUserMessageId] = useState<string | null>(null);
  const [composerPrefillRequest, setComposerPrefillRequest] = useState<{
    token: number;
    text: string;
    attachments?: AttachmentData[];
  } | null>(null);
  const activeRepoAppearance = activeRepo && !isScratch
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

  const isGitHubConnected = Boolean(token);
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
  const headerPlainInteractiveClass =
    'relative text-push-fg-secondary transition-colors duration-200 hover:text-push-fg active:scale-[0.98]';
  const headerRoundButtonClass =
    `flex h-9 w-9 items-center justify-center ${headerPlainInteractiveClass}`;
  const headerPillButtonClass =
    `pointer-events-auto flex h-9 items-center gap-2 px-1.5 ${headerPlainInteractiveClass}`;

  const selectedComposerProvider: AIProviderType = (() => {
    if (isProviderLocked && lockedProvider) return lockedProvider;
    if (selectedChatProvider) return selectedChatProvider;
    return catalog.availableProviders[0]?.[0] ?? 'demo';
  })();

  const isDisplayedComposerProviderLocked = Boolean(
    isProviderLocked &&
    lockedProvider &&
    lockedProvider === selectedComposerProvider,
  );

  const selectedComposerModel = (() => {
    if (isDisplayedComposerProviderLocked && lockedModel) return lockedModel;
    if (selectedComposerProvider === 'ollama') return selectedChatModels.ollama;
    if (selectedComposerProvider === 'openrouter') return selectedChatModels.openrouter;
    if (selectedComposerProvider === 'zen') return selectedChatModels.zen;
    if (selectedComposerProvider === 'nvidia') return selectedChatModels.nvidia;
    if (selectedComposerProvider === 'blackbox') return selectedChatModels.blackbox;
    if (selectedComposerProvider === 'azure') return selectedChatModels.azure;
    if (selectedComposerProvider === 'bedrock') return selectedChatModels.bedrock;
    if (selectedComposerProvider === 'vertex') return selectedChatModels.vertex;
    return 'demo';
  })();

  // Destructure stable function refs to avoid depending on the whole object
  const { markSnapshotActivity } = snapshots;

  // Snapshot heartbeat wrappers
  const sendMessageWithSnapshotHeartbeat = useCallback((message: string, attachments?: AttachmentData[], options?: ChatSendOptions) => {
    markSnapshotActivity();
    return sendMessage(message, attachments, options);
  }, [markSnapshotActivity, sendMessage]);

  const cancelEditingUserMessage = useCallback(() => {
    setEditingUserMessageId(null);
  }, []);

  const validateComposerAttachments = useCallback((attachments?: AttachmentData[]) => {
    const hasImageAttachments = Boolean(attachments?.some((attachment) => attachment.type === 'image'));
    if (!hasImageAttachments) return true;

    const visionNotice = getVisionCapabilityNotice(selectedComposerProvider, selectedComposerModel);
    if (visionNotice.support !== 'unsupported') return true;

    const providerLabel = CHAT_PROVIDER_LABELS[selectedComposerProvider];
    toast.error(`${providerLabel} · ${selectedComposerModel} cannot read image attachments yet.`);
    return false;
  }, [selectedComposerModel, selectedComposerProvider]);

  const handleComposerSend = useCallback((message: string, attachments?: AttachmentData[], options?: ChatSendOptions) => {
    if (!validateComposerAttachments(attachments)) return;
    markSnapshotActivity();

    if (editingUserMessageId) {
      const targetMessageId = editingUserMessageId;
      setEditingUserMessageId(null);
      return editMessageAndResend(targetMessageId, message, attachments, options);
    }

    return sendMessage(message, attachments, options);
  }, [editMessageAndResend, editingUserMessageId, markSnapshotActivity, sendMessage, validateComposerAttachments]);

  const handleQuickPrompt = useCallback((quickPrompt: QuickPrompt) => {
    const { text, displayText } = buildQuickPromptMessage(quickPrompt);
    return sendMessageWithSnapshotHeartbeat(text, undefined, { displayText });
  }, [sendMessageWithSnapshotHeartbeat]);

  const handleEditUserMessage = useCallback((messageId: string) => {
    const target = messages.find((message) => message.id === messageId && message.role === 'user' && !message.isToolResult);
    if (!target) return;

    setEditingUserMessageId(messageId);
    setComposerPrefillRequest({
      token: Date.now(),
      text: target.displayContent ?? target.content,
      attachments: target.attachments,
    });
  }, [messages]);

  const handleRegenerateLastResponse = useCallback(() => {
    setEditingUserMessageId(null);
    markSnapshotActivity();
    return regenerateLastResponse();
  }, [markSnapshotActivity, regenerateLastResponse]);

  useEffect(() => {
    if (!editingUserMessageId) return;
    const stillExists = messages.some((message) => message.id === editingUserMessageId && message.role === 'user' && !message.isToolResult);
    if (!stillExists) {
      setEditingUserMessageId(null);
    }
  }, [editingUserMessageId, messages]);

  const handleWorkspaceHubOpenChange = useCallback((open: boolean) => {
    if (open) {
      setIsChatsDrawerOpen(false);
    }
    setIsWorkspaceHubOpen(open);
  }, [setIsWorkspaceHubOpen]);

  const openWorkspaceHub = useCallback(() => {
    setIsChatsDrawerOpen(false);
    setIsWorkspaceHubOpen(true);
  }, [setIsWorkspaceHubOpen]);

  const openLauncher = useCallback(() => {
    setIsChatsDrawerOpen(false);
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
  const workspaceHubCapabilities: WorkspaceCapabilities = {
    canManageBranches: !isScratch && Boolean(activeRepo?.full_name),
    canBrowsePullRequests: !isScratch && Boolean(activeRepo?.full_name),
    canCommitAndPush: !isScratch && Boolean(activeRepo?.full_name),
  };
  const workspaceHubScratchActions: WorkspaceScratchActions | null = isScratch
    ? buildWorkspaceScratchActions({
      snapshots,
      sandboxStatus: sandbox.status,
      downloadingWorkspace: sandboxDownloading,
      onDownloadWorkspace: () => {
        void handleSandboxDownload();
      },
      emptyStateText: 'Save a snapshot or download your files from this workspace.',
    })
    : null;

  // Provider locked states
  const isOllamaModelLocked = isModelLocked && lockedProvider === 'ollama';
  const isZenModelLocked = isModelLocked && lockedProvider === 'zen';
  const isNvidiaModelLocked = isModelLocked && lockedProvider === 'nvidia';
  const isBlackboxModelLocked = isModelLocked && lockedProvider === 'blackbox';
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

        isConnected: isGitHubConnected,
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
    builtInProviders: {
      ollama: {
        hasKey: catalog.ollama.hasKey,
        model: catalog.ollama.model,
        setModel: catalog.ollama.setModel,
        modelOptions: catalog.ollamaModelOptions,
        modelsLoading: catalog.ollamaModels.loading,
        modelsError: catalog.ollamaModels.error,
        modelsUpdatedAt: catalog.ollamaModels.updatedAt,
        isModelLocked: isOllamaModelLocked,
        refreshModels: catalog.refreshOllamaModels,
        keyInput: catalog.ollama.keyInput,
        setKeyInput: catalog.ollama.setKeyInput,
        setKey: catalog.ollama.setKey,
        clearKey: catalog.ollama.clearKey,
      },
      openrouter: {
        hasKey: catalog.openRouter.hasKey,
        model: catalog.openRouter.model,
        setModel: catalog.openRouter.setModel,
        modelOptions: catalog.openRouterModelOptions,
        modelsLoading: catalog.openRouterModels.loading,
        modelsError: catalog.openRouterModels.error,
        modelsUpdatedAt: catalog.openRouterModels.updatedAt,
        isModelLocked: isProviderLocked && lockedProvider === 'openrouter',
        refreshModels: catalog.refreshOpenRouterModels,
        keyInput: catalog.openRouter.keyInput,
        setKeyInput: catalog.openRouter.setKeyInput,
        setKey: catalog.openRouter.setKey,
        clearKey: catalog.openRouter.clearKey,
      },
      nvidia: {
        hasKey: catalog.nvidia.hasKey,
        model: catalog.nvidia.model,
        setModel: catalog.nvidia.setModel,
        modelOptions: catalog.nvidiaModelOptions,
        modelsLoading: catalog.nvidiaModels.loading,
        modelsError: catalog.nvidiaModels.error,
        modelsUpdatedAt: catalog.nvidiaModels.updatedAt,
        isModelLocked: isNvidiaModelLocked,
        refreshModels: catalog.refreshNvidiaModels,
        keyInput: catalog.nvidia.keyInput,
        setKeyInput: catalog.nvidia.setKeyInput,
        setKey: catalog.nvidia.setKey,
        clearKey: catalog.nvidia.clearKey,
      },
      zen: {
        hasKey: catalog.zen.hasKey,
        model: catalog.zen.model,
        setModel: catalog.zen.setModel,
        modelOptions: catalog.zenModelOptions,
        modelsLoading: catalog.zenModels.loading,
        modelsError: catalog.zenModels.error,
        modelsUpdatedAt: catalog.zenModels.updatedAt,
        isModelLocked: isZenModelLocked,
        refreshModels: catalog.refreshZenModels,
        keyInput: catalog.zen.keyInput,
        setKeyInput: catalog.zen.setKeyInput,
        setKey: catalog.zen.setKey,
        clearKey: catalog.zen.clearKey,
        goMode: catalog.zenGoMode,
        setGoMode: catalog.setZenGoMode,
      },
      blackbox: {
        hasKey: catalog.blackbox.hasKey,
        model: catalog.blackbox.model,
        setModel: catalog.blackbox.setModel,
        modelOptions: catalog.blackboxModelOptions,
        modelsLoading: catalog.blackboxModels.loading,
        modelsError: catalog.blackboxModels.error,
        modelsUpdatedAt: catalog.blackboxModels.updatedAt,
        isModelLocked: isBlackboxModelLocked,
        refreshModels: catalog.refreshBlackboxModels,
        keyInput: catalog.blackbox.keyInput,
        setKeyInput: catalog.blackbox.setKeyInput,
        setKey: catalog.blackbox.setKey,
        clearKey: catalog.blackbox.clearKey,
      },
      kilocode: {
        hasKey: catalog.kilocode.hasKey,
        model: catalog.kilocode.model,
        setModel: catalog.kilocode.setModel,
        modelOptions: catalog.kilocodeModelOptions,
        modelsLoading: catalog.kilocodeModels.loading,
        modelsError: catalog.kilocodeModels.error,
        modelsUpdatedAt: catalog.kilocodeModels.updatedAt,
        isModelLocked: isModelLocked && lockedProvider === 'kilocode',
        refreshModels: catalog.refreshKilocodeModels,
        keyInput: catalog.kilocode.keyInput,
        setKeyInput: catalog.kilocode.setKeyInput,
        setKey: catalog.kilocode.setKey,
        clearKey: catalog.kilocode.clearKey,
      },
    },
    experimentalProviders: {
      azure: {
        hasKey: catalog.azure.hasKey,
        keyInput: catalog.azure.keyInput,
        setKeyInput: catalog.azure.setKeyInput,
        setKey: catalog.azure.setKey,
        clearKey: catalog.azure.clearKey,
        baseUrl: catalog.azure.baseUrl,
        baseUrlInput: catalog.azure.baseUrlInput,
        setBaseUrlInput: catalog.azure.setBaseUrlInput,
        baseUrlError: catalog.azure.baseUrlError,
        setBaseUrl: catalog.azure.setBaseUrl,
        clearBaseUrl: catalog.azure.clearBaseUrl,
        model: catalog.azure.model,
        modelInput: catalog.azure.modelInput,
        setModelInput: catalog.azure.setModelInput,
        setModel: catalog.azure.setModel,
        clearModel: catalog.azure.clearModel,
        deployments: catalog.azure.deployments,
        activeDeploymentId: catalog.azure.activeDeploymentId,
        saveDeployment: catalog.azure.saveDeployment,
        selectDeployment: catalog.azure.selectDeployment,
        removeDeployment: catalog.azure.removeDeployment,
        clearDeployments: catalog.azure.clearDeployments,
        deploymentLimitReached: catalog.azure.deploymentLimitReached,
        isConfigured: catalog.azure.isConfigured,
      },
      bedrock: {
        hasKey: catalog.bedrock.hasKey,
        keyInput: catalog.bedrock.keyInput,
        setKeyInput: catalog.bedrock.setKeyInput,
        setKey: catalog.bedrock.setKey,
        clearKey: catalog.bedrock.clearKey,
        baseUrl: catalog.bedrock.baseUrl,
        baseUrlInput: catalog.bedrock.baseUrlInput,
        setBaseUrlInput: catalog.bedrock.setBaseUrlInput,
        baseUrlError: catalog.bedrock.baseUrlError,
        setBaseUrl: catalog.bedrock.setBaseUrl,
        clearBaseUrl: catalog.bedrock.clearBaseUrl,
        model: catalog.bedrock.model,
        modelInput: catalog.bedrock.modelInput,
        setModelInput: catalog.bedrock.setModelInput,
        setModel: catalog.bedrock.setModel,
        clearModel: catalog.bedrock.clearModel,
        deployments: catalog.bedrock.deployments,
        activeDeploymentId: catalog.bedrock.activeDeploymentId,
        saveDeployment: catalog.bedrock.saveDeployment,
        selectDeployment: catalog.bedrock.selectDeployment,
        removeDeployment: catalog.bedrock.removeDeployment,
        clearDeployments: catalog.bedrock.clearDeployments,
        deploymentLimitReached: catalog.bedrock.deploymentLimitReached,
        isConfigured: catalog.bedrock.isConfigured,
      },
    },
    vertexProvider: {
      hasKey: catalog.vertex.hasKey,
      keyInput: catalog.vertex.keyInput,
      setKeyInput: catalog.vertex.setKeyInput,
      keyError: catalog.vertex.keyError,
      setKey: catalog.vertex.setKey,
      clearKey: catalog.vertex.clearKey,
      region: catalog.vertex.region,
      regionInput: catalog.vertex.regionInput,
      setRegionInput: catalog.vertex.setRegionInput,
      regionError: catalog.vertex.regionError,
      setRegion: catalog.vertex.setRegion,
      clearRegion: catalog.vertex.clearRegion,
      model: catalog.vertex.model,
      modelInput: catalog.vertex.modelInput,
      setModelInput: catalog.vertex.setModelInput,
      modelOptions: catalog.vertex.modelOptions,
      setModel: catalog.vertex.setModel,
      clearModel: catalog.vertex.clearModel,
      mode: catalog.vertex.mode,
      transport: catalog.vertex.transport,
      projectId: catalog.vertex.projectId,
      hasLegacyConfig: catalog.vertex.hasLegacyConfig,
      isConfigured: catalog.vertex.isConfigured,
    },
    tavilyProvider: {
      hasKey: catalog.tavily.hasKey,
      keyInput: catalog.tavily.keyInput,
      setKeyInput: catalog.tavily.setKeyInput,
      setKey: catalog.tavily.setKey,
      clearKey: catalog.tavily.clearKey,
    },
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
          <div className="flex h-[34px] min-w-0 items-center gap-1 pl-0.5 pr-1">
            <RepoChatDrawer
              open={isChatsDrawerOpen}
              onOpenChange={setIsChatsDrawerOpen}
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
                {isScratch ? (
                  <span className="hidden sm:inline">Workspace</span>
                ) : (
                  activeRepo?.name || 'Push'
                )}
              </p>
            </div>
          </div>
          {isScratch && (
              <>
                <span className="text-push-2xs text-push-fg-dim">ephemeral</span>
                {snapshots.latestSnapshot && (
                  <span
                    className={`hidden text-push-2xs sm:inline ${snapshotIsStale ? 'text-amber-400' : 'text-push-fg-dim'}`}
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
                    <span className="hidden sm:inline">Save</span>
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
                    <span className="hidden sm:inline">Restore</span>
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
        {(activeRepo || isScratch) && (
          <div className="flex min-w-0 justify-center">
            <button
              onClick={openLauncher}
              className={`${headerPillButtonClass} group min-w-0 max-w-full`}
              aria-label="Open launcher"
              title="Launcher"
            >
              <LauncherGridIcon className="relative z-10 h-3.5 w-3.5 text-push-fg-secondary transition-colors group-hover:text-push-fg" />
              <span className="relative z-10 max-w-[92px] truncate text-xs font-medium text-push-fg-secondary transition-colors group-hover:text-push-fg sm:max-w-[128px]">
                {isScratch ? 'Workspace' : currentBranch}
              </span>
            </button>
          </div>
        )}
        <div className="relative z-20 flex min-w-0 items-center justify-end gap-2">
          {(activeRepo || isScratch) && (
            <button
              onClick={() => openWorkspaceHub()}
              className={headerRoundButtonClass}
              aria-label="Open workspace hub"
              title="Workspace"
            >
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
        isInScratchWorkspace={Boolean(isScratch)}
        onStart={() => {
          if (isScratch) {
            void sandbox.start('', 'main');
          } else if (activeRepo) {
            void sandbox.start(activeRepo.full_name, activeRepo.current_branch || activeRepo.default_branch);
          }
        }}
        onRetry={() => void sandbox.refresh()}
        onNewSandbox={() => {
          if (isScratch) {
            void sandbox.stop().then(() => sandbox.start('', 'main'));
          } else if (activeRepo) {
            void sandbox.stop().then(() => sandbox.start(activeRepo.full_name, activeRepo.current_branch || activeRepo.default_branch));
          }
        }}
        onExitWorkspace={handleExitWorkspace}
      />

      {/* Sandbox expiry warning */}
      {isScratch && (
        <SandboxExpiryBanner
          createdAt={sandbox.createdAt}
          sandboxId={sandbox.sandboxId}
          sandboxStatus={sandbox.status}
          onRestart={handleSandboxRestart}
        />
      )}

      {!isScratch && activeRepo && instructions.projectInstructionsChecked && !instructions.projectInstructionsCheckFailed && !instructions.agentsMdContent && (
        <div className={`mx-4 mt-5 px-1 py-2.5 ${HUB_TOP_BANNER_STRIP_CLASS} border-push-edge/70`}>
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
        hasSandbox={Boolean(isScratch || activeRepo)}
        onSuggestion={handleQuickPrompt}
        onCardAction={handleCardActionWithSnapshotHeartbeat}
        onPin={pinnedArtifacts.pin}
        interruptedCheckpoint={interruptedCheckpoint}
        onResumeRun={resumeInterruptedRun}
        onDismissResume={dismissResume}
        ciStatus={ciStatus}
        onDiagnoseCI={diagnoseCIFailure}
        onEditUserMessage={!isStreaming ? handleEditUserMessage : undefined}
        onRegenerateLastResponse={!isStreaming ? handleRegenerateLastResponse : undefined}
      />

      {/* Input */}
      <ChatInput
        onSend={handleComposerSend}
        onStop={abortStream}
        isStreaming={isStreaming}
        repoName={activeRepo?.name}
        contextUsage={contextUsage}
        draftKey={activeChatId}
        prefillRequest={composerPrefillRequest}
        editState={editingUserMessageId ? {
          label: 'Editing an earlier message. Sending will replay the chat from here.',
          onCancel: cancelEditingUserMessage,
        } : null}
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
          blackboxModel: selectedChatModels.blackbox,
          blackboxModelOptions: catalog.blackboxModelOptions,
          blackboxModelsLoading: catalog.blackboxModels.loading,
          blackboxModelsError: catalog.blackboxModels.error,
          blackboxModelsUpdatedAt: catalog.blackboxModels.updatedAt,
          isBlackboxModelLocked,
          refreshBlackboxModels: catalog.refreshBlackboxModels,
          onSelectBlackboxModel: handleSelectBlackboxModelFromChat,
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
          if (isScratch) {
            void sandbox.start('', 'main');
          } else if (activeRepo) {
            void sandbox.start(activeRepo.full_name, activeRepo.current_branch || activeRepo.default_branch);
          }
        }}
        onRetrySandbox={() => void sandbox.refresh()}
        onNewSandbox={() => {
          if (isScratch) {
            void sandbox.stop().then(() => sandbox.start('', 'main'));
          } else if (activeRepo) {
            void sandbox.stop().then(() => sandbox.start(activeRepo.full_name, activeRepo.current_branch || activeRepo.default_branch));
          }
        }}
        reviewProviders={catalog.availableProviders}
        reviewActiveProvider={catalog.activeProviderLabel}
        reviewModelOptions={{
          ollama: catalog.ollamaModelOptions,
          openrouter: catalog.openRouterModelOptions,
          zen: catalog.zenModelOptions,
          nvidia: catalog.nvidiaModelOptions,
          vertex: catalog.vertex.modelOptions,
        }}
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
        sandboxSession={isScratch ? { status: sandbox.status, createdAt: sandbox.createdAt } : null}
        onStartWorkspace={handleStartWorkspace}
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
