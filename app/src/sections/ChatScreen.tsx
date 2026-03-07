import { useCallback, Suspense } from 'react';
import { Loader2, Download, Save, RotateCcw, GitBranch, GitMerge, ChevronDown, Check, Trash2, PanelRight } from 'lucide-react';
import { BranchWaveIcon } from '@/components/icons/push-custom-icons';
import { Toaster } from '@/components/ui/sonner';
import { ChatContainer } from '@/components/chat/ChatContainer';
import { ChatInput } from '@/components/chat/ChatInput';
import { RepoChatDrawer } from '@/components/chat/RepoChatDrawer';
import { WorkspaceHubSheet } from '@/components/chat/WorkspaceHubSheet';
import { SandboxExpiryBanner } from '@/components/chat/SandboxExpiryBanner';
import { BranchCreateSheet } from '@/components/chat/BranchCreateSheet';
import { MergeFlowSheet } from '@/components/chat/MergeFlowSheet';
import { LazySettingsSheet as SettingsSheet } from '@/components/LazySettingsSheet';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { PreferredProvider } from '@/lib/providers';
import type { SandboxStatus } from '@/hooks/useSandbox';
import { formatSnapshotAge, isSnapshotStale, snapshotStagePercent } from '@/hooks/useSnapshotManager';
import type { ModelCatalog } from '@/hooks/useModelCatalog';
import type { SnapshotManager } from '@/hooks/useSnapshotManager';
import type { BranchManager } from '@/hooks/useBranchManager';
import type { ProjectInstructionsManager } from '@/hooks/useProjectInstructions';
import type { RepoOverride } from '@/hooks/useProtectMain';
import type { ScratchpadMemory } from '@/hooks/useScratchpad';
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
  sendMessage: (message: string, attachments?: AttachmentData[]) => void;
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
    loadMemory: (id: string) => void;
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

  // Settings
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  settingsTab: 'you' | 'workspace' | 'ai';
  setSettingsTab: (tab: 'you' | 'workspace' | 'ai') => void;
  handleOpenSettingsFromDrawer: (tab: 'you' | 'workspace' | 'ai') => void;
  handleDisconnect: () => void;

  // Sandbox controls
  handleSandboxRestart: () => Promise<void>;
  handleSandboxDownload: () => Promise<void>;
  sandboxDownloading: boolean;

  // Provider/model selection from chat
  handleSelectBackend: (provider: PreferredProvider) => void;
  handleSelectOllamaModelFromChat: (model: string) => void;
  handleSelectOpenRouterModelFromChat: (model: string) => void;
  handleSelectZenModelFromChat: (model: string) => void;
  handleSelectNvidiaModelFromChat: (model: string) => void;

  // Repo selection
  handleSelectRepoFromDrawer: (repo: RepoWithActivity) => void;
  handleBrowseRepos: () => void;
  setCurrentBranch: (branch: string) => void;

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
    settingsOpen,
    setSettingsOpen,
    settingsTab,
    setSettingsTab,
    handleOpenSettingsFromDrawer,
    handleDisconnect,
    handleSandboxRestart,
    handleSandboxDownload,
    sandboxDownloading,
    handleSelectBackend,
    handleSelectOllamaModelFromChat,
    handleSelectOpenRouterModelFromChat,
    handleSelectZenModelFromChat,
    handleSelectNvidiaModelFromChat,
    handleSelectRepoFromDrawer,
    handleBrowseRepos,
    setCurrentBranch,
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

  const {
    currentBranch,
    isOnMain,
    displayBranches,
    repoBranchesLoading,
    repoBranchesError,
    branchMenuOpen,
    setBranchMenuOpen,
    pendingDeleteBranch,
    setPendingDeleteBranch,
    deletingBranch,
    showBranchCreate,
    setShowBranchCreate,
    showMergeFlow,
    setShowMergeFlow,
    loadRepoBranches,
    handleDeleteBranch,
  } = branches;

  const isConnected = Boolean(token) || isDemo || isSandboxMode;

  // Destructure stable function refs to avoid depending on the whole object
  const { markSnapshotActivity } = snapshots;

  // Snapshot heartbeat wrappers
  const sendMessageWithSnapshotHeartbeat = useCallback((message: string, attachments?: AttachmentData[]) => {
    markSnapshotActivity();
    return sendMessage(message, attachments);
  }, [markSnapshotActivity, sendMessage]);

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

  // Settings sheet (lazy-loaded)
  const settingsSheet = (
    <Suspense fallback={null}>
    <SettingsSheet
      open={settingsOpen}
      onOpenChange={setSettingsOpen}
      side="left"
      settingsTab={settingsTab}
      setSettingsTab={setSettingsTab}
      auth={{
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
      }}
      profile={{
        displayNameDraft,
        setDisplayNameDraft,
        onDisplayNameBlur: handleDisplayNameBlur,
        bioDraft,
        setBioDraft,
        onBioBlur: handleBioBlur,
        profile,
        clearProfile,
        validatedUser,
      }}
      ai={{
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
        hasTavilyKey: catalog.tavily.hasKey,
        tavilyKeyInput: catalog.tavily.keyInput,
        setTavilyKeyInput: catalog.tavily.setKeyInput,
        setTavilyKey: catalog.tavily.setKey,
        clearTavilyKey: catalog.tavily.clearKey,
      }}
      workspace={{
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
      }}
      data={{
        activeRepo,
        deleteAllChats,
      }}
    />
    </Suspense>
  );

  return (
    <div className="flex h-dvh flex-col bg-[#000] safe-area-top safe-area-bottom">
      {/* Top bar */}
      <header className="relative z-10 flex items-center justify-between px-3 pt-3 pb-2">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <div className="relative flex min-w-0 items-center gap-1.5 overflow-hidden rounded-full border border-[#1b2230] bg-push-grad-input py-1.5 pl-1.5 pr-3 shadow-[0_12px_34px_rgba(0,0,0,0.5),0_3px_10px_rgba(0,0,0,0.28)] backdrop-blur-xl">
            <div className="pointer-events-none absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/[0.05] to-transparent" />
            <RepoChatDrawer
              repos={repos}
              activeRepo={activeRepo}
              conversations={conversations}
              activeChatId={activeChatId ?? ''}
              onSelectRepo={handleSelectRepoFromDrawer}
              onSwitchChat={switchChat}
              onNewChat={handleCreateNewChat}
              onDeleteChat={deleteChat}
              onRenameChat={renameChat}
              onOpenSettings={handleOpenSettingsFromDrawer}
              onBrowseRepos={handleBrowseRepos}
              onSandboxMode={isSandboxMode ? undefined : handleSandboxMode}
              isSandboxMode={isSandboxMode}
              onExitSandboxMode={handleExitSandboxMode}
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
            <div className="min-w-0">
              <p className="truncate text-xs font-semibold text-[#f5f7ff]">
                {isSandboxMode ? 'Sandbox' : activeRepo?.name || 'Push'}
              </p>
            </div>
          </div>
          {isSandboxMode && (
              <>
                <span className="text-[10px] text-push-fg-dim">ephemeral</span>
                {snapshots.latestSnapshot && (
                  <span
                    className={`text-[10px] ${snapshotIsStale ? 'text-amber-400' : 'text-[#5f6b80]'}`}
                    title={`Latest snapshot: ${new Date(snapshots.latestSnapshot.createdAt).toLocaleString()}`}
                  >
                    {snapshotIsStale ? `snapshot stale (${snapshotAgeLabel})` : `snapshot ${snapshotAgeLabel}`}
                  </span>
                )}
                {sandbox.status === 'ready' && (
                  <button
                    onClick={() => snapshots.captureSnapshot('manual')}
                    disabled={snapshots.snapshotSaving || snapshots.snapshotRestoring}
                    className="flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] text-push-fg-dim transition-colors hover:bg-[#0d1119] hover:text-emerald-400 active:scale-95 disabled:opacity-50"
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
                    className="flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] text-push-fg-dim transition-colors hover:bg-[#0d1119] hover:text-emerald-400 active:scale-95 disabled:opacity-50"
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
                    className="flex h-7 w-7 items-center justify-center rounded-lg text-push-fg-dim transition-colors hover:bg-[#0d1119] hover:text-emerald-400 active:scale-95 disabled:opacity-50"
                    title="Download workspace"
                    aria-label="Download workspace"
                  >
                    {sandboxDownloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                  </button>
                )}
                {snapshots.snapshotRestoring && snapshots.snapshotRestoreProgress && (
                  <div className="flex min-w-[120px] flex-col gap-1">
                    <span className="text-[10px] text-push-fg-muted">{snapshots.snapshotRestoreProgress.message}</span>
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
        {/* Centered branch selector for chat mode */}
        {activeRepo && !isSandboxMode && (
          <div className="pointer-events-none absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2">
            <DropdownMenu
              open={branchMenuOpen}
              onOpenChange={(open) => {
                setBranchMenuOpen(open);
                if (!open) {
                  setPendingDeleteBranch(null);
                }
                if (open && !repoBranchesLoading && displayBranches.length === 0) {
                  void loadRepoBranches(activeRepo.full_name);
                }
              }}
            >
              <DropdownMenuTrigger className="pointer-events-auto flex items-center gap-1 rounded-full border border-[#1b2230] bg-push-grad-input px-2 py-1 shadow-[0_10px_28px_rgba(0,0,0,0.45),0_2px_8px_rgba(0,0,0,0.25)] backdrop-blur-xl transition-all hover:border-[#31425a] hover:brightness-110">
                <BranchWaveIcon className="h-3 w-3 text-[#5f6b80]" />
                <span className="max-w-[100px] truncate text-[10px] font-medium text-[#8b96aa]">
                  {currentBranch}
                </span>
                <ChevronDown className={`h-3 w-3 text-[#5f6b80] transition-transform ${branchMenuOpen ? 'rotate-180' : ''}`} />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="center"
                sideOffset={8}
                className="w-[240px] rounded-xl border border-push-edge bg-push-grad-card shadow-[0_18px_40px_rgba(0,0,0,0.62)]"
              >
                {isOnMain ? (
                  <DropdownMenuItem
                    onSelect={() => setShowBranchCreate(true)}
                    className="mx-1 flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-push-fg-secondary hover:bg-[#0d1119]"
                  >
                    <GitBranch className="h-3.5 w-3.5" />
                    Create branch
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem
                    onSelect={() => setShowMergeFlow(true)}
                    className="mx-1 flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-emerald-300 hover:bg-[#0d1119]"
                  >
                    <GitMerge className="h-3.5 w-3.5" />
                    Merge into {activeRepo.default_branch}
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator className="bg-push-edge" />
                <DropdownMenuLabel className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-push-fg-dim">
                  Switch Branch
                </DropdownMenuLabel>
                <DropdownMenuSeparator className="bg-push-edge" />

                {repoBranchesLoading && (
                  <DropdownMenuItem disabled className="mx-1 flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-push-fg-dim">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Loading branches...
                  </DropdownMenuItem>
                )}

                {!repoBranchesLoading && repoBranchesError && (
                  <>
                    <DropdownMenuItem disabled className="mx-1 rounded-lg px-3 py-2 text-xs text-red-400">
                      Failed to load branches
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={(e) => {
                        e.preventDefault();
                        void loadRepoBranches(activeRepo.full_name);
                      }}
                      className="mx-1 rounded-lg px-3 py-2 text-xs text-push-link hover:bg-[#0d1119]"
                    >
                      Retry
                    </DropdownMenuItem>
                  </>
                )}

                {!repoBranchesLoading && !repoBranchesError && displayBranches.length === 0 && (
                  <DropdownMenuItem disabled className="mx-1 rounded-lg px-3 py-2 text-xs text-push-fg-dim">
                    No branches found
                  </DropdownMenuItem>
                )}

                {!repoBranchesLoading && !repoBranchesError && displayBranches.map((branch) => {
                  const isActiveBranch = branch.name === currentBranch;
                  const canDeleteBranch = !isActiveBranch && !branch.isDefault && !branch.isProtected;
                  const isDeletePending = pendingDeleteBranch === branch.name;
                  const isDeletingThisBranch = deletingBranch === branch.name;
                  return (
                    <div key={branch.name}>
                      <DropdownMenuItem
                        onSelect={(e) => {
                          if (isActiveBranch) {
                            e.preventDefault();
                            return;
                          }
                          setPendingDeleteBranch(null);
                          setCurrentBranch(branch.name);
                        }}
                        className={`mx-1 flex items-center gap-2 rounded-lg px-3 py-2 ${
                          isActiveBranch ? 'bg-[#101621]' : 'hover:bg-[#0d1119]'
                        }`}
                      >
                        <span className={`min-w-0 flex-1 truncate text-xs ${isActiveBranch ? 'text-push-fg' : 'text-push-fg-secondary'}`}>
                          {branch.name}
                        </span>
                        {branch.isDefault && (
                          <span className="rounded-full bg-[#0d2847] px-1.5 py-0.5 text-[10px] text-[#58a6ff]">
                            default
                          </span>
                        )}
                        {branch.isProtected && (
                          <span className="rounded-full bg-[#2a1a1a] px-1.5 py-0.5 text-[10px] text-[#fca5a5]">
                            protected
                          </span>
                        )}
                        {isActiveBranch && <Check className="h-3.5 w-3.5 text-push-link" />}
                      </DropdownMenuItem>
                      {canDeleteBranch && (
                        <DropdownMenuItem
                          onSelect={(e) => {
                            e.preventDefault();
                            if (isDeletingThisBranch || deletingBranch) return;
                            if (!isDeletePending) {
                              setPendingDeleteBranch(branch.name);
                              return;
                            }
                            void handleDeleteBranch(branch.name);
                          }}
                          className={`mx-1 mb-1 flex items-center gap-2 rounded-lg px-3 py-1.5 text-[11px] ${
                            isDeletePending
                              ? 'bg-red-950/30 text-red-300 hover:bg-red-950/40'
                              : 'text-push-fg-dim hover:bg-[#0d1119] hover:text-red-300'
                          }`}
                        >
                          {isDeletingThisBranch ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                          {isDeletingThisBranch
                            ? `Deleting ${branch.name}...`
                            : isDeletePending
                            ? `Confirm delete ${branch.name}`
                            : `Delete ${branch.name}`}
                        </DropdownMenuItem>
                      )}
                    </div>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
        <div className="flex items-center gap-2">
          {(activeRepo || isSandboxMode) && (
            <button
              onClick={() => setIsWorkspaceHubOpen(true)}
              className="relative flex h-8 w-8 items-center justify-center rounded-full border border-[#1b2230] bg-push-grad-input text-[#8891a1] shadow-[0_10px_26px_rgba(0,0,0,0.45),0_2px_8px_rgba(0,0,0,0.24)] backdrop-blur-xl transition-all duration-200 hover:border-[#31425a] hover:text-[#e2e8f0] hover:brightness-110 spring-press"
              aria-label="Open workspace hub"
              title="Workspace"
            >
              <PanelRight className="h-4 w-4" />
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

      {/* Sandbox error banner */}
      {sandbox.status === 'error' && sandbox.error && (
        <div className="mx-4 mt-2 rounded-xl border border-red-500/20 bg-red-500/5 px-3.5 py-3 flex items-center justify-between gap-2 animate-fade-in-down">
          <p className="text-xs text-red-400 min-w-0 truncate">{sandbox.error}</p>
          <div className="flex items-center gap-2 shrink-0">
            {sandbox.sandboxId && (
              <button
                onClick={() => void sandbox.refresh()}
                className="text-xs font-medium text-amber-300 hover:text-amber-200 transition-colors"
              >
                Refresh
              </button>
            )}
            <button
              onClick={() => {
                if (isSandboxMode) {
                  void sandbox.start('', 'main');
                } else if (activeRepo) {
                  void sandbox.stop().then(() => sandbox.start(activeRepo.full_name, activeRepo.current_branch || activeRepo.default_branch));
                }
              }}
              className="text-xs font-medium text-red-300 hover:text-red-200 transition-colors"
            >
              Restart
            </button>
            {isSandboxMode && (
              <button
                onClick={handleExitSandboxMode}
                className="text-xs font-medium text-[#71717a] hover:text-[#a1a1aa] transition-colors"
              >
                Exit
              </button>
            )}
          </div>
        </div>
      )}

      {/* Sandbox expiry warning */}
      {isSandboxMode && (
        <SandboxExpiryBanner
          createdAt={sandbox.createdAt}
          sandboxId={sandbox.sandboxId}
          sandboxStatus={sandbox.status}
          onRestart={handleSandboxRestart}
        />
      )}

      {!isSandboxMode && activeRepo && instructions.projectInstructionsChecked && !instructions.agentsMdContent && (
        <div className="mx-4 mt-3 rounded-xl border border-push-edge bg-push-grad-card px-3.5 py-3.5 shadow-push-card animate-fade-in-down">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-medium text-[#e4e4e7]">No AGENTS.md found</p>
              <p className="text-[11px] text-push-fg-muted">Add project instructions so the agent understands your repo conventions.</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                onClick={instructions.handleCreateAgentsMdWithAI}
                disabled={instructions.creatingAgentsMdWithAI || isStreaming}
                className="rounded-lg border border-emerald-600/35 bg-emerald-900/20 px-3 py-1.5 text-xs font-medium text-emerald-300 transition-colors hover:bg-emerald-900/30 disabled:opacity-50"
              >
                {instructions.creatingAgentsMdWithAI ? 'Drafting...' : 'Create with AI'}
              </button>
              <button
                onClick={instructions.handleCreateAgentsMd}
                disabled={instructions.creatingAgentsMd || instructions.creatingAgentsMdWithAI}
                className="rounded-lg border border-[#243148] bg-[#0b1220] px-3 py-1.5 text-xs font-medium text-[#8ad4ff] transition-colors hover:bg-[#0d1526] disabled:opacity-50"
              >
                {instructions.creatingAgentsMd ? 'Creating...' : 'Create Template'}
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
          activeProvider: catalog.activeProviderLabel,
          activeBackend: catalog.activeBackend,
          availableProviders: catalog.availableProviders,
          isProviderLocked,
          lockedProvider,
          lockedModel,
          onSelectBackend: handleSelectBackend,
          ollamaModel: catalog.ollama.model,
          ollamaModelOptions: catalog.ollamaModelOptions,
          ollamaModelsLoading: catalog.ollamaModels.loading,
          ollamaModelsError: catalog.ollamaModels.error,
          ollamaModelsUpdatedAt: catalog.ollamaModels.updatedAt,
          isOllamaModelLocked,
          refreshOllamaModels: catalog.refreshOllamaModels,
          onSelectOllamaModel: handleSelectOllamaModelFromChat,
          openRouterModel: catalog.openRouter.model,
          openRouterModelOptions: catalog.openRouterModelOptions,
          isOpenRouterModelLocked: isProviderLocked && lockedProvider === 'openrouter',
          onSelectOpenRouterModel: handleSelectOpenRouterModelFromChat,
          zenModel: catalog.zen.model,
          zenModelOptions: catalog.zenModelOptions,
          zenModelsLoading: catalog.zenModels.loading,
          zenModelsError: catalog.zenModels.error,
          zenModelsUpdatedAt: catalog.zenModels.updatedAt,
          isZenModelLocked,
          refreshZenModels: catalog.refreshZenModels,
          onSelectZenModel: handleSelectZenModelFromChat,
          nvidiaModel: catalog.nvidia.model,
          nvidiaModelOptions: catalog.nvidiaModelOptions,
          nvidiaModelsLoading: catalog.nvidiaModels.loading,
          nvidiaModelsError: catalog.nvidiaModels.error,
          nvidiaModelsUpdatedAt: catalog.nvidiaModels.updatedAt,
          isNvidiaModelLocked,
          refreshNvidiaModels: catalog.refreshNvidiaModels,
          onSelectNvidiaModel: handleSelectNvidiaModelFromChat,
        }}
      />

      <WorkspaceHubSheet
        open={isWorkspaceHubOpen}
        onOpenChange={setIsWorkspaceHubOpen}
        messages={messages}
        agentEvents={agentEvents}
        sandboxId={sandbox.sandboxId}
        sandboxStatus={sandbox.status}
        ensureSandbox={ensureSandbox}
        repoName={activeRepo?.name || (isSandboxMode ? 'Sandbox' : undefined)}
        protectMainEnabled={protectMain.isProtected}
        showToolActivity={showToolActivity}
        scratchpadContent={scratchpad.content}
        scratchpadMemories={scratchpad.memories}
        activeMemoryId={scratchpad.activeMemoryId}
        onScratchpadContentChange={scratchpad.setContent}
        onScratchpadClear={scratchpad.clear}
        onScratchpadSaveMemory={scratchpad.saveMemory}
        onScratchpadLoadMemory={(id) => {
          if (!id) return;
          scratchpad.loadMemory(id);
        }}
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
      />

      {/* Toast notifications */}
      <Toaster position="bottom-center" />

      {/* Settings Sheet */}
      {settingsSheet}

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
          setCurrentBranch={setCurrentBranch}
        />
      )}
    </div>
  );
}
