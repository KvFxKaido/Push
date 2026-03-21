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
import { useSnapshotManager, buildWorkspaceScratchActions } from '@/hooks/useSnapshotManager';
import { useBranchManager } from '@/hooks/useBranchManager';
import { useProjectInstructions } from '@/hooks/useProjectInstructions';
import {
  normalizeKilocodeModelName,
  type PreferredProvider,
} from '@/lib/providers';
import { getContextMode, setContextMode, type ContextMode } from '@/lib/orchestrator';
import { downloadFromSandbox, execInSandbox } from '@/lib/sandbox-client';
import { getSandboxStartMode, setSandboxStartMode, type SandboxStartMode } from '@/lib/sandbox-start-mode';
import { safeStorageGet, safeStorageSet } from '@/lib/safe-storage';
import { lazyWithRecovery, toDefaultExport } from '@/lib/lazy-import';
import type {
  AppScreen,
  ActiveRepo,
  AttachmentData,
  ChatSendOptions,
  NewChatWorkspaceState,
  RepoWithActivity,
  SandboxStateCardData,
  WorkspaceSession,
  WorkspaceCapabilities,
  WorkspaceScratchActions,
} from '@/types';
import './App.css';

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

function sameActiveRepo(a: ActiveRepo | null, b: ActiveRepo | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.id === b.id
    && a.name === b.name
    && a.full_name === b.full_name
    && a.owner === b.owner
    && a.default_branch === b.default_branch
    && a.current_branch === b.current_branch
    && a.private === b.private;
}

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
const CHAT_MODEL_MEMORY_STORAGE_KEY = 'push:chat:last-used-models';

const EMPTY_CHAT_MODEL_MEMORY: Record<PreferredProvider, string> = {
  ollama: '',
  openrouter: '',
  zen: '',
  nvidia: '',
  blackbox: '',
  azure: '',
  bedrock: '',
  vertex: '',
  kilocode: '',
  openadapter: '',
};

