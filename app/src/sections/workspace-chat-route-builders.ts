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
    cloudflare: catalog.cloudflareModelOptions,
    zen: catalog.zenModelOptions,
    nvidia: catalog.nvidiaModelOptions,
    kilocode: catalog.kilocodeModelOptions,
    fireworks: catalog.fireworksModelOptions,
    sakana: catalog.sakanaModelOptions,
    deepseek: catalog.deepseekModelOptions,
    vertex: catalog.vertex.modelOptions,
    google: catalog.googleModelOptions,
  };
}

export function buildWorkspaceHubBranchProps(args: {
  activeRepo: ChatRouteProps['activeRepo'];
  displayBranches: RepoChatDrawerProps['availableBranches'];
  repoBranchesLoading: boolean;
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
  currentBranch: string | undefined;
  defaultBranch: string | undefined;
  setCurrentBranch: ChatRouteProps['setCurrentBranch'];
  switchBranchFromUI: ChatRouteProps['switchBranchFromUI'];
  displayBranches: RepoChatDrawerProps['availableBranches'];
  repoBranchesLoading: boolean;
  repoBranchesError: string | null;
  loadRepoBranches: (repoFullName: string) => Promise<void> | void;
  handleDeleteBranch: RepoChatDrawerProps['onDeleteBranch'];
}): RepoChatDrawerProps {
  const activeRepoFullName = args.activeRepo?.full_name;

  // ChatSurfaceRoute and WorkspaceChatRoute route taps through
  // `App.handleResumeChatFromDrawer`, which only handles chat / scratch
  // / repo conversations. local-pc / relay chats fall through to a
  // no-op there, so surfacing them in these drawers would render dead
  // rows (the tap closes the drawer but the workspace doesn't switch
  // and the chat doesn't resume). Filter them out at the builder so
  // both routes share the guard. DaemonChatBody constructs its own
  // drawer props and isn't affected.
  const conversationsForDrawer: typeof args.conversations = {};
  for (const [id, conv] of Object.entries(args.conversations)) {
    if (conv.mode === 'local-pc' || conv.mode === 'relay') continue;
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
    currentBranch: args.currentBranch,
    defaultBranch: args.defaultBranch,
    setCurrentBranch: args.setCurrentBranch,
    switchBranchFromUI: args.switchBranchFromUI,
    availableBranches: args.displayBranches,
    branchesLoading: args.repoBranchesLoading,
    branchesError: args.repoBranchesError,
    onRefreshBranches: activeRepoFullName
      ? () => {
          void args.loadRepoBranches(activeRepoFullName);
        }
      : undefined,
    onDeleteBranch: args.handleDeleteBranch,
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
  handleStartLocalPc?: () => void;
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
    onStartLocalPc: args.handleStartLocalPc,
    onStartRelay: args.handleStartRelay,
    onDisconnect: args.handleDisconnect,
    user: args.validatedUser,
    mode: args.mode,
  };
}
