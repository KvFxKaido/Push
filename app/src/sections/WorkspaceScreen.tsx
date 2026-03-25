import { useState, useEffect, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { Toaster } from '@/components/ui/sonner';
import { WorkspaceChatRoute } from './WorkspaceChatRoute';
import { FileBrowser } from './FileBrowser';
import { useChat } from '@/hooks/useChat';
import { useSandbox } from '@/hooks/useSandbox';
import { useScratchpad } from '@/hooks/useScratchpad';
import { useProtectMain } from '@/hooks/useProtectMain';
import { useModelCatalog } from '@/hooks/useModelCatalog';
import { useSnapshotManager, buildWorkspaceScratchActions } from '@/hooks/useSnapshotManager';
import { useBranchManager } from '@/hooks/useBranchManager';
import { useProjectInstructions } from '@/hooks/useProjectInstructions';
import { useWorkspaceComposerState } from '@/hooks/useWorkspaceComposerState';
import { useWorkspacePreferences } from '@/hooks/useWorkspacePreferences';
import { downloadFromSandbox, execInSandbox } from '@/lib/sandbox-client';
import { toConversationIndex } from '@/lib/conversation-index';
import type {
  NewChatWorkspaceState,
  RepoWithActivity,
  SandboxStateCardData,
  WorkspaceCapabilities,
  WorkspaceScratchActions,
  WorkspaceScreenProps,
} from '@/types';

function parseSandboxGitStatus(sandboxId: string, stdout: string): SandboxStateCardData {
  const lines = stdout.split('\n').map((line) => line.trimEnd()).filter(Boolean);
  const statusLine = lines.find((line) => line.startsWith('##'))?.slice(2).trim() || 'unknown';
  const branch = statusLine.split('...')[0].trim() || 'unknown';
  const entries = lines.filter((line) => !line.startsWith('##'));

  let stagedFiles = 0;
  let unstagedFiles = 0;
  let untrackedFiles = 0;
  for (const entry of entries) {
    const x = entry[0] || ' ';
    const y = entry[1] || ' ';
    if (x === '?' && y === '?') {
      untrackedFiles++;
      continue;
    }
    if (x !== ' ') stagedFiles++;
    if (y !== ' ') unstagedFiles++;
  }

  return {
    sandboxId,
    repoPath: '/workspace',
    branch,
    statusLine,
    changedFiles: entries.length,
    stagedFiles,
    unstagedFiles,
    untrackedFiles,
    preview: entries.slice(0, 6).map((line) => line.length > 120 ? `${line.slice(0, 120)}...` : line),
    fetchedAt: new Date().toISOString(),
  };
}

export function WorkspaceScreen({
  workspaceSession,
  onWorkspaceSessionChange,
  setActiveRepo,
  setCurrentBranch,
  repos,
  reposLoading,
  reposError,
  resolveRepoAppearance,
  setRepoAppearance,
  clearRepoAppearance,
  token,
  patToken,
  validatedUser,
  isAppAuth,
  installationId,
  appLoading,
  appError,
  connectApp,
  installApp,
  setInstallationIdManually,
  onDisconnect,
  onSelectRepo,
  onStartScratchWorkspace,
  onEndWorkspace,
  pendingResumeChatId,
  onConversationIndexChange,
}: WorkspaceScreenProps) {
  const isScratch = workspaceSession.kind === 'scratch';
  const workspaceRepo = workspaceSession.kind === 'repo' ? workspaceSession.repo : null;
  const scratchpad = useScratchpad(workspaceRepo?.full_name ?? null);
  const sandbox = useSandbox(
    isScratch ? '' : (workspaceRepo?.full_name ?? null),
    isScratch ? 'main' : (workspaceRepo?.current_branch || workspaceRepo?.default_branch || null),
  );
  const stopSandbox = sandbox.stop;
  const startSandbox = sandbox.start;
  const catalog = useModelCatalog();

  const skipBranchTeardownRef = useRef(false);
  const handleSandboxBranchSwitch = useCallback((branch: string) => {
    skipBranchTeardownRef.current = true;
    setCurrentBranch(branch);
  }, [setCurrentBranch]);

  const {
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
    createNewChat,
    deleteChat,
    deleteAllChats,
    regenerateLastResponse,
    editMessageAndResend,
    setWorkspaceContext,
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
    saveExpiryCheckpoint,
    ciStatus,
    diagnoseCIFailure,
  } = useChat(
    workspaceRepo?.full_name ?? null,
    {
      content: scratchpad.content,
      replace: scratchpad.replace,
      append: scratchpad.append,
    },
    undefined,
    {
      bindSandboxSessionToRepo: (repoFullName, branch) => {
        sandbox.rebindSessionRepo(repoFullName, branch);
      },
      onSandboxPromoted: (repo) => {
        sandbox.rebindSessionRepo(repo.full_name, repo.default_branch);
        setActiveRepo(repo);
        onWorkspaceSessionChange({
          id: workspaceSession.id,
          kind: 'repo',
          repo,
          sandboxId: sandbox.sandboxId,
        });
        toast.success(`Promoted to GitHub: ${repo.full_name}`);
      },
      onBranchSwitch: handleSandboxBranchSwitch,
      onSandboxUnreachable: (reason) => {
        sandbox.markUnreachable(reason);
      },
    },
    {
      currentBranch: workspaceRepo?.current_branch || workspaceRepo?.default_branch,
      defaultBranch: workspaceRepo?.default_branch,
    },
  );

  useEffect(() => {
    onConversationIndexChange(toConversationIndex(conversations));
  }, [conversations, onConversationIndexChange]);

  const handledResumeKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!pendingResumeChatId || !conversations[pendingResumeChatId]) return;
    const resumeKey = `${workspaceSession.id}:${pendingResumeChatId}`;
    if (handledResumeKeyRef.current === resumeKey) return;
    handledResumeKeyRef.current = resumeKey;
    switchChat(pendingResumeChatId);
  }, [conversations, pendingResumeChatId, switchChat, workspaceSession.id]);

  const protectMain = useProtectMain(workspaceRepo?.full_name ?? undefined);
  useEffect(() => {
    setIsMainProtected(protectMain.isProtected);
  }, [protectMain.isProtected, setIsMainProtected]);

  const {
    selectedChatProvider,
    selectedChatModels,
    sendMessageWithChatDraft,
    handleCreateNewChat,
    handleSelectBackend,
    handleSelectOllamaModelFromChat,
    handleSelectOpenRouterModelFromChat,
    handleSelectZenModelFromChat,
    handleSelectNvidiaModelFromChat,
    handleSelectBlackboxModelFromChat,
    handleSelectKilocodeModelFromChat,
    handleSelectOpenAdapterModelFromChat,
    handleSelectAzureModelFromChat,
    handleSelectBedrockModelFromChat,
    handleSelectVertexModelFromChat,
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

  const snapshots = useSnapshotManager(workspaceSession, sandbox, workspaceRepo, isStreaming);
  const branches = useBranchManager(workspaceRepo, workspaceSession);
  const [showFileBrowser, setShowFileBrowser] = useState(false);

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
    installIdInput,
    setInstallIdInput,
    showInstallIdInput,
    setShowInstallIdInput,
    showToolActivity,
    updateShowToolActivity,
    sandboxStartMode,
    updateSandboxStartMode,
    contextMode,
    updateContextMode,
    approvalMode,
    updateApprovalMode,
    allowlistSecretCmd,
    copyAllowlistCommand,
  } = useWorkspacePreferences(validatedUser?.login);

  const [sandboxState, setSandboxState] = useState<SandboxStateCardData | null>(null);
  const [sandboxStateLoading, setSandboxStateLoading] = useState(false);
  const sandboxStateFetchedFor = useRef<string | null>(null);
  const [sandboxDownloading, setSandboxDownloading] = useState(false);

  const handleSelectRepoFromDrawer = useCallback((repo: RepoWithActivity, branch?: string) => {
    onSelectRepo(repo, branch);
  }, [onSelectRepo]);

  const fetchSandboxState = useCallback(async (id: string): Promise<SandboxStateCardData | null> => {
    setSandboxStateLoading(true);
    try {
      const result = await execInSandbox(id, 'cd /workspace && git status -sb --porcelain=1');
      if (result.exitCode !== 0) return null;

      const nextState = parseSandboxGitStatus(id, result.stdout);
      setSandboxState(nextState);
      return nextState;
    } catch {
      return null;
    } finally {
      setSandboxStateLoading(false);
    }
  }, []);

  const inspectNewChatWorkspace = useCallback(async (): Promise<NewChatWorkspaceState | null> => {
    if (sandbox.status !== 'ready' || !sandbox.sandboxId) return null;

    if (isScratch) {
      try {
        const result = await execInSandbox(
          sandbox.sandboxId,
          "cd /workspace && total=$(find . -path './.git' -prune -o -type f -print | sed 's#^\\./##' | sort | wc -l | tr -d ' '); printf '__COUNT__%s\\n' \"$total\"; find . -path './.git' -prune -o -type f -print | sed 's#^\\./##' | sort | head -6",
        );
        if (result.exitCode !== 0) return null;

        const lines = result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
        const countLine = lines.find((line) => line.startsWith('__COUNT__'));
        const fileCount = Number.parseInt(countLine?.slice('__COUNT__'.length) || '0', 10);
        if (!Number.isFinite(fileCount) || fileCount <= 0) return null;

        return {
          mode: 'scratch',
          sandboxId: sandbox.sandboxId,
          branch: 'scratch',
          changedFiles: fileCount,
          stagedFiles: 0,
          unstagedFiles: fileCount,
          untrackedFiles: fileCount,
          preview: lines.filter((line) => !line.startsWith('__COUNT__')).slice(0, 6),
          fetchedAt: new Date().toISOString(),
        };
      } catch {
        return null;
      }
    }

    const nextState = await fetchSandboxState(sandbox.sandboxId);
    if (!nextState || nextState.changedFiles <= 0) return null;

    return {
      mode: 'repo',
      sandboxId: nextState.sandboxId,
      branch: nextState.branch,
      changedFiles: nextState.changedFiles,
      stagedFiles: nextState.stagedFiles,
      unstagedFiles: nextState.unstagedFiles,
      untrackedFiles: nextState.untrackedFiles,
      preview: nextState.preview,
      fetchedAt: nextState.fetchedAt,
    };
  }, [fetchSandboxState, isScratch, sandbox.sandboxId, sandbox.status]);

  useEffect(() => {
    if (sandbox.status !== 'ready' || !sandbox.sandboxId) {
      if (sandbox.status === 'idle') {
        setSandboxState(null);
        sandboxStateFetchedFor.current = null;
      }
      return;
    }
    if (sandboxStateFetchedFor.current === sandbox.sandboxId) return;
    sandboxStateFetchedFor.current = sandbox.sandboxId;
    fetchSandboxState(sandbox.sandboxId);
  }, [sandbox.status, sandbox.sandboxId, fetchSandboxState]);

  const ensureSandbox = useCallback(async (): Promise<string | null> => {
    if (sandbox.sandboxId) return sandbox.sandboxId;
    if (isScratch) return sandbox.start('', 'main');
    if (!workspaceRepo) return null;
    return sandbox.start(workspaceRepo.full_name, workspaceRepo.current_branch || workspaceRepo.default_branch);
  }, [sandbox, isScratch, workspaceRepo]);

  useEffect(() => {
    setEnsureSandbox(ensureSandbox);
  }, [ensureSandbox, setEnsureSandbox]);

  useEffect(() => {
    setSandboxId(sandbox.sandboxId);
    if (workspaceSession.sandboxId === sandbox.sandboxId) return;
    onWorkspaceSessionChange({ ...workspaceSession, sandboxId: sandbox.sandboxId });
  }, [onWorkspaceSessionChange, sandbox.sandboxId, setSandboxId, workspaceSession]);

  useEffect(() => {
    setWorkspaceSessionId(workspaceSession.id ?? null);
  }, [workspaceSession.id, setWorkspaceSessionId]);

  const previousSessionIdRef = useRef(workspaceSession.id);
  useEffect(() => {
    const previousSessionId = previousSessionIdRef.current;
    previousSessionIdRef.current = workspaceSession.id;
    if (previousSessionId === workspaceSession.id) return;

    setShowFileBrowser(false);
    setSandboxState(null);
    sandboxStateFetchedFor.current = null;

    if (isStreaming) {
      abortStream();
    }
    void stopSandbox();

    if (workspaceSession.kind === 'scratch') {
      createNewChat();
    }
  }, [abortStream, createNewChat, isStreaming, stopSandbox, workspaceSession.id, workspaceSession.kind]);

  const prevBranchRef = useRef<string | undefined>(workspaceRepo?.current_branch);
  useEffect(() => {
    const currentBranchValue = workspaceRepo?.current_branch;
    const prevBranch = prevBranchRef.current;
    prevBranchRef.current = currentBranchValue;

    if (prevBranch === currentBranchValue) return;
    if (isScratch) return;
    if (prevBranch === undefined) return;

    if (skipBranchTeardownRef.current) {
      console.log(`[WorkspaceScreen] Branch changed: ${prevBranch} → ${currentBranchValue} (sandbox-initiated, skipping teardown)`);
      skipBranchTeardownRef.current = false;
      return;
    }

    console.log(`[WorkspaceScreen] Branch changed: ${prevBranch} → ${currentBranchValue}, tearing down sandbox`);
    void stopSandbox();
  }, [workspaceRepo?.current_branch, isScratch, stopSandbox]);

  const { status: sandboxStatus, sandboxId: currentSandboxId } = sandbox;
  useEffect(() => {
    if (isScratch && sandboxStatus === 'idle' && !currentSandboxId) {
      startSandbox('', 'main');
    }
  }, [isScratch, sandboxStatus, currentSandboxId, startSandbox]);

  const handleSandboxDownload = useCallback(async () => {
    if (!sandbox.sandboxId || sandboxDownloading) return;
    setSandboxDownloading(true);
    try {
      const result = await downloadFromSandbox(sandbox.sandboxId);
      if (result.ok && result.archiveBase64) {
        const raw = atob(result.archiveBase64);
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        const blob = new Blob([bytes], { type: 'application/gzip' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `workspace-${Date.now()}.tar.gz`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch {
      // Best effort
    } finally {
      setSandboxDownloading(false);
    }
  }, [sandbox.sandboxId, sandboxDownloading]);

  const handleSandboxRestart = useCallback(async () => {
    await stopSandbox();
    if (isScratch) {
      await startSandbox('', 'main');
      return;
    }
    if (!workspaceRepo) return;
    await startSandbox(workspaceRepo.full_name, workspaceRepo.current_branch || workspaceRepo.default_branch);
  }, [isScratch, startSandbox, stopSandbox, workspaceRepo]);

  const fileBrowserCapabilities: Pick<WorkspaceCapabilities, 'canCommitAndPush'> = {
    canCommitAndPush: !isScratch,
  };

  const fileBrowserScratchActions: WorkspaceScratchActions | null = isScratch
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

  const handleExitWorkspace = useCallback(() => {
    if (isStreaming) {
      abortStream();
    }
    setShowFileBrowser(false);
    onEndWorkspace();
  }, [abortStream, isStreaming, onEndWorkspace]);

  const handleDisconnectFromWorkspace = useCallback(() => {
    if (isStreaming) {
      abortStream();
    }
    setShowFileBrowser(false);
    onDisconnect();
  }, [abortStream, isStreaming, onDisconnect]);

  useEffect(() => {
    return () => {
      void stopSandbox();
    };
  }, [stopSandbox]);

  if (showFileBrowser && sandbox.sandboxId) {
    return (
      <div className="flex h-dvh flex-col bg-[#000] safe-area-top safe-area-bottom">
        <FileBrowser
          sandboxId={sandbox.sandboxId}
          workspaceLabel={workspaceRepo?.name || 'Workspace'}
          capabilities={fileBrowserCapabilities}
          scratchActions={fileBrowserScratchActions}
          onBack={() => setShowFileBrowser(false)}
          lockedProvider={lockedProvider}
          lockedModel={lockedModel}
        />
        <Toaster position="bottom-center" />
      </div>
    );
  }

  return (
    <WorkspaceChatRoute
      key={workspaceSession.id}
      activeRepo={workspaceRepo}
      workspaceSession={workspaceSession}
      resolveRepoAppearance={resolveRepoAppearance}
      setRepoAppearance={setRepoAppearance}
      clearRepoAppearance={clearRepoAppearance}
      sandbox={sandbox}
      messages={messages}
      sendMessage={sendMessageWithChatDraft}
      agentStatus={agentStatus}
      agentEvents={agentEvents}
      isStreaming={isStreaming}
      lockedProvider={lockedProvider}
      isProviderLocked={isProviderLocked}
      lockedModel={lockedModel}
      isModelLocked={isModelLocked}
      conversations={conversations}
      activeChatId={activeChatId}
      switchChat={switchChat}
      renameChat={renameChat}
      deleteChat={deleteChat}
      deleteAllChats={deleteAllChats}
      regenerateLastResponse={regenerateLastResponse}
      editMessageAndResend={editMessageAndResend}
      handleCardAction={handleCardAction}
      contextUsage={contextUsage}
      abortStream={abortStream}
      interruptedCheckpoint={interruptedCheckpoint}
      resumeInterruptedRun={resumeInterruptedRun}
      dismissResume={dismissResume}
      saveExpiryCheckpoint={saveExpiryCheckpoint}
      ciStatus={ciStatus}
      diagnoseCIFailure={diagnoseCIFailure}
      repos={repos}
      reposLoading={reposLoading}
      reposError={reposError}
      branches={branches}
      catalog={catalog}
      snapshots={snapshots}
      instructions={instructions}
      scratchpad={scratchpad}
      protectMain={protectMain}
      profile={profile}
      updateProfile={updateProfile}
      clearProfile={clearProfile}
      token={token}
      patToken={patToken}
      isAppAuth={isAppAuth}
      installationId={installationId}
      validatedUser={validatedUser}
      appLoading={appLoading}
      appError={appError}
      connectApp={connectApp}
      installApp={installApp}
      showToolActivity={showToolActivity}
      handleStartWorkspace={isScratch ? undefined : onStartScratchWorkspace}
      handleExitWorkspace={handleExitWorkspace}
      handleCreateNewChat={handleCreateNewChat}
      inspectNewChatWorkspace={inspectNewChatWorkspace}
      handleDisconnect={handleDisconnectFromWorkspace}
      handleSandboxRestart={handleSandboxRestart}
      handleSandboxDownload={handleSandboxDownload}
      sandboxDownloading={sandboxDownloading}
      selectedChatProvider={selectedChatProvider}
      selectedChatModels={selectedChatModels}
      handleSelectBackend={handleSelectBackend}
      handleSelectOllamaModelFromChat={handleSelectOllamaModelFromChat}
      handleSelectOpenRouterModelFromChat={handleSelectOpenRouterModelFromChat}
      handleSelectZenModelFromChat={handleSelectZenModelFromChat}
      handleSelectNvidiaModelFromChat={handleSelectNvidiaModelFromChat}
      handleSelectBlackboxModelFromChat={handleSelectBlackboxModelFromChat}
      handleSelectKilocodeModelFromChat={handleSelectKilocodeModelFromChat}
      handleSelectOpenAdapterModelFromChat={handleSelectOpenAdapterModelFromChat}
      handleSelectAzureModelFromChat={handleSelectAzureModelFromChat}
      handleSelectBedrockModelFromChat={handleSelectBedrockModelFromChat}
      handleSelectVertexModelFromChat={handleSelectVertexModelFromChat}
      handleSelectRepoFromDrawer={handleSelectRepoFromDrawer}
      setCurrentBranch={setCurrentBranch}
      onSandboxBranchSwitch={handleSandboxBranchSwitch}
      sandboxState={sandboxState}
      sandboxStateLoading={sandboxStateLoading}
      fetchSandboxState={fetchSandboxState}
      approvalMode={approvalMode}
      updateApprovalMode={updateApprovalMode}
      contextMode={contextMode}
      updateContextMode={updateContextMode}
      sandboxStartMode={sandboxStartMode}
      updateSandboxStartMode={updateSandboxStartMode}
      updateShowToolActivity={updateShowToolActivity}
      showInstallIdInput={showInstallIdInput}
      setShowInstallIdInput={setShowInstallIdInput}
      installIdInput={installIdInput}
      setInstallIdInput={setInstallIdInput}
      setInstallationIdManually={setInstallationIdManually}
      allowlistSecretCmd={allowlistSecretCmd}
      copyAllowlistCommand={copyAllowlistCommand}
      displayNameDraft={displayNameDraft}
      setDisplayNameDraft={setDisplayNameDraft}
      handleDisplayNameBlur={handleDisplayNameBlur}
      bioDraft={bioDraft}
      setBioDraft={setBioDraft}
      handleBioBlur={handleBioBlur}
      ensureSandbox={ensureSandbox}
    />
  );
}

export default WorkspaceScreen;
