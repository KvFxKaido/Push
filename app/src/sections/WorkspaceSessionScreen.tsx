import { lazy, Suspense, useCallback, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { Toaster } from '@/components/ui/sonner';
import { useChat } from '@/hooks/useChat';
import { resolveWorkspaceChatAction } from '@/hooks/chat-management';
import { useSandbox } from '@/hooks/useSandbox';
import { useScratchpad } from '@/hooks/useScratchpad';
import { useTodo } from '@/hooks/useTodo';
import { useSnapshotManager } from '@/hooks/useSnapshotManager';
import { useBranchManager } from '@/hooks/useBranchManager';
import { useProjectInstructions } from '@/hooks/useProjectInstructions';
import { useWorkspaceComposerState } from '@/hooks/useWorkspaceComposerState';
import { useWorkspacePreferences } from '@/hooks/useWorkspacePreferences';
import { useWorkspaceSandboxController } from '@/hooks/useWorkspaceSandboxController';
import { useWorkspaceSandboxAutoBack } from '@/hooks/useWorkspaceSandboxAutoBack';
import { useWorkspaceSandboxRestore } from '@/hooks/useWorkspaceSandboxRestore';
import { perfMark } from '@/lib/perf-marks';
import { getRepoAppearanceColorHex } from '@/lib/repo-appearance';
import { restoreResumeBranchIfNeeded } from '@/lib/resume-branch-restore';
import { useWorkspaceSessionBridge } from './useWorkspaceSessionBridge';
import { getDefaultMemoryStore } from '@/lib/context-memory-store';
import type { ActiveRepo, RepoWithActivity, WorkspaceScreenProps } from '@/types';

const FileBrowser = lazy(() =>
  import('./FileBrowser').then((module) => ({ default: module.FileBrowser })),
);
const ChatSurfaceRoute = lazy(() =>
  import('./ChatSurfaceRoute').then((module) => ({ default: module.ChatSurfaceRoute })),
);
const WorkspaceChatRoute = lazy(() =>
  import('./WorkspaceChatRoute').then((module) => ({ default: module.WorkspaceChatRoute })),
);

const workspaceRouteFallback = <div className="h-dvh bg-push-surface-inset" />;

export function WorkspaceSessionScreen({
  workspace,
  repoShell,
  auth,
  navigation,
  homeBridge,
  catalog,
}: WorkspaceScreenProps) {
  const { workspaceSession, onWorkspaceSessionChange } = workspace;
  const {
    setActiveRepo,
    setCurrentBranch,
    repos,
    reposLoading,
    reposError,
    resolveRepoAppearance,
    setRepoAppearance,
    clearRepoAppearance,
  } = repoShell;
  const {
    token,
    tokenKind,
    patToken,
    validatedUser,
    isAppAuth,
    installationId,
    appLoading,
    appError,
    connectApp,
    installApp,
    setInstallationIdManually,
  } = auth;
  const {
    onDisconnect,
    onSelectRepo,
    onStartScratchWorkspace,
    onStartChat,
    onStartRelay,
    onResumeRelaySession,
    onEndWorkspace,
    onOpenDraftComposer,
  } = navigation;
  const {
    pendingResumeChatId,
    onConversationIndexChange,
    pendingNewChat,
    onPendingNewChatConsumed,
    onResumeChatFromDrawer,
  } = homeBridge;

  const isScratch = workspaceSession.kind === 'scratch';
  const isChat = workspaceSession.kind === 'chat';
  const workspaceRepo = workspaceSession.kind === 'repo' ? workspaceSession.repo : null;
  const scratchpad = useScratchpad(workspaceRepo?.full_name ?? null);
  const todo = useTodo(workspaceRepo?.full_name ?? null);
  const sandbox = useSandbox(
    isChat ? null : isScratch ? '' : (workspaceRepo?.full_name ?? null),
    isChat
      ? null
      : isScratch
        ? 'main'
        : workspaceRepo?.current_branch || workspaceRepo?.default_branch || null,
    isChat || isScratch ? null : (workspaceRepo?.default_branch ?? null),
  );
  const repoBranch = workspaceRepo?.current_branch || workspaceRepo?.default_branch || null;

  // B2 auto-back: while a real repo sandbox is live, continuously mirror the
  // working tree to its durable `draft/auto/<branch>` ref (debounce-after-edits
  // + flush on tab-hide). Gated to repo sessions — scratch has no remote to push
  // to until it's promoted. See "Pushed Branch as Source of Truth" §Move B.
  useWorkspaceSandboxAutoBack({
    sandboxId: sandbox.sandboxId,
    branch: repoBranch,
    repoFullName: workspaceRepo?.full_name ?? null,
    enabled: workspaceRepo != null && sandbox.status === 'ready',
  });
  const autoBackRestore = useWorkspaceSandboxRestore({
    sandboxId: sandbox.sandboxId,
    branch: repoBranch,
    repoFullName: workspaceRepo?.full_name ?? null,
    // The `restoredFromSnapshotSandboxId` clause suppresses the offer when a
    // cloud snapshot already restored the tree (web). On the native shell cloud
    // restore is gated off (Increment 2), so this id stays null and never
    // matches — the native checkpoint offer reaches a cold-started sandbox by
    // construction. Left explicit so a future change can't silently re-suppress
    // it on native.
    enabled:
      workspaceRepo != null &&
      sandbox.status === 'ready' &&
      sandbox.freshSandboxId === sandbox.sandboxId &&
      sandbox.restoredFromSnapshotSandboxId !== sandbox.sandboxId,
  });

  const handleWorkspacePromotion = useCallback(
    (repo: ActiveRepo, branch?: string, sandboxIdOverride?: string | null) => {
      const promotedRepo =
        branch && branch !== repo.default_branch ? { ...repo, current_branch: branch } : repo;

      sandbox.rebindSessionRepo(repo.full_name, branch ?? repo.default_branch);
      setActiveRepo(promotedRepo);
      onWorkspaceSessionChange({
        id: workspaceSession.id,
        kind: 'repo',
        repo: promotedRepo,
        sandboxId: sandboxIdOverride ?? sandbox.sandboxId,
      });
    },
    [onWorkspaceSessionChange, sandbox, setActiveRepo, workspaceSession.id],
  );

  const skipBranchTeardownRef = useRef(false);
  const handleSandboxBranchSwitch = useCallback(
    (branch: string) => {
      skipBranchTeardownRef.current = true;
      // Re-key the persisted sandbox session (createdAt/lastActivityAt/
      // hasMutated) onto the new branch — same live container, new git ref.
      // Without this, branch-on-first-prompt's fork leaves the working
      // branch's first keep-warm snapshot with no `existing` record to carry
      // `hasMutated` forward from, so it lands `undefined` instead of the
      // `false` the cold-start seeded under the old (default-branch) key —
      // the definitively-gone recovery skip never fires for the session it
      // exists for (Codex P2 on #1315).
      if (workspaceRepo) {
        sandbox.rebindSessionRepo(workspaceRepo.full_name, branch);
      }
      setCurrentBranch(branch);
    },
    [sandbox, setCurrentBranch, workspaceRepo],
  );

  const {
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
    conversationsLoaded,
    activeChatId,
    switchChat,
    renameChat,
    setChatLinkedLibraries,
    createNewChat,
    deleteChat,
    deleteAllChats,
    regenerateLastResponse,
    editMessageAndResend,
    setWorkspaceContext,
    setWorkspaceMode,
    setSandboxId,
    setWorkspaceSessionId,
    setEnsureSandbox,
    setAgentsMd,
    setInstructionFilename,
    handleCardAction,
    contextUsage,
    abortStream,
    setIsMainProtected,
    interruptedCheckpoint,
    resumeInterruptedRun,
    dismissResume,
    runHostAttach,
    saveExpiryCheckpoint,
    ciStatus,
    diagnoseCIFailure,
    applyBranchSwitchFromUI,
    forkBranchFromUI,
    switchBranchFromUI,
    mergeBranchInUI,
    replayOnFreshSandbox,
  } = useChat(
    workspaceRepo?.full_name ?? null,
    {
      content: scratchpad.content,
      replace: scratchpad.replace,
      append: scratchpad.append,
    },
    {
      bindSandboxSessionToRepo: (repoFullName, branch) => {
        sandbox.rebindSessionRepo(repoFullName, branch);
      },
      onSandboxPromoted: (repo) => {
        handleWorkspacePromotion(repo, repo.default_branch);
        toast.success(`Promoted to GitHub: ${repo.full_name}`);
      },
      onBranchSwitch: handleSandboxBranchSwitch,
      onBranchDesync: ({ expected, actual, reconciled }) => {
        if (reconciled) {
          toast.info(`Sandbox moved to ${actual} (was ${expected}) — Push followed.`);
        } else {
          toast.info(
            `Sandbox moved to detached HEAD (was ${expected}) — Push did not change branches.`,
          );
        }
      },
      onSandboxUnreachable: (reason, policy) => {
        sandbox.markUnreachable(reason, policy);
      },
    },
    {
      // Raw current branch (no `|| default_branch` collapse): branch-on-first-
      // prompt only fires when this is *known* to equal the default branch, so
      // an unknown branch must stay undefined rather than masquerade as the
      // default. Downstream consumers re-apply their own `?? defaultBranch`.
      currentBranch: workspaceRepo?.current_branch,
      defaultBranch: workspaceRepo?.default_branch,
    },
    {
      todos: todo.todos,
      replace: todo.replace,
      clear: todo.clear,
    },
  );

  // Synchronously set workspace mode so createNewChat tags conversations correctly
  // during workspace transitions (before the async useProjectInstructions effect fires).
  setWorkspaceMode(
    workspaceSession.kind === 'chat'
      ? 'chat'
      : workspaceSession.kind === 'scratch'
        ? 'scratch'
        : 'repo',
  );

  useEffect(() => {
    perfMark(workspaceSession.kind === 'chat' ? 'surface:chat' : 'surface:workspace');
  }, [workspaceSession.id, workspaceSession.kind]);

  // Workspace-patch replay (persist-diffs PR 3). Two signals must
  // align before replay fires:
  //
  //  1. `creating → ready` status transition. Snapshot restore takes
  //     the `reconnecting → ready` path and brings the working tree
  //     back as-is; replay would double-apply.
  //
  //  2. The sandbox id must also have *changed* since the last replay.
  //     `useSandbox.refresh()` re-enters `creating` as a transient
  //     "checking" state on the *same* container (see useSandbox.ts:532)
  //     — a non-silent refresh on a live container would otherwise
  //     trigger replay against the already-applied working tree and
  //     drag the card to `applied('already-applied')` prematurely,
  //     leaving nothing to replay when a *real* new container later
  //     replaces this one.
  const prevSandboxStatusRef = useRef(sandbox.status);
  const lastReplayedSandboxIdRef = useRef<string | null>(null);
  useEffect(() => {
    const prevStatus = prevSandboxStatusRef.current;
    const currStatus = sandbox.status;
    prevSandboxStatusRef.current = currStatus;
    if (prevStatus !== 'creating' || currStatus !== 'ready') return;
    if (!sandbox.sandboxId) return;
    if (sandbox.sandboxId === lastReplayedSandboxIdRef.current) return;
    lastReplayedSandboxIdRef.current = sandbox.sandboxId;
    void replayOnFreshSandbox(sandbox.sandboxId, activeChatId, conversations);
  }, [sandbox.status, sandbox.sandboxId, replayOnFreshSandbox, activeChatId, conversations]);

  useEffect(() => {
    // Decision (including the `conversationsLoaded` hydration gate that keeps
    // a pre-hydration map from minting a throwaway chat) lives in the pure
    // `resolveWorkspaceChatAction` helper so it can be unit-tested without
    // mounting this screen.
    const workspaceMode =
      workspaceSession.kind === 'chat'
        ? 'chat'
        : workspaceSession.kind === 'scratch'
          ? 'scratch'
          : 'repo';
    const action = resolveWorkspaceChatAction({
      conversations,
      activeChatId,
      repoFullName: workspaceRepo?.full_name ?? null,
      workspaceMode,
      conversationsLoaded,
      hasPendingResume: Boolean(pendingResumeChatId),
      hasPendingNewChat: Boolean(pendingNewChat),
    });

    if (action.kind === 'switch') {
      switchChat(action.chatId);
    } else if (action.kind === 'create') {
      createNewChat();
    }
  }, [
    activeChatId,
    conversations,
    conversationsLoaded,
    createNewChat,
    pendingNewChat,
    pendingResumeChatId,
    switchChat,
    workspaceRepo?.full_name,
    workspaceSession.kind,
  ]);

  const handlePendingResumeChatSwitch = useCallback(
    (chatId: string, conversation: (typeof conversations)[string]) => {
      const currentBranch = workspaceRepo?.current_branch || workspaceRepo?.default_branch;
      void restoreResumeBranchIfNeeded({
        chatId,
        repoFullName: conversation.repoFullName,
        activeRepoFullName: workspaceRepo?.full_name,
        savedBranch: conversation.branch,
        currentBranch,
        surface: 'drawer',
        switchBranchFromUI,
      });
    },
    [
      switchBranchFromUI,
      workspaceRepo?.current_branch,
      workspaceRepo?.default_branch,
      workspaceRepo?.full_name,
    ],
  );

  const { protectMain } = useWorkspaceSessionBridge({
    conversations,
    onConversationIndexChange,
    pendingResumeChatId,
    workspaceSessionId: workspaceSession.id,
    switchChat,
    onPendingResumeChatSwitch: handlePendingResumeChatSwitch,
    setIsMainProtected,
    repoFullName: workspaceRepo?.full_name ?? undefined,
  });

  const clearMemoryByRepo = useCallback(() => {
    if (!workspaceRepo?.full_name) return;
    void Promise.resolve(getDefaultMemoryStore().clearByRepo(workspaceRepo.full_name)).catch(
      (e: unknown) => console.warn('[Settings] Failed to clear memory by repo', e),
    );
  }, [workspaceRepo]);

  const clearMemoryByBranch = useCallback(() => {
    if (!workspaceRepo?.full_name || !workspaceRepo.current_branch) return;
    void Promise.resolve(
      getDefaultMemoryStore().clearByBranch(workspaceRepo.full_name, workspaceRepo.current_branch),
    ).catch((e: unknown) => console.warn('[Settings] Failed to clear memory by branch', e));
  }, [workspaceRepo]);
  const {
    selectedChatProvider,
    selectedChatModels,
    sendMessageWithChatDraft,
    handleCreateNewChat,
    upsertChatDraft,
    handleSelectBackend,
    handleSelectOllamaModelFromChat,
    handleSelectOpenRouterModelFromChat,
    handleSelectCloudflareModelFromChat,
    handleSelectZenModelFromChat,
    handleSelectNvidiaModelFromChat,
    handleSelectKilocodeModelFromChat,
    handleSelectFireworksModelFromChat,
    handleSelectSakanaModelFromChat,
    handleSelectDeepSeekModelFromChat,
    handleSelectAzureModelFromChat,
    handleSelectBedrockModelFromChat,
    handleSelectVertexModelFromChat,
    handleSelectAnthropicModelFromChat,
    handleSelectOpenAIModelFromChat,
    handleSelectGoogleModelFromChat,
  } = useWorkspaceComposerState({
    catalog,
    conversations,
    activeChatId,
    isProviderLocked,
    isModelLocked,
    createNewChat,
    switchChat,
    sendMessage,
  });

  // Drain `pendingNewChat` set by the pre-flight menu on confirm.
  // Confirming the menu always means "open a fresh chat here" — even
  // when the current chat is empty, the user tapped "+ New chat" and
  // expects a new one. The auto-create-conv effect above is gated on
  // `pendingNewChat` so it doesn't race the drain on cross-context
  // commits (the workspace would otherwise switch into an existing
  // matching chat before we mint).
  //
  // Wait for `conversationsLoaded` before minting: the IDB hydration
  // in useChat replaces the in-memory conversation map wholesale, so
  // a chat created before hydration completes is wiped, and the
  // post-hydration setActiveChatId fallback then routes the user back
  // to the most recent existing chat in this workspace — which is the
  // chat they came from when picking "same repo" in the composer.
  //
  // When the menu picked a provider/model override, apply it to the
  // newly minted chat's draft. First-send-anchors-lock then pins
  // that chat — the catalog-wide default is left alone.
  const drainedNewChatKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!pendingNewChat) return;
    if (!conversationsLoaded) return;
    if (drainedNewChatKeyRef.current === pendingNewChat.key) return;
    drainedNewChatKeyRef.current = pendingNewChat.key;
    const newChatId = createNewChat();
    if (pendingNewChat.provider) {
      const provider = pendingNewChat.provider;
      upsertChatDraft(newChatId, {
        provider,
        models: pendingNewChat.model ? { [provider]: pendingNewChat.model } : undefined,
      });
    }
    onPendingNewChatConsumed();
  }, [
    conversationsLoaded,
    createNewChat,
    onPendingNewChatConsumed,
    pendingNewChat,
    upsertChatDraft,
  ]);

  const snapshots = useSnapshotManager(workspaceSession, sandbox, workspaceRepo, isStreaming);
  const branches = useBranchManager(workspaceRepo, workspaceSession);
  const {
    showFileBrowser,
    setShowFileBrowser,
    sandboxState,
    sandboxStateLoading,
    sandboxDownloading,
    fetchSandboxState,
    ensureSandbox,
    handleSandboxRestart,
    handleSandboxDownload,
    fileBrowserCapabilities,
    fileBrowserScratchActions,
    handleExitWorkspace,
    handleDisconnectFromWorkspace,
  } = useWorkspaceSandboxController({
    workspaceSession,
    workspaceRepo,
    isScratch,
    sandbox,
    snapshots,
    isStreaming,
    abortStream,
    createNewChat,
    onWorkspaceSessionChange,
    onEndWorkspace,
    onDisconnect,
    setEnsureSandbox,
    setSandboxId,
    setWorkspaceSessionId,
    skipBranchTeardownRef,
  });

  const instructions = useProjectInstructions(
    workspaceRepo,
    repos,
    workspaceSession,
    sandbox,
    setAgentsMd,
    setInstructionFilename,
    setWorkspaceContext,
    sendMessageWithChatDraft,
    isStreaming,
    setShowFileBrowser,
    snapshots.markSnapshotActivity,
  );

  const {
    profile,
    updateProfile,
    clearProfile,
    displayNameDraft,
    setDisplayNameDraft,
    handleDisplayNameBlur,
    bioDraft,
    setBioDraft,
    handleBioBlur,
    chatInstructionsDraft,
    setChatInstructionsDraft,
    handleChatInstructionsBlur,
    installIdInput,
    setInstallIdInput,
    showInstallIdInput,
    setShowInstallIdInput,
    showToolActivity,
    updateShowToolActivity,
    providerFailover,
    updateProviderFailover,
    runTokenBudget,
    updateRunTokenBudget,
    approvalMode,
    updateApprovalMode,
    allowlistSecretCmd,
    copyAllowlistCommand,
  } = useWorkspacePreferences(validatedUser?.login);

  const handleSelectRepoFromDrawer = useCallback(
    (repo: RepoWithActivity, branch?: string) => {
      onSelectRepo(repo, branch);
    },
    [onSelectRepo],
  );

  const handleCommitSandboxExpired = useCallback(async (): Promise<string | null> => {
    if (!workspaceRepo?.full_name) return null;
    const branch = workspaceRepo.current_branch || workspaceRepo.default_branch || 'main';
    await sandbox.stop();
    return sandbox.start(workspaceRepo.full_name, branch);
  }, [sandbox, workspaceRepo]);

  if (showFileBrowser && sandbox.sandboxId) {
    // Carry the repo's ambient glow into the file browser so chat ↔
    // file-tree feels like one continuous workspace, not two skins. Scratch
    // sessions have no repo to theme from, so they render flat (matching
    // the pre-glow file browser); the glow is a repo-identity affordance
    // and there's no identity to express here.
    const fileBrowserAppearance = workspaceRepo
      ? resolveRepoAppearance(workspaceRepo.full_name)
      : null;
    const fileBrowserAccentHex = fileBrowserAppearance
      ? getRepoAppearanceColorHex(fileBrowserAppearance.color)
      : null;
    return (
      <div className="flex h-dvh flex-col bg-push-surface-inset safe-area-top safe-area-bottom">
        <Suspense
          fallback={
            <div className="flex flex-1 items-center justify-center text-sm text-push-fg-dim">
              Loading workspace files...
            </div>
          }
        >
          <FileBrowser
            sandboxId={sandbox.sandboxId}
            workspaceLabel={workspaceRepo?.name || 'Workspace'}
            capabilities={fileBrowserCapabilities}
            scratchActions={fileBrowserScratchActions}
            onBack={() => setShowFileBrowser(false)}
            lockedProvider={lockedProvider}
            lockedModel={lockedModel}
            repoFullName={workspaceRepo?.full_name ?? null}
            onSandboxExpired={handleCommitSandboxExpired}
            currentBranch={workspaceRepo?.current_branch || workspaceRepo?.default_branch}
            defaultBranch={workspaceRepo?.default_branch}
            onBranchSwitchPayload={applyBranchSwitchFromUI}
            accentHex={fileBrowserAccentHex}
            glowEnabled={fileBrowserAppearance?.glowEnabled ?? false}
            glowStyle={fileBrowserAppearance?.glowStyle ?? 'gradient'}
          />
        </Suspense>
        <Toaster position="bottom-center" />
      </div>
    );
  }

  // Assemble route domains — each group maps to a ChatRoute*Props interface
  const workspaceDomain = {
    activeRepo: workspaceRepo,
    workspaceSession,
    resolveRepoAppearance,
    setRepoAppearance,
    clearRepoAppearance,
    handleWorkspacePromotion,
    sandbox,
    handleStartWorkspace: onStartScratchWorkspace,
    handleStartChat: onStartChat,
    handleStartRelay: onStartRelay,
    handleResumeRelaySession: onResumeRelaySession,
    handleExitWorkspace,
    handleDisconnect: handleDisconnectFromWorkspace,
    handleCreateNewChat,
    handleOpenDraftComposer: onOpenDraftComposer,
    handleSandboxRestart,
    handleSandboxDownload,
    sandboxDownloading,
    setCurrentBranch,
    switchBranchFromUI,
    sandboxState,
    sandboxStateLoading,
    fetchSandboxState,
    ensureSandbox,
  };

  const conversationDomain = {
    messages,
    sendMessage: sendMessageWithChatDraft,
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
    setChatLinkedLibraries,
    deleteChat,
    deleteAllChats,
    clearMemoryByRepo,
    clearMemoryByBranch,
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
    applyBranchSwitchFromUI,
    forkBranchFromUI,
    switchBranchFromUI,
    mergeBranchInUI,
  };

  const repositoryDomain = {
    repos,
    reposLoading,
    reposError,
    branches,
    handleSelectRepoFromDrawer,
    handleResumeChatFromDrawer: onResumeChatFromDrawer,
  };

  const catalogDomain = {
    catalog,
    selectedChatProvider,
    selectedChatModels,
    handleSelectBackend,
    handleSelectOllamaModelFromChat,
    handleSelectOpenRouterModelFromChat,
    handleSelectCloudflareModelFromChat,
    handleSelectZenModelFromChat,
    handleSelectNvidiaModelFromChat,
    handleSelectKilocodeModelFromChat,
    handleSelectFireworksModelFromChat,
    handleSelectSakanaModelFromChat,
    handleSelectDeepSeekModelFromChat,
    handleSelectAzureModelFromChat,
    handleSelectBedrockModelFromChat,
    handleSelectVertexModelFromChat,
    handleSelectAnthropicModelFromChat,
    handleSelectOpenAIModelFromChat,
    handleSelectGoogleModelFromChat,
  };

  const workspaceDataDomain = {
    snapshots,
    instructions,
    scratchpad,
    todo,
    protectMain,
    autoBackRestore,
  };

  const authDomain = {
    token,
    tokenKind,
    patToken,
    isAppAuth,
    installationId,
    validatedUser,
    appLoading,
    appError,
    connectApp,
    installApp,
    setInstallationIdManually,
  };

  const uiStateDomain = {
    showToolActivity,
    approvalMode,
    updateApprovalMode,
    updateShowToolActivity,
    providerFailover,
    updateProviderFailover,
    runTokenBudget,
    updateRunTokenBudget,
    showInstallIdInput,
    setShowInstallIdInput,
    installIdInput,
    setInstallIdInput,
    allowlistSecretCmd,
    copyAllowlistCommand,
  };

  const profileDomain = {
    profile,
    updateProfile,
    clearProfile,
    displayNameDraft,
    setDisplayNameDraft,
    handleDisplayNameBlur,
    bioDraft,
    setBioDraft,
    handleBioBlur,
    chatInstructionsDraft,
    setChatInstructionsDraft,
    handleChatInstructionsBlur,
  };

  const routeProps = {
    ...workspaceDomain,
    ...conversationDomain,
    ...repositoryDomain,
    ...catalogDomain,
    ...workspaceDataDomain,
    ...authDomain,
    ...uiStateDomain,
    ...profileDomain,
  };

  return (
    <Suspense fallback={workspaceRouteFallback}>
      {workspaceSession.kind === 'chat' ? (
        <ChatSurfaceRoute key={workspaceSession.id} {...routeProps} />
      ) : (
        <WorkspaceChatRoute key={workspaceSession.id} {...routeProps} />
      )}
    </Suspense>
  );
}

export default WorkspaceSessionScreen;
