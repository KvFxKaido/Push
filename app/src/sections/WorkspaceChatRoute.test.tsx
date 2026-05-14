import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatRouteProps } from './workspace-chat-route-types';

// Mock out the sub-components and controllers so the route can be exercised
// in isolation: we only want to verify that WorkspaceChatRoute wires its
// inputs through to ChatScreen and handles the scratch/repo branching.
const chatScreenSpy = vi.hoisted(() => vi.fn<(props?: unknown) => null>(() => null));
const toasterSpy = vi.hoisted(() => vi.fn(() => null));

vi.mock('./ChatScreen', () => ({
  ChatScreen: (props: unknown) => chatScreenSpy(props),
}));

vi.mock('@/components/ui/sonner', () => ({
  Toaster: () => toasterSpy(),
}));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  }),
}));

vi.mock('@/hooks/usePinnedArtifacts', () => ({
  usePinnedArtifacts: () => ({
    artifacts: [],
    pin: vi.fn(),
    unpin: vi.fn(),
    updateLabel: vi.fn(),
  }),
}));

vi.mock('@/hooks/useWorkspaceChatComposerController', () => ({
  useWorkspaceChatComposerController: () => ({
    composerPrefillRequest: null,
    editState: null,
    handleComposerSend: vi.fn(),
    handleQuickPrompt: vi.fn(),
    handleEditUserMessage: vi.fn(),
    handleRegenerateLastResponse: vi.fn(),
    handleCardActionWithSnapshotHeartbeat: vi.fn(),
    providerControls: {} as never,
  }),
}));

vi.mock('@/hooks/useWorkspaceChatPanelsController', () => ({
  useWorkspaceChatPanelsController: () => ({
    isWorkspaceHubOpen: false,
    isLauncherOpen: false,
    isChatsDrawerOpen: false,
    newChatSheetOpen: false,
    newChatWorkspaceState: null,
    checkingNewChatWorkspace: false,
    resettingWorkspaceForNewChat: false,
    hubTabRequest: null,
    setIsChatsDrawerOpen: vi.fn(),
    setIsLauncherOpen: vi.fn(),
    handleWorkspaceHubOpenChange: vi.fn(),
    openWorkspaceHub: vi.fn(),
    openLauncher: vi.fn(),
    handleNewChatSheetOpenChange: vi.fn(),
    handleCreateNewChatRequest: vi.fn(),
    handleContinueCurrentWorkspace: vi.fn(),
    handleReviewNewChatWorkspace: vi.fn(),
    handleStartFreshWorkspaceForNewChat: vi.fn(),
    handleExpiryWarningReached: vi.fn(),
    handleFixReviewFinding: vi.fn(),
    handleResumeConversationFromLauncher: vi.fn(),
    handleStartWorkspaceRequest: vi.fn(),
    handleExitWorkspaceRequest: vi.fn(),
    handleDisconnectRequest: vi.fn(),
  }),
}));

vi.mock('./workspace-chat-route-builders', () => ({
  buildRepoChatDrawerProps: () => ({}),
  buildRepoLauncherSheetProps: () => ({}),
  buildSettingsAI: () => ({}),
  buildSettingsAuth: () => ({}),
  buildSettingsData: () => ({}),
  buildSettingsProfile: () => ({}),
  buildSettingsWorkspace: () => ({}),
  buildWorkspaceHubBranchProps: () => ({}),
  buildWorkspaceHubCapabilities: () => ({}),
  buildWorkspaceHubReviewModelOptions: () => ({}),
  buildWorkspaceHubScratchActions: () => null,
}));

const { WorkspaceChatRoute } = await import('./WorkspaceChatRoute');

