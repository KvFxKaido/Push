import type { ComponentProps } from 'react';
import type {
  SettingsAIProps,
  SettingsAuthProps,
  SettingsDataProps,
  SettingsProfileProps,
  SettingsWorkspaceProps,
} from '@/components/SettingsSheet';
import { buildSettingsBuiltInProviders } from '@/components/settings-built-in-provider-builder';
import { buildWorkspaceScratchActions, type SnapshotManager } from '@/hooks/useSnapshotManager';
import { hapticMedium } from '@/lib/android/haptics';
import type { ChatRouteProps } from './workspace-chat-route-types';

type WorkspaceHubProps = ComponentProps<
  typeof import('@/components/chat/WorkspaceHubSheet').WorkspaceHubSheet
>;
type RepoChatDrawerProps = ComponentProps<
  typeof import('@/components/chat/RepoChatDrawer').RepoChatDrawer
>;
type RepoLauncherSheetProps = ComponentProps<
  typeof import('@/components/launcher/RepoLauncherSheet').RepoLauncherSheet
>;

// Branch-option shape, owned here now that the drawer is out of the branch
// business (it no longer renders a switcher). The Workspace hub is the
// canonical branch surface; this type feeds its branch props.
type BranchOption = { name: string; isDefault: boolean; isProtected: boolean };

export function buildSettingsAuth(
  props: ChatRouteProps,
  onDisconnect: () => void,
): SettingsAuthProps {
  return {
    isConnected: Boolean(props.token),
    isAppAuth: props.isAppAuth,
    installationId: props.installationId ?? '',
    token: props.token ?? '',
    tokenKind: props.tokenKind,
    patToken: props.patToken ?? '',
    validatedUser: props.validatedUser,
    appLoading: props.appLoading,
    appError: props.appError,
    connectApp: props.connectApp,
    installApp: props.installApp,
    showInstallIdInput: props.showInstallIdInput,
    setShowInstallIdInput: props.setShowInstallIdInput,
    installIdInput: props.installIdInput,
    setInstallIdInput: props.setInstallIdInput,
    setInstallationIdManually: props.setInstallationIdManually,
    allowlistSecretCmd: props.allowlistSecretCmd,
    copyAllowlistCommand: props.copyAllowlistCommand,
    onDisconnect,
  };
}

export function buildSettingsProfile(props: ChatRouteProps): SettingsProfileProps {
  return {
    displayNameDraft: props.displayNameDraft,
    setDisplayNameDraft: props.setDisplayNameDraft,
    onDisplayNameBlur: props.handleDisplayNameBlur,
    bioDraft: props.bioDraft,
    setBioDraft: props.setBioDraft,
    onBioBlur: props.handleBioBlur,
    chatInstructionsDraft: props.chatInstructionsDraft,
    setChatInstructionsDraft: props.setChatInstructionsDraft,
    onChatInstructionsBlur: props.handleChatInstructionsBlur,
    profile: props.profile,
    clearProfile: props.clearProfile,
    validatedUser: props.validatedUser,
  };
}

export function buildSettingsAI(props: ChatRouteProps): SettingsAIProps {
  const { catalog, isProviderLocked, isModelLocked, lockedProvider, lockedModel } = props;
  const isCloudflareModelLocked = isModelLocked && lockedProvider === 'cloudflare';

  return {
    activeProviderLabel: catalog.activeProviderLabel,
    activeBackend: catalog.activeBackend,
    setActiveBackend: catalog.setActiveBackend,
    isProviderLocked,
    lockedProvider,
    lockedModel,
    availableProviders: catalog.availableProviders,
    setPreferredProvider: catalog.setPreferredProvider,
    clearPreferredProvider: catalog.clearPreferredProvider,
    builtInProviders: buildSettingsBuiltInProviders({
      catalog,
      isProviderLocked,
      lockedProvider,
      isModelLocked,
    }),
    cloudflareProvider: {
      configured: catalog.cloudflare.configured,
      statusLoading: catalog.cloudflare.statusLoading,
      statusError: catalog.cloudflare.statusError,
      model: catalog.cloudflare.model,
      setModel: catalog.cloudflare.setModel,
      modelOptions: catalog.cloudflareModelOptions,
      modelsLoading: catalog.cloudflareModels.loading,
      modelsError: catalog.cloudflareModels.error,
      modelsUpdatedAt: catalog.cloudflareModels.updatedAt,
      isModelLocked: isCloudflareModelLocked,
      refreshModels: catalog.refreshCloudflareModels,
    },
    tavilyProvider: {
      hasKey: catalog.tavily.hasKey,
      keyInput: catalog.tavily.keyInput,
      setKeyInput: catalog.tavily.setKeyInput,
      setKey: catalog.tavily.setKey,
      clearKey: catalog.tavily.clearKey,
    },
  };
}

