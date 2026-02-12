import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { FolderOpen, Loader2, Download, Save, RotateCcw, GitBranch, GitMerge, ChevronDown, Check } from 'lucide-react';
import { toast } from 'sonner';
import { Toaster } from '@/components/ui/sonner';
import { useChat } from '@/hooks/useChat';
import { useGitHubAuth } from '@/hooks/useGitHubAuth';
import { useGitHubAppAuth } from '@/hooks/useGitHubAppAuth';
import { useRepos } from '@/hooks/useRepos';
import { useActiveRepo } from '@/hooks/useActiveRepo';
import { useMoonshotKey } from '@/hooks/useMoonshotKey';
import { useOllamaConfig } from '@/hooks/useOllamaConfig';
import { useMistralConfig } from '@/hooks/useMistralConfig';
import { useZaiConfig } from '@/hooks/useZaiConfig';
import { useTavilyConfig } from '@/hooks/useTavilyConfig';
import { getPreferredProvider, setPreferredProvider, clearPreferredProvider, type PreferredProvider } from '@/lib/providers';
import { getActiveProvider, getContextMode, setContextMode, type ContextMode } from '@/lib/orchestrator';
import { fetchOllamaModels, fetchMistralModels } from '@/lib/model-catalog';
import { useSandbox } from '@/hooks/useSandbox';
import { useScratchpad } from '@/hooks/useScratchpad';
import { useUserProfile } from '@/hooks/useUserProfile';
import { useProtectMain } from '@/hooks/useProtectMain';
import { buildWorkspaceContext, sanitizeProjectInstructions } from '@/lib/workspace-context';
import { readFromSandbox, execInSandbox, downloadFromSandbox, writeToSandbox } from '@/lib/sandbox-client';
import { fetchProjectInstructions, fetchRepoBranches } from '@/lib/github-tools';
import { getSandboxStartMode, setSandboxStartMode, type SandboxStartMode } from '@/lib/sandbox-start-mode';
import {
  createSnapshot,
  saveSnapshotToIndexedDB,
  getLatestSnapshotBlob,
  getLatestSnapshotMeta,
  hydrateSnapshot,
  type SnapshotMeta,
  type HydrateProgress,
} from '@/lib/snapshot-manager';
import { ChatContainer } from '@/components/chat/ChatContainer';
import { ChatInput } from '@/components/chat/ChatInput';
import { RepoChatDrawer } from '@/components/chat/RepoChatDrawer';
import { WorkspacePanelButton } from '@/components/chat/WorkspacePanelButton';
import { WorkspacePanel } from '@/components/chat/WorkspacePanel';
import { SandboxExpiryBanner } from '@/components/chat/SandboxExpiryBanner';
import { OnboardingScreen } from '@/sections/OnboardingScreen';
import { HomeScreen } from '@/sections/HomeScreen';
import { FileBrowser } from '@/sections/FileBrowser';
import type { AppScreen, RepoWithActivity, SandboxStateCardData } from '@/types';
import { SettingsSheet } from '@/components/SettingsSheet';
import { BranchCreateSheet } from '@/components/chat/BranchCreateSheet';
import { MergeFlowSheet } from '@/components/chat/MergeFlowSheet';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import './App.css';

const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;
const SNAPSHOT_IDLE_MS = 5 * 60 * 1000;
const SNAPSHOT_HARD_CAP_MS = 4 * 60 * 60 * 1000;
const SNAPSHOT_MIN_GAP_MS = 60 * 1000;
const SNAPSHOT_STALE_MS = 7 * 24 * 60 * 60 * 1000;

