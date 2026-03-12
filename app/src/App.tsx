import { useState, useEffect, useCallback, useMemo, useRef, Suspense } from 'react';
import { toast } from 'sonner';
import { Toaster } from '@/components/ui/sonner';
import { useChat } from '@/hooks/useChat';
import { useGitHubAuth } from '@/hooks/useGitHubAuth';
import { useGitHubAppAuth } from '@/hooks/useGitHubAppAuth';
import { useRepos } from '@/hooks/useRepos';
import { useActiveRepo } from '@/hooks/useActiveRepo';
import { useSandbox } from '@/hooks/useSandbox';
import { useScratchpad } from '@/hooks/useScratchpad';
import { useUserProfile } from '@/hooks/useUserProfile';
import { useProtectMain } from '@/hooks/useProtectMain';
import { useRepoAppearance } from '@/hooks/useRepoAppearance';
import { useModelCatalog } from '@/hooks/useModelCatalog';
import { useSnapshotManager } from '@/hooks/useSnapshotManager';
import { useBranchManager } from '@/hooks/useBranchManager';
import { useProjectInstructions } from '@/hooks/useProjectInstructions';
import {
  type PreferredProvider,
} from '@/lib/providers';
import { getContextMode, setContextMode, type ContextMode } from '@/lib/orchestrator';
import { downloadFromSandbox, execInSandbox } from '@/lib/sandbox-client';
import { getSandboxStartMode, setSandboxStartMode, type SandboxStartMode } from '@/lib/sandbox-start-mode';
import { lazyWithRecovery, toDefaultExport } from '@/lib/lazy-import';
import type { AppScreen, AttachmentData, RepoWithActivity, SandboxStateCardData } from '@/types';
import './App.css';

// --- Lazy-loaded screen & settings components (code-split) ---
const OnboardingScreen = lazyWithRecovery(
  toDefaultExport(() => import('@/sections/OnboardingScreen'), (module) => module.OnboardingScreen),
);
const HomeScreen = lazyWithRecovery(
  toDefaultExport(() => import('@/sections/HomeScreen'), (module) => module.HomeScreen),
);
const FileBrowser = lazyWithRecovery(
  toDefaultExport(() => import('@/sections/FileBrowser'), (module) => module.FileBrowser),
);
const ChatScreen = lazyWithRecovery(
  toDefaultExport(() => import('@/sections/ChatScreen'), (module) => module.ChatScreen),
);

const TOOL_ACTIVITY_STORAGE_KEY = 'push:workspace:show-tool-activity';

type ChatComposerDraft = {
  provider: PreferredProvider | null;
  models: Record<PreferredProvider, string>;
};

type ChatComposerDraftUpdate = {
  provider?: PreferredProvider | null;
  models?: Partial<Record<PreferredProvider, string>>;
};