function readStoredChatModelMemory(): Record<PreferredProvider, string> {
  const raw = safeStorageGet(CHAT_MODEL_MEMORY_STORAGE_KEY);
  if (!raw) return { ...EMPTY_CHAT_MODEL_MEMORY };

  try {
    const parsed = JSON.parse(raw) as Partial<Record<PreferredProvider, unknown>>;
    return {
      ollama: typeof parsed.ollama === 'string' ? parsed.ollama.trim() : '',
      openrouter: typeof parsed.openrouter === 'string' ? parsed.openrouter.trim() : '',
      zen: typeof parsed.zen === 'string' ? parsed.zen.trim() : '',
      nvidia: typeof parsed.nvidia === 'string' ? parsed.nvidia.trim() : '',
      blackbox: typeof parsed.blackbox === 'string' ? parsed.blackbox.trim() : '',
      azure: typeof parsed.azure === 'string' ? parsed.azure.trim() : '',
      bedrock: typeof parsed.bedrock === 'string' ? parsed.bedrock.trim() : '',
      vertex: typeof parsed.vertex === 'string' ? parsed.vertex.trim() : '',
      kilocode: typeof parsed.kilocode === 'string' ? normalizeKilocodeModelName(parsed.kilocode) : '',
      openadapter: typeof parsed.openadapter === 'string' ? parsed.openadapter.trim() : '',
    };
  } catch {
    return { ...EMPTY_CHAT_MODEL_MEMORY };
  }
}

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
  const [isWorkspaceHubOpen, setIsWorkspaceHubOpen] = useState(false);
  const [workspaceSession, setWorkspaceSession] = useState<WorkspaceSession | null>(() => (
    activeRepo
      ? { id: crypto.randomUUID(), kind: 'repo', repo: activeRepo, sandboxId: null }
      : null
  ));
  const isScratch = workspaceSession?.kind === 'scratch';
  const workspaceRepo = workspaceSession?.kind === 'repo' ? workspaceSession.repo : null;
  const scratchpad = useScratchpad(workspaceRepo?.full_name ?? null);
  const sandbox = useSandbox(
    isScratch ? '' : (workspaceRepo?.full_name ?? null),
    isScratch ? 'main' : (workspaceRepo?.current_branch || workspaceRepo?.default_branch || null),
  );
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
    blackbox: catalog.blackbox.model,
    kilocode: catalog.kilocode.model,
    openadapter: catalog.openadapter.model,
    azure: catalog.azure.model,
    bedrock: catalog.bedrock.model,
    vertex: catalog.vertex.model,
  }), [
    catalog.azure.model,
    catalog.bedrock.model,
    catalog.blackbox.model,
    catalog.kilocode.model,
    catalog.openadapter.model,
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

  const [rememberedChatModels, setRememberedChatModels] = useState<Record<PreferredProvider, string>>(
    () => readStoredChatModelMemory(),
  );

  useEffect(() => {
    safeStorageSet(CHAT_MODEL_MEMORY_STORAGE_KEY, JSON.stringify(rememberedChatModels));
  }, [rememberedChatModels]);

  const rememberChatModel = useCallback((provider: PreferredProvider, model: string | null | undefined) => {
    const trimmed = typeof model === 'string'
      ? (provider === 'kilocode' ? normalizeKilocodeModelName(model) : model.trim())
      : '';
    if (!trimmed) return;
    setRememberedChatModels((prev) => (
      prev[provider] === trimmed
        ? prev
        : { ...prev, [provider]: trimmed }
    ));
  }, []);

  const normalizeChatDraft = useCallback((draft?: Partial<ChatComposerDraft> | null): ChatComposerDraft => {
    const models: Record<PreferredProvider, string> = {
      ollama: draft?.models?.ollama?.trim() || rememberedChatModels.ollama || defaultChatModels.ollama,
      openrouter: draft?.models?.openrouter?.trim() || rememberedChatModels.openrouter || defaultChatModels.openrouter,
      zen: draft?.models?.zen?.trim() || rememberedChatModels.zen || defaultChatModels.zen,
      nvidia: draft?.models?.nvidia?.trim() || rememberedChatModels.nvidia || defaultChatModels.nvidia,
      blackbox: draft?.models?.blackbox?.trim() || rememberedChatModels.blackbox || defaultChatModels.blackbox,
      azure: draft?.models?.azure?.trim() || rememberedChatModels.azure || defaultChatModels.azure,
      bedrock: draft?.models?.bedrock?.trim() || rememberedChatModels.bedrock || defaultChatModels.bedrock,
      vertex: draft?.models?.vertex?.trim() || rememberedChatModels.vertex || defaultChatModels.vertex,
      kilocode: normalizeKilocodeModelName(
        draft?.models?.kilocode?.trim()
          || rememberedChatModels.kilocode
          || defaultChatModels.kilocode,
      ),
      openadapter: draft?.models?.openadapter?.trim() || rememberedChatModels.openadapter || defaultChatModels.openadapter,
    };

    let provider = draft?.provider ?? defaultChatProvider;
    if (provider && !availableChatProviders.has(provider)) {
      provider = defaultChatProvider;
    }

    return { provider, models };
  }, [availableChatProviders, defaultChatModels, defaultChatProvider, rememberedChatModels]);

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
        setWorkspaceSession((prev) => ({
          id: prev?.id ?? crypto.randomUUID(),
          kind: 'repo',
          repo,
          sandboxId: sandbox.sandboxId,
        }));
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

  const activeConversation = activeChatId ? conversations[activeChatId] : undefined;

  const activeChatDraft = useMemo(() => {
    const storedDraft = activeChatId ? chatDrafts[activeChatId] : null;
    const baseDraft = normalizeChatDraft(storedDraft);
    const lockedConversationModel = activeConversation?.provider === 'kilocode' && activeConversation.model
      ? normalizeKilocodeModelName(activeConversation.model)
      : activeConversation?.model;

    if (activeConversation?.provider && activeConversation.provider !== 'demo') {
      return normalizeChatDraft({
        provider: activeConversation.provider,
        models: lockedConversationModel
          ? { ...baseDraft.models, [activeConversation.provider]: lockedConversationModel }
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
  const protectMain = useProtectMain(workspaceRepo?.full_name ?? undefined);
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

  const sendMessageWithChatDraft = useCallback((message: string, attachments?: AttachmentData[], options?: ChatSendOptions) => {
    if (activeChatDraft.provider) {
      rememberChatModel(activeChatDraft.provider, activeChatDraft.models[activeChatDraft.provider]);
    }
    return sendMessage(message, attachments, {
      provider: activeChatDraft.provider,
      model: activeChatDraft.provider ? activeChatDraft.models[activeChatDraft.provider] : null,
      displayText: options?.displayText,
    });
  }, [activeChatDraft, rememberChatModel, sendMessage]);

  // --- Extracted hooks ---
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

  // --- Settings UI ---
  const [showToolActivity, setShowToolActivityState] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(TOOL_ACTIVITY_STORAGE_KEY) === '1';
  });
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
    if (isScratch) return showFileBrowser && sandbox.sandboxId ? 'file-browser' : 'chat';
    if (!token) return 'onboarding';
    if (workspaceSession?.kind === 'repo') {
      return showFileBrowser && sandbox.sandboxId ? 'file-browser' : 'chat';
    }
    return 'home';
  }, [token, isScratch, showFileBrowser, sandbox.sandboxId, workspaceSession]);

  // --- Auth & repo handlers ---
  const handleConnect = useCallback(
    async (pat: string): Promise<boolean> => {
      const success = await setTokenManually(pat);
      if (success) syncRepos();
      return success;
    },
    [setTokenManually, syncRepos],
  );

  const handleStartScratchWorkspace = useCallback(() => {
    if (isStreaming) abortStream();
    if (workspaceSession) void sandbox.stop();
    clearActiveRepo();
    setWorkspaceSession({ id: crypto.randomUUID(), kind: 'scratch', sandboxId: null });
    createNewChat();
  }, [isStreaming, abortStream, clearActiveRepo, createNewChat, sandbox, workspaceSession]);

  const handleEndWorkspace = useCallback(() => {
    if (isStreaming) abortStream();
    setWorkspaceSession(null);
    void sandbox.stop();
    createNewChat();
  }, [isStreaming, abortStream, sandbox, createNewChat]);

  const handleSandboxRestart = useCallback(async () => {
    await sandbox.stop();
    sandbox.start('', 'main');
  }, [sandbox]);

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
      const switchingFromScratch = workspaceSession?.kind === 'scratch';
      const switchingRepos = workspaceSession?.kind === 'repo'
        && workspaceSession.repo.full_name !== repoData.full_name;
      if (switchingFromScratch || switchingRepos) {
        void sandbox.stop();
      }
      setActiveRepo(repoData);
      setWorkspaceSession({ id: crypto.randomUUID(), kind: 'repo', repo: repoData, sandboxId: null });
    },
    [sandbox, setActiveRepo, workspaceSession],
  );

  const handleSelectRepoFromDrawer = useCallback((repo: RepoWithActivity, branch?: string) => {
    handleSelectRepo(repo, branch);
  }, [handleSelectRepo]);

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
    rememberChatModel('ollama', model);
    const chatId = ensureDraftChatForComposerChange();
    upsertChatDraft(chatId, { models: { ollama: model } });
  }, [ensureDraftChatForComposerChange, rememberChatModel, upsertChatDraft]);

  const handleSelectOpenRouterModelFromChat = useCallback((model: string) => {
    rememberChatModel('openrouter', model);
    const chatId = ensureDraftChatForComposerChange();
    upsertChatDraft(chatId, { models: { openrouter: model } });
  }, [ensureDraftChatForComposerChange, rememberChatModel, upsertChatDraft]);

  const handleSelectZenModelFromChat = useCallback((model: string) => {
    rememberChatModel('zen', model);
    const chatId = ensureDraftChatForComposerChange();
    upsertChatDraft(chatId, { models: { zen: model } });
  }, [ensureDraftChatForComposerChange, rememberChatModel, upsertChatDraft]);

  const handleSelectNvidiaModelFromChat = useCallback((model: string) => {
    rememberChatModel('nvidia', model);
    const chatId = ensureDraftChatForComposerChange();
    upsertChatDraft(chatId, { models: { nvidia: model } });
  }, [ensureDraftChatForComposerChange, rememberChatModel, upsertChatDraft]);

  const handleSelectBlackboxModelFromChat = useCallback((model: string) => {
    rememberChatModel('blackbox', model);
    const chatId = ensureDraftChatForComposerChange();
    upsertChatDraft(chatId, { models: { blackbox: model } });
  }, [ensureDraftChatForComposerChange, rememberChatModel, upsertChatDraft]);

  const handleSelectKilocodeModelFromChat = useCallback((model: string) => {
    const normalizedModel = normalizeKilocodeModelName(model);
    rememberChatModel('kilocode', normalizedModel);
    const chatId = ensureDraftChatForComposerChange();
    upsertChatDraft(chatId, { models: { kilocode: normalizedModel } });
  }, [ensureDraftChatForComposerChange, rememberChatModel, upsertChatDraft]);

  const handleSelectOpenAdapterModelFromChat = useCallback((model: string) => {
    rememberChatModel('openadapter', model);
    const chatId = ensureDraftChatForComposerChange();
    upsertChatDraft(chatId, { models: { openadapter: model } });
  }, [ensureDraftChatForComposerChange, rememberChatModel, upsertChatDraft]);

  const handleSelectAzureModelFromChat = useCallback((model: string) => {
    rememberChatModel('azure', model);
    const chatId = ensureDraftChatForComposerChange();
    upsertChatDraft(chatId, { models: { azure: model } });
  }, [ensureDraftChatForComposerChange, rememberChatModel, upsertChatDraft]);

  const handleSelectBedrockModelFromChat = useCallback((model: string) => {
    rememberChatModel('bedrock', model);
    const chatId = ensureDraftChatForComposerChange();
    upsertChatDraft(chatId, { models: { bedrock: model } });
  }, [ensureDraftChatForComposerChange, rememberChatModel, upsertChatDraft]);

  const handleSelectVertexModelFromChat = useCallback((model: string) => {
    rememberChatModel('vertex', model);
    const chatId = ensureDraftChatForComposerChange();
    upsertChatDraft(chatId, { models: { vertex: model } });
  }, [ensureDraftChatForComposerChange, rememberChatModel, upsertChatDraft]);

  const handleDisconnect = useCallback(() => {
    appDisconnect();
    patLogout();
    clearActiveRepo();
    deleteAllChats();
    setWorkspaceSession(null);
  }, [appDisconnect, patLogout, clearActiveRepo, deleteAllChats]);

  useEffect(() => {
    if (!activeRepo) {
      setWorkspaceSession((prev) => (prev?.kind === 'repo' ? null : prev));
      return;
    }

    setWorkspaceSession((prev) => {
      if (!prev) {
        return { id: crypto.randomUUID(), kind: 'repo', repo: activeRepo, sandboxId: null };
      }
      if (prev.kind !== 'repo' || sameActiveRepo(prev.repo, activeRepo)) {
        return prev;
      }
      return { ...prev, repo: activeRepo };
    });
  }, [activeRepo]);

  // --- Sandbox lifecycle ---
  useEffect(() => {
    setSandboxId(sandbox.sandboxId);
    setWorkspaceSession((prev) => {
      if (!prev || prev.sandboxId === sandbox.sandboxId) return prev;
      return { ...prev, sandboxId: sandbox.sandboxId };
    });
  }, [sandbox.sandboxId, setSandboxId]);

  // Keep useChat's workspace session ID ref in sync
  useEffect(() => {
    setWorkspaceSessionId(workspaceSession?.id ?? null);
  }, [workspaceSession?.id, setWorkspaceSessionId]);

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

  // Branch switching: tear down sandbox when branch changes
  const prevBranchRef = useRef<string | undefined>(workspaceRepo?.current_branch);
  useEffect(() => {
    const currentBranchValue = workspaceRepo?.current_branch;
    const prevBranch = prevBranchRef.current;
    prevBranchRef.current = currentBranchValue;

    if (prevBranch === currentBranchValue) return;
    if (isScratch) return;
    if (prevBranch === undefined) return;

    if (skipBranchTeardownRef.current) {
      console.log(`[App] Branch changed: ${prevBranch} → ${currentBranchValue} (sandbox-initiated, skipping teardown)`);
      skipBranchTeardownRef.current = false;
      return;
    }

    console.log(`[App] Branch changed: ${prevBranch} → ${currentBranchValue}, tearing down sandbox`);
    void sandbox.stop();
  }, [workspaceRepo?.current_branch, isScratch, sandbox]);

  // Auto-start sandbox when entering sandbox mode
  const { status: sandboxStatus, sandboxId: currentSandboxId, start: startSandbox } = sandbox;
  useEffect(() => {
    if (isScratch && sandboxStatus === 'idle' && !currentSandboxId) {
      startSandbox('', 'main');
    }
  }, [isScratch, sandboxStatus, currentSandboxId, startSandbox]);

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
    if (activeChatDraft.provider) {
      rememberChatModel(activeChatDraft.provider, activeChatDraft.models[activeChatDraft.provider]);
    }
    const id = createNewChat();
    switchChat(id);
    syncRepos();
  }, [activeChatDraft, createNewChat, rememberChatModel, switchChat, syncRepos]);

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

  // ----- Screen routing -----

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
            conversations={conversations}
            activeRepo={workspaceRepo ?? activeRepo}
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

  if (screen === 'file-browser' && sandbox.sandboxId) {
    return (
      <Suspense fallback={suspenseFallback}>
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
      </Suspense>
    );
  }

  // ----- Chat screen -----
  return (
    <Suspense fallback={suspenseFallback}>
    <ChatScreen
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
      isWorkspaceHubOpen={isWorkspaceHubOpen}
      setIsWorkspaceHubOpen={setIsWorkspaceHubOpen}
      showToolActivity={showToolActivity}
      setShowFileBrowser={setShowFileBrowser}
      handleStartWorkspace={isScratch ? undefined : handleStartScratchWorkspace}
      handleExitWorkspace={handleEndWorkspace}
      handleCreateNewChat={handleCreateNewChat}
      inspectNewChatWorkspace={inspectNewChatWorkspace}
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
