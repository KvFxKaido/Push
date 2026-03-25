import { useState, useEffect, useCallback, useMemo, Suspense } from 'react';
import { useGitHubAuth } from '@/hooks/useGitHubAuth';
import { useGitHubAppAuth } from '@/hooks/useGitHubAppAuth';
import { useRepos } from '@/hooks/useRepos';
import { useActiveRepo } from '@/hooks/useActiveRepo';
import { useRepoAppearance } from '@/hooks/useRepoAppearance';
import { replaceAllConversations, migrateConversationsToIndexedDB } from '@/lib/conversation-store';
import { safeStorageRemove } from '@/lib/safe-storage';
import { lazyWithRecovery, toDefaultExport } from '@/lib/lazy-import';
import type {
  AppShellScreen,
  Conversation,
  ConversationIndex,
  RepoWithActivity,
  WorkspaceSession,
} from '@/types';
import './App.css';

function toConversationIndex(conversations: Record<string, Conversation>): ConversationIndex {
  const index: ConversationIndex = {};
  for (const [chatId, conversation] of Object.entries(conversations)) {
    index[chatId] = Object.fromEntries(
      Object.entries(conversation).filter(([key]) => key !== 'messages'),
    ) as ConversationIndex[string];
  }
  return index;
}

const OnboardingScreen = lazyWithRecovery(
  toDefaultExport(() => import('@/sections/OnboardingScreen'), (module) => module.OnboardingScreen),
);
const HomeScreen = lazyWithRecovery(
  toDefaultExport(() => import('@/sections/HomeScreen'), (module) => module.HomeScreen),
);
const WorkspaceScreen = lazyWithRecovery(
  toDefaultExport(() => import('@/sections/WorkspaceScreen'), (module) => module.WorkspaceScreen),
);

