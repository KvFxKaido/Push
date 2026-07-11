import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { ApprovalMode } from '@/lib/approval-mode';
import { Toaster } from '@/components/ui/sonner';
import { BranchSwitchConfirm } from '@/components/chat/BranchSwitchConfirm';
import { formatSnapshotAge, isSnapshotStale } from '@/hooks/useSnapshotManager';
import { nativeCheckpointsActive } from '@/lib/checkpoint/checkpoint-store';
import { useBackHandler } from '@/hooks/useBackHandler';
import { useConnectedCliSessions } from '@/hooks/useConnectedCliSessions';
import { usePinnedArtifacts } from '@/hooks/usePinnedArtifacts';
import { useMergeDetectedBanner } from '@/hooks/useMergeDetectedBanner';
import { useWorkspaceChatComposerController } from '@/hooks/useWorkspaceChatComposerController';
import { useWorkspaceChatPanelsController } from '@/hooks/useWorkspaceChatPanelsController';
import { getSandboxConnectivityToast } from '@/lib/sandbox-connectivity-notifications';
import { getChatShellNav, resolveNavMode } from '@/lib/nav-transition';
import type { BranchSwitchProbe } from '@/lib/branch-switch-probe';
import { getRepoAppearanceColorHex, hexToRgba } from '@/lib/repo-appearance';
import { getSandboxDiff } from '@/lib/sandbox-client';
import { executeSandboxToolCall } from '@/lib/sandbox-tools';
import {
  resolveCommitForkFromBranch,
  runCommitSwitchConfirmAction,
  runCommitSwitchDefaultAction,
} from '@/lib/commit-card-branch-actions';
import { cleanWorkspacePublishMessage } from '@/lib/workspace-publish';
import type { CardAction, DaemonCliSession } from '@/types';
import { ChatScreen } from './ChatScreen';
import {
  buildRepoChatDrawerProps,
  buildRepoLauncherSheetProps,
  buildSettingsAI,
  buildSettingsAuth,
  buildSettingsData,
  buildSettingsProfile,
  buildSettingsWorkspace,
  buildWorkspaceHubBranchProps,
  buildWorkspaceHubCapabilities,
  buildWorkspaceHubReviewModelOptions,
  buildWorkspaceHubScratchActions,
} from './workspace-chat-route-builders';
import type { ChatRouteProps } from './workspace-chat-route-types';

const BranchCreateSheet = lazy(() =>
  import('@/components/chat/BranchCreateSheet').then((module) => ({
    default: module.BranchCreateSheet,
  })),
);
const BranchForkSheet = lazy(() =>
  import('@/components/chat/BranchForkSheet').then((module) => ({
    default: module.BranchForkSheet,
  })),
);
const MergeFlowSheet = lazy(() =>
  import('@/components/chat/MergeFlowSheet').then((module) => ({ default: module.MergeFlowSheet })),
);
const WorkspaceHubSheet = lazy(() =>
  import('@/components/chat/WorkspaceHubSheet').then((module) => ({
    default: module.WorkspaceHubSheet,
  })),
);
const RepoLauncherSheet = lazy(() =>
  import('@/components/launcher/RepoLauncherSheet').then((module) => ({
    default: module.RepoLauncherSheet,
  })),
);

