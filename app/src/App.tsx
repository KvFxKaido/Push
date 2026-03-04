import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
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
import { useModelCatalog } from '@/hooks/useModelCatalog';
import { useSnapshotManager } from '@/hooks/useSnapshotManager';
import { useBranchManager } from '@/hooks/useBranchManager';
import { useProjectInstructions } from '@/hooks/useProjectInstructions';
import {
  setPreferredProvider,
  type PreferredProvider,
} from '@/lib/providers';
import { getContextMode, setContextMode, type ContextMode } from '@/lib/orchestrator';
import { downloadFromSandbox, execInSandbox } from '@/lib/sandbox-client';
import { getSandboxStartMode, setSandboxStartMode, type SandboxStartMode } from '@/lib/sandbox-start-mode';
import { SettingsSheet } from '@/components/SettingsSheet';
import { OnboardingScreen } from '@/sections/OnboardingScreen';
import { HomeScreen } from '@/sections/HomeScreen';
import { FileBrowser } from '@/sections/FileBrowser';
import { ChatScreen } from '@/sections/ChatScreen';
import type { AppScreen, RepoWithActivity, SandboxStateCardData } from '@/types';
import './App.css';

const TOOL_ACTIVITY_STORAGE_KEY = 'push:workspace:show-tool-activity';