function App() {
  const { activeRepo, setActiveRepo, clearActiveRepo, setCurrentBranch } = useActiveRepo();
  const [workspaceSession, setWorkspaceSession] = useState<WorkspaceSession | null>(() => (
    activeRepo
      ? { id: crypto.randomUUID(), kind: 'repo', repo: activeRepo, sandboxId: null }
      : null
  ));
  const [conversationIndex, setConversationIndex] = useState<ConversationIndex>({});
  const [pendingResumeChatId, setPendingResumeChatId] = useState<string | null>(null);

  const {
    resolveRepoAppearance,
    setRepoAppearance,
    clearRepoAppearance,
  } = useRepoAppearance();

  useEffect(() => {
    let cancelled = false;
    migrateConversationsToIndexedDB().then((conversations) => {
      if (cancelled) return;
      setConversationIndex(toConversationIndex(conversations));
    }).catch(() => {
      // Best effort bootstrap for HomeScreen history.
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const {
    token: patToken,
    setTokenManually,
    logout: patLogout,
    loading: patLoading,
    error: patError,
    validatedUser: patUser,
  } = useGitHubAuth();

  const {
    token: appToken,
    installationId,
    connect: connectApp,
    install: installApp,
    disconnect: appDisconnect,
    setInstallationIdManually,
    loading: appLoading,
    error: appError,
    validatedUser: appUser,
    isAppAuth,
  } = useGitHubAppAuth();

  const token = appToken || patToken;
  const authLoading = appLoading || patLoading;
  const authError = appError || patError;
  const validatedUser = appUser || patUser;
  const { repos, loading: reposLoading, error: reposError, sync: syncRepos } = useRepos();

  const handleConnect = useCallback(
    async (pat: string): Promise<boolean> => {
      const success = await setTokenManually(pat);
      if (success) syncRepos();
      return success;
    },
    [setTokenManually, syncRepos],
  );

  const handleStartScratchWorkspace = useCallback(() => {
    setPendingResumeChatId(null);
    clearActiveRepo();
    setWorkspaceSession({ id: crypto.randomUUID(), kind: 'scratch', sandboxId: null });
  }, [clearActiveRepo]);

  const handleEndWorkspace = useCallback(() => {
    setPendingResumeChatId(null);
    setWorkspaceSession(null);
  }, []);

  const handleSelectRepo = useCallback(
    (repo: RepoWithActivity, branch?: string) => {
      const repoData = {
        id: repo.id,
        name: repo.name,
        full_name: repo.full_name,
        owner: repo.owner,
        default_branch: repo.default_branch,
        current_branch: branch || repo.default_branch,
        private: repo.private,
      };
      setPendingResumeChatId(null);
      setActiveRepo(repoData);
      setWorkspaceSession({ id: crypto.randomUUID(), kind: 'repo', repo: repoData, sandboxId: null });
    },
    [setActiveRepo],
  );

  const handleResumeConversationFromHome = useCallback((chatId: string) => {
    const conversation = conversationIndex[chatId];
    if (!conversation?.repoFullName) return;

    const repo = repos.find((candidate) => candidate.full_name === conversation.repoFullName);
    if (!repo) return;

    handleSelectRepo(repo, conversation.branch || undefined);
    setPendingResumeChatId(chatId);
  }, [conversationIndex, repos, handleSelectRepo]);

  const handleSetCurrentBranch = useCallback((branch: string) => {
    setCurrentBranch(branch);
    setWorkspaceSession((prev) => {
      if (!prev || prev.kind !== 'repo') return prev;
      if (prev.repo.current_branch === branch) return prev;
      return {
        ...prev,
        repo: {
          ...prev.repo,
          current_branch: branch,
        },
      };
    });
  }, [setCurrentBranch]);

  const handleDisconnect = useCallback(() => {
    appDisconnect();
    patLogout();
    clearActiveRepo();
    setWorkspaceSession(null);
    setPendingResumeChatId(null);
    setConversationIndex({});
    safeStorageRemove('diff_active_chat');
    safeStorageRemove('diff_conversations');
    safeStorageRemove('diff_chat_history');
    void replaceAllConversations({});
  }, [appDisconnect, clearActiveRepo, patLogout]);

  useEffect(() => {
    if (token) syncRepos();
  }, [token, syncRepos]);

  const screen: AppShellScreen = useMemo(() => {
    if (workspaceSession?.kind === 'scratch') return 'workspace';
    if (!token) return 'onboarding';
    if (workspaceSession?.kind === 'repo') return 'workspace';
    return 'home';
  }, [token, workspaceSession]);

  const suspenseFallback = <div className="h-dvh bg-[#000]" />;

  if (screen === 'onboarding') {
    return (
      <Suspense fallback={suspenseFallback}>
        <div className="flex h-dvh flex-col bg-[#000] safe-area-top safe-area-bottom">
          <OnboardingScreen
            onConnect={handleConnect}
            onConnectOAuth={connectApp}
            onStartWorkspace={handleStartScratchWorkspace}
            onInstallApp={installApp}
            onConnectInstallationId={setInstallationIdManually}
            loading={authLoading}
            error={authError}
            validatedUser={validatedUser}
            isAppAuth={isAppAuth}
          />
        </div>
      </Suspense>
    );
  }

  if (screen === 'home') {
    return (
      <Suspense fallback={suspenseFallback}>
        <div className="flex h-dvh flex-col bg-[#000] safe-area-top safe-area-bottom">
          <HomeScreen
            repos={repos}
            loading={reposLoading}
            error={reposError}
            conversations={conversationIndex}
            activeRepo={activeRepo}
            resolveRepoAppearance={resolveRepoAppearance}
            setRepoAppearance={setRepoAppearance}
            clearRepoAppearance={clearRepoAppearance}
            onSelectRepo={handleSelectRepo}
            onResumeConversation={handleResumeConversationFromHome}
            onDisconnect={handleDisconnect}
            onStartWorkspace={handleStartScratchWorkspace}
            user={validatedUser}
          />
        </div>
      </Suspense>
    );
  }

  if (!workspaceSession) {
    return suspenseFallback;
  }

  return (
    <Suspense fallback={suspenseFallback}>
      <WorkspaceScreen
        workspaceSession={workspaceSession}
        onWorkspaceSessionChange={setWorkspaceSession}
        setActiveRepo={setActiveRepo}
        setCurrentBranch={handleSetCurrentBranch}
        repos={repos}
        reposLoading={reposLoading}
        reposError={reposError}
        resolveRepoAppearance={resolveRepoAppearance}
        setRepoAppearance={setRepoAppearance}
        clearRepoAppearance={clearRepoAppearance}
        token={token}
        patToken={patToken}
        validatedUser={validatedUser}
        isAppAuth={isAppAuth}
        installationId={installationId}
        appLoading={appLoading}
        appError={appError}
        connectApp={connectApp}
        installApp={installApp}
        setInstallationIdManually={setInstallationIdManually}
        onDisconnect={handleDisconnect}
        onSelectRepo={handleSelectRepo}
        onStartScratchWorkspace={handleStartScratchWorkspace}
        onEndWorkspace={handleEndWorkspace}
        pendingResumeChatId={pendingResumeChatId}
        onConversationIndexChange={setConversationIndex}
      />
    </Suspense>
  );
}

export default App;