function baseProps(overrides: Partial<ChatRouteProps> = {}): ChatRouteProps {
  return {
    activeRepo: null,
    workspaceSession: null,
    resolveRepoAppearance: () => null as never,
    setRepoAppearance: vi.fn(),
    clearRepoAppearance: vi.fn(),
    handleWorkspacePromotion: vi.fn(),
    sandbox: {
      sandboxId: null,
      status: 'idle',
      error: null,
      createdAt: null,
      start: vi.fn(async () => null),
      stop: vi.fn(async () => {}),
      refresh: vi.fn(async () => false),
      markUnreachable: vi.fn(),
      hibernate: vi.fn(async () => false),
      forgetSnapshot: vi.fn(),
      snapshotInfo: null,
    },
    messages: [],
    sendMessage: vi.fn(),
    agentStatus: { active: false } as never,
    agentEvents: [],
    runEvents: [],
    isStreaming: false,
    queuedFollowUpCount: 0,
    pendingSteerCount: 0,
    lockedProvider: null,
    isProviderLocked: false,
    lockedModel: null,
    isModelLocked: false,
    conversations: {},
    activeChatId: null,
    switchChat: vi.fn(),
    renameChat: vi.fn(),
    deleteChat: vi.fn(),
    deleteAllChats: vi.fn(),
    clearMemoryByRepo: vi.fn(),
    clearMemoryByBranch: vi.fn(),
    regenerateLastResponse: vi.fn(),
    editMessageAndResend: vi.fn(),
    handleCardAction: vi.fn(),
    contextUsage: { used: 0, max: 1, percent: 0 },
    abortStream: vi.fn(),
    interruptedCheckpoint: null,
    resumeInterruptedRun: vi.fn(),
    dismissResume: vi.fn(),
    saveExpiryCheckpoint: vi.fn(),
    ciStatus: null,
    diagnoseCIFailure: vi.fn(),
    forkBranchFromUI: vi.fn(async () => ({ ok: true as const })),
    repos: [],
    reposLoading: false,
    reposError: null,
    branches: {
      currentBranch: 'main',
      displayBranches: [],
      repoBranchesLoading: false,
      repoBranchesError: null,
      showBranchCreate: false,
      setShowBranchCreate: vi.fn(),
      showMergeFlow: false,
      setShowMergeFlow: vi.fn(),
      loadRepoBranches: vi.fn(),
      handleDeleteBranch: vi.fn(),
    } as never,
    catalog: { availableProviders: [], activeProviderLabel: 'kilocode' } as never,
    selectedChatProvider: null,
    selectedChatModels: {} as never,
    handleSelectBackend: vi.fn(),
    handleSelectOllamaModelFromChat: vi.fn(),
    handleSelectOpenRouterModelFromChat: vi.fn(),
    handleSelectCloudflareModelFromChat: vi.fn(),
    handleSelectZenModelFromChat: vi.fn(),
    handleSelectNvidiaModelFromChat: vi.fn(),
    handleSelectBlackboxModelFromChat: vi.fn(),
    handleSelectKilocodeModelFromChat: vi.fn(),
    handleSelectOpenAdapterModelFromChat: vi.fn(),
    handleSelectAzureModelFromChat: vi.fn(),
    handleSelectBedrockModelFromChat: vi.fn(),
    handleSelectVertexModelFromChat: vi.fn(),
    handleSelectRepoFromDrawer: vi.fn(),
    snapshots: {
      latestSnapshot: null,
      markSnapshotActivity: vi.fn(),
      captureSnapshot: vi.fn(),
      handleRestoreFromSnapshot: vi.fn(),
      snapshotSaving: false,
      snapshotRestoring: false,
      snapshotRestoreProgress: null,
    } as never,
    instructions: {
      projectInstructionsChecked: false,
      projectInstructionsCheckFailed: false,
      agentsMdContent: null,
      creatingAgentsMd: false,
      creatingAgentsMdWithAI: false,
      handleCreateAgentsMd: vi.fn(),
      handleCreateAgentsMdWithAI: vi.fn(),
    } as never,
    scratchpad: {
      content: '',
      hasContent: false,
      setContent: vi.fn(),
      clear: vi.fn(),
      memories: [],
      activeMemoryId: null,
      saveMemory: vi.fn(),
      loadMemory: vi.fn(),
      deleteMemory: vi.fn(),
    },
    todo: {
      todos: [],
      clear: vi.fn(),
    },
    protectMain: {
      isProtected: false,
      globalDefault: false,
      setGlobalDefault: vi.fn(),
      repoOverride: 'inherit',
      setRepoOverride: vi.fn(),
    },
    token: null,
    patToken: null,
    isAppAuth: false,
    installationId: null,
    validatedUser: null,
    appLoading: false,
    appError: null,
    connectApp: vi.fn(),
    installApp: vi.fn(),
    setInstallationIdManually: vi.fn(async () => true),
    showToolActivity: false,
    approvalMode: 'supervised',
    updateApprovalMode: vi.fn(),
    contextMode: 'graceful',
    updateContextMode: vi.fn(),
    sandboxStartMode: 'smart',
    updateSandboxStartMode: vi.fn(),
    updateShowToolActivity: vi.fn(),
    showInstallIdInput: false,
    setShowInstallIdInput: vi.fn(),
    installIdInput: '',
    setInstallIdInput: vi.fn(),
    allowlistSecretCmd: '',
    copyAllowlistCommand: vi.fn(),
    profile: {
      displayName: '',
      bio: '',
      chatInstructions: '',
      githubLogin: '',
    } as never,
    updateProfile: vi.fn(),
    clearProfile: vi.fn(),
    displayNameDraft: '',
    setDisplayNameDraft: vi.fn(),
    handleDisplayNameBlur: vi.fn(),
    bioDraft: '',
    setBioDraft: vi.fn(),
    handleBioBlur: vi.fn(),
    chatInstructionsDraft: '',
    setChatInstructionsDraft: vi.fn(),
    handleChatInstructionsBlur: vi.fn(),
    handleStartWorkspace: vi.fn(),
    handleStartChat: vi.fn(),
    handleStartLocalPc: vi.fn(),
    handleStartRelay: vi.fn(),
    handleExitWorkspace: vi.fn(),
    handleDisconnect: vi.fn(),
    handleCreateNewChat: vi.fn(),
    inspectNewChatWorkspace: vi.fn(async () => null),
    handleSandboxRestart: vi.fn(async () => {}),
    handleSandboxDownload: vi.fn(async () => {}),
    sandboxDownloading: false,
    sandboxState: null,
    sandboxStateLoading: false,
    fetchSandboxState: vi.fn(),
    setCurrentBranch: vi.fn(),
    ensureSandbox: vi.fn(async () => null),
    ...overrides,
  };
}