export function WorkspaceChatRoute(props: ChatRouteProps) {
  // Native shell recovers from the on-device checkpoint, not a cloud snapshot —
  // so the hub's hibernate/restore/forget affordances are hidden there (the
  // useSandbox cloud-snapshot paths are gated off by the same predicate).
  const cloudSnapshotsHidden = nativeCheckpointsActive();
  const {
    activeRepo,
    workspaceSession,
    resolveRepoAppearance,
    setRepoAppearance,
    clearRepoAppearance,
    handleWorkspacePromotion,
    sandbox,
    messages,
    sendMessage,
    agentStatus,
    agentEvents,
    runEvents,
    isStreaming,
    queuedFollowUpCount,
    pendingSteerCount,
    lockedProvider,
    isProviderLocked,
    lockedModel,
    isModelLocked,
    conversations,
    activeChatId,
    switchChat,
    renameChat,
    // `setChatLinkedLibraries` is accepted by the route prop type for
    // parity with chat mode but not surfaced here — repo/scratch
    // surfaces use the git repo (or scratch dir) as their durable
    // context, so libraries aren't wired into the composer. Leaving
    // it un-destructured is intentional.
    deleteChat,
    regenerateLastResponse,
    editMessageAndResend,
    handleCardAction,
    contextUsage,
    abortStream,
    interruptedCheckpoint,
    resumeInterruptedRun,
    dismissResume,
    runHostAttach,
    saveExpiryCheckpoint,
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
    todo,
    protectMain,
    autoBackRestore,
    showToolActivity,
    handleStartWorkspace,
    handleStartChat,
    handleStartRelay,
    handleResumeRelaySession,
    handleExitWorkspace,
    handleOpenDraftComposer,
    handleDisconnect,
    handleSandboxRestart,
    handleSandboxDownload,
    sandboxDownloading,
    selectedChatProvider,
    selectedChatModels,
    handleSelectBackend,
    handleSelectOllamaModelFromChat,
    handleSelectOpenRouterModelFromChat,
    handleSelectZaiModelFromChat,
    handleSelectKimiModelFromChat,
    handleSelectHuggingFaceModelFromChat,
    handleSelectCloudflareModelFromChat,
    handleSelectZenModelFromChat,
    handleSelectNvidiaModelFromChat,
    handleSelectFireworksModelFromChat,
    handleSelectSakanaModelFromChat,
    handleSelectDeepSeekModelFromChat,
    handleSelectAnthropicModelFromChat,
    handleSelectOpenAIModelFromChat,
    handleSelectXAIModelFromChat,
    handleSelectGoogleModelFromChat,
    handleSelectRepoFromDrawer,
    handleResumeChatFromDrawer,
    setCurrentBranch,
    switchBranchFromUI,
    mergeBranchInUI,
    ensureSandbox,
    approvalMode,
    updateApprovalMode,
  } = props;

  const cycleApprovalMode = useCallback(() => {
    const modes: ApprovalMode[] = ['supervised', 'autonomous', 'full-auto'];
    const next = modes[(modes.indexOf(approvalMode) + 1) % modes.length];
    updateApprovalMode(next);
    toast.success(
      `Switched to ${next === 'full-auto' ? 'Full Auto' : next.charAt(0).toUpperCase() + next.slice(1)} mode`,
    );
  }, [approvalMode, updateApprovalMode]);

  const isScratch = workspaceSession?.kind === 'scratch';
  const activeRepoAppearance =
    activeRepo && !isScratch ? resolveRepoAppearance(activeRepo.full_name) : null;
  const activeRepoAccentHex = activeRepoAppearance
    ? getRepoAppearanceColorHex(activeRepoAppearance.color)
    : null;
  const pinnedArtifacts = usePinnedArtifacts(activeRepo?.full_name ?? null);

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
    root.style.setProperty('--repo-theme-accent-soft', hexToRgba(activeRepoAccentHex, 0.1));
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
    showBranchFork,
    setShowBranchFork,
    showMergeFlow,
    setShowMergeFlow,
    loadRepoBranches,
    handleDeleteBranch,
  } = branches;
  const activeConversationBranch =
    (activeChatId ? conversations[activeChatId]?.branch : null) || currentBranch;
  const { mergeDetected, dismissMergeDetected, refreshMergeDetection } = useMergeDetectedBanner({
    repoFullName: activeRepo?.full_name,
    activeChatId,
    chatBranch: activeConversationBranch,
    defaultBranch: activeRepo?.default_branch,
  });
  const [workspaceHubMounted, setWorkspaceHubMounted] = useState(false);
  const [launcherSheetMounted, setLauncherSheetMounted] = useState(false);
  const [branchCreateMounted, setBranchCreateMounted] = useState(false);
  const [branchForkMounted, setBranchForkMounted] = useState(false);
  const [mergeFlowMounted, setMergeFlowMounted] = useState(false);
  const [commitForkFromBranch, setCommitForkFromBranch] = useState<string | null>(null);
  const [commitSwitchConfirmBranch, setCommitSwitchConfirmBranch] = useState<string | null>(null);
  const [commitSwitchProbe, setCommitSwitchProbe] = useState<BranchSwitchProbe | null>(null);
  const [commitSwitchError, setCommitSwitchError] = useState<string | null>(null);
  const [commitSwitchingBranch, setCommitSwitchingBranch] = useState<string | null>(null);
  const previousSandboxStatusRef = useRef(sandbox.status);
  const previousSandboxErrorRef = useRef(sandbox.error);

  const { markSnapshotActivity } = snapshots;

  useEffect(() => {
    const previousStatus = previousSandboxStatusRef.current;
    const previousError = previousSandboxErrorRef.current;
    const notification = getSandboxConnectivityToast(
      previousStatus,
      sandbox.status,
      sandbox.error,
      previousError,
    );
    previousSandboxStatusRef.current = sandbox.status;
    previousSandboxErrorRef.current = sandbox.error;
    if (!notification) return;
    toast[notification.kind](notification.message, notification.options);
  }, [sandbox.error, sandbox.status]);

  const sandboxStart = sandbox.start;
  const sandboxStop = sandbox.stop;
  const startCurrentSandbox = useCallback(() => {
    if (isScratch) {
      void sandboxStart('', 'main');
      return;
    }
    if (activeRepo) {
      void sandboxStart(
        activeRepo.full_name,
        activeRepo.current_branch || activeRepo.default_branch,
      );
    }
  }, [activeRepo, isScratch, sandboxStart]);

  const restartCurrentSandbox = useCallback(() => {
    if (isScratch) {
      void sandboxStop().then(() => sandboxStart('', 'main'));
      return;
    }
    if (activeRepo) {
      void sandboxStop().then(() =>
        sandboxStart(activeRepo.full_name, activeRepo.current_branch || activeRepo.default_branch),
      );
    }
  }, [activeRepo, isScratch, sandboxStart, sandboxStop]);

  const {
    composerPrefillRequest,
    editState,
    handleComposerSend,
    handleQuickPrompt,
    handleEditUserMessage,
    handleRegenerateLastResponse,
    handleCardActionWithSnapshotHeartbeat,
    providerControls,
  } = useWorkspaceChatComposerController({
    messages,
    sendMessage,
    editMessageAndResend,
    regenerateLastResponse,
    handleCardAction,
    catalog,
    selectedChatProvider,
    selectedChatModels,
    handleSelectBackend,
    handleSelectOllamaModelFromChat,
    handleSelectOpenRouterModelFromChat,
    handleSelectZaiModelFromChat,
    handleSelectKimiModelFromChat,
    handleSelectHuggingFaceModelFromChat,
    handleSelectCloudflareModelFromChat,
    handleSelectZenModelFromChat,
    handleSelectNvidiaModelFromChat,
    handleSelectFireworksModelFromChat,
    handleSelectSakanaModelFromChat,
    handleSelectDeepSeekModelFromChat,
    handleSelectAnthropicModelFromChat,
    handleSelectOpenAIModelFromChat,
    handleSelectXAIModelFromChat,
    handleSelectGoogleModelFromChat,
    isProviderLocked,
    lockedProvider,
    lockedModel,
    isModelLocked,
    markSnapshotActivity,
  });

  const {
    isWorkspaceHubOpen,
    isLauncherOpen,
    isChatsDrawerOpen,
    hubTabRequest,
    setIsChatsDrawerOpen,
    setIsLauncherOpen,
    handleWorkspaceHubOpenChange,
    openWorkspaceHub,
    openLauncher,
    handleCreateNewChatRequest,
    handleExpiryWarningReached,
    handleFixReviewFinding,
    handleResumeConversationFromLauncher,
    handleStartWorkspaceRequest,
    handleDisconnectRequest,
  } = useWorkspaceChatPanelsController({
    activeRepo,
    sandbox,
    conversations,
    repos,
    switchChat,
    switchBranchFromUI,
    handleSelectRepoFromDrawer,
    handleOpenDraftComposer,
    handleStartWorkspace,
    handleExitWorkspace,
    handleDisconnect,
    ensureSandbox,
    sendMessage,
    saveExpiryCheckpoint,
    isStreaming,
    isScratch,
    isChat: false,
    markSnapshotActivity,
  });

  const handleWorkspaceHubOpenChangeWithMount = useCallback(
    (open: boolean) => {
      if (open) {
        setWorkspaceHubMounted(true);
      }
      handleWorkspaceHubOpenChange(open);
    },
    [handleWorkspaceHubOpenChange],
  );

  const openWorkspaceHubWithMount = useCallback(() => {
    setWorkspaceHubMounted(true);
    openWorkspaceHub();
  }, [openWorkspaceHub]);

  const openLauncherWithMount = useCallback(() => {
    setLauncherSheetMounted(true);
    openLauncher();
  }, [openLauncher]);

  const loadRepoBranchesWithMergeDetection = useCallback(
    async (repoFullName: string) => {
      await loadRepoBranches(repoFullName);
      await refreshMergeDetection();
    },
    [loadRepoBranches, refreshMergeDetection],
  );

  const setLauncherOpenWithMount = useCallback(
    (open: boolean) => {
      if (open) {
        setLauncherSheetMounted(true);
      }
      setIsLauncherOpen(open);
    },
    [setIsLauncherOpen],
  );

  const setShowBranchCreateWithMount = useCallback(
    (open: boolean) => {
      if (open) {
        setBranchCreateMounted(true);
      }
      setShowBranchCreate(open);
    },
    [setShowBranchCreate],
  );

  const setShowBranchForkWithMount = useCallback(
    (open: boolean) => {
      if (open) {
        setBranchForkMounted(true);
      } else {
        setCommitForkFromBranch(null);
      }
      setShowBranchFork(open);
    },
    [setShowBranchFork],
  );

  const setShowMergeFlowWithMount = useCallback(
    (open: boolean) => {
      if (open) {
        setMergeFlowMounted(true);
      }
      setShowMergeFlow(open);
    },
    [setShowMergeFlow],
  );

  // Android Back closes the topmost open overlay instead of backgrounding the
  // app. Order matters only when two stack (e.g. a branch sheet over the hub):
  // the most-recently-opened registers last and so closes first (LIFO). Inert on
  // web. The branch sheets sit "over" the hub, so they're wired after it.
  useBackHandler(isWorkspaceHubOpen, () => handleWorkspaceHubOpenChangeWithMount(false));
  useBackHandler(isChatsDrawerOpen, () => setIsChatsDrawerOpen(false));
  useBackHandler(isLauncherOpen, () => setLauncherOpenWithMount(false));
  useBackHandler(showBranchCreate, () => setShowBranchCreateWithMount(false));
  useBackHandler(showBranchFork, () => setShowBranchForkWithMount(false));
  useBackHandler(showMergeFlow, () => setShowMergeFlowWithMount(false));

  const openCommitSwitchConfirm = useCallback((branch: string, probe: BranchSwitchProbe) => {
    setCommitSwitchConfirmBranch(branch);
    setCommitSwitchProbe(probe);
    setCommitSwitchError(null);
  }, []);

  const closeCommitSwitchConfirm = useCallback(() => {
    setCommitSwitchConfirmBranch(null);
    setCommitSwitchProbe(null);
    setCommitSwitchError(null);
    setCommitSwitchingBranch(null);
  }, []);

  const confirmCommitBranchSwitch = useCallback(async () => {
    if (!commitSwitchConfirmBranch) return;
    setCommitSwitchingBranch(commitSwitchConfirmBranch);
    setCommitSwitchError(null);
    try {
      await runCommitSwitchConfirmAction({
        branch: commitSwitchConfirmBranch,
        sandboxId: sandbox.sandboxId,
        setCurrentBranch,
        switchBranchFromUI,
        onError: setCommitSwitchError,
        onDone: closeCommitSwitchConfirm,
      });
    } finally {
      setCommitSwitchingBranch((current) =>
        current === commitSwitchConfirmBranch ? null : current,
      );
    }
  }, [
    closeCommitSwitchConfirm,
    commitSwitchConfirmBranch,
    sandbox.sandboxId,
    setCurrentBranch,
    switchBranchFromUI,
  ]);

  const handleWorkspaceCardAction = useCallback(
    (action: CardAction) => {
      if (action.type === 'commit-switch-default') {
        markSnapshotActivity();
        return runCommitSwitchDefaultAction({
          targetBranch: action.targetBranch,
          sandboxId: sandbox.sandboxId,
          getSandboxDiff,
          switchBranchFromUI,
          openConfirm: openCommitSwitchConfirm,
          onSwitchError: (message) => toast.error(message),
        });
      }

      if (action.type === 'commit-fork-from-here') {
        markSnapshotActivity();
        // BranchForkSheet forks from sandbox HEAD, so only surface the stamped
        // committed branch as the fork source when HEAD is still on it. If the
        // user switched away, drop it (null) and the sheet labels the actual
        // current branch — the UI never claims to fork from a branch it won't.
        setCommitForkFromBranch(
          resolveCommitForkFromBranch(action.fromBranch, activeRepo?.current_branch),
        );
        setShowBranchForkWithMount(true);
        return;
      }

      return handleCardActionWithSnapshotHeartbeat(action);
    },
    [
      activeRepo?.current_branch,
      handleCardActionWithSnapshotHeartbeat,
      markSnapshotActivity,
      openCommitSwitchConfirm,
      sandbox.sandboxId,
      setShowBranchForkWithMount,
      switchBranchFromUI,
    ],
  );

  const handlePublishToGitHub = useCallback(
    async (args: { repoName: string; description?: string; isPrivate: boolean }) => {
      if (!isScratch) {
        throw new Error(
          'Workspace publishing is only available from scratch workspaces right now.',
        );
      }
      if (!props.validatedUser) {
        throw new Error('Connect GitHub in Settings before publishing this workspace.');
      }
      if (isStreaming) {
        throw new Error('Wait for the current response to finish before publishing.');
      }

      const sandboxId = sandbox.sandboxId ?? (await ensureSandbox());
      if (!sandboxId) {
        throw new Error('Sandbox is not ready yet. Try again in a moment.');
      }

      const result = await executeSandboxToolCall(
        {
          tool: 'promote_to_github',
          args: {
            repo_name: args.repoName,
            description: args.description,
            private: args.isPrivate,
          },
        },
        sandboxId,
      );

      if (!result.promotion?.repo) {
        throw new Error(
          cleanWorkspacePublishMessage(result.text) || 'Failed to publish workspace to GitHub.',
        );
      }

      const promotedRepo = result.promotion.repo;
      handleWorkspacePromotion(promotedRepo, promotedRepo.default_branch, sandboxId);

      if (result.promotion.warning) {
        toast.warning(`${promotedRepo.full_name} created. ${result.promotion.warning}`);
      } else {
        toast.success(`Published to GitHub: ${promotedRepo.full_name}`);
      }
    },
    [
      ensureSandbox,
      handleWorkspacePromotion,
      isScratch,
      isStreaming,
      props.validatedUser,
      sandbox.sandboxId,
    ],
  );

  const chatShellNav = getChatShellNav(resolveNavMode(), {
    drawerOpen: isChatsDrawerOpen,
    hubOpen: isWorkspaceHubOpen,
  });
  const chatShellTransform = chatShellNav.transform;
  const chatShellShadow = chatShellNav.shadowClass;
  const chatShellStyle = chatShellNav.style;

  const snapshotAgeLabel = snapshots.latestSnapshot
    ? formatSnapshotAge(snapshots.latestSnapshot.createdAt)
    : null;
  const snapshotIsStale = snapshots.latestSnapshot
    ? isSnapshotStale(snapshots.latestSnapshot.createdAt)
    : false;

  const settingsAuth = buildSettingsAuth(props, handleDisconnectRequest);
  const settingsProfile = buildSettingsProfile(props);
  const settingsAI = buildSettingsAI(props);
  const settingsWorkspace = buildSettingsWorkspace(props);
  const settingsData = buildSettingsData(props);
  const workspaceHubCapabilities = buildWorkspaceHubCapabilities(isScratch, activeRepo);
  const workspaceHubScratchActions = buildWorkspaceHubScratchActions({
    isScratch,
    snapshots,
    sandboxStatus: sandbox.status,
    sandboxDownloading,
    onDownloadWorkspace: () => {
      void handleSandboxDownload();
    },
  });
  const reviewModelOptions = buildWorkspaceHubReviewModelOptions(catalog);
  const branchProps = buildWorkspaceHubBranchProps({
    activeRepo,
    displayBranches,
    repoBranchesLoading,
    repoBranchesError,
    loadRepoBranches: loadRepoBranchesWithMergeDetection,
    setCurrentBranch,
    switchBranchFromUI,
    setShowBranchCreate: setShowBranchCreateWithMount,
    setShowBranchFork: setShowBranchForkWithMount,
    setShowMergeFlow: setShowMergeFlowWithMount,
    handleDeleteBranch,
  });
  // Paired remote daemon (CLI/TUI) sessions for the drawer's Connected
  // section — dialed lazily while the drawer is open. See /rc.
  const { sessions: connectedCliSessions, grantSessionAttach } =
    useConnectedCliSessions(isChatsDrawerOpen);
  // Tap-to-resume: grant the session's bearer over the drawer's open
  // connection, then hand off to App's relay entry. A `stale` grant
  // means the user moved on mid-round-trip (closed the drawer /
  // navigated away — the hook's activation was superseded), so a slow
  // grant can't yank them into Remote after the fact (Codex P2 on
  // #1310) and doesn't toast either. On a live failure the drawer
  // stays open (the toast is the only signal; navigating away would
  // hide it).
  const handleResumeConnectedCliSession = useCallback(
    async (session: DaemonCliSession) => {
      if (!handleResumeRelaySession) return;
      const grant = await grantSessionAttach(session.sessionId);
      if (grant.stale) return; // user moved on
      if (grant.token) {
        handleResumeRelaySession(session.sessionId, grant.token);
        return;
      }
      toast.error('Could not reach the daemon to resume this session.');
    },
    [handleResumeRelaySession, grantSessionAttach],
  );
  const drawerProps = buildRepoChatDrawerProps({
    open: isChatsDrawerOpen,
    setOpen: setIsChatsDrawerOpen,
    repos,
    activeRepo,
    conversations,
    activeChatId,
    resolveRepoAppearance,
    setRepoAppearance,
    clearRepoAppearance,
    handleResumeChatFromDrawer,
    handleCreateNewChatRequest,
    deleteChat,
    renameChat,
    cliSessions: connectedCliSessions,
    cliSessionsLabel: 'relay',
    onResumeCliSession: handleResumeRelaySession
      ? (session) => void handleResumeConnectedCliSession(session)
      : undefined,
  });
  const repoLauncherProps = buildRepoLauncherSheetProps({
    open: isLauncherOpen,
    setOpen: setLauncherOpenWithMount,
    repos,
    reposLoading,
    reposError,
    conversations,
    activeRepo,
    resolveRepoAppearance,
    setRepoAppearance,
    clearRepoAppearance,
    handleSelectRepoFromDrawer,
    handleResumeConversationFromLauncher,
    isScratch,
    sandboxStatus: sandbox.status,
    sandboxCreatedAt: sandbox.createdAt,
    handleStartWorkspace: handleStartWorkspace ? handleStartWorkspaceRequest : undefined,
    handleStartChat,
    handleStartRelay,
    handleDisconnect: handleDisconnectRequest,
    validatedUser: props.validatedUser,
    mode: 'default',
  });
  const chatScreenWorkspace = {
    activeRepo,
    isScratch,
    activeRepoAppearance,
    sandboxStatus: sandbox.status,
    sandboxDownloading,
    onSandboxDownload: handleSandboxDownload,
    instructions,
    snapshots,
    snapshotAgeLabel,
    snapshotIsStale,
  };
  const chatScreenShell = {
    launcherLabel: isScratch ? 'Workspace' : currentBranch,
    hasWorkspaceActivityIndicator: scratchpad.hasContent || agentStatus.active,
    chatShellTransform,
    chatShellShadow,
    chatShellStyle,
    onOpenLauncher: openLauncherWithMount,
    onOpenWorkspaceHub: openWorkspaceHubWithMount,
    drawerProps,
  };
  const chatScreenChat = {
    lockedProvider,
    containerProps: {
      messages,
      agentStatus,
      activeRepo,
      hasSandbox: Boolean(isScratch || activeRepo),
      isChat: false,
      onSuggestion: handleQuickPrompt,
      onCardAction: handleWorkspaceCardAction,
      onPin: pinnedArtifacts.pin,
      interruptedCheckpoint,
      onResumeRun: resumeInterruptedRun,
      onDismissResume: dismissResume,
      runHostAttach,
      ciStatus,
      onDiagnoseCI: diagnoseCIFailure,
      mergeDetected,
      mergeBranchInUI,
      onDismissMergeDetected: dismissMergeDetected,
      onEditUserMessage: !isStreaming ? handleEditUserMessage : undefined,
      onRegenerateLastResponse: !isStreaming ? handleRegenerateLastResponse : undefined,
    },
    inputProps: {
      onSend: handleComposerSend,
      onStop: abortStream,
      isStreaming,
      queuedFollowUpCount,
      pendingSteerCount,
      repoName: activeRepo?.name,
      contextUsage,
      draftKey: activeChatId,
      prefillRequest: composerPrefillRequest,
      editState,
      providerControls,
    },
  };
  const chatScreenBanners = {
    // The red sandbox-status error banner was removed; only the chip's error
    // tooltip and the streaming gate still read from this bag.
    sandboxStatusBannerProps: {
      error: sandbox.error,
      isStreaming,
    },
    sandboxExpiryBannerProps: isScratch
      ? {
          createdAt: sandbox.createdAt,
          sandboxId: sandbox.sandboxId,
          sandboxStatus: sandbox.status,
          onRestart: handleSandboxRestart,
          onWarningThresholdReached: () => {
            void handleExpiryWarningReached();
          },
        }
      : null,
    autoBackRestoreBannerProps:
      !isScratch && activeRepo && autoBackRestore?.available
        ? {
            summary: autoBackRestore.summary,
            restoring: autoBackRestore.restoring,
            error: autoBackRestore.error,
            onRestore: () => {
              void autoBackRestore.restore();
            },
            onDismiss: autoBackRestore.dismiss,
          }
        : null,
  };

  return (
    <>
      <ChatScreen
        workspace={chatScreenWorkspace}
        shell={chatScreenShell}
        chat={chatScreenChat}
        banners={chatScreenBanners}
        approvalMode={approvalMode}
        onCycleApprovalMode={cycleApprovalMode}
      />

      {workspaceHubMounted && (
        <Suspense fallback={null}>
          <WorkspaceHubSheet
            open={isWorkspaceHubOpen}
            onOpenChange={handleWorkspaceHubOpenChangeWithMount}
            externalTabRequest={hubTabRequest}
            messages={messages}
            agentEvents={agentEvents}
            runEvents={runEvents}
            sandboxId={sandbox.sandboxId}
            sandboxStatus={sandbox.status}
            sandboxError={sandbox.error}
            ensureSandbox={ensureSandbox}
            onStartSandbox={startCurrentSandbox}
            onRetrySandbox={() => {
              void sandbox.refresh();
            }}
            onNewSandbox={restartCurrentSandbox}
            onHibernateSandbox={cloudSnapshotsHidden ? undefined : sandbox.hibernate}
            onForgetSandboxSnapshot={cloudSnapshotsHidden ? undefined : sandbox.forgetSnapshot}
            snapshotInfo={cloudSnapshotsHidden ? null : sandbox.snapshotInfo}
            reviewProviders={catalog.availableProviders}
            reviewActiveProvider={catalog.activeProviderLabel}
            reviewModelOptions={reviewModelOptions}
            lockedProvider={lockedProvider}
            lockedModel={lockedModel}
            workspaceMode={isScratch ? 'scratch' : 'repo'}
            capabilities={workspaceHubCapabilities}
            scratchActions={workspaceHubScratchActions}
            onPublishToGitHub={isScratch && props.validatedUser ? handlePublishToGitHub : undefined}
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
            appearance={activeRepoAppearance ?? undefined}
            accentHex={activeRepoAccentHex ?? undefined}
            todos={todo.todos}
            onTodoClear={todo.clear}
            branchProps={branchProps}
            forkBranchFromUI={props.forkBranchFromUI}
            onFixReviewFinding={handleFixReviewFinding}
            pinnedArtifacts={pinnedArtifacts.artifacts}
            onUnpinArtifact={pinnedArtifacts.unpin}
            onUpdateArtifactLabel={pinnedArtifacts.updateLabel}
          />
        </Suspense>
      )}

      {launcherSheetMounted && (
        <Suspense fallback={null}>
          <RepoLauncherSheet
            {...repoLauncherProps}
            onPublishToGitHub={isScratch && props.validatedUser ? handlePublishToGitHub : undefined}
          />
        </Suspense>
      )}

      <Toaster />

      {commitSwitchConfirmBranch && (
        <div className="fixed inset-x-3 bottom-24 z-50 mx-auto max-w-md">
          <BranchSwitchConfirm
            branch={commitSwitchConfirmBranch}
            probe={commitSwitchProbe}
            error={commitSwitchError}
            switchingMode={commitSwitchingBranch ? 'warm' : null}
            onConfirm={() => void confirmCommitBranchSwitch()}
            onCancel={closeCommitSwitchConfirm}
          />
        </div>
      )}

      {activeRepo && branchCreateMounted && (
        <Suspense fallback={null}>
          <BranchCreateSheet
            open={showBranchCreate}
            onOpenChange={setShowBranchCreateWithMount}
            activeRepo={activeRepo}
            setCurrentBranch={setCurrentBranch}
            forkBranch={props.forkBranchFromUI}
          />
        </Suspense>
      )}

      {activeRepo && branchForkMounted && (
        <Suspense fallback={null}>
          <BranchForkSheet
            open={showBranchFork}
            onOpenChange={setShowBranchForkWithMount}
            fromBranch={
              commitForkFromBranch || activeRepo.current_branch || activeRepo.default_branch
            }
            forkBranch={props.forkBranchFromUI}
          />
        </Suspense>
      )}

      {activeRepo && mergeFlowMounted && (
        <Suspense fallback={null}>
          <MergeFlowSheet
            open={showMergeFlow}
            onOpenChange={setShowMergeFlowWithMount}
            activeRepo={activeRepo}
            sandboxId={sandbox.sandboxId}
            projectInstructions={instructions.agentsMdContent}
            setCurrentBranch={setCurrentBranch}
            mergeBranchInUI={mergeBranchInUI}
            lockedProvider={lockedProvider}
            lockedModel={lockedModel}
          />
        </Suspense>
      )}
    </>
  );
}
