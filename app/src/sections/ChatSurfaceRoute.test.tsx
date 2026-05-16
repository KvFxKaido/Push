import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatRouteProps } from './workspace-chat-route-types';

const chatSurfaceScreenSpy = vi.hoisted(() => vi.fn<(props?: unknown) => null>(() => null));
const toasterSpy = vi.hoisted(() => vi.fn(() => null));

vi.mock('./ChatSurfaceScreen', () => ({
  ChatSurfaceScreen: (props: unknown) => chatSurfaceScreenSpy(props),
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
    hubTabRequest: null,
    setIsChatsDrawerOpen: vi.fn(),
    setIsLauncherOpen: vi.fn(),
    handleWorkspaceHubOpenChange: vi.fn(),
    openWorkspaceHub: vi.fn(),
    openLauncher: vi.fn(),
    handleFixReviewFinding: vi.fn(),
    handleResumeConversationFromLauncher: vi.fn(),
    handleStartWorkspaceRequest: vi.fn(),
    handleDisconnectRequest: vi.fn(),
    newChatSheetOpen: false,
    newChatWorkspaceState: null,
    checkingNewChatWorkspace: false,
    resettingWorkspaceForNewChat: false,
    handleNewChatSheetOpenChange: vi.fn(),
    handleCreateNewChatRequest: vi.fn(),
    handleContinueCurrentWorkspace: vi.fn(),
    handleReviewNewChatWorkspace: vi.fn(),
    handleStartFreshWorkspaceForNewChat: vi.fn(),
    handleExpiryWarningReached: vi.fn(),
    handleExitWorkspaceRequest: vi.fn(),
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
  buildWorkspaceHubReviewModelOptions: () => ({}),
}));

const { ChatSurfaceRoute } = await import('./ChatSurfaceRoute');

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
    mergeBranchInUI: vi.fn(),
    repos: [],
    reposLoading: false,
    reposError: null,
    branches: {} as never,
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
    handleSelectAnthropicModelFromChat: vi.fn(),
    handleSelectOpenAIModelFromChat: vi.fn(),
    handleSelectGoogleModelFromChat: vi.fn(),
    handleSelectRepoFromDrawer: vi.fn(),
    snapshots: {
      markSnapshotActivity: vi.fn(),
    } as never,
    instructions: {} as never,
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
    profile: {} as never,
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
  chatSurfaceScreenSpy.mockClear();
  toasterSpy.mockClear();
});

describe('ChatSurfaceRoute', () => {
  it('renders ChatSurfaceScreen with chat-mode container props and mounts the Toaster', () => {
    renderToStaticMarkup(<ChatSurfaceRoute {...baseProps()} />);

    expect(chatSurfaceScreenSpy).toHaveBeenCalledTimes(1);
    expect(toasterSpy).toHaveBeenCalledTimes(1);

    const [args] = chatSurfaceScreenSpy.mock.calls[0] as [
      {
        containerProps: {
          isChat: boolean;
          hasSandbox: boolean;
          onEditUserMessage?: unknown;
          onRegenerateLastResponse?: unknown;
        };
        inputProps: { placeholder: string; isStreaming: boolean };
      },
    ];
    expect(args.containerProps.isChat).toBe(true);
    expect(args.containerProps.hasSandbox).toBe(false);
    expect(args.inputProps.placeholder).toBe('Message');
    expect(args.inputProps.isStreaming).toBe(false);
    // When not streaming, edit/regenerate callbacks are passed through.
    expect(args.containerProps.onEditUserMessage).toBeTypeOf('function');
    expect(args.containerProps.onRegenerateLastResponse).toBeTypeOf('function');
  });

  it('omits edit/regenerate callbacks while streaming', () => {
    renderToStaticMarkup(<ChatSurfaceRoute {...baseProps({ isStreaming: true })} />);

    const [args] = chatSurfaceScreenSpy.mock.calls[0] as [
      {
        containerProps: {
          onEditUserMessage?: unknown;
          onRegenerateLastResponse?: unknown;
        };
        inputProps: { isStreaming: boolean };
      },
    ];
    expect(args.containerProps.onEditUserMessage).toBeUndefined();
    expect(args.containerProps.onRegenerateLastResponse).toBeUndefined();
    expect(args.inputProps.isStreaming).toBe(true);
  });

  it('forwards the active chat id as the draft key so local drafts scope to the conversation', () => {
    renderToStaticMarkup(<ChatSurfaceRoute {...baseProps({ activeChatId: 'chat-42' })} />);

    const [args] = chatSurfaceScreenSpy.mock.calls[0] as [
      { inputProps: { draftKey: string | null } },
    ];
    expect(args.inputProps.draftKey).toBe('chat-42');
  });
});
