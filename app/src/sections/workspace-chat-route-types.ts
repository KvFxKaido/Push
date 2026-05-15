import type { ApprovalMode } from '@/lib/approval-mode';
import type { ContextMode } from '@/lib/orchestrator';
import type { PreferredProvider } from '@/lib/providers';
import type { RepoAppearance } from '@/lib/repo-appearance';
import type { SandboxStartMode } from '@/lib/sandbox-start-mode';
import type { BranchManager } from '@/hooks/useBranchManager';
import type { ModelCatalog } from '@/hooks/useModelCatalog';
import type { ProjectInstructionsManager } from '@/hooks/useProjectInstructions';
import type { RepoOverride } from '@/hooks/useProtectMain';
import type { ScratchpadMemory } from '@/hooks/useScratchpad';
import type { TodoItem } from '@/lib/todo-tools';
import type { SnapshotManager } from '@/hooks/useSnapshotManager';
import type { SandboxStatus } from '@/hooks/useSandbox';
import type {
  ActiveRepo,
  AgentStatus,
  AgentStatusEvent,
  AIProviderType,
  AttachmentData,
  CardAction,
  ChatMessage,
  ChatSendOptions,
  CIStatus,
  Conversation,
  GitHubUser,
  NewChatWorkspaceState,
  RepoWithActivity,
  RunEvent,
  RunCheckpoint,
  SandboxStateCardData,
  UserProfile,
  WorkspaceSession,
} from '@/types';

export interface ChatRouteWorkspaceProps {
  activeRepo: ActiveRepo | null;
  workspaceSession?: WorkspaceSession | null;
  resolveRepoAppearance: (repoFullName?: string | null) => RepoAppearance;
  setRepoAppearance: (repoFullName: string, appearance: RepoAppearance) => void;
  clearRepoAppearance: (repoFullName: string) => void;
  handleWorkspacePromotion: (
    repo: ActiveRepo,
    branch?: string,
    sandboxIdOverride?: string | null,
  ) => void;
  sandbox: {
    sandboxId: string | null;
    status: SandboxStatus;
    error: string | null;
    createdAt: number | null;
    start: (repo: string, branch?: string) => Promise<string | null>;
    stop: () => Promise<void>;
    refresh: () => Promise<boolean>;
    markUnreachable: (reason: string) => void;
    hibernate: () => Promise<boolean>;
    forgetSnapshot: () => void;
    snapshotInfo: { snapshotId: string; createdAt: number } | null;
  };
  handleStartWorkspace: (() => void) | undefined;
  handleStartChat: (() => void) | undefined;
  handleStartLocalPc: (() => void) | undefined;
  handleStartRelay: (() => void) | undefined;
  handleExitWorkspace: () => void;
  handleDisconnect: () => void;
  handleCreateNewChat: () => void;
  inspectNewChatWorkspace: () => Promise<NewChatWorkspaceState | null>;
  handleSandboxRestart: () => Promise<void>;
  handleSandboxDownload: () => Promise<void>;
  sandboxDownloading: boolean;
  setCurrentBranch: (branch: string) => void;
  /** Slice 2.1: UI-initiated fork. Calls sandbox_create_branch tool path
   *  then dispatches the resulting payload through applyBranchSwitchPayload
   *  so conversation migration fires the same way as model-initiated forks. */
  forkBranchFromUI: (
    name: string,
    from?: string,
  ) => Promise<import('@/lib/fork-branch-in-workspace').ForkBranchInWorkspaceResult>;
  /** UI-initiated post-merge migration. Dispatches a `kind: 'merged'`
   *  BranchSwitchPayload through `applyBranchSwitchPayload`, so the active
   *  chat migrates to the default branch instead of being filtered out by
   *  the auto-switch effect. Called by `MergeFlowSheet` after a successful
   *  PR merge — the chat follows on branch switches but explicitly
   *  follows on merge too, just without auto-bumping the user to a fresh
   *  conversation. */
  mergeBranchInUI: (toBranch: string, opts?: { from?: string; prNumber?: number }) => void;
  sandboxState: SandboxStateCardData | null;
  sandboxStateLoading: boolean;
  fetchSandboxState: (id: string) => void;
  ensureSandbox: () => Promise<string | null>;
}

