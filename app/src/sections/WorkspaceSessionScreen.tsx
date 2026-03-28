import { lazy, Suspense, useEffect, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { Toaster } from '@/components/ui/sonner';
import { useChat } from '@/hooks/useChat';
import { useSandbox } from '@/hooks/useSandbox';
import { useScratchpad } from '@/hooks/useScratchpad';
import { useProtectMain } from '@/hooks/useProtectMain';
import { useModelCatalog } from '@/hooks/useModelCatalog';
import { useSnapshotManager } from '@/hooks/useSnapshotManager';
import { useBranchManager } from '@/hooks/useBranchManager';
import { useProjectInstructions } from '@/hooks/useProjectInstructions';
import { useWorkspaceComposerState } from '@/hooks/useWorkspaceComposerState';
import { useWorkspacePreferences } from '@/hooks/useWorkspacePreferences';
import { useWorkspaceSandboxController } from '@/hooks/useWorkspaceSandboxController';
import { toConversationIndex } from '@/lib/conversation-index';
import type {
  RepoWithActivity,
  WorkspaceScreenProps,
} from '@/types';

const FileBrowser = lazy(() => import('./FileBrowser').then((module) => ({ default: module.FileBrowser })));
const WorkspaceChatRoute = lazy(() => import('./WorkspaceChatRoute').then((module) => ({ default: module.WorkspaceChatRoute })));

const workspaceRouteFallback = <div className="h-dvh bg-[#000]" />;

export function WorkspaceSessionScreen({
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
    runEvents,
    isStreaming,
    queuedFollowUpCount,
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
  const {
    showFileBrowser,
    setShowFileBrowser,
    sandboxState,
    sandboxStateLoading,
    sandboxDownloading,
    fetchSandboxState,
    inspectNewChatWorkspace,
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

  const handleSelectRepoFromDrawer = useCallback((repo: RepoWithActivity, branch?: string) => {
    onSelectRepo(repo, branch);
  }, [onSelectRepo]);

  if (showFileBrowser && sandbox.sandboxId) {
    return (
      <div className="flex h-dvh flex-col bg-[#000] safe-area-top safe-area-bottom">
        <Suspense
          fallback={(
            <div className="flex flex-1 items-center justify-center text-sm text-push-fg-dim">
              Loading workspace files...
            </div>
          )}
        >
          <FileBrowser
            sandboxId={sandbox.sandboxId}
            workspaceLabel={workspaceRepo?.name || 'Workspace'}
            capabilities={fileBrowserCapabilities}
            scratchActions={fileBrowserScratchActions}
            onBack={() => setShowFileBrowser(false)}
            lockedProvider={lockedProvider}
            lockedModel={lockedModel}
          />
        </Suspense>
        <Toaster position="bottom-center" />
      </div>
    );
  }

  return (
    <Suspense fallback={workspaceRouteFallback}>
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
        runEvents={runEvents}
        isStreaming={isStreaming}
        queuedFollowUpCount={queuedFollowUpCount}
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
    </Suspense>
  );
}

export default WorkspaceSessionScreen;