function formatSnapshotAge(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  if (diffMs < 60_000) return 'just now';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function snapshotStagePercent(stage: HydrateProgress['stage']): number {
  switch (stage) {
    case 'uploading': return 20;
    case 'restoring': return 60;
    case 'validating': return 85;
    case 'done': return 100;
    default: return 0;
  }
}

const AGENTS_MD_TEMPLATE = `# AGENTS.md

## Project Overview
- What this project does:
- Primary users:
- Current priorities:

## Tech Stack
- Runtime/frameworks:
- Build/test tools:
- Deployment target:

## Architecture Notes
- Key directories:
- Important services/modules:
- Data flow summary:

## Coding Conventions
- Style/linting rules:
- Type/validation expectations:
- Error handling patterns:

## Testing
- Run unit tests:
- Run integration/e2e tests:
- Definition of done:

## Agent Guidance
- Preferred workflow for edits:
- Files/components to read first:
- Things to avoid:
`;

function App() {
  const { activeRepo, setActiveRepo, clearActiveRepo, setCurrentBranch } = useActiveRepo();
  const scratchpad = useScratchpad(activeRepo?.full_name ?? null);
  const [isWorkspacePanelOpen, setIsWorkspacePanelOpen] = useState(false);
  const [isSandboxMode, setIsSandboxMode] = useState(false);
  const sandbox = useSandbox(isSandboxMode ? '' : (activeRepo?.full_name ?? null));
  const {
    messages,
    sendMessage,
    agentStatus,
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
        // Sandbox already switched to this branch internally (e.g. draft checkout).
        // Suppress the next teardown so we just sync state without destroying the sandbox.
        skipBranchTeardownRef.current = true;
        setCurrentBranch(branch);
      },
    },
    {
      currentBranch: activeRepo?.current_branch || activeRepo?.default_branch,
      defaultBranch: activeRepo?.default_branch,
    },
  );

  // Protect Main — blocks commits/pushes to the default branch
  const protectMain = useProtectMain(activeRepo?.full_name ?? undefined);

  // Sync protect-main state to useChat (ref-based, non-reactive)
  useEffect(() => {
    setIsMainProtected(protectMain.isProtected);
  }, [protectMain.isProtected, setIsMainProtected]);

  // PAT-based auth (fallback)
  const {
    token: patToken,
    setTokenManually,
    logout: patLogout,
    loading: patLoading,
    error: patError,
    validatedUser: patUser,
  } = useGitHubAuth();

  // GitHub App auth (primary)
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

  // Prefer GitHub App token over PAT
  const token = appToken || patToken;
  const authLoading = appLoading || patLoading;
  const authError = appError || patError;
  const validatedUser = appUser || patUser;
  const { repos, loading: reposLoading, error: reposError, sync: syncRepos } = useRepos();
  const { setKey: setKimiKey, clearKey: clearKimiKey, hasKey: hasKimiKey } = useMoonshotKey();
  const { setKey: setOllamaKey, clearKey: clearOllamaKey, hasKey: hasOllamaKey, model: ollamaModel, setModel: setOllamaModel } = useOllamaConfig();
  const { setKey: setMistralKey, clearKey: clearMistralKey, hasKey: hasMistralKey, model: mistralModel, setModel: setMistralModel } = useMistralConfig();
  const { setKey: setZaiKey, clearKey: clearZaiKey, hasKey: hasZaiKey } = useZaiConfig();
  const { setKey: setTavilyKey, clearKey: clearTavilyKey, hasKey: hasTavilyKey } = useTavilyConfig();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'you' | 'workspace' | 'ai'>('you');
  const [isDemo, setIsDemo] = useState(false);
  const { profile, updateProfile, clearProfile } = useUserProfile();
  const [displayNameDraft, setDisplayNameDraft] = useState('');
  const [bioDraft, setBioDraft] = useState('');
  const [kimiKeyInput, setKimiKeyInput] = useState('');
  const [ollamaKeyInput, setOllamaKeyInput] = useState('');
  const [mistralKeyInput, setMistralKeyInput] = useState('');
  const [zaiKeyInput, setZaiKeyInput] = useState('');
  const [tavilyKeyInput, setTavilyKeyInput] = useState('');
  const [activeBackend, setActiveBackend] = useState<PreferredProvider | null>(() => getPreferredProvider());
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [mistralModels, setMistralModels] = useState<string[]>([]);
  const [ollamaModelsLoading, setOllamaModelsLoading] = useState(false);
  const [mistralModelsLoading, setMistralModelsLoading] = useState(false);
  const [ollamaModelsError, setOllamaModelsError] = useState<string | null>(null);
  const [mistralModelsError, setMistralModelsError] = useState<string | null>(null);
  const [ollamaModelsUpdatedAt, setOllamaModelsUpdatedAt] = useState<number | null>(null);
  const [mistralModelsUpdatedAt, setMistralModelsUpdatedAt] = useState<number | null>(null);

  // Derive display label from actual active provider
  const activeProviderLabel = getActiveProvider();
  const availableProviders = ([['moonshot', 'Kimi', hasKimiKey], ['ollama', 'Ollama', hasOllamaKey], ['mistral', 'Mistral', hasMistralKey], ['zai', 'Z.ai', hasZaiKey]] as const).filter(([, , has]) => has);
  
  const [showFileBrowser, setShowFileBrowser] = useState(false);
  const [creatingAgentsMd, setCreatingAgentsMd] = useState(false);
  const [creatingAgentsMdWithAI, setCreatingAgentsMdWithAI] = useState(false);
  const [installIdInput, setInstallIdInput] = useState('');
  const [showInstallIdInput, setShowInstallIdInput] = useState(false);

  // Branch lifecycle controls (sheets wired in Tasks 5 & 6)
  const [showBranchCreate, setShowBranchCreate] = useState(false);
  const [showMergeFlow, setShowMergeFlow] = useState(false);
  const [repoBranches, setRepoBranches] = useState<{ name: string; isDefault: boolean; isProtected: boolean }[]>([]);
  const [repoBranchesLoading, setRepoBranchesLoading] = useState(false);
  const [repoBranchesError, setRepoBranchesError] = useState<string | null>(null);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const branchFetchSeqRef = useRef(0);

  // Derived branch values
  const activeRepoFullName = activeRepo?.full_name || null;
  const currentBranch = activeRepo?.current_branch || activeRepo?.default_branch || 'main';
  const isOnMain = currentBranch === (activeRepo?.default_branch || 'main');
  const displayBranches = useMemo(() => {
    if (!activeRepo) return repoBranches;
    if (!currentBranch) return repoBranches;
    if (repoBranches.some((b) => b.name === currentBranch)) return repoBranches;
    return [
      {
        name: currentBranch,
        isDefault: currentBranch === activeRepo.default_branch,
        isProtected: false,
      },
      ...repoBranches,
    ];
  }, [activeRepo, currentBranch, repoBranches]);

  // Sandbox state for settings display
  const [sandboxState, setSandboxState] = useState<SandboxStateCardData | null>(null);
  const [sandboxStateLoading, setSandboxStateLoading] = useState(false);
  const sandboxStateFetchedFor = useRef<string | null>(null);
  const [latestSnapshot, setLatestSnapshot] = useState<SnapshotMeta | null>(null);
  const [snapshotSaving, setSnapshotSaving] = useState(false);
  const [snapshotRestoring, setSnapshotRestoring] = useState(false);
  const [snapshotRestoreProgress, setSnapshotRestoreProgress] = useState<HydrateProgress | null>(null);
  const snapshotLastActivityRef = useRef<number>(Date.now());
  const snapshotLastSavedAtRef = useRef<number>(0);
  const snapshotSessionStartedAtRef = useRef<number>(Date.now());
  const snapshotHardCapNotifiedRef = useRef(false);
  const [sandboxStartMode, setSandboxStartModeState] = useState<SandboxStartMode>(() => getSandboxStartMode());
  const [contextMode, setContextModeState] = useState<ContextMode>(() => getContextMode());
  const allowlistSecretCmd = 'npx wrangler secret put GITHUB_ALLOWED_INSTALLATION_IDS';
  const isOllamaModelLocked = isModelLocked && lockedProvider === 'ollama';
  const isMistralModelLocked = isModelLocked && lockedProvider === 'mistral';

  const refreshOllamaModels = useCallback(async () => {
    if (!hasOllamaKey || ollamaModelsLoading) return;
    setOllamaModelsLoading(true);
    setOllamaModelsError(null);
    try {
      const models = await fetchOllamaModels();
      setOllamaModels(models);
      setOllamaModelsUpdatedAt(Date.now());
      if (models.length === 0) setOllamaModelsError('No models returned by Ollama.');
    } catch (err) {
      setOllamaModelsError(err instanceof Error ? err.message : 'Failed to load Ollama models.');
    } finally {
      setOllamaModelsLoading(false);
    }
  }, [hasOllamaKey, ollamaModelsLoading]);

  const refreshMistralModels = useCallback(async () => {
    if (!hasMistralKey || mistralModelsLoading) return;
    setMistralModelsLoading(true);
    setMistralModelsError(null);
    try {
      const models = await fetchMistralModels();
      setMistralModels(models);
      setMistralModelsUpdatedAt(Date.now());
      if (models.length === 0) setMistralModelsError('No models returned by Mistral.');
    } catch (err) {
      setMistralModelsError(err instanceof Error ? err.message : 'Failed to load Mistral models.');
    } finally {
      setMistralModelsLoading(false);
    }
  }, [hasMistralKey, mistralModelsLoading]);

  const loadRepoBranches = useCallback(async (repoFullName: string) => {
    const seq = ++branchFetchSeqRef.current;
    setRepoBranchesLoading(true);
    setRepoBranchesError(null);
    try {
      const { branches } = await fetchRepoBranches(repoFullName, 500);
      if (seq !== branchFetchSeqRef.current) return;
      setRepoBranches(branches);
    } catch (err) {
      if (seq !== branchFetchSeqRef.current) return;
      setRepoBranches([]);
      setRepoBranchesError(err instanceof Error ? err.message : 'Failed to load branches');
    } finally {
      if (seq === branchFetchSeqRef.current) {
        setRepoBranchesLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!activeRepoFullName || isSandboxMode) {
      branchFetchSeqRef.current++;
      setRepoBranches([]);
      setRepoBranchesError(null);
      setRepoBranchesLoading(false);
      setBranchMenuOpen(false);
      return;
    }
    void loadRepoBranches(activeRepoFullName);
  }, [activeRepoFullName, isSandboxMode, loadRepoBranches]);

  useEffect(() => {
    if (hasOllamaKey && ollamaModels.length === 0 && !ollamaModelsLoading) {
      refreshOllamaModels();
    }
  }, [hasOllamaKey, ollamaModels.length, ollamaModelsLoading, refreshOllamaModels]);

  useEffect(() => {
    if (hasMistralKey && mistralModels.length === 0 && !mistralModelsLoading) {
      refreshMistralModels();
    }
  }, [hasMistralKey, mistralModels.length, mistralModelsLoading, refreshMistralModels]);

  useEffect(() => {
    if (!hasOllamaKey) {
      setOllamaModels([]);
      setOllamaModelsError(null);
      setOllamaModelsUpdatedAt(null);
    }
  }, [hasOllamaKey]);

  useEffect(() => {
    if (!hasMistralKey) {
      setMistralModels([]);
      setMistralModelsError(null);
      setMistralModelsUpdatedAt(null);
    }
  }, [hasMistralKey]);

  useEffect(() => {
    setDisplayNameDraft(profile.displayName);
  }, [profile.displayName]);

  useEffect(() => {
    setBioDraft(profile.bio);
  }, [profile.bio]);

  const ollamaModelOptions = useMemo(() => {
    const set = new Set(ollamaModels);
    if (ollamaModel && !set.has(ollamaModel)) return [ollamaModel, ...ollamaModels];
    return ollamaModels;
  }, [ollamaModels, ollamaModel]);

  const mistralModelOptions = useMemo(() => {
    const set = new Set(mistralModels);
    if (mistralModel && !set.has(mistralModel)) return [mistralModel, ...mistralModels];
    return mistralModels;
  }, [mistralModels, mistralModel]);

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

  // Screen state machine
  const screen: AppScreen = useMemo(() => {
    if (isSandboxMode) return showFileBrowser && sandbox.sandboxId ? 'file-browser' : 'chat';
    if (isDemo) return showFileBrowser && sandbox.sandboxId ? 'file-browser' : 'chat';
    if (!token) return 'onboarding';
    if (!activeRepo) return 'home';
    if (showFileBrowser && sandbox.sandboxId) return 'file-browser';
    return 'chat';
  }, [token, activeRepo, isDemo, isSandboxMode, showFileBrowser, sandbox.sandboxId]);

  // On PAT connect success: auto-sync repos
  const handleConnect = useCallback(
    async (pat: string): Promise<boolean> => {
      const success = await setTokenManually(pat);
      if (success) syncRepos();
      return success;
    },
    [setTokenManually, syncRepos],
  );

  // Sandbox mode — ephemeral workspace, no GitHub auth required.
  // Must create a fresh chat to break any provider lock from the previous conversation.
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

  // Restart sandbox (for expiry recovery)
  const handleSandboxRestart = useCallback(async () => {
    await sandbox.stop();
    sandbox.start('', 'main');
  }, [sandbox]);

  // Sandbox download handler (for header button + expiry banner)
  const [sandboxDownloading, setSandboxDownloading] = useState(false);
  const markSnapshotActivity = useCallback(() => {
    snapshotLastActivityRef.current = Date.now();
  }, []);

  const refreshLatestSnapshot = useCallback(async () => {
    try {
      const meta = await getLatestSnapshotMeta();
      setLatestSnapshot(meta);
    } catch {
      setLatestSnapshot(null);
    }
  }, []);

  const captureSnapshot = useCallback(async (reason: 'manual' | 'interval' | 'idle') => {
    if (!sandbox.sandboxId || sandbox.status !== 'ready') return false;
    const now = Date.now();
    if (reason !== 'manual' && (now - snapshotLastSavedAtRef.current) < SNAPSHOT_MIN_GAP_MS) {
      return false;
    }

    setSnapshotSaving(true);
    try {
      const blob = await createSnapshot('/workspace', sandbox.sandboxId);
      const label = `workspace-${new Date().toISOString()}`;
      await saveSnapshotToIndexedDB(label, blob);
      snapshotLastSavedAtRef.current = Date.now();
      await refreshLatestSnapshot();
      if (reason === 'manual') {
        toast.success('Snapshot saved');
      }
      return true;
    } catch (err) {
      if (reason === 'manual') {
        const message = err instanceof Error ? err.message : 'Snapshot save failed';
        toast.error(message);
      }
      return false;
    } finally {
      setSnapshotSaving(false);
    }
  }, [sandbox.sandboxId, sandbox.status, refreshLatestSnapshot]);

  const handleRestoreFromSnapshot = useCallback(async () => {
    if (snapshotRestoring) return;
    const blob = await getLatestSnapshotBlob();
    if (!blob) {
      toast.error('No snapshot found');
      return;
    }

    let targetSandboxId = sandbox.sandboxId;
    if (!targetSandboxId) {
      targetSandboxId = isSandboxMode
        ? await sandbox.start('', 'main')
        : (activeRepo ? await sandbox.start(activeRepo.full_name, activeRepo.current_branch || activeRepo.default_branch) : null);
    }
    if (!targetSandboxId) {
      toast.error('Sandbox is not ready');
      return;
    }

    const shouldProceed = !sandbox.sandboxId || window.confirm('Restore will overwrite files in /workspace. Continue?');
    if (!shouldProceed) return;

    setSnapshotRestoring(true);
    setSnapshotRestoreProgress({ stage: 'uploading', message: 'Uploading snapshot...' });
    try {
      const result = await hydrateSnapshot(blob, '/workspace', targetSandboxId, setSnapshotRestoreProgress);
      if (!result.ok) {
        toast.error(result.error || 'Restore failed');
        return;
      }
      markSnapshotActivity();
      toast.success(`Snapshot restored (${result.restoredFiles ?? 0} files)`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Restore failed';
      toast.error(message);
    } finally {
      setSnapshotRestoring(false);
      setSnapshotRestoreProgress(null);
    }
  }, [snapshotRestoring, sandbox, isSandboxMode, activeRepo, markSnapshotActivity]);

  const refreshAgentsMdFromSandbox = useCallback(async (sandboxId: string): Promise<string | null> => {
    try {
      const result = await readFromSandbox(sandboxId, '/workspace/AGENTS.md');
      const content = result.content || '';
      if (!content.trim()) return null;
      setAgentsMdContent(content);
      setAgentsMd(content);
      return content;
    } catch {
      return null;
    }
  }, [setAgentsMd]);

  const autoCommitAgentsMdInSandbox = useCallback(async (sandboxId: string): Promise<{ ok: boolean; message: string }> => {
    const commitResult = await execInSandbox(
      sandboxId,
      `cd /workspace && if [ ! -d .git ]; then git init >/dev/null 2>&1; fi && git add AGENTS.md && if git diff --cached --quiet; then echo "__PUSH_NO_CHANGES__"; else git commit -m "Add project instructions"; fi`,
    );

    if (commitResult.exitCode !== 0) {
      const detail = commitResult.stderr || commitResult.stdout || 'unknown git error';
      return { ok: false, message: `AGENTS.md created, but commit failed: ${detail}` };
    }

    if ((commitResult.stdout || '').includes('__PUSH_NO_CHANGES__')) {
      return { ok: true, message: 'AGENTS.md already up to date in git.' };
    }

    return { ok: true, message: 'AGENTS.md created and committed.' };
  }, []);

  const handleCreateAgentsMd = useCallback(async () => {
    if (!activeRepo || creatingAgentsMd) return;
    setCreatingAgentsMd(true);
    try {
      let id = sandbox.sandboxId;
      if (!id) {
        id = await sandbox.start(activeRepo.full_name, activeRepo.current_branch || activeRepo.default_branch);
      }
      if (!id) {
        toast.error('Sandbox is not ready yet. Try again in a moment.');
        return;
      }

      const writeResult = await writeToSandbox(id, '/workspace/AGENTS.md', AGENTS_MD_TEMPLATE);
      if (!writeResult.ok) {
        toast.error(writeResult.error || 'Failed to create AGENTS.md');
        return;
      }

      const refreshed = await refreshAgentsMdFromSandbox(id);
      if (!refreshed) {
        toast.error('AGENTS.md was written but could not be re-read.');
        return;
      }

      const commitStatus = await autoCommitAgentsMdInSandbox(id);
      if (commitStatus.ok) {
        toast.success(commitStatus.message);
      } else {
        toast.warning(commitStatus.message);
      }
      setShowFileBrowser(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create AGENTS.md';
      toast.error(message);
    } finally {
      setCreatingAgentsMd(false);
    }
  }, [activeRepo, creatingAgentsMd, sandbox, refreshAgentsMdFromSandbox, autoCommitAgentsMdInSandbox]);

  const handleCreateAgentsMdWithAI = useCallback(async () => {
    if (!activeRepo || creatingAgentsMdWithAI || isStreaming) return;
    setCreatingAgentsMdWithAI(true);
    markSnapshotActivity();
    try {
      const prompt = [
        `Create an AGENTS.md file for this repository (${activeRepo.full_name}).`,
        'Use sandbox tools to inspect the repo quickly (README, package.json/pyproject, key folders), then write /workspace/AGENTS.md.',
        'Keep it concise and practical, with sections for: Project Overview, Tech Stack, Architecture Notes, Coding Conventions, Testing, Agent Guidance.',
        'If AGENTS.md already exists, overwrite it with an improved version.',
        'After writing the file, commit it with message "Add project instructions".',
        'If there are no staged changes, state that clearly.',
        'After commit, summarize what you included in 5 bullets.',
      ].join('\n');

      await sendMessage(prompt);
      const id = sandbox.sandboxId;
      if (!id) {
        toast.warning('AGENTS.md draft may be ready, but sandbox session is unavailable to refresh context.');
        return;
      }

      const refreshed = await refreshAgentsMdFromSandbox(id);
      if (!refreshed) {
        toast.warning('AGENTS.md was not detected after AI run. You can retry or use Create Template.');
        return;
      }

      const commitStatus = await autoCommitAgentsMdInSandbox(id);
      if (commitStatus.ok) {
        toast.success(commitStatus.message);
      } else {
        toast.warning(commitStatus.message);
      }
      setShowFileBrowser(true);
    } finally {
      setCreatingAgentsMdWithAI(false);
    }
  }, [activeRepo, creatingAgentsMdWithAI, isStreaming, markSnapshotActivity, sendMessage, sandbox.sandboxId, refreshAgentsMdFromSandbox, autoCommitAgentsMdInSandbox]);

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

  // Repo selection from picker
  const handleSelectRepo = useCallback(
    (repo: RepoWithActivity) => {
      setActiveRepo({
        id: repo.id,
        name: repo.name,
        full_name: repo.full_name,
        owner: repo.owner,
        default_branch: repo.default_branch,
        current_branch: repo.default_branch,
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
    // Restore the branch context from the conversation so the chat filter includes it
    if (conv.branch) {
      setCurrentBranch(conv.branch);
    }
    requestAnimationFrame(() => {
      switchChat(chatId);
    });
  }, [conversations, repos, handleSelectRepo, switchChat, setCurrentBranch]);

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

  const handleSelectBackend = useCallback((provider: PreferredProvider) => {
    ensureUnlockedChatForProviderChange();
    setPreferredProvider(provider);
    setActiveBackend(provider);
  }, [ensureUnlockedChatForProviderChange]);

  const handleSelectOllamaModelFromChat = useCallback((model: string) => {
    ensureUnlockedChatForProviderChange();
    setOllamaModel(model);
  }, [ensureUnlockedChatForProviderChange, setOllamaModel]);

  const handleSelectMistralModelFromChat = useCallback((model: string) => {
    ensureUnlockedChatForProviderChange();
    setMistralModel(model);
  }, [ensureUnlockedChatForProviderChange, setMistralModel]);

  // Disconnect: clear everything (both auth methods)
  const handleDisconnect = useCallback(() => {
    appDisconnect();
    patLogout();
    clearActiveRepo();
    deleteAllChats();
    setIsDemo(false);
    setIsSandboxMode(false);
  }, [appDisconnect, patLogout, clearActiveRepo, deleteAllChats]);

  // --- Project instructions: two-phase loading ---
  // Phase A: Fetch via GitHub API immediately when activeRepo changes (no sandbox needed)
  // Phase B: Upgrade from sandbox filesystem when sandbox becomes ready (may have local edits)

  const [agentsMdContent, setAgentsMdContent] = useState<string | null>(null);
  const [projectInstructionsChecked, setProjectInstructionsChecked] = useState(false);

  // Phase A — GitHub API fetch (immediate)
  useEffect(() => {
    if (!activeRepo) {
      setAgentsMdContent(null);
      setAgentsMd(null);
      setProjectInstructionsChecked(false);
      return;
    }
    setProjectInstructionsChecked(false);
    let cancelled = false;
    fetchProjectInstructions(activeRepo.full_name)
      .then((result) => {
        if (cancelled) return;
        setAgentsMdContent(result?.content ?? null);
        setAgentsMd(result?.content ?? null);
        setProjectInstructionsChecked(true);
      })
      .catch(() => {
        if (cancelled) return;
        setAgentsMdContent(null);
        setAgentsMd(null);
        setProjectInstructionsChecked(true);
      });
    return () => { cancelled = true; };
  }, [activeRepo, setAgentsMd]);

  // Phase B — Sandbox upgrade (overrides Phase A when sandbox is ready)
  useEffect(() => {
    if (sandbox.status !== 'ready' || !sandbox.sandboxId) return;
    let cancelled = false;
    readFromSandbox(sandbox.sandboxId, '/workspace/AGENTS.md')
      .then((result) => {
        if (cancelled) return;
        setAgentsMdContent(result.content);
        setAgentsMd(result.content);
      })
      .catch(() => {
        // Sandbox read failed — keep Phase A content, don't clear
      });
    return () => { cancelled = true; };
  }, [sandbox.status, sandbox.sandboxId, setAgentsMd]);

  // Build workspace context when repos, active repo, or project instructions change.
  // In sandbox mode, workspace context is null — the Orchestrator gets a sandbox-only
  // preamble instead (see toLLMMessages in orchestrator.ts).
  useEffect(() => {
    if (isSandboxMode) {
      setWorkspaceContext(null);
      return;
    }
    if (repos.length > 0) {
      let ctx = buildWorkspaceContext(repos, activeRepo);
      if (agentsMdContent) {
        const safe = sanitizeProjectInstructions(agentsMdContent);
        ctx += '\n\n[PROJECT INSTRUCTIONS]\n' + safe + '\n[/PROJECT INSTRUCTIONS]';
      }
      setWorkspaceContext(ctx);
    } else {
      setWorkspaceContext(null);
    }
  }, [repos, activeRepo, agentsMdContent, isSandboxMode, setWorkspaceContext]);

  // Sync sandbox ID to useChat
  useEffect(() => {
    setSandboxId(sandbox.sandboxId);
  }, [sandbox.sandboxId, setSandboxId]);

  // Fetch sandbox git state (for settings display)
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
      // Best-effort — sandbox state is informational
    } finally {
      setSandboxStateLoading(false);
    }
  }, []);

  // Auto-fetch sandbox state when sandbox becomes ready
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

  // Lazy sandbox auto-spin: creates sandbox on demand (called by useChat when sandbox tools are detected)
  const ensureSandbox = useCallback(async (): Promise<string | null> => {
    if (sandbox.sandboxId) return sandbox.sandboxId;
    if (isSandboxMode) return sandbox.start('', 'main');
    if (!activeRepo) return null;
    return sandbox.start(activeRepo.full_name, activeRepo.current_branch || activeRepo.default_branch);
  }, [sandbox, activeRepo, isSandboxMode]);

  useEffect(() => {
    setEnsureSandbox(ensureSandbox);
  }, [ensureSandbox, setEnsureSandbox]);

  // Branch switching: tear down sandbox when current_branch changes so it recreates on the new branch.
  // Uses a ref to track previous branch and skip the initial mount.
  // skipBranchTeardownRef suppresses teardown when the sandbox itself switched branches (e.g. draft checkout).
  const prevBranchRef = useRef<string | undefined>(activeRepo?.current_branch);
  const skipBranchTeardownRef = useRef(false);
  useEffect(() => {
    const currentBranchValue = activeRepo?.current_branch;
    const prevBranch = prevBranchRef.current;
    prevBranchRef.current = currentBranchValue;

    // Skip when there's no meaningful change
    if (prevBranch === currentBranchValue) return;
    // Don't tear down in sandbox mode (no repo-based sandbox)
    if (isSandboxMode) return;
    // Only tear down if there was a previous branch (not initial repo selection)
    if (prevBranch === undefined) return;

    // When the sandbox already switched branches (e.g. sandbox_save_draft created a draft branch),
    // skip teardown — the sandbox is already on the correct branch.
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

  // Load latest local snapshot metadata when sandbox mode is active.
  useEffect(() => {
    if (!isSandboxMode) return;
    refreshLatestSnapshot();
  }, [isSandboxMode, refreshLatestSnapshot]);

  // Snapshot activity heartbeat sources: user input + chat agent activity.
  useEffect(() => {
    if (!isSandboxMode) return;
    const mark = () => markSnapshotActivity();
    window.addEventListener('keydown', mark);
    window.addEventListener('pointerdown', mark);
    return () => {
      window.removeEventListener('keydown', mark);
      window.removeEventListener('pointerdown', mark);
    };
  }, [isSandboxMode, markSnapshotActivity]);

  useEffect(() => {
    if (isStreaming) {
      markSnapshotActivity();
    }
  }, [isStreaming, markSnapshotActivity]);

  useEffect(() => {
    if (!sandbox.sandboxId) return;
    snapshotSessionStartedAtRef.current = Date.now();
    snapshotHardCapNotifiedRef.current = false;
  }, [sandbox.sandboxId]);

  // Auto-save every 5 minutes and on idle heartbeat, with a 4-hour hard cap.
  useEffect(() => {
    if (!isSandboxMode || sandbox.status !== 'ready' || !sandbox.sandboxId) return;
    const timer = window.setInterval(async () => {
      const now = Date.now();
      const age = now - snapshotSessionStartedAtRef.current;
      if (age > SNAPSHOT_HARD_CAP_MS) {
        if (!snapshotHardCapNotifiedRef.current) {
          snapshotHardCapNotifiedRef.current = true;
          toast.message('Snapshot autosave paused after 4 hours');
        }
        return;
      }

      const lastSavedAgo = now - snapshotLastSavedAtRef.current;
      const idleFor = now - snapshotLastActivityRef.current;
      if (lastSavedAgo >= SNAPSHOT_INTERVAL_MS) {
        await captureSnapshot('interval');
        return;
      }
      if (idleFor >= SNAPSHOT_IDLE_MS) {
        await captureSnapshot('idle');
      }
    }, 15_000);

    return () => window.clearInterval(timer);
  }, [isSandboxMode, sandbox.status, sandbox.sandboxId, captureSnapshot]);

  // Sync repos on mount (for returning users who already have a token)
  useEffect(() => {
    if (token) syncRepos();
  }, [token, syncRepos]);

  useEffect(() => {
    if (validatedUser?.login && validatedUser.login !== profile.githubLogin) {
      updateProfile({ githubLogin: validatedUser.login });
    }
  }, [validatedUser?.login, profile.githubLogin, updateProfile]);

  // Wrap createNewChat to also re-sync repos
  const handleCreateNewChat = useCallback(() => {
    const id = createNewChat();
    switchChat(id);
    syncRepos();
  }, [createNewChat, switchChat, syncRepos]);

  const sendMessageWithSnapshotHeartbeat = useCallback((message: string, attachments?: Parameters<typeof sendMessage>[1]) => {
    markSnapshotActivity();
    return sendMessage(message, attachments);
  }, [markSnapshotActivity, sendMessage]);

  const handleCardActionWithSnapshotHeartbeat = useCallback((action: Parameters<typeof handleCardAction>[0]) => {
    markSnapshotActivity();
    return handleCardAction(action);
  }, [markSnapshotActivity, handleCardAction]);

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

  // Unregister service workers on tunnel domains to prevent stale caching
  useEffect(() => {
    if (window.location.hostname.includes('trycloudflare.com')) {
      navigator.serviceWorker?.getRegistrations().then((regs) =>
        regs.forEach((r) => r.unregister())
      );
    }
  }, []);

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
      <div className="flex h-dvh flex-col bg-[#000] safe-area-top safe-area-bottom">
        <HomeScreen
          repos={repos}
          loading={reposLoading}
          error={reposError}
          conversations={conversations}
          activeRepo={activeRepo}
          onSelectRepo={handleSelectRepo}
          onSelectBranch={setCurrentBranch}
          availableBranches={displayBranches}
          branchesLoading={repoBranchesLoading}
          branchesError={repoBranchesError}
          onRefreshBranches={
            activeRepo
              ? () => {
                  void loadRepoBranches(activeRepo.full_name);
                }
              : undefined
          }
          onResumeConversation={handleResumeConversationFromHome}
          onDisconnect={handleDisconnect}
          onSandboxMode={handleSandboxMode}
          user={validatedUser}
        />
      </div>
    );
  }

  // ----- File browser screen -----

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

  const isConnected = Boolean(token) || isDemo || isSandboxMode;
  const snapshotAgeLabel = latestSnapshot ? formatSnapshotAge(latestSnapshot.createdAt) : null;
  const snapshotIsStale = latestSnapshot ? (Date.now() - latestSnapshot.createdAt) > SNAPSHOT_STALE_MS : false;

  return (
    <div className="flex h-dvh flex-col bg-[#000] safe-area-top safe-area-bottom">
      {/* Top bar */}
      <header className="relative z-10 flex items-center justify-between px-3 pt-3 pb-2">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5 rounded-full border border-white/[0.06] bg-[#0a0e16]/80 py-1.5 pl-1.5 pr-3 backdrop-blur-xl">
            <RepoChatDrawer
              repos={repos}
              activeRepo={activeRepo}
              conversations={conversations}
              activeChatId={activeChatId}
              onSelectRepo={handleSelectRepoFromDrawer}
              onSwitchChat={switchChat}
              onNewChat={handleCreateNewChat}
              onDeleteChat={deleteChat}
              onRenameChat={renameChat}
              onOpenSettings={handleOpenSettingsFromDrawer}
              onBrowseRepos={handleBrowseRepos}
              onSandboxMode={isSandboxMode ? undefined : handleSandboxMode}
              isSandboxMode={isSandboxMode}
              onExitSandboxMode={handleExitSandboxMode}
              currentBranch={activeRepo?.current_branch || activeRepo?.default_branch}
              defaultBranch={activeRepo?.default_branch}
              setCurrentBranch={setCurrentBranch}
              availableBranches={displayBranches}
              branchesLoading={repoBranchesLoading}
              branchesError={repoBranchesError}
              onRefreshBranches={
                activeRepo
                  ? () => {
                      void loadRepoBranches(activeRepo.full_name);
                    }
                  : undefined
              }
            />
            <div className="min-w-0">
              <p className="truncate text-xs font-semibold text-[#f5f7ff]">
                {isSandboxMode ? 'Sandbox' : activeRepo?.name || 'Push'}
              </p>
            </div>
          </div>
          {isSandboxMode && (
              <>
                <span className="text-[10px] text-push-fg-dim">ephemeral</span>
                {latestSnapshot && (
                  <span
                    className={`text-[10px] ${snapshotIsStale ? 'text-amber-400' : 'text-[#5f6b80]'}`}
                    title={`Latest snapshot: ${new Date(latestSnapshot.createdAt).toLocaleString()}`}
                  >
                    {snapshotIsStale ? `snapshot stale (${snapshotAgeLabel})` : `snapshot ${snapshotAgeLabel}`}
                  </span>
                )}
                {sandbox.status === 'ready' && (
                  <button
                    onClick={() => captureSnapshot('manual')}
                    disabled={snapshotSaving || snapshotRestoring}
                    className="flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] text-push-fg-dim transition-colors hover:bg-[#0d1119] hover:text-emerald-400 active:scale-95 disabled:opacity-50"
                    title="Save Snapshot Now"
                    aria-label="Save Snapshot Now"
                  >
                    {snapshotSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                    Save
                  </button>
                )}
                {latestSnapshot && (
                  <button
                    onClick={handleRestoreFromSnapshot}
                    disabled={snapshotSaving || snapshotRestoring || sandbox.status === 'creating'}
                    className="flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] text-push-fg-dim transition-colors hover:bg-[#0d1119] hover:text-emerald-400 active:scale-95 disabled:opacity-50"
                    title="Restore from Last Snapshot"
                    aria-label="Restore from Last Snapshot"
                  >
                    {snapshotRestoring ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                    Restore
                  </button>
                )}
                {sandbox.status === 'ready' && (
                  <button
                    onClick={handleSandboxDownload}
                    disabled={sandboxDownloading}
                    className="flex h-7 w-7 items-center justify-center rounded-lg text-push-fg-dim transition-colors hover:bg-[#0d1119] hover:text-emerald-400 active:scale-95 disabled:opacity-50"
                    title="Download workspace"
                    aria-label="Download workspace"
                  >
                    {sandboxDownloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                  </button>
                )}
                {snapshotRestoring && snapshotRestoreProgress && (
                  <div className="flex min-w-[120px] flex-col gap-1">
                    <span className="text-[10px] text-push-fg-muted">{snapshotRestoreProgress.message}</span>
                    <div className="h-1 w-full overflow-hidden rounded bg-[#1a2130]">
                      <div
                        className="h-full bg-emerald-500 transition-all duration-300"
                        style={{ width: `${snapshotStagePercent(snapshotRestoreProgress.stage)}%` }}
                      />
                    </div>
                  </div>
                )}
              </>
            )}
        </div>
        {/* Centered branch selector for chat mode */}
        {activeRepo && !isSandboxMode && (
          <div className="pointer-events-none absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2">
            <DropdownMenu
              open={branchMenuOpen}
              onOpenChange={(open) => {
                setBranchMenuOpen(open);
                if (open && !repoBranchesLoading && displayBranches.length === 0) {
                  void loadRepoBranches(activeRepo.full_name);
                }
              }}
            >
              <DropdownMenuTrigger className="pointer-events-auto flex items-center gap-1 rounded-full border border-white/[0.06] bg-[#0a0e16]/90 px-2 py-1 backdrop-blur-xl transition-colors hover:border-[#31425a] hover:bg-[#0d1119]">
                <GitBranch className="h-3 w-3 text-[#5f6b80]" />
                <span className="max-w-[100px] truncate text-[10px] font-medium text-[#8b96aa]">
                  {currentBranch}
                </span>
                <ChevronDown className={`h-3 w-3 text-[#5f6b80] transition-transform ${branchMenuOpen ? 'rotate-180' : ''}`} />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="center"
                sideOffset={8}
                className="w-[240px] rounded-xl border border-push-edge bg-push-grad-card shadow-[0_18px_40px_rgba(0,0,0,0.62)]"
              >
                {isOnMain ? (
                  <DropdownMenuItem
                    onSelect={() => setShowBranchCreate(true)}
                    className="mx-1 flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-push-fg-secondary hover:bg-[#0d1119]"
                  >
                    <GitBranch className="h-3.5 w-3.5" />
                    Create branch
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem
                    onSelect={() => setShowMergeFlow(true)}
                    className="mx-1 flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-emerald-300 hover:bg-[#0d1119]"
                  >
                    <GitMerge className="h-3.5 w-3.5" />
                    Merge into {activeRepo.default_branch}
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator className="bg-push-edge" />
                <DropdownMenuLabel className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-push-fg-dim">
                  Switch Branch
                </DropdownMenuLabel>
                <DropdownMenuSeparator className="bg-push-edge" />

                {repoBranchesLoading && (
                  <DropdownMenuItem disabled className="mx-1 flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-push-fg-dim">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Loading branches...
                  </DropdownMenuItem>
                )}

                {!repoBranchesLoading && repoBranchesError && (
                  <>
                    <DropdownMenuItem disabled className="mx-1 rounded-lg px-3 py-2 text-xs text-red-400">
                      Failed to load branches
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={(e) => {
                        e.preventDefault();
                        void loadRepoBranches(activeRepo.full_name);
                      }}
                      className="mx-1 rounded-lg px-3 py-2 text-xs text-push-link hover:bg-[#0d1119]"
                    >
                      Retry
                    </DropdownMenuItem>
                  </>
                )}

                {!repoBranchesLoading && !repoBranchesError && displayBranches.length === 0 && (
                  <DropdownMenuItem disabled className="mx-1 rounded-lg px-3 py-2 text-xs text-push-fg-dim">
                    No branches found
                  </DropdownMenuItem>
                )}

                {!repoBranchesLoading && !repoBranchesError && displayBranches.map((branch) => {
                  const isActiveBranch = branch.name === currentBranch;
                  return (
                    <DropdownMenuItem
                      key={branch.name}
                      onSelect={() => {
                        if (!isActiveBranch) setCurrentBranch(branch.name);
                      }}
                      className={`mx-1 flex items-center gap-2 rounded-lg px-3 py-2 ${
                        isActiveBranch ? 'bg-[#101621]' : 'hover:bg-[#0d1119]'
                      }`}
                    >
                      <span className={`min-w-0 flex-1 truncate text-xs ${isActiveBranch ? 'text-push-fg' : 'text-push-fg-secondary'}`}>
                        {branch.name}
                      </span>
                      {branch.isDefault && (
                        <span className="rounded-full bg-[#0d2847] px-1.5 py-0.5 text-[10px] text-[#58a6ff]">
                          default
                        </span>
                      )}
                      {branch.isProtected && (
                        <span className="rounded-full bg-[#2a1a1a] px-1.5 py-0.5 text-[10px] text-[#fca5a5]">
                          protected
                        </span>
                      )}
                      {isActiveBranch && <Check className="h-3.5 w-3.5 text-push-link" />}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
        <div className="flex items-center gap-2">
          {/* File browser */}
          {(activeRepo || isSandboxMode) && (
            <button
              onClick={async () => {
                if (sandbox.status === 'ready') {
                  setShowFileBrowser(true);
                  return;
                }
                if (sandbox.status === 'creating') return;
                const id = await ensureSandbox();
                if (id) setShowFileBrowser(true);
              }}
              disabled={sandbox.status === 'creating'}
              className={`flex h-8 w-8 items-center justify-center rounded-full border border-white/[0.06] bg-[#0a0e16]/80 backdrop-blur-xl transition-all duration-200 spring-press ${
                sandbox.status === 'creating'
                  ? 'text-[#f59e0b] animate-pulse'
                  : sandbox.status === 'ready'
                  ? 'text-[#22c55e] hover:text-[#4ade80]'
                  : 'text-push-fg-dim hover:text-[#d1d8e6]'
              }`}
              aria-label="Open file browser"
              title={sandbox.status === 'creating' ? 'Starting sandbox...' : sandbox.status === 'ready' ? 'File browser' : 'Open file browser (starts sandbox)'}
            >
              <FolderOpen className="h-4 w-4" />
            </button>
          )}
          <WorkspacePanelButton
            onClick={() => setIsWorkspacePanelOpen(o => !o)}
            scratchpadHasContent={scratchpad.hasContent}
            agentActive={agentStatus.active}
          />
        </div>
        <div className="pointer-events-none absolute inset-x-0 top-full h-8 bg-gradient-to-b from-black to-transparent" />
      </header>

      {/* Sandbox error banner — shown when Modal call fails */}
      {isSandboxMode && sandbox.status === 'error' && sandbox.error && (
        <div className="mx-4 mt-2 rounded-xl border border-red-500/20 bg-red-500/5 px-3.5 py-3 flex items-center justify-between gap-2 animate-fade-in-down">
          <p className="text-xs text-red-400 min-w-0 truncate">{sandbox.error}</p>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => sandbox.start('', 'main')}
              className="text-xs font-medium text-red-300 hover:text-red-200 transition-colors"
            >
              Retry
            </button>
            <button
              onClick={handleExitSandboxMode}
              className="text-xs font-medium text-[#71717a] hover:text-[#a1a1aa] transition-colors"
            >
              Exit
            </button>
          </div>
        </div>
      )}

      {/* Sandbox expiry warning */}
      {isSandboxMode && (
        <SandboxExpiryBanner
          createdAt={sandbox.createdAt}
          sandboxId={sandbox.sandboxId}
          sandboxStatus={sandbox.status}
          onRestart={handleSandboxRestart}
        />
      )}

      {!isSandboxMode && activeRepo && projectInstructionsChecked && !agentsMdContent && (
        <div className="mx-4 mt-3 rounded-xl border border-push-edge bg-push-grad-card px-3.5 py-3.5 shadow-push-card animate-fade-in-down">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-medium text-[#e4e4e7]">No AGENTS.md found</p>
              <p className="text-[11px] text-push-fg-muted">Add project instructions so the agent understands your repo conventions.</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                onClick={handleCreateAgentsMdWithAI}
                disabled={creatingAgentsMdWithAI || isStreaming}
                className="rounded-lg border border-emerald-600/35 bg-emerald-900/20 px-3 py-1.5 text-xs font-medium text-emerald-300 transition-colors hover:bg-emerald-900/30 disabled:opacity-50"
              >
                {creatingAgentsMdWithAI ? 'Drafting...' : 'Create with AI'}
              </button>
              <button
                onClick={handleCreateAgentsMd}
                disabled={creatingAgentsMd || creatingAgentsMdWithAI}
                className="rounded-lg border border-[#243148] bg-[#0b1220] px-3 py-1.5 text-xs font-medium text-[#8ad4ff] transition-colors hover:bg-[#0d1526] disabled:opacity-50"
              >
                {creatingAgentsMd ? 'Creating...' : 'Create Template'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Chat */}
      <ChatContainer
        messages={messages}
        agentStatus={agentStatus}
        activeRepo={activeRepo}
        isSandboxMode={isSandboxMode}
        onSuggestion={sendMessageWithSnapshotHeartbeat}
        onCardAction={handleCardActionWithSnapshotHeartbeat}
      />

      {/* Input */}
      <ChatInput
        onSend={sendMessageWithSnapshotHeartbeat}
        onStop={abortStream}
        isStreaming={isStreaming}
        repoName={activeRepo?.name}
        contextUsage={contextUsage}
        providerControls={{
          activeProvider: activeProviderLabel,
          activeBackend,
          availableProviders,
          isProviderLocked,
          lockedProvider,
          lockedModel,
          onSelectBackend: handleSelectBackend,
          ollamaModel,
          ollamaModelOptions,
          ollamaModelsLoading,
          ollamaModelsError,
          ollamaModelsUpdatedAt,
          isOllamaModelLocked,
          refreshOllamaModels,
          onSelectOllamaModel: handleSelectOllamaModelFromChat,
          mistralModel,
          mistralModelOptions,
          mistralModelsLoading,
          mistralModelsError,
          mistralModelsUpdatedAt,
          isMistralModelLocked,
          refreshMistralModels,
          onSelectMistralModel: handleSelectMistralModelFromChat,
        }}
      />

      {/* Workspace panel (console + scratchpad) */}
      <WorkspacePanel
        isOpen={isWorkspacePanelOpen}
        onClose={() => setIsWorkspacePanelOpen(false)}
        messages={messages}
        content={scratchpad.content}
        memories={scratchpad.memories}
        activeMemoryId={scratchpad.activeMemoryId}
        onContentChange={scratchpad.setContent}
        onClear={scratchpad.clear}
        onSaveMemory={scratchpad.saveMemory}
        onLoadMemory={scratchpad.loadMemory}
        onDeleteMemory={scratchpad.deleteMemory}
      />

      {/* Toast notifications */}
      <Toaster position="bottom-center" />

      {/* Settings Sheet */}
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
          installationId,
          token,
          patToken,
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
          activeProviderLabel,
          activeBackend,
          setActiveBackend,
          isProviderLocked,
          lockedProvider,
          lockedModel,
          availableProviders,
          setPreferredProvider,
          clearPreferredProvider,
          hasOllamaKey,
          ollamaModel,
          setOllamaModel,
          ollamaModelOptions,
          ollamaModelsLoading,
          ollamaModelsError,
          ollamaModelsUpdatedAt,
          isOllamaModelLocked,
          refreshOllamaModels,
          ollamaKeyInput,
          setOllamaKeyInput,
          setOllamaKey,
          clearOllamaKey,
          hasKimiKey,
          kimiKeyInput,
          setKimiKeyInput,
          setKimiKey,
          clearKimiKey,
          hasMistralKey,
          hasZaiKey,
          mistralModel,
          setMistralModel,
          mistralModelOptions,
          mistralModelsLoading,
          mistralModelsError,
          mistralModelsUpdatedAt,
          isMistralModelLocked,
          refreshMistralModels,
          mistralKeyInput,
          setMistralKeyInput,
          setMistralKey,
          clearMistralKey,
          zaiKeyInput,
          setZaiKeyInput,
          setZaiKey: setZaiKey,
          clearZaiKey,
          hasTavilyKey,
          tavilyKeyInput,
          setTavilyKeyInput,
          setTavilyKey,
          clearTavilyKey,
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
          activeRepoFullName: activeRepo?.full_name ?? null,
        }}
        data={{
          activeRepo,
          deleteAllChats,
        }}
      />

      {/* Branch creation sheet */}
      {activeRepo && (
        <BranchCreateSheet
          open={showBranchCreate}
          onOpenChange={setShowBranchCreate}
          activeRepo={activeRepo}
          setCurrentBranch={setCurrentBranch}
        />
      )}

      {/* Merge flow sheet */}
      {activeRepo && (
        <MergeFlowSheet
          open={showMergeFlow}
          onOpenChange={setShowMergeFlow}
          activeRepo={activeRepo}
          sandboxId={sandbox.sandboxId}
          setCurrentBranch={setCurrentBranch}
        />
      )}
    </div>
  );
}

export default App;