beforeEach(() => {
  chatScreenSpy.mockClear();
  toasterSpy.mockClear();
});

describe('WorkspaceChatRoute', () => {
  it('renders ChatScreen and the Toaster with repo workspace props', () => {
    const props = baseProps({
      activeRepo: {
        id: 'repo-1',
        name: 'my-app',
        full_name: 'owner/my-app',
        default_branch: 'main',
        current_branch: 'main',
      } as never,
    });
    props.branches = {
      ...props.branches,
      currentBranch: 'main',
    };

    renderToStaticMarkup(<WorkspaceChatRoute {...props} />);

    expect(chatScreenSpy).toHaveBeenCalledTimes(1);
    expect(toasterSpy).toHaveBeenCalledTimes(1);

    const [args] = chatScreenSpy.mock.calls[0] as [
      {
        workspace: { isScratch: boolean; activeRepo: { name: string } | null };
        shell: { launcherLabel: string | undefined };
        approvalMode?: string;
      },
    ];
    expect(args.workspace.isScratch).toBe(false);
    expect(args.workspace.activeRepo?.name).toBe('my-app');
    expect(args.shell.launcherLabel).toBe('main');
    expect(args.approvalMode).toBe('supervised');
  });

  it('flags the workspace as scratch when the session kind is scratch', () => {
    const props = baseProps({
      workspaceSession: { kind: 'scratch' } as never,
    });

    renderToStaticMarkup(<WorkspaceChatRoute {...props} />);

    const [args] = chatScreenSpy.mock.calls[0] as [
      { workspace: { isScratch: boolean }; shell: { launcherLabel: string } },
    ];
    expect(args.workspace.isScratch).toBe(true);
    expect(args.shell.launcherLabel).toBe('Workspace');
  });

  it('cycles approval mode supervised → autonomous on invocation', () => {
    const updateApprovalMode = vi.fn();
    const props = baseProps({
      approvalMode: 'supervised',
      updateApprovalMode,
    });

    renderToStaticMarkup(<WorkspaceChatRoute {...props} />);

    const [args] = chatScreenSpy.mock.calls[0] as [{ onCycleApprovalMode?: () => void }];
    args.onCycleApprovalMode?.();

    expect(updateApprovalMode).toHaveBeenCalledWith('autonomous');
  });

  it('wraps from full-auto back to supervised', () => {
    const updateApprovalMode = vi.fn();
    const props = baseProps({
      approvalMode: 'full-auto',
      updateApprovalMode,
    });

    renderToStaticMarkup(<WorkspaceChatRoute {...props} />);

    const [args] = chatScreenSpy.mock.calls[0] as [{ onCycleApprovalMode?: () => void }];
    args.onCycleApprovalMode?.();

    expect(updateApprovalMode).toHaveBeenCalledWith('supervised');
  });
});