function App() {
  // --- Core state ---
  const { activeRepo, setActiveRepo, clearActiveRepo, setCurrentBranch } = useActiveRepo();
  const scratchpad = useScratchpad(activeRepo?.full_name ?? null);
  const [isWorkspaceHubOpen, setIsWorkspaceHubOpen] = useState(false);
  const [isSandboxMode, setIsSandboxMode] = useState(false);
  const sandbox = useSandbox(isSandboxMode ? '' : (activeRepo?.full_name ?? null));

  // --- Chat ---
  const skipBranchTeardownRef = useRef(false);
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
      onBranchSwitch: (branch) => {
        skipBranchTeardownRef.current = true;
        setCurrentBranch(branch);
      },
      onSandboxUnreachable: (reason) => {
        sandbox.markUnreachable(reason);
      },
    },
    {
      currentBranch: activeRepo?.current_branch || activeRepo?.default_branch,
      defaultBranch: activeRepo?.default_branch,
    },
  );

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

  // --- Extracted hooks ---
  const catalog = useModelCatalog();
  const snapshots = useSnapshotManager(isSandboxMode, sandbox, activeRepo, isStreaming);
  const branches = useBranchManager(activeRepo, isSandboxMode);
  const [showFileBrowser, setShowFileBrowser] = useState(false);

  const instructions = useProjectInstructions(
    activeRepo,
    repos,
    isSandboxMode,
    sandbox,
    setAgentsMd,
    setWorkspaceContext,
    sendMessage,
    isStreaming,
    setShowFileBrowser,
    snapshots.markSnapshotActivity,
  );

  // --- Settings UI ---
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'you' | 'workspace' | 'ai'>('you');
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

  const handleSelectRepoFromDrawer = useCallback((repo: RepoWithActivity) => {
    if (isSandboxMode) {
      setIsSandboxMode(false);
      void sandbox.stop();
    }
    handleSelectRepo(repo);
  }, [isSandboxMode, sandbox, handleSelectRepo]);

  const handleBrowseRepos = useCallback(() => {
    if (isSandboxMode) {
      if (isStreaming) abortStream();
      setIsSandboxMode(false);
      void sandbox.stop();
      createNewChat();
    }
    clearActiveRepo();
  }, [isSandboxMode, isStreaming, abortStream, sandbox, createNewChat, clearActiveRepo]);

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

  // --- Settings & provider selection ---
  const handleOpenSettingsFromDrawer = useCallback((tab: 'you' | 'workspace' | 'ai') => {
    setSettingsTab(tab);
    setSettingsOpen(true);
  }, []);

  const ensureUnlockedChatForProviderChange = useCallback(() => {
    if (isProviderLocked || isModelLocked) {
      const id = createNewChat();
      switchChat(id);
    }
  }, [isProviderLocked, isModelLocked, createNewChat, switchChat]);

  // Destructure stable setter refs from catalog to avoid depending on the whole object
  const { setActiveBackend: setCatalogBackend } = catalog;
  const setOllamaModel = catalog.ollama.setModel;
  const setMistralModel = catalog.mistral.setModel;
  const setOpenRouterModel = catalog.openRouter.setModel;
  const setMinimaxModel = catalog.minimax.setModel;
  const setZaiModel = catalog.zai.setModel;
  const setGoogleModel = catalog.google.setModel;
  const setZenModel = catalog.zen.setModel;

  const handleSelectBackend = useCallback((provider: PreferredProvider) => {
    ensureUnlockedChatForProviderChange();
    setPreferredProvider(provider);
    setCatalogBackend(provider);
  }, [ensureUnlockedChatForProviderChange, setCatalogBackend]);

  const handleSelectOllamaModelFromChat = useCallback((model: string) => {
    ensureUnlockedChatForProviderChange();
    setOllamaModel(model);
  }, [ensureUnlockedChatForProviderChange, setOllamaModel]);

  const handleSelectMistralModelFromChat = useCallback((model: string) => {
    ensureUnlockedChatForProviderChange();
    setMistralModel(model);
  }, [ensureUnlockedChatForProviderChange, setMistralModel]);

  const handleSelectOpenRouterModelFromChat = useCallback((model: string) => {
    ensureUnlockedChatForProviderChange();
    setOpenRouterModel(model);
  }, [ensureUnlockedChatForProviderChange, setOpenRouterModel]);

  const handleSelectMinimaxModelFromChat = useCallback((model: string) => {
    ensureUnlockedChatForProviderChange();
    setMinimaxModel(model);
  }, [ensureUnlockedChatForProviderChange, setMinimaxModel]);

  const handleSelectZaiModelFromChat = useCallback((model: string) => {
    ensureUnlockedChatForProviderChange();
    setZaiModel(model);
  }, [ensureUnlockedChatForProviderChange, setZaiModel]);

  const handleSelectGoogleModelFromChat = useCallback((model: string) => {
    ensureUnlockedChatForProviderChange();
    setGoogleModel(model);
  }, [ensureUnlockedChatForProviderChange, setGoogleModel]);

  const handleSelectZenModelFromChat = useCallback((model: string) => {
    ensureUnlockedChatForProviderChange();
    setZenModel(model);
  }, [ensureUnlockedChatForProviderChange, setZenModel]);

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

  // ----- Settings sheet (shared across screens) -----
  const isConnected = Boolean(token) || isDemo || isSandboxMode;

  const settingsSheet = (
    <SettingsSheet
      open={settingsOpen}
      onOpenChange={setSettingsOpen}
      side="left"
      settingsTab={settingsTab}
      setSettingsTab={setSettingsTab}
      auth={{
        isConnected,
        isDemo,
        isAppAuth,
        installationId: installationId ?? '',
        token: token ?? '',
        patToken: patToken ?? '',
        validatedUser,
        appLoading,
        appError,
        connectApp,
        installApp,
        showInstallIdInput,
        setShowInstallIdInput,
        installIdInput,
        setInstallIdInput,
        setInstallationIdManually,
        allowlistSecretCmd,
        copyAllowlistCommand,
        onDisconnect: handleDisconnect,
      }}
      profile={{
        displayNameDraft,
        setDisplayNameDraft,
        onDisplayNameBlur: handleDisplayNameBlur,
        bioDraft,
        setBioDraft,
        onBioBlur: handleBioBlur,
        profile,
        clearProfile,
        validatedUser,
      }}
      ai={{
        activeProviderLabel: catalog.activeProviderLabel,
        activeBackend: catalog.activeBackend,
        setActiveBackend: catalog.setActiveBackend,
        isProviderLocked,
        lockedProvider,
        lockedModel,
        availableProviders: catalog.availableProviders,
        setPreferredProvider: catalog.setPreferredProvider,
        clearPreferredProvider: catalog.clearPreferredProvider,
        hasOllamaKey: catalog.ollama.hasKey,
        ollamaModel: catalog.ollama.model,
        setOllamaModel: catalog.ollama.setModel,
        ollamaModelOptions: catalog.ollamaModelOptions,
        ollamaModelsLoading: catalog.ollamaModels.loading,
        ollamaModelsError: catalog.ollamaModels.error,
        ollamaModelsUpdatedAt: catalog.ollamaModels.updatedAt,
        isOllamaModelLocked: isModelLocked && lockedProvider === 'ollama',
        refreshOllamaModels: catalog.refreshOllamaModels,
        ollamaKeyInput: catalog.ollama.keyInput,
        setOllamaKeyInput: catalog.ollama.setKeyInput,
        setOllamaKey: catalog.ollama.setKey,
        clearOllamaKey: catalog.ollama.clearKey,
        hasMistralKey: catalog.mistral.hasKey,
        mistralModel: catalog.mistral.model,
        setMistralModel: catalog.mistral.setModel,
        mistralModelOptions: catalog.mistralModelOptions,
        mistralModelsLoading: catalog.mistralModels.loading,
        mistralModelsError: catalog.mistralModels.error,
        mistralModelsUpdatedAt: catalog.mistralModels.updatedAt,
        isMistralModelLocked: isModelLocked && lockedProvider === 'mistral',
        refreshMistralModels: catalog.refreshMistralModels,
        mistralKeyInput: catalog.mistral.keyInput,
        setMistralKeyInput: catalog.mistral.setKeyInput,
        setMistralKey: catalog.mistral.setKey,
        clearMistralKey: catalog.mistral.clearKey,
        hasOpenRouterKey: catalog.openRouter.hasKey,
        openRouterModel: catalog.openRouter.model,
        setOpenRouterModel: catalog.openRouter.setModel,
        openRouterModelOptions: catalog.openRouterModelOptions,
        openRouterModelsLoading: catalog.openRouterModels.loading,
        openRouterModelsError: catalog.openRouterModels.error,
        openRouterModelsUpdatedAt: catalog.openRouterModels.updatedAt,
        isOpenRouterModelLocked: isProviderLocked && lockedProvider === 'openrouter',
        refreshOpenRouterModels: catalog.refreshOpenRouterModels,
        openRouterKeyInput: catalog.openRouter.keyInput,
        setOpenRouterKeyInput: catalog.openRouter.setKeyInput,
        setOpenRouterKey: catalog.openRouter.setKey,
        clearOpenRouterKey: catalog.openRouter.clearKey,
        hasMinimaxKey: catalog.minimax.hasKey,
        minimaxModel: catalog.minimax.model,
        setMinimaxModel: catalog.minimax.setModel,
        minimaxModelOptions: catalog.minimaxModelOptions,
        minimaxModelsLoading: catalog.minimaxModels.loading,
        minimaxModelsError: catalog.minimaxModels.error,
        minimaxModelsUpdatedAt: catalog.minimaxModels.updatedAt,
        isMinimaxModelLocked: isModelLocked && lockedProvider === 'minimax',
        refreshMinimaxModels: catalog.refreshMinimaxModels,
        minimaxKeyInput: catalog.minimax.keyInput,
        setMinimaxKeyInput: catalog.minimax.setKeyInput,
        setMinimaxKey: catalog.minimax.setKey,
        clearMinimaxKey: catalog.minimax.clearKey,
        hasZaiKey: catalog.zai.hasKey,
        zaiModel: catalog.zai.model,
        setZaiModel: catalog.zai.setModel,
        zaiModelOptions: catalog.zaiModelOptions,
        zaiModelsLoading: catalog.zaiModels.loading,
        zaiModelsError: catalog.zaiModels.error,
        zaiModelsUpdatedAt: catalog.zaiModels.updatedAt,
        isZaiModelLocked: isModelLocked && lockedProvider === 'zai',
        refreshZaiModels: catalog.refreshZaiModels,
        zaiKeyInput: catalog.zai.keyInput,
        setZaiKeyInput: catalog.zai.setKeyInput,
        setZaiKey: catalog.zai.setKey,
        clearZaiKey: catalog.zai.clearKey,
        hasGoogleKey: catalog.google.hasKey,
        googleModel: catalog.google.model,
        setGoogleModel: catalog.google.setModel,
        googleModelOptions: catalog.googleModelOptions,
        googleModelsLoading: catalog.googleModels.loading,
        googleModelsError: catalog.googleModels.error,
        googleModelsUpdatedAt: catalog.googleModels.updatedAt,
        isGoogleModelLocked: isModelLocked && lockedProvider === 'google',
        refreshGoogleModels: catalog.refreshGoogleModels,
        googleKeyInput: catalog.google.keyInput,
        setGoogleKeyInput: catalog.google.setKeyInput,
        setGoogleKey: catalog.google.setKey,
        clearGoogleKey: catalog.google.clearKey,
        hasZenKey: catalog.zen.hasKey,
        zenModel: catalog.zen.model,
        setZenModel: catalog.zen.setModel,
        zenModelOptions: catalog.zenModelOptions,
        zenModelsLoading: catalog.zenModels.loading,
        zenModelsError: catalog.zenModels.error,
        zenModelsUpdatedAt: catalog.zenModels.updatedAt,
        isZenModelLocked: isModelLocked && lockedProvider === 'zen',
        refreshZenModels: catalog.refreshZenModels,
        zenKeyInput: catalog.zen.keyInput,
        setZenKeyInput: catalog.zen.setKeyInput,
        setZenKey: catalog.zen.setKey,
        clearZenKey: catalog.zen.clearKey,
        hasTavilyKey: catalog.tavily.hasKey,
        tavilyKeyInput: catalog.tavily.keyInput,
        setTavilyKeyInput: catalog.tavily.setKeyInput,
        setTavilyKey: catalog.tavily.setKey,
        clearTavilyKey: catalog.tavily.clearKey,
      }}
      workspace={{
        contextMode,
        updateContextMode,
        sandboxStartMode,
        updateSandboxStartMode,
        sandboxStatus: sandbox.status,
        sandboxId: sandbox.sandboxId,
        sandboxError: sandbox.error,
        sandboxState,
        sandboxStateLoading,
        fetchSandboxState,
        protectMainGlobal: protectMain.globalDefault,
        setProtectMainGlobal: protectMain.setGlobalDefault,
        protectMainRepoOverride: protectMain.repoOverride,
        setProtectMainRepoOverride: protectMain.setRepoOverride,
        showToolActivity,
        setShowToolActivity: updateShowToolActivity,
        activeRepoFullName: activeRepo?.full_name ?? null,
      }}
      data={{
        activeRepo,
        deleteAllChats,
      }}
    />
  );

  // ----- Screen routing -----

  if (screen === 'onboarding') {
    return (
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
    );
  }

  if (screen === 'home') {
    return (
      <>
        <div className="flex h-dvh flex-col bg-[#000] safe-area-top safe-area-bottom">
          <HomeScreen
            repos={repos}
            loading={reposLoading}
            error={reposError}
            conversations={conversations}
            activeRepo={activeRepo}
            onSelectRepo={handleSelectRepo}
            onResumeConversation={handleResumeConversationFromHome}
            onOpenSettings={handleOpenSettingsFromDrawer}
            onDisconnect={handleDisconnect}
            onSandboxMode={handleSandboxMode}
            user={validatedUser}
          />
        </div>
        {settingsSheet}
      </>
    );
  }

  if (screen === 'file-browser' && sandbox.sandboxId) {
    return (
      <div className="flex h-dvh flex-col bg-[#000] safe-area-top safe-area-bottom">
        <FileBrowser
          sandboxId={sandbox.sandboxId}
          repoName={activeRepo?.name || 'Sandbox'}
          onBack={() => setShowFileBrowser(false)}
        />
        <Toaster position="bottom-center" />
      </div>
    );
  }

  // ----- Chat screen -----
  return (
    <ChatScreen
      activeRepo={activeRepo}
      isSandboxMode={isSandboxMode}
      sandbox={sandbox}
      messages={messages}
      sendMessage={sendMessage}
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
      settingsOpen={settingsOpen}
      setSettingsOpen={setSettingsOpen}
      settingsTab={settingsTab}
      setSettingsTab={setSettingsTab}
      handleOpenSettingsFromDrawer={handleOpenSettingsFromDrawer}
      handleDisconnect={handleDisconnect}
      handleSandboxRestart={handleSandboxRestart}
      handleSandboxDownload={handleSandboxDownload}
      sandboxDownloading={sandboxDownloading}
      handleSelectBackend={handleSelectBackend}
      handleSelectOllamaModelFromChat={handleSelectOllamaModelFromChat}
      handleSelectMistralModelFromChat={handleSelectMistralModelFromChat}
      handleSelectOpenRouterModelFromChat={handleSelectOpenRouterModelFromChat}
      handleSelectMinimaxModelFromChat={handleSelectMinimaxModelFromChat}
      handleSelectZaiModelFromChat={handleSelectZaiModelFromChat}
      handleSelectGoogleModelFromChat={handleSelectGoogleModelFromChat}
      handleSelectZenModelFromChat={handleSelectZenModelFromChat}
      handleSelectRepoFromDrawer={handleSelectRepoFromDrawer}
      handleBrowseRepos={handleBrowseRepos}
      setCurrentBranch={setCurrentBranch}
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
  );
}

export default App;