export function buildSettingsWorkspace(props: ChatRouteProps): SettingsWorkspaceProps {
  return {
    approvalMode: props.approvalMode,
    updateApprovalMode: props.updateApprovalMode,
    sandboxStatus: props.sandbox.status,
    sandboxId: props.sandbox.sandboxId,
    sandboxError: props.sandbox.error,
    sandboxState: props.sandboxState,
    sandboxStateLoading: props.sandboxStateLoading,
    fetchSandboxState: props.fetchSandboxState,
    protectMainGlobal: props.protectMain.globalDefault,
    setProtectMainGlobal: props.protectMain.setGlobalDefault,
    protectMainRepoOverride: props.protectMain.repoOverride,
    setProtectMainRepoOverride: props.protectMain.setRepoOverride,
    showToolActivity: props.showToolActivity,
    setShowToolActivity: props.updateShowToolActivity,
    providerFailover: props.providerFailover,
    setProviderFailover: props.updateProviderFailover,
    runTokenBudget: props.runTokenBudget,
    setRunTokenBudget: props.updateRunTokenBudget,
    activeRepoFullName: props.activeRepo?.full_name ?? null,
  };
}

export function buildSettingsData(props: ChatRouteProps): SettingsDataProps {
  return {
    activeRepo: props.activeRepo,
    activeBranch: props.activeRepo?.current_branch ?? null,
    deleteAllChats: props.deleteAllChats,
    clearMemoryByRepo: props.clearMemoryByRepo,
    clearMemoryByBranch: props.clearMemoryByBranch,
  };
}

export function buildWorkspaceHubCapabilities(
  isScratch: boolean,
  activeRepo: ChatRouteProps['activeRepo'],
): WorkspaceHubProps['capabilities'] {
  return {
    canManageBranches: !isScratch && Boolean(activeRepo?.full_name),
    canBrowsePullRequests: !isScratch && Boolean(activeRepo?.full_name),
    canCommitAndPush: !isScratch && Boolean(activeRepo?.full_name),
  };
}

export function buildWorkspaceHubScratchActions(args: {
  isScratch: boolean;
  snapshots: SnapshotManager;
  sandboxStatus: ChatRouteProps['sandbox']['status'];
  sandboxDownloading: boolean;
  onDownloadWorkspace: () => void;
}): WorkspaceHubProps['scratchActions'] {
  if (!args.isScratch) return null;
  return buildWorkspaceScratchActions({
    snapshots: args.snapshots,
    sandboxStatus: args.sandboxStatus,
    downloadingWorkspace: args.sandboxDownloading,
    onDownloadWorkspace: args.onDownloadWorkspace,
    emptyStateText: 'Save a snapshot or download your files from this workspace.',
  });
}

export function buildWorkspaceHubReviewModelOptions(
  catalog: ChatRouteProps['catalog'],
): WorkspaceHubProps['reviewModelOptions'] {
  return {
    ollama: catalog.ollamaModelOptions,
    openrouter: catalog.openRouterModelOptions,
    zai: catalog.zaiModelOptions,
    kimi: catalog.kimiModelOptions,
    huggingface: catalog.huggingfaceModelOptions,
    cloudflare: catalog.cloudflareModelOptions,
    zen: catalog.zenModelOptions,
    nvidia: catalog.nvidiaModelOptions,
    fireworks: catalog.fireworksModelOptions,
    sakana: catalog.sakanaModelOptions,
    deepseek: catalog.deepseekModelOptions,
    xai: catalog.xaiModelOptions,
    google: catalog.googleModelOptions,
  };
}

export function buildWorkspaceHubBranchProps(args: {
  activeRepo: ChatRouteProps['activeRepo'];
  displayBranches: BranchOption[] | undefined;
  repoBranchesLoading: boolean;
  repoBranchesError: string | null;
  loadRepoBranches: (repoFullName: string) => Promise<void> | void;
  setCurrentBranch: ChatRouteProps['setCurrentBranch'];
  switchBranchFromUI: ChatRouteProps['switchBranchFromUI'];
  setShowBranchCreate: (open: boolean) => void;
  setShowBranchFork: (open: boolean) => void;
  setShowMergeFlow: (open: boolean) => void;
  handleDeleteBranch: NonNullable<WorkspaceHubProps['branchProps']>['onDeleteBranch'];
}): WorkspaceHubProps['branchProps'] {
  const activeRepoFullName = args.activeRepo?.full_name;

  return {
    currentBranch: args.activeRepo?.current_branch || args.activeRepo?.default_branch,
    defaultBranch: args.activeRepo?.default_branch,
    availableBranches: args.displayBranches ?? [],
    branchesLoading: args.repoBranchesLoading,
    branchesError: args.repoBranchesError,
    // A firmer tap on a branch switch — a committed context change (no-op on web).
    onSwitchBranch: (branch) => {
      hapticMedium();
      args.setCurrentBranch(branch);
    },
    onWarmSwitchBranch: (branch) => {
      hapticMedium();
      return args.switchBranchFromUI(branch);
    },
    onRefreshBranches: activeRepoFullName
      ? () => {
          void args.loadRepoBranches(activeRepoFullName);
        }
      : () => {},
    onShowBranchCreate: () => args.setShowBranchCreate(true),
    onShowBranchFork: () => args.setShowBranchFork(true),
    onShowMergeFlow: () => args.setShowMergeFlow(true),
    onDeleteBranch: args.handleDeleteBranch,
  };
}

