import type { ComponentProps } from 'react';
import type {
  SettingsAIProps,
  SettingsAuthProps,
  SettingsDataProps,
  SettingsProfileProps,
  SettingsWorkspaceProps,
} from '@/components/SettingsSheet';
import { buildWorkspaceScratchActions, type SnapshotManager } from '@/hooks/useSnapshotManager';
import type { ChatRouteProps } from './workspace-chat-route-types';

type WorkspaceHubProps = ComponentProps<typeof import('@/components/chat/WorkspaceHubSheet').WorkspaceHubSheet>;
type RepoChatDrawerProps = ComponentProps<typeof import('@/components/chat/RepoChatDrawer').RepoChatDrawer>;
type RepoLauncherSheetProps = ComponentProps<typeof import('@/components/launcher/RepoLauncherSheet').RepoLauncherSheet>;

export function buildSettingsAuth(props: ChatRouteProps, onDisconnect: () => void): SettingsAuthProps {
  return {
    isConnected: Boolean(props.token),
    isAppAuth: props.isAppAuth,
    installationId: props.installationId ?? '',
    token: props.token ?? '',
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
    profile: props.profile,
    clearProfile: props.clearProfile,
    validatedUser: props.validatedUser,
  };
}

export function buildSettingsAI(props: ChatRouteProps): SettingsAIProps {
  const { catalog, isProviderLocked, isModelLocked, lockedProvider, lockedModel } = props;
  const isOllamaModelLocked = isModelLocked && lockedProvider === 'ollama';
  const isZenModelLocked = isModelLocked && lockedProvider === 'zen';
  const isNvidiaModelLocked = isModelLocked && lockedProvider === 'nvidia';
  const isBlackboxModelLocked = isModelLocked && lockedProvider === 'blackbox';
  const isKilocodeModelLocked = isModelLocked && lockedProvider === 'kilocode';
  const isOpenAdapterModelLocked = isModelLocked && lockedProvider === 'openadapter';

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
        isModelLocked: isKilocodeModelLocked,
        refreshModels: catalog.refreshKilocodeModels,
        keyInput: catalog.kilocode.keyInput,
        setKeyInput: catalog.kilocode.setKeyInput,
        setKey: catalog.kilocode.setKey,
        clearKey: catalog.kilocode.clearKey,
      },
      openadapter: {
        hasKey: catalog.openadapter.hasKey,
        model: catalog.openadapter.model,
        setModel: catalog.openadapter.setModel,
        modelOptions: catalog.openAdapterModelOptions,
        modelsLoading: catalog.openAdapterModels.loading,
        modelsError: catalog.openAdapterModels.error,
        modelsUpdatedAt: catalog.openAdapterModels.updatedAt,
        isModelLocked: isOpenAdapterModelLocked,
        refreshModels: catalog.refreshOpenAdapterModels,
        keyInput: catalog.openadapter.keyInput,
        setKeyInput: catalog.openadapter.setKeyInput,
        setKey: catalog.openadapter.setKey,
        clearKey: catalog.openadapter.clearKey,
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
}

export function buildSettingsWorkspace(props: ChatRouteProps): SettingsWorkspaceProps {
  return {
    approvalMode: props.approvalMode,
    updateApprovalMode: props.updateApprovalMode,
    contextMode: props.contextMode,
    updateContextMode: props.updateContextMode,
    sandboxStartMode: props.sandboxStartMode,
    updateSandboxStartMode: props.updateSandboxStartMode,
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
    activeRepoFullName: props.activeRepo?.full_name ?? null,
  };
}

export function buildSettingsData(props: ChatRouteProps): SettingsDataProps {
  return {
    activeRepo: props.activeRepo,
    deleteAllChats: props.deleteAllChats,
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
    zen: catalog.zenModelOptions,
    nvidia: catalog.nvidiaModelOptions,
    vertex: catalog.vertex.modelOptions,
  };
}

export function buildWorkspaceHubBranchProps(args: {
  activeRepo: ChatRouteProps['activeRepo'];
  displayBranches: RepoChatDrawerProps['availableBranches'];
  repoBranchesLoading: boolean;
  loadRepoBranches: (repoFullName: string) => Promise<void> | void;
  setCurrentBranch: ChatRouteProps['setCurrentBranch'];
  setShowBranchCreate: (open: boolean) => void;
  setShowMergeFlow: (open: boolean) => void;
  handleDeleteBranch: NonNullable<WorkspaceHubProps['branchProps']>['onDeleteBranch'];
}): WorkspaceHubProps['branchProps'] {
  const activeRepoFullName = args.activeRepo?.full_name;

  return {
    currentBranch: args.activeRepo?.current_branch || args.activeRepo?.default_branch,
    defaultBranch: args.activeRepo?.default_branch,
    availableBranches: args.displayBranches ?? [],
    branchesLoading: args.repoBranchesLoading,
    onSwitchBranch: args.setCurrentBranch,
    onRefreshBranches: activeRepoFullName
      ? () => { void args.loadRepoBranches(activeRepoFullName); }
      : () => {},
    onShowBranchCreate: () => args.setShowBranchCreate(true),
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
  handleSelectRepoFromDrawer: ChatRouteProps['handleSelectRepoFromDrawer'];
  switchChat: ChatRouteProps['switchChat'];
  handleCreateNewChatRequest: () => void;
  deleteChat: ChatRouteProps['deleteChat'];
  renameChat: ChatRouteProps['renameChat'];
  currentBranch: string | undefined;
  defaultBranch: string | undefined;
  setCurrentBranch: ChatRouteProps['setCurrentBranch'];
  displayBranches: RepoChatDrawerProps['availableBranches'];
  repoBranchesLoading: boolean;
  repoBranchesError: string | null;
  loadRepoBranches: (repoFullName: string) => Promise<void> | void;
  handleDeleteBranch: RepoChatDrawerProps['onDeleteBranch'];
}): RepoChatDrawerProps {
  const activeRepoFullName = args.activeRepo?.full_name;

  return {
    open: args.open,
    onOpenChange: args.setOpen,
    repos: args.repos,
    activeRepo: args.activeRepo,
    conversations: args.conversations,
    activeChatId: args.activeChatId ?? '',
    resolveRepoAppearance: args.resolveRepoAppearance,
    setRepoAppearance: args.setRepoAppearance,
    clearRepoAppearance: args.clearRepoAppearance,
    onSelectRepo: args.handleSelectRepoFromDrawer,
    onSwitchChat: args.switchChat,
    onNewChat: args.handleCreateNewChatRequest,
    onDeleteChat: args.deleteChat,
    onRenameChat: args.renameChat,
    currentBranch: args.currentBranch,
    defaultBranch: args.defaultBranch,
    setCurrentBranch: args.setCurrentBranch,
    availableBranches: args.displayBranches,
    branchesLoading: args.repoBranchesLoading,
    branchesError: args.repoBranchesError,
    onRefreshBranches: activeRepoFullName
      ? () => { void args.loadRepoBranches(activeRepoFullName); }
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
    sandboxSession: args.isScratch ? { status: args.sandboxStatus, createdAt: args.sandboxCreatedAt } : null,
    onStartWorkspace: args.handleStartWorkspace,
    onStartChat: args.handleStartChat,
  };
}