export interface ChatRouteConversationProps {
  messages: ChatMessage[];
  sendMessage: (
    message: string,
    attachments?: AttachmentData[],
    options?: ChatSendOptions,
  ) => Promise<void> | void;
  agentStatus: AgentStatus;
  agentEvents: AgentStatusEvent[];
  runEvents: RunEvent[];
  isStreaming: boolean;
  queuedFollowUpCount: number;
  pendingSteerCount: number;
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
  clearMemoryByRepo: () => void;
  clearMemoryByBranch: () => void;
  regenerateLastResponse: () => Promise<void> | void;
  editMessageAndResend: (
    messageId: string,
    text: string,
    attachments?: AttachmentData[],
    options?: ChatSendOptions,
  ) => Promise<void> | void;
  handleCardAction: (action: CardAction) => void;
  contextUsage: { used: number; max: number; percent: number };
  abortStream: (options?: { clearQueuedFollowUps?: boolean }) => void;
  interruptedCheckpoint: RunCheckpoint | null;
  resumeInterruptedRun: () => void;
  dismissResume: () => void;
  saveExpiryCheckpoint: (savedDiff: string) => void;
  ciStatus: CIStatus | null;
  diagnoseCIFailure: () => void;
}

export interface ChatRouteRepositoryProps {
  repos: RepoWithActivity[];
  reposLoading: boolean;
  reposError: string | null;
  branches: BranchManager;
  handleSelectRepoFromDrawer: (repo: RepoWithActivity, branch?: string) => void;
}

export interface ChatRouteCatalogProps {
  catalog: ModelCatalog;
  selectedChatProvider: PreferredProvider | null;
  selectedChatModels: Record<PreferredProvider, string>;
  handleSelectBackend: (provider: PreferredProvider) => void;
  handleSelectOllamaModelFromChat: (model: string) => void;
  handleSelectOpenRouterModelFromChat: (model: string) => void;
  handleSelectCloudflareModelFromChat: (model: string) => void;
  handleSelectZenModelFromChat: (model: string) => void;
  handleSelectNvidiaModelFromChat: (model: string) => void;
  handleSelectBlackboxModelFromChat: (model: string) => void;
  handleSelectKilocodeModelFromChat: (model: string) => void;
  handleSelectOpenAdapterModelFromChat: (model: string) => void;
  handleSelectAzureModelFromChat: (model: string) => void;
  handleSelectBedrockModelFromChat: (model: string) => void;
  handleSelectVertexModelFromChat: (model: string) => void;
}

export interface ChatRouteWorkspaceDataProps {
  snapshots: SnapshotManager;
  instructions: ProjectInstructionsManager;
  scratchpad: {
    content: string;
    hasContent: boolean;
    setContent: (content: string) => void;
    clear: () => void;
    memories: ScratchpadMemory[];
    activeMemoryId: string | null;
    saveMemory: (label: string) => void;
    loadMemory: (id: string | null) => void;
    deleteMemory: (id: string) => void;
  };
  todo: {
    todos: readonly TodoItem[];
    clear: () => void;
  };
  protectMain: {
    isProtected: boolean;
    globalDefault: boolean;
    setGlobalDefault: (value: boolean) => void;
    repoOverride: RepoOverride;
    setRepoOverride: (value: RepoOverride) => void;
  };
}

export interface ChatRouteAuthProps {
  token: string | null;
  patToken: string | null;
  isAppAuth: boolean;
  installationId: string | null;
  validatedUser: GitHubUser | null;
  appLoading: boolean;
  appError: string | null;
  connectApp: () => void;
  installApp: () => void;
  setInstallationIdManually: (id: string) => Promise<boolean>;
}

export interface ChatRouteUiStateProps {
  showToolActivity: boolean;
  approvalMode: ApprovalMode;
  updateApprovalMode: (mode: ApprovalMode) => void;
  contextMode: ContextMode;
  updateContextMode: (mode: ContextMode) => void;
  sandboxStartMode: SandboxStartMode;
  updateSandboxStartMode: (mode: SandboxStartMode) => void;
  updateShowToolActivity: (value: boolean) => void;
  showInstallIdInput: boolean;
  setShowInstallIdInput: (value: boolean) => void;
  installIdInput: string;
  setInstallIdInput: (value: string) => void;
  allowlistSecretCmd: string;
  copyAllowlistCommand: () => void;
}

export interface ChatRouteProfileProps {
  profile: UserProfile;
  updateProfile: (updates: Partial<UserProfile>) => void;
  clearProfile: () => void;
  displayNameDraft: string;
  setDisplayNameDraft: (value: string) => void;
  handleDisplayNameBlur: () => void;
  bioDraft: string;
  setBioDraft: (value: string) => void;
  handleBioBlur: () => void;
  chatInstructionsDraft: string;
  setChatInstructionsDraft: (value: string) => void;
  handleChatInstructionsBlur: () => void;
}

export type ChatRouteProps = ChatRouteWorkspaceProps &
  ChatRouteConversationProps &
  ChatRouteRepositoryProps &
  ChatRouteCatalogProps &
  ChatRouteWorkspaceDataProps &
  ChatRouteAuthProps &
  ChatRouteUiStateProps &
  ChatRouteProfileProps;