function App() {
  // --- Core state ---
  const { activeRepo, setActiveRepo, clearActiveRepo, setCurrentBranch } = useActiveRepo();
  const scratchpad = useScratchpad(activeRepo?.full_name ?? null);
  const [isWorkspaceHubOpen, setIsWorkspaceHubOpen] = useState(false);
  const [isSandboxMode, setIsSandboxMode] = useState(false);
  const sandbox = useSandbox(isSandboxMode ? '' : (activeRepo?.full_name ?? null));
  const catalog = useModelCatalog();
  const {
    resolveRepoAppearance,
    setRepoAppearance,
    clearRepoAppearance,
  } = useRepoAppearance();

  const defaultChatModels = useMemo<Record<PreferredProvider, string>>(() => ({
    ollama: catalog.ollama.model,
    openrouter: catalog.openRouter.model,
    zen: catalog.zen.model,
    nvidia: catalog.nvidia.model,
    azure: catalog.azure.model,
    bedrock: catalog.bedrock.model,
    vertex: catalog.vertex.model,
  }), [
    catalog.azure.model,
    catalog.bedrock.model,
    catalog.nvidia.model,
    catalog.ollama.model,
    catalog.openRouter.model,
    catalog.vertex.model,
    catalog.zen.model,
  ]);

  const availableChatProviders = useMemo(
    () => new Set(catalog.availableProviders.map(([provider]) => provider)),
    [catalog.availableProviders],
  );

  const defaultChatProvider = useMemo<PreferredProvider | null>(() => {
    if (catalog.activeBackend && availableChatProviders.has(catalog.activeBackend)) {
      return catalog.activeBackend;
    }
    if (catalog.activeProviderLabel !== 'demo' && availableChatProviders.has(catalog.activeProviderLabel)) {
      return catalog.activeProviderLabel;
    }
    return catalog.availableProviders[0]?.[0] ?? null;
  }, [availableChatProviders, catalog.activeBackend, catalog.activeProviderLabel, catalog.availableProviders]);

  const normalizeChatDraft = useCallback((draft?: Partial<ChatComposerDraft> | null): ChatComposerDraft => {
    const models: Record<PreferredProvider, string> = {
      ollama: draft?.models?.ollama?.trim() || defaultChatModels.ollama,
      openrouter: draft?.models?.openrouter?.trim() || defaultChatModels.openrouter,
      zen: draft?.models?.zen?.trim() || defaultChatModels.zen,
      nvidia: draft?.models?.nvidia?.trim() || defaultChatModels.nvidia,
      azure: draft?.models?.azure?.trim() || defaultChatModels.azure,
      bedrock: draft?.models?.bedrock?.trim() || defaultChatModels.bedrock,
      vertex: draft?.models?.vertex?.trim() || defaultChatModels.vertex,
    };

    let provider = draft?.provider ?? defaultChatProvider;
    if (provider && !availableChatProviders.has(provider)) {
      provider = defaultChatProvider;
    }

    return { provider, models };
  }, [availableChatProviders, defaultChatModels, defaultChatProvider]);

  const [chatDrafts, setChatDrafts] = useState<Record<string, ChatComposerDraft>>({});

  // --- Chat ---
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
    setWorkspaceContext,
    setSandboxId,
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
    ciStatus,
    diagnoseCIFailure,
  } = useChat(
    activeRepo?.full_name ?? null,
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
        setIsSandboxMode(false);
        toast.success(`Promoted to GitHub: ${repo.full_name}`);
      },
      onBranchSwitch: handleSandboxBranchSwitch,
      onSandboxUnreachable: (reason) => {
        sandbox.markUnreachable(reason);
      },
    },
    {
      currentBranch: activeRepo?.current_branch || activeRepo?.default_branch,
      defaultBranch: activeRepo?.default_branch,
    },
  );

  const activeConversation = activeChatId ? conversations[activeChatId] : undefined;

  const activeChatDraft = useMemo(() => {
    const storedDraft = activeChatId ? chatDrafts[activeChatId] : null;
    const baseDraft = normalizeChatDraft(storedDraft);

    if (activeConversation?.provider && activeConversation.provider !== 'demo') {
      return normalizeChatDraft({
        provider: activeConversation.provider,
        models: activeConversation.model
          ? { ...baseDraft.models, [activeConversation.provider]: activeConversation.model }
          : baseDraft.models,
      });
    }

    return baseDraft;
  }, [activeChatId, activeConversation?.model, activeConversation?.provider, chatDrafts, normalizeChatDraft]);

  useEffect(() => {
    setChatDrafts((prev) => {
      let changed = false;
      const next: Record<string, ChatComposerDraft> = {};

      for (const [chatId, draft] of Object.entries(prev)) {
        const conversation = conversations[chatId];
        if (!conversation || conversation.provider) {
          changed = true;
          continue;
        }
        next[chatId] = draft;
      }

      return changed ? next : prev;
    });
  }, [conversations]);

  const upsertChatDraft = useCallback((chatId: string, updates: ChatComposerDraftUpdate) => {
    setChatDrafts((prev) => {
      const current = normalizeChatDraft(prev[chatId]);
      const next = normalizeChatDraft({
        provider: updates.provider ?? current.provider,
        models: {
          ...current.models,
          ...(updates.models ?? {}),
        },
      });
      return {
        ...prev,
        [chatId]: next,
      };
    });
  }, [normalizeChatDraft]);

  const ensureDraftChatForComposerChange = useCallback((): string => {
    if (activeChatId && !isProviderLocked && !isModelLocked) {
      return activeChatId;
    }

    const nextId = createNewChat();
    upsertChatDraft(nextId, activeChatDraft);
    return nextId;
  }, [activeChatDraft, activeChatId, createNewChat, isModelLocked, isProviderLocked, upsertChatDraft]);

  // --- Protect Main ---
  const protectMain = useProtectMain(activeRepo?.full_name ?? undefined);
  useEffect(() => {
    setIsMainProtected(protectMain.isProtected);
  }, [protectMain.isProtected, setIsMainProtected]);

  // --- Auth ---
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

  const sendMessageWithChatDraft = useCallback((message: string, attachments?: AttachmentData[]) => {
    return sendMessage(message, attachments, {
      provider: activeChatDraft.provider,
      model: activeChatDraft.provider ? activeChatDraft.models[activeChatDraft.provider] : null,
    });
  }, [activeChatDraft, sendMessage]);

  // --- Extracted hooks ---
  const snapshots = useSnapshotManager(isSandboxMode, sandbox, activeRepo, isStreaming);
  const branches = useBranchManager(activeRepo, isSandboxMode);
  const [showFileBrowser, setShowFileBrowser] = useState(false);

  const instructions = useProjectInstructions(
    activeRepo,
    repos,
    isSandboxMode,
    sandbox,
    setAgentsMd,
    setInstructionFilename,
    setWorkspaceContext,
    sendMessageWithChatDraft,
    isStreaming,
    setShowFileBrowser,
    snapshots.markSnapshotActivity,
  );

  // --- Settings UI ---
  const [showToolActivity, setShowToolActivityState] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(TOOL_ACTIVITY_STORAGE_KEY) === '1';
  });
  const [isDemo, setIsDemo] = useState(false);
  const { profile, updateProfile, clearProfile } = useUserProfile();
  const [displayNameDraft, setDisplayNameDraft] = useState('');
  const [bioDraft, setBioDraft] = useState('');
  const [installIdInput, setInstallIdInput] = useState('');
  const [showInstallIdInput, setShowInstallIdInput] = useState(false);
  const allowlistSecretCmd = 'npx wrangler secret put GITHUB_ALLOWED_INSTALLATION_IDS';
  const [sandboxStartMode, setSandboxStartModeState] = useState<SandboxStartMode>(() => getSandboxStartMode());
  const [contextMode, setContextModeState] = useState<ContextMode>(() => getContextMode());

  // --- Sandbox state for settings display ---
  const [sandboxState, setSandboxState] = useState<SandboxStateCardData | null>(null);
  const [sandboxStateLoading, setSandboxStateLoading] = useState(false);
  const sandboxStateFetchedFor = useRef<string | null>(null);
  const [sandboxDownloading, setSandboxDownloading] = useState(false);

  // --- Profile sync ---
  useEffect(() => { setDisplayNameDraft(profile.displayName); }, [profile.displayName]);
  useEffect(() => { setBioDraft(profile.bio); }, [profile.bio]);

  // --- Utility callbacks ---
  const copyAllowlistCommand = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(allowlistSecretCmd);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = allowlistSecretCmd;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
  }, [allowlistSecretCmd]);

  const updateContextMode = useCallback((mode: ContextMode) => {
    setContextMode(mode);
    setContextModeState(mode);
  }, []);

  const updateSandboxStartMode = useCallback((mode: SandboxStartMode) => {
    setSandboxStartMode(mode);
    setSandboxStartModeState(mode);
  }, []);

  const updateShowToolActivity = useCallback((value: boolean) => {
    setShowToolActivityState(value);
    if (typeof window === 'undefined') return;
    if (value) {
      window.localStorage.setItem(TOOL_ACTIVITY_STORAGE_KEY, '1');
    } else {
      window.localStorage.removeItem(TOOL_ACTIVITY_STORAGE_KEY);
    }
  }, []);

  // --- Screen state machine ---
  const screen: AppScreen = useMemo(() => {
    if (isSandboxMode) return showFileBrowser && sandbox.sandboxId ? 'file-browser' : 'chat';
    if (isDemo) return showFileBrowser && sandbox.sandboxId ? 'file-browser' : 'chat';
    if (!token) return 'onboarding';
    if (!activeRepo) return 'home';
    if (showFileBrowser && sandbox.sandboxId) return 'file-browser';
    return 'chat';
  }, [token, activeRepo, isDemo, isSandboxMode, showFileBrowser, sandbox.sandboxId]);

  // --- Auth & repo handlers ---
  const handleConnect = useCallback(
    async (pat: string): Promise<boolean> => {
      const success = await setTokenManually(pat);
      if (success) syncRepos();
      return success;
    },
    [setTokenManually, syncRepos],
  );

  const handleSandboxMode = useCallback(() => {
    if (isStreaming) abortStream();
    clearActiveRepo();
    setIsSandboxMode(true);
    createNewChat();
  }, [isStreaming, abortStream, createNewChat, clearActiveRepo]);

  const handleExitSandboxMode = useCallback(() => {
    if (isStreaming) abortStream();
    setIsSandboxMode(false);
    void sandbox.stop();
    createNewChat();
  }, [isStreaming, abortStream, sandbox, createNewChat]);

  const handleSandboxRestart = useCallback(async () => {
    await sandbox.stop();
    sandbox.start('', 'main');
  }, [sandbox]);

  const handleSelectRepo = useCallback(
    (repo: RepoWithActivity, branch?: string) => {
      setActiveRepo({
        id: repo.id,
        name: repo.name,
        full_name: repo.full_name,
        owner: repo.owner,
        default_branch: repo.default_branch,
        current_branch: branch || repo.default_branch,
        private: repo.private,
      });
    },
    [setActiveRepo],
  );

  const handleSelectRepoFromDrawer = useCallback((repo: RepoWithActivity, branch?: string) => {
    if (isSandboxMode) {
      setIsSandboxMode(false);
      void sandbox.stop();
    }
    handleSelectRepo(repo, branch);
  }, [isSandboxMode, sandbox, handleSelectRepo]);

  const handleResumeConversationFromHome = useCallback((chatId: string) => {
    const conv = conversations[chatId];
    if (!conv?.repoFullName) return;
    const repo = repos.find((r) => r.full_name === conv.repoFullName);
    if (!repo) return;
    handleSelectRepo(repo);
    if (conv.branch) {
      setCurrentBranch(conv.branch);
    }
    requestAnimationFrame(() => {
      switchChat(chatId);
    });
  }, [conversations, repos, handleSelectRepo, switchChat, setCurrentBranch]);

  const handleSelectBackend = useCallback((provider: PreferredProvider) => {
    const chatId = ensureDraftChatForComposerChange();
    upsertChatDraft(chatId, { provider });
  }, [ensureDraftChatForComposerChange, upsertChatDraft]);

  const handleSelectOllamaModelFromChat = useCallback((model: string) => {
    const chatId = ensureDraftChatForComposerChange();
    upsertChatDraft(chatId, { models: { ollama: model } });
  }, [ensureDraftChatForComposerChange, upsertChatDraft]);

  const handleSelectOpenRouterModelFromChat = useCallback((model: string) => {
    const chatId = ensureDraftChatForComposerChange();
    upsertChatDraft(chatId, { models: { openrouter: model } });
  }, [ensureDraftChatForComposerChange, upsertChatDraft]);

  const handleSelectZenModelFromChat = useCallback((model: string) => {
    const chatId = ensureDraftChatForComposerChange();
    upsertChatDraft(chatId, { models: { zen: model } });
  }, [ensureDraftChatForComposerChange, upsertChatDraft]);

  const handleSelectNvidiaModelFromChat = useCallback((model: string) => {
    const chatId = ensureDraftChatForComposerChange();
    upsertChatDraft(chatId, { models: { nvidia: model } });
  }, [ensureDraftChatForComposerChange, upsertChatDraft]);

  const handleSelectAzureModelFromChat = useCallback((model: string) => {
    const chatId = ensureDraftChatForComposerChange();
    upsertChatDraft(chatId, { models: { azure: model } });
  }, [ensureDraftChatForComposerChange, upsertChatDraft]);

  const handleSelectBedrockModelFromChat = useCallback((model: string) => {
    const chatId = ensureDraftChatForComposerChange();
    upsertChatDraft(chatId, { models: { bedrock: model } });
  }, [ensureDraftChatForComposerChange, upsertChatDraft]);

  const handleSelectVertexModelFromChat = useCallback((model: string) => {
    const chatId = ensureDraftChatForComposerChange();
    upsertChatDraft(chatId, { models: { vertex: model } });
  }, [ensureDraftChatForComposerChange, upsertChatDraft]);

  const handleDisconnect = useCallback(() => {
    appDisconnect();
    patLogout();
    clearActiveRepo();
    deleteAllChats();
    setIsDemo(false);
    setIsSandboxMode(false);
  }, [appDisconnect, patLogout, clearActiveRepo, deleteAllChats]);

  // --- Sandbox lifecycle ---
  useEffect(() => {
    setSandboxId(sandbox.sandboxId);
  }, [sandbox.sandboxId, setSandboxId]);

  const fetchSandboxState = useCallback(async (id: string) => {
    setSandboxStateLoading(true);
    try {
      const result = await execInSandbox(id, 'cd /workspace && git status -sb --porcelain=1');
      if (result.exitCode !== 0) return;

      const lines = result.stdout.split('\n').map((l: string) => l.trimEnd()).filter(Boolean);
      const statusLine = lines.find((l: string) => l.startsWith('##'))?.slice(2).trim() || 'unknown';
      const branch = statusLine.split('...')[0].trim() || 'unknown';
      const entries = lines.filter((l: string) => !l.startsWith('##'));

      let stagedFiles = 0, unstagedFiles = 0, untrackedFiles = 0;
      for (const entry of entries) {
        const x = entry[0] || ' ', y = entry[1] || ' ';
        if (x === '?' && y === '?') { untrackedFiles++; continue; }
        if (x !== ' ') stagedFiles++;
        if (y !== ' ') unstagedFiles++;
      }

      setSandboxState({
        sandboxId: id,
        repoPath: '/workspace',
        branch,
        statusLine,
        changedFiles: entries.length,
        stagedFiles,
        unstagedFiles,
        untrackedFiles,
        preview: entries.slice(0, 6).map((l: string) => l.length > 120 ? `${l.slice(0, 120)}...` : l),
        fetchedAt: new Date().toISOString(),
      });
    } catch {
      // Best-effort
    } finally {
      setSandboxStateLoading(false);
    }
  }, []);

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
    if (isSandboxMode) return sandbox.start('', 'main');
    if (!activeRepo) return null;
    return sandbox.start(activeRepo.full_name, activeRepo.current_branch || activeRepo.default_branch);
  }, [sandbox, activeRepo, isSandboxMode]);

  useEffect(() => {
    setEnsureSandbox(ensureSandbox);
  }, [ensureSandbox, setEnsureSandbox]);

  // Branch switching: tear down sandbox when branch changes
  const prevBranchRef = useRef<string | undefined>(activeRepo?.current_branch);
  useEffect(() => {
    const currentBranchValue = activeRepo?.current_branch;
    const prevBranch = prevBranchRef.current;
    prevBranchRef.current = currentBranchValue;

    if (prevBranch === currentBranchValue) return;
    if (isSandboxMode) return;
    if (prevBranch === undefined) return;

    if (skipBranchTeardownRef.current) {
      console.log(`[App] Branch changed: ${prevBranch} → ${currentBranchValue} (sandbox-initiated, skipping teardown)`);
      skipBranchTeardownRef.current = false;
      return;
    }

    console.log(`[App] Branch changed: ${prevBranch} → ${currentBranchValue}, tearing down sandbox`);
    void sandbox.stop();
  }, [activeRepo?.current_branch, isSandboxMode, sandbox]);

  // Auto-start sandbox when entering sandbox mode
  const { status: sandboxStatus, sandboxId: currentSandboxId, start: startSandbox } = sandbox;
  useEffect(() => {
    if (isSandboxMode && sandboxStatus === 'idle' && !currentSandboxId) {
      startSandbox('', 'main');
    }
  }, [isSandboxMode, sandboxStatus, currentSandboxId, startSandbox]);

  // --- Global effects ---
  useEffect(() => {
    if (token) syncRepos();
  }, [token, syncRepos]);

  useEffect(() => {
    if (validatedUser?.login && validatedUser.login !== profile.githubLogin) {
      updateProfile({ githubLogin: validatedUser.login });
    }
  }, [validatedUser?.login, profile.githubLogin, updateProfile]);

  const handleCreateNewChat = useCallback(() => {
    const id = createNewChat();
    switchChat(id);
    syncRepos();
  }, [createNewChat, switchChat, syncRepos]);

  const handleDisplayNameBlur = useCallback(() => {
    const nextDisplayName = displayNameDraft.trim();
    if (nextDisplayName !== profile.displayName) {
      updateProfile({ displayName: nextDisplayName });
    }
    if (nextDisplayName !== displayNameDraft) {
      setDisplayNameDraft(nextDisplayName);
    }
  }, [displayNameDraft, profile.displayName, updateProfile]);

  const handleBioBlur = useCallback(() => {
    const nextBio = bioDraft.slice(0, 300);
    if (nextBio !== profile.bio) {
      updateProfile({ bio: nextBio });
    }
    if (nextBio !== bioDraft) {
      setBioDraft(nextBio);
    }
  }, [bioDraft, profile.bio, updateProfile]);

  // Unregister service workers on tunnel domains
  useEffect(() => {
    if (window.location.hostname.includes('trycloudflare.com')) {
      navigator.serviceWorker?.getRegistrations().then((regs) =>
        regs.forEach((r) => r.unregister())
      );
    }
  }, []);

  // Sandbox download handler
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

  // ----- Screen routing -----

  const suspenseFallback = <div className="h-dvh bg-[#000]" />;

  if (screen === 'onboarding') {
    return (
      <Suspense fallback={suspenseFallback}>
        <div className="flex h-dvh flex-col bg-[#000] safe-area-top safe-area-bottom">
          <OnboardingScreen
            onConnect={handleConnect}
            onConnectOAuth={connectApp}
            onSandboxMode={handleSandboxMode}
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
            conversations={conversations}
            activeRepo={activeRepo}
            resolveRepoAppearance={resolveRepoAppearance}
            setRepoAppearance={setRepoAppearance}
            clearRepoAppearance={clearRepoAppearance}
            onSelectRepo={handleSelectRepo}
            onResumeConversation={handleResumeConversationFromHome}
            onDisconnect={handleDisconnect}
            onSandboxMode={handleSandboxMode}
            user={validatedUser}
          />
        </div>
      </Suspense>
    );
  }

  if (screen === 'file-browser' && sandbox.sandboxId) {
    return (
      <Suspense fallback={suspenseFallback}>
        <div className="flex h-dvh flex-col bg-[#000] safe-area-top safe-area-bottom">
          <FileBrowser
            sandboxId={sandbox.sandboxId}
            repoName={activeRepo?.name || 'Sandbox'}
            onBack={() => setShowFileBrowser(false)}
            lockedProvider={lockedProvider}
            lockedModel={lockedModel}
          />
          <Toaster position="bottom-center" />
        </div>
      </Suspense>
    );
  }

  // ----- Chat screen -----
  return (
    <Suspense fallback={suspenseFallback}>
    <ChatScreen
      activeRepo={activeRepo}
      isSandboxMode={isSandboxMode}
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
      handleCardAction={handleCardAction}
      contextUsage={contextUsage}
      abortStream={abortStream}
      interruptedCheckpoint={interruptedCheckpoint}
      resumeInterruptedRun={resumeInterruptedRun}
      dismissResume={dismissResume}
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
      isDemo={isDemo}
      isWorkspaceHubOpen={isWorkspaceHubOpen}
      setIsWorkspaceHubOpen={setIsWorkspaceHubOpen}
      showToolActivity={showToolActivity}
      setShowFileBrowser={setShowFileBrowser}
      handleSandboxMode={isSandboxMode ? undefined : handleSandboxMode}
      handleExitSandboxMode={handleExitSandboxMode}
      handleCreateNewChat={handleCreateNewChat}
      handleDisconnect={handleDisconnect}
      handleSandboxRestart={handleSandboxRestart}
      handleSandboxDownload={handleSandboxDownload}
      sandboxDownloading={sandboxDownloading}
      selectedChatProvider={activeChatDraft.provider}
      selectedChatModels={activeChatDraft.models}
      handleSelectBackend={handleSelectBackend}
      handleSelectOllamaModelFromChat={handleSelectOllamaModelFromChat}
      handleSelectOpenRouterModelFromChat={handleSelectOpenRouterModelFromChat}
      handleSelectZenModelFromChat={handleSelectZenModelFromChat}
      handleSelectNvidiaModelFromChat={handleSelectNvidiaModelFromChat}
      handleSelectAzureModelFromChat={handleSelectAzureModelFromChat}
      handleSelectBedrockModelFromChat={handleSelectBedrockModelFromChat}
      handleSelectVertexModelFromChat={handleSelectVertexModelFromChat}
      handleSelectRepoFromDrawer={handleSelectRepoFromDrawer}
      setCurrentBranch={setCurrentBranch}
      onSandboxBranchSwitch={handleSandboxBranchSwitch}
      sandboxState={sandboxState}
      sandboxStateLoading={sandboxStateLoading}
      fetchSandboxState={fetchSandboxState}
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

export default App;