export function buildRepoChatDrawerProps(args: {
  open: boolean;
  setOpen: (open: boolean) => void;
  repos: ChatRouteProps['repos'];
  activeRepo: ChatRouteProps['activeRepo'];
  conversations: ChatRouteProps['conversations'];
  activeChatId: string | null;
  resolveRepoAppearance: ChatRouteProps['resolveRepoAppearance'];
  setRepoAppearance: ChatRouteProps['setRepoAppearance'];
  clearRepoAppearance: ChatRouteProps['clearRepoAppearance'];
  handleResumeChatFromDrawer: ChatRouteProps['handleResumeChatFromDrawer'];
  handleCreateNewChatRequest: () => void;
  deleteChat: ChatRouteProps['deleteChat'];
  renameChat: ChatRouteProps['renameChat'];
  /** Live daemon sessions from `useConnectedCliSessions` (paired remote
   * daemon), rendered in the drawer's Connected section. Optional —
   * omitted means the section never renders. */
  cliSessions?: RepoChatDrawerProps['cliSessions'];
  cliSessionsLabel?: RepoChatDrawerProps['cliSessionsLabel'];
  /** Tap-to-resume handler for Connected rows; undefined → read-only. */
  onResumeCliSession?: RepoChatDrawerProps['onResumeCliSession'];
}): RepoChatDrawerProps {
  // ChatSurfaceRoute and WorkspaceChatRoute route taps through
  // `App.handleResumeChatFromDrawer`, which only handles chat / scratch
  // / repo conversations. Relay chats fall through to a
  // no-op there, so surfacing them in these drawers would render dead
  // rows (the tap closes the drawer but the workspace doesn't switch
  // and the chat doesn't resume). Filter them out at the builder so
  // both routes share the guard. DaemonChatBody constructs its own
  // drawer props and isn't affected.
  const conversationsForDrawer: typeof args.conversations = {};
  for (const [id, conv] of Object.entries(args.conversations)) {
    if (conv.mode === 'relay') continue;
    conversationsForDrawer[id] = conv;
  }

  return {
    open: args.open,
    onOpenChange: args.setOpen,
    repos: args.repos,
    activeRepo: args.activeRepo,
    conversations: conversationsForDrawer,
    activeChatId: args.activeChatId ?? '',
    resolveRepoAppearance: args.resolveRepoAppearance,
    setRepoAppearance: args.setRepoAppearance,
    clearRepoAppearance: args.clearRepoAppearance,
    onResumeChat: args.handleResumeChatFromDrawer,
    onNewChat: args.handleCreateNewChatRequest,
    onDeleteChat: args.deleteChat,
    onRenameChat: args.renameChat,
    cliSessions: args.cliSessions,
    cliSessionsLabel: args.cliSessionsLabel,
    onResumeCliSession: args.onResumeCliSession,
  };
}

export function buildRepoLauncherSheetProps(args: {
  open: boolean;
  setOpen: (open: boolean) => void;
  repos: ChatRouteProps['repos'];
  reposLoading: boolean;
  reposError: string | null;
  conversations: ChatRouteProps['conversations'];
  activeRepo: ChatRouteProps['activeRepo'];
  resolveRepoAppearance: ChatRouteProps['resolveRepoAppearance'];
  setRepoAppearance: ChatRouteProps['setRepoAppearance'];
  clearRepoAppearance: ChatRouteProps['clearRepoAppearance'];
  handleSelectRepoFromDrawer: ChatRouteProps['handleSelectRepoFromDrawer'];
  handleResumeConversationFromLauncher: (chatId: string) => void;
  isScratch: boolean;
  sandboxStatus: ChatRouteProps['sandbox']['status'];
  sandboxCreatedAt: ChatRouteProps['sandbox']['createdAt'];
  handleStartWorkspace?: () => void;
  handleStartChat?: () => void;
  handleStartRelay?: () => void;
  handleDisconnect: () => void;
  validatedUser: ChatRouteProps['validatedUser'];
  mode?: 'default' | 'chat';
}): RepoLauncherSheetProps {
  return {
    open: args.open,
    onOpenChange: args.setOpen,
    repos: args.repos,
    loading: args.reposLoading,
    error: args.reposError,
    conversations: args.conversations,
    activeRepo: args.activeRepo,
    resolveRepoAppearance: args.resolveRepoAppearance,
    setRepoAppearance: args.setRepoAppearance,
    clearRepoAppearance: args.clearRepoAppearance,
    onSelectRepo: args.handleSelectRepoFromDrawer,
    onResumeConversation: args.handleResumeConversationFromLauncher,
    sandboxSession: args.isScratch
      ? { status: args.sandboxStatus, createdAt: args.sandboxCreatedAt }
      : null,
    onStartWorkspace: args.handleStartWorkspace,
    onStartChat: args.handleStartChat,
    onStartRelay: args.handleStartRelay,
    onDisconnect: args.handleDisconnect,
    user: args.validatedUser,
    mode: args.mode,
  };
}
