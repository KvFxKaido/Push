import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Settings, Trash2, FolderOpen, Cpu, GitBranch, RefreshCw, Loader2, Download, Save, RotateCcw } from 'lucide-react';
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
import { useTavilyConfig } from '@/hooks/useTavilyConfig';
import { getPreferredProvider, setPreferredProvider, clearPreferredProvider, type PreferredProvider } from '@/lib/providers';
import { getActiveProvider, getContextMode, setContextMode, type ContextMode } from '@/lib/orchestrator';
import { fetchOllamaModels, fetchMistralModels } from '@/lib/model-catalog';
import { useSandbox } from '@/hooks/useSandbox';
import { useScratchpad } from '@/hooks/useScratchpad';
import { useUserProfile } from '@/hooks/useUserProfile';
import { buildWorkspaceContext, sanitizeProjectInstructions } from '@/lib/workspace-context';
import { readFromSandbox, execInSandbox, downloadFromSandbox, writeToSandbox } from '@/lib/sandbox-client';
import { fetchProjectInstructions } from '@/lib/github-tools';
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
import { RepoAndChatSelector } from '@/components/chat/RepoAndChatSelector';
import { ScratchpadDrawer } from '@/components/chat/ScratchpadDrawer';
import { SandboxExpiryBanner } from '@/components/chat/SandboxExpiryBanner';
import { OnboardingScreen } from '@/sections/OnboardingScreen';
import { RepoPicker } from '@/sections/RepoPicker';
import { FileBrowser } from '@/sections/FileBrowser';
import type { AppScreen, RepoWithActivity, AIProviderType, SandboxStateCardData } from '@/types';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import './App.css';

const PROVIDER_LABELS: Record<AIProviderType, string> = { 
  ollama: 'Ollama', 
  moonshot: 'Kimi', 
  mistral: 'Mistral',
  demo: 'Demo'
};
const PROVIDER_ICONS: Record<AIProviderType, string> = { 
  ollama: '🦙', 
  moonshot: '🌙', 
  mistral: '🌪️',
  demo: '⚡'
};

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
  const { activeRepo, setActiveRepo, clearActiveRepo } = useActiveRepo();
  const scratchpad = useScratchpad(activeRepo?.full_name ?? null);
  const [isConsoleOpen, setIsConsoleOpen] = useState(false);
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
    sortedChatIds,
    switchChat,
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
    },
  );
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
  const availableProviders = ([['moonshot', 'Kimi', hasKimiKey], ['ollama', 'Ollama', hasOllamaKey], ['mistral', 'Mistral', hasMistralKey]] as const).filter(([, , has]) => has);
  
  const [showFileBrowser, setShowFileBrowser] = useState(false);
  const [creatingAgentsMd, setCreatingAgentsMd] = useState(false);
  const [creatingAgentsMdWithAI, setCreatingAgentsMdWithAI] = useState(false);
  const [installIdInput, setInstallIdInput] = useState('');
  const [showInstallIdInput, setShowInstallIdInput] = useState(false);

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

  useEffect(() => {
    if (settingsOpen && hasOllamaKey && ollamaModels.length === 0 && !ollamaModelsLoading) {
      refreshOllamaModels();
    }
  }, [settingsOpen, hasOllamaKey, ollamaModels.length, ollamaModelsLoading, refreshOllamaModels]);

  useEffect(() => {
    if (settingsOpen && hasMistralKey && mistralModels.length === 0 && !mistralModelsLoading) {
      refreshMistralModels();
    }
  }, [settingsOpen, hasMistralKey, mistralModels.length, mistralModelsLoading, refreshMistralModels]);

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
    if (!activeRepo) return 'repo-picker';
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
        : (activeRepo ? await sandbox.start(activeRepo.full_name, activeRepo.default_branch) : null);
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
        id = await sandbox.start(activeRepo.full_name, activeRepo.default_branch);
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
        private: repo.private,
      });
    },
    [setActiveRepo],
  );

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
    return sandbox.start(activeRepo.full_name, activeRepo.default_branch);
  }, [sandbox, activeRepo, isSandboxMode]);

  useEffect(() => {
    setEnsureSandbox(ensureSandbox);
  }, [ensureSandbox, setEnsureSandbox]);

  // Auto-start sandbox when entering sandbox mode
  useEffect(() => {
    const { status, sandboxId, start } = sandbox;
    if (isSandboxMode && status === 'idle' && !sandboxId) {
      start('', 'main');
    }
  }, [isSandboxMode, sandbox]);

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
    createNewChat();
    syncRepos();
  }, [createNewChat, syncRepos]);

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

  if (screen === 'repo-picker') {
    return (
      <div className="flex h-dvh flex-col bg-[#000] safe-area-top safe-area-bottom">
        <RepoPicker
          repos={repos}
          loading={reposLoading}
          error={reposError}
          onSelect={handleSelectRepo}
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
      <header className="flex items-center justify-between px-4 py-3 border-b border-[#111]">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {isSandboxMode ? (
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  setIsSandboxMode(false);
                  sandbox.stop();
                  createNewChat();
                }}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#0d0d0d] border border-[#1a1a1a] hover:border-[#3f3f46] transition-colors"
                title="Exit sandbox mode"
              >
                <div className={`h-2 w-2 rounded-full ${sandbox.status === 'ready' ? 'bg-emerald-500' : sandbox.status === 'creating' ? 'bg-[#f59e0b] animate-pulse' : sandbox.status === 'error' ? 'bg-red-500' : 'bg-[#52525b]'}`} />
                <span className="text-xs font-medium text-[#a1a1aa]">Sandbox</span>
                <span className="text-[10px] text-[#52525b]">✕</span>
              </button>
              <span className="text-[10px] text-[#52525b]">ephemeral</span>
              {latestSnapshot && (
                <span
                  className={`text-[10px] ${snapshotIsStale ? 'text-amber-400' : 'text-[#3f3f46]'}`}
                  title={`Latest snapshot: ${new Date(latestSnapshot.createdAt).toLocaleString()}`}
                >
                  {snapshotIsStale ? `snapshot stale (${snapshotAgeLabel})` : `snapshot ${snapshotAgeLabel}`}
                </span>
              )}
              {sandbox.status === 'ready' && (
                <button
                  onClick={() => captureSnapshot('manual')}
                  disabled={snapshotSaving || snapshotRestoring}
                  className="flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] text-[#52525b] transition-colors hover:text-emerald-400 hover:bg-[#0d0d0d] active:scale-95 disabled:opacity-50"
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
                  className="flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] text-[#52525b] transition-colors hover:text-emerald-400 hover:bg-[#0d0d0d] active:scale-95 disabled:opacity-50"
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
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-[#52525b] transition-colors hover:text-emerald-400 hover:bg-[#0d0d0d] active:scale-95 disabled:opacity-50"
                  title="Download workspace"
                  aria-label="Download workspace"
                >
                  {sandboxDownloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                </button>
              )}
              {snapshotRestoring && snapshotRestoreProgress && (
                <div className="flex min-w-[120px] flex-col gap-1">
                  <span className="text-[10px] text-[#71717a]">{snapshotRestoreProgress.message}</span>
                  <div className="h-1 w-full overflow-hidden rounded bg-[#1a1a1a]">
                    <div
                      className="h-full bg-emerald-500 transition-all duration-300"
                      style={{ width: `${snapshotStagePercent(snapshotRestoreProgress.stage)}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          ) : (
            <RepoAndChatSelector
              repos={repos}
              activeRepo={activeRepo}
              onSelectRepo={handleSelectRepo}
              conversations={conversations}
              sortedChatIds={sortedChatIds}
              activeChatId={activeChatId}
              onSwitchChat={switchChat}
              onNewChat={handleCreateNewChat}
              onDeleteChat={deleteChat}
              onBrowseRepos={clearActiveRepo}
              onSandboxMode={handleSandboxMode}
            />
          )}
        </div>
        <div className="flex items-center gap-3">
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
              className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors duration-200 active:scale-95 ${
                sandbox.status === 'creating'
                  ? 'text-[#f59e0b] animate-pulse'
                  : sandbox.status === 'ready'
                  ? 'text-[#22c55e] hover:bg-[#0d0d0d]'
                  : 'text-[#52525b] hover:text-[#a1a1aa] hover:bg-[#0d0d0d]'
              }`}
              aria-label="Open file browser"
              title={sandbox.status === 'creating' ? 'Starting sandbox...' : sandbox.status === 'ready' ? 'File browser' : 'Open file browser (starts sandbox)'}
            >
              <FolderOpen className="h-4 w-4" />
            </button>
          )}
          
          {/* Provider indicator with lock status */}
          <div className="flex items-center gap-2">
            <div
              className={`flex items-center gap-1.5 px-2 py-1 rounded-md transition-colors ${
                isProviderLocked 
                  ? 'bg-[#0d0d0d] border border-[#1a1a1a]' 
                  : ''
              }`}
              title={isProviderLocked 
                ? `${PROVIDER_LABELS[lockedProvider || 'demo']} locked for this chat` 
                : 'Provider can be changed until first message'}
            >
              <Cpu className={`h-3 w-3 ${isProviderLocked ? 'text-emerald-500' : 'text-[#52525b]'}`} />
              <span className={`text-xs ${isProviderLocked ? 'text-[#a1a1aa]' : 'text-[#52525b]'}`}>
                {PROVIDER_ICONS[lockedProvider || activeProviderLabel]}
                {PROVIDER_LABELS[lockedProvider || activeProviderLabel]}
              </span>
              {isProviderLocked && (
                <span className="text-[10px] text-[#52525b] ml-1">🔒</span>
              )}
            </div>
          </div>
          
          <button
            onClick={() => setSettingsOpen(true)}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-[#52525b] transition-colors duration-200 hover:text-[#a1a1aa] hover:bg-[#0d0d0d] active:scale-95"
            aria-label="Settings"
          >
            <Settings className="h-4 w-4" />
          </button>
        </div>
      </header>

      {/* Sandbox error banner — shown when Modal call fails */}
      {isSandboxMode && sandbox.status === 'error' && sandbox.error && (
        <div className="mx-4 mt-2 rounded-xl border border-red-500/20 bg-red-500/5 px-3 py-2.5 flex items-center justify-between gap-2">
          <p className="text-xs text-red-400 min-w-0 truncate">{sandbox.error}</p>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => sandbox.start('', 'main')}
              className="text-xs font-medium text-red-300 hover:text-red-200 transition-colors"
            >
              Retry
            </button>
            <button
              onClick={() => {
                setIsSandboxMode(false);
                createNewChat();
              }}
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
        <div className="mx-4 mt-3 rounded-xl border border-[#1a1a1a] bg-[#0d0d0d] px-3 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-medium text-[#e4e4e7]">No AGENTS.md found</p>
              <p className="text-[11px] text-[#71717a]">Add project instructions so the agent understands your repo conventions.</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                onClick={handleCreateAgentsMdWithAI}
                disabled={creatingAgentsMdWithAI || isStreaming}
                className="rounded-lg border border-emerald-700/50 bg-emerald-900/20 px-3 py-1.5 text-xs font-medium text-emerald-300 transition-colors hover:bg-emerald-900/30 disabled:opacity-50"
              >
                {creatingAgentsMdWithAI ? 'Drafting...' : 'Create with AI'}
              </button>
              <button
                onClick={handleCreateAgentsMd}
                disabled={creatingAgentsMd || creatingAgentsMdWithAI}
                className="rounded-lg border border-[#1f2937] bg-[#111827] px-3 py-1.5 text-xs font-medium text-emerald-300 transition-colors hover:bg-[#0f172a] disabled:opacity-50"
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
        isConsoleOpen={isConsoleOpen}
        onConsoleClose={() => setIsConsoleOpen(false)}
      />

      {/* Input */}
      <ChatInput
        onSend={sendMessageWithSnapshotHeartbeat}
        onStop={abortStream}
        isStreaming={isStreaming}
        repoName={activeRepo?.name}
        onScratchpadToggle={scratchpad.toggle}
        scratchpadHasContent={scratchpad.hasContent}
        onConsoleToggle={() => setIsConsoleOpen(o => !o)}
        agentActive={agentStatus.active}
        contextUsage={contextUsage}
      />

      {/* Scratchpad drawer */}
      <ScratchpadDrawer
        isOpen={scratchpad.isOpen}
        content={scratchpad.content}
        memories={scratchpad.memories}
        activeMemoryId={scratchpad.activeMemoryId}
        onContentChange={scratchpad.setContent}
        onClose={scratchpad.close}
        onClear={scratchpad.clear}
        onSaveMemory={scratchpad.saveMemory}
        onLoadMemory={scratchpad.loadMemory}
        onDeleteMemory={scratchpad.deleteMemory}
      />

      {/* Toast notifications */}
      <Toaster position="bottom-center" />

      {/* Settings Sheet */}
      <Sheet open={settingsOpen} onOpenChange={setSettingsOpen}>
        <SheetContent side="right" className="bg-[#000] border-[#1a1a1a] flex flex-col overflow-hidden">
          <SheetHeader className="shrink-0">
            <SheetTitle className="text-[#fafafa]">Settings</SheetTitle>
            <SheetDescription className="text-[#a1a1aa]">
              Connect GitHub and configure your workspace.
            </SheetDescription>
          </SheetHeader>

          {/* Tab bar */}
          <div className="flex gap-1 px-4 pt-1 pb-2 shrink-0">
            {([['you', 'You'], ['workspace', 'Workspace'], ['ai', 'AI']] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setSettingsTab(key)}
                className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                  settingsTab === key
                    ? 'bg-[#1a1a1a] text-[#fafafa]'
                    : 'text-[#52525b] hover:text-[#a1a1aa]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto">
          <div className="flex flex-col gap-6 px-4 pt-2 pb-8">
            {/* GitHub Connection */}
            {settingsTab === 'you' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-[#fafafa]">
                  GitHub
                </label>
                <div className="flex items-center gap-1.5">
                  <div
                    className={`h-2 w-2 rounded-full ${
                      isConnected ? 'bg-emerald-500' : 'bg-[#52525b]'
                    }`}
                  />
                  <span className="text-xs text-[#a1a1aa]">
                    {isDemo
                      ? 'Demo mode'
                      : isConnected
                      ? `Connected${validatedUser ? ` as ${validatedUser.login}` : ''}`
                      : 'Not connected'}
                  </span>
                </div>
              </div>

              {isConnected && (
                <div className="space-y-2">
                  {!isDemo && (
                    <div className="rounded-lg border border-[#1a1a1a] bg-[#0d0d0d] px-3 py-2">
                      <p className="text-sm text-[#a1a1aa] font-mono">
                        {isAppAuth ? (
                          <span className="text-emerald-400">GitHub App</span>
                        ) : token.startsWith('ghp_') ? (
                          'ghp_••••••••'
                        ) : (
                          'Token saved'
                        )}
                      </p>
                      {isAppAuth && (
                        <p className="text-xs text-[#52525b] mt-1">
                          Auto-refreshing token
                        </p>
                      )}
                      {isAppAuth && installationId && (
                        <p className="text-xs text-[#71717a] mt-1 font-mono">
                          Installation ID: {installationId}
                        </p>
                      )}
                    </div>
                  )}
                  {/* Upgrade to GitHub App (shown when using PAT) */}
                  {!isDemo && !isAppAuth && patToken && (
                    <div className="space-y-2">
                      {showInstallIdInput ? (
                        <>
                          <input
                            type="text"
                            value={installIdInput}
                            onChange={(e) => setInstallIdInput(e.target.value)}
                            placeholder="Installation ID (e.g., 12345678)"
                            className="w-full rounded-lg border border-[#1a1a1a] bg-[#0d0d0d] px-3 py-2 text-sm text-[#fafafa] placeholder:text-[#52525b] focus:outline-none focus:border-[#3f3f46] font-mono"
                            onKeyDown={async (e) => {
                              if (e.key === 'Enter' && installIdInput.trim()) {
                                const success = await setInstallationIdManually(installIdInput.trim());
                                if (success) {
                                  setInstallIdInput('');
                                  setShowInstallIdInput(false);
                                }
                              }
                            }}
                          />
                          <div className="flex gap-2">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={async () => {
                                if (installIdInput.trim()) {
                                  const success = await setInstallationIdManually(installIdInput.trim());
                                  if (success) {
                                    setInstallIdInput('');
                                    setShowInstallIdInput(false);
                                  }
                                }
                              }}
                              disabled={!installIdInput.trim() || appLoading}
                              className="text-[#0070f3] hover:text-[#0060d3] flex-1"
                            >
                              {appLoading ? 'Connecting...' : 'Connect'}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setShowInstallIdInput(false)}
                              className="text-[#52525b] hover:text-[#a1a1aa]"
                            >
                              Cancel
                            </Button>
                          </div>
                          <p className="text-xs text-[#52525b]">
                            Find your ID at github.com/settings/installations
                          </p>
                        </>
                      ) : (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              connectApp();
                              setSettingsOpen(false);
                            }}
                            className="text-[#0070f3] hover:text-[#0060d3] w-full justify-start"
                          >
                            ⬆️ Connect with GitHub
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              installApp();
                              setSettingsOpen(false);
                            }}
                            className="text-[#52525b] hover:text-[#a1a1aa] w-full justify-start text-xs"
                          >
                            Install GitHub App (first time)
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setShowInstallIdInput(true)}
                            className="text-[#52525b] hover:text-[#a1a1aa] w-full justify-start text-xs"
                          >
                            Enter installation ID manually
                          </Button>
                        </>
                      )}
                      {appError && (
                        <div className="space-y-1">
                          <p className="text-xs text-red-400">{appError}</p>
                          {appError.includes('GITHUB_ALLOWED_INSTALLATION_IDS') && (
                            <div className="text-[11px] text-[#71717a]">
                              <p>Ask the deployment admin to run:</p>
                              <div className="mt-1 flex items-center gap-2">
                                <code className="font-mono text-[#a1a1aa]">{allowlistSecretCmd}</code>
                                <button
                                  type="button"
                                  onClick={copyAllowlistCommand}
                                  className="rounded border border-[#27272a] px-2 py-0.5 text-[10px] text-[#a1a1aa] hover:text-[#fafafa] hover:border-[#3f3f46]"
                                >
                                  Copy
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      handleDisconnect();
                      setSettingsOpen(false);
                    }}
                    className="text-[#a1a1aa] hover:text-red-400 w-full justify-start"
                  >
                    Disconnect
                  </Button>
                </div>
              )}
            </div>
            )}

            {/* Context window behavior */}
            {settingsTab === 'workspace' && (<>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-[#fafafa]">
                  Context Mode
                </label>
                <span className="text-xs text-[#a1a1aa]">
                  {contextMode === 'graceful' ? 'Graceful digest' : 'No trimming'}
                </span>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => updateContextMode('graceful')}
                  className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                    contextMode === 'graceful'
                      ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400'
                      : 'border-[#1a1a1a] bg-[#0d0d0d] text-[#71717a] hover:text-[#a1a1aa]'
                  }`}
                >
                  Graceful Digest
                </button>
                <button
                  type="button"
                  onClick={() => updateContextMode('none')}
                  className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                    contextMode === 'none'
                      ? 'border-amber-500/50 bg-amber-500/10 text-amber-400'
                      : 'border-[#1a1a1a] bg-[#0d0d0d] text-[#71717a] hover:text-[#a1a1aa]'
                  }`}
                >
                  No Trimming
                </button>
              </div>
              {contextMode === 'none' && (
                <p className="text-[11px] text-[#a1a1aa]">
                  No trimming can hit model context limits on long chats and cause failures.
                </p>
              )}
            </div>

            {/* Sandbox start behavior */}
            <div className="space-y-3 pt-2 border-t border-[#1a1a1a]">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-[#fafafa]">
                  Sandbox Start Mode
                </label>
                <span className="text-xs text-[#a1a1aa]">
                  {sandboxStartMode === 'off' ? 'Off' : sandboxStartMode === 'smart' ? 'Smart' : 'Always'}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => updateSandboxStartMode('off')}
                  className={`rounded-lg border px-2 py-2 text-xs font-medium transition-colors ${
                    sandboxStartMode === 'off'
                      ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400'
                      : 'border-[#1a1a1a] bg-[#0d0d0d] text-[#71717a] hover:text-[#a1a1aa]'
                  }`}
                >
                  Off
                </button>
                <button
                  type="button"
                  onClick={() => updateSandboxStartMode('smart')}
                  className={`rounded-lg border px-2 py-2 text-xs font-medium transition-colors ${
                    sandboxStartMode === 'smart'
                      ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400'
                      : 'border-[#1a1a1a] bg-[#0d0d0d] text-[#71717a] hover:text-[#a1a1aa]'
                  }`}
                >
                  Smart
                </button>
                <button
                  type="button"
                  onClick={() => updateSandboxStartMode('always')}
                  className={`rounded-lg border px-2 py-2 text-xs font-medium transition-colors ${
                    sandboxStartMode === 'always'
                      ? 'border-amber-500/50 bg-amber-500/10 text-amber-400'
                      : 'border-[#1a1a1a] bg-[#0d0d0d] text-[#71717a] hover:text-[#a1a1aa]'
                  }`}
                >
                  Always
                </button>
              </div>
              <p className="text-[11px] text-[#a1a1aa]">
                Smart prewarms sandbox for likely coding prompts. Always prewarms on every message.
              </p>
            </div>

            {/* Sandbox State */}
            {sandbox.status !== 'idle' && (
              <div className="space-y-3 pt-2 border-t border-[#1a1a1a]">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium text-[#fafafa]">
                    Sandbox
                  </label>
                  <div className="flex items-center gap-1.5">
                    <div className={`h-2 w-2 rounded-full ${
                      sandbox.status === 'ready' ? 'bg-emerald-500' :
                      sandbox.status === 'creating' ? 'bg-[#f59e0b] animate-pulse' :
                      sandbox.status === 'error' ? 'bg-red-500' : 'bg-[#52525b]'
                    }`} />
                    <span className="text-xs text-[#a1a1aa]">
                      {sandbox.status === 'ready' ? 'Running' :
                       sandbox.status === 'creating' ? 'Starting...' :
                       sandbox.status === 'error' ? 'Error' : 'Idle'}
                    </span>
                  </div>
                </div>

                {sandboxState && sandbox.status === 'ready' && (
                  <div className="rounded-lg border border-[#1a1a1a] bg-[#0d0d0d] overflow-hidden">
                    <div className="px-3 py-2 flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <GitBranch className="h-3.5 w-3.5 text-[#71717a]" />
                        <span className="text-xs text-[#e4e4e7] font-mono truncate">{sandboxState.branch}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={`text-[11px] px-1.5 py-0.5 rounded-full ${
                          sandboxState.changedFiles > 0
                            ? 'bg-[#f59e0b]/15 text-[#f59e0b]'
                            : 'bg-[#22c55e]/15 text-[#22c55e]'
                        }`}>
                          {sandboxState.changedFiles > 0 ? `${sandboxState.changedFiles} changed` : 'clean'}
                        </span>
                        <button
                          type="button"
                          onClick={() => sandbox.sandboxId && fetchSandboxState(sandbox.sandboxId)}
                          disabled={sandboxStateLoading}
                          className="inline-flex items-center gap-1 rounded border border-[#27272a] px-1.5 py-0.5 text-[10px] text-[#a1a1aa] hover:text-[#fafafa] hover:border-[#3f3f46] disabled:opacity-50"
                          title="Refresh sandbox state"
                        >
                          {sandboxStateLoading ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <RefreshCw className="h-3 w-3" />
                          )}
                        </button>
                      </div>
                    </div>

                    {sandboxState.changedFiles > 0 && (
                      <div className="px-3 pb-2 space-y-1.5">
                        <div className="flex gap-3 text-[11px] text-[#71717a]">
                          <span>Staged: <span className="text-[#a1a1aa]">{sandboxState.stagedFiles}</span></span>
                          <span>Unstaged: <span className="text-[#a1a1aa]">{sandboxState.unstagedFiles}</span></span>
                          <span>Untracked: <span className="text-[#a1a1aa]">{sandboxState.untrackedFiles}</span></span>
                        </div>
                        {sandboxState.preview.length > 0 && (
                          <div className="rounded border border-[#1f1f23] bg-[#0a0a0c] p-1.5 space-y-0.5">
                            {sandboxState.preview.map((line, idx) => (
                              <div key={`${line}-${idx}`} className="text-[10px] text-[#a1a1aa] font-mono truncate">
                                {line}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    <div className="px-3 pb-2 text-[10px] text-[#52525b]">
                      {new Date(sandboxState.fetchedAt).toLocaleTimeString()}
                      <span className="font-mono ml-1.5">{sandboxState.sandboxId.slice(0, 12)}...</span>
                    </div>
                  </div>
                )}

                {sandbox.error && (
                  <p className="text-xs text-red-400">{sandbox.error}</p>
                )}
              </div>
            )}

            </>)}

            {/* About You */}
            {settingsTab === 'you' && (
            <div className="space-y-3 pt-2 border-t border-[#1a1a1a]">
              <label className="text-sm font-medium text-[#fafafa]">
                About You
              </label>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-[#a1a1aa]">
                  Your Name
                </label>
                <input
                  type="text"
                  value={displayNameDraft}
                  onChange={(e) => setDisplayNameDraft(e.target.value)}
                  onBlur={handleDisplayNameBlur}
                  placeholder="Your name"
                  className="w-full rounded-lg border border-[#1a1a1a] bg-[#0d0d0d] px-3 py-2 text-sm text-[#fafafa] placeholder:text-[#52525b] focus:outline-none focus:border-[#3f3f46]"
                />
              </div>

              {validatedUser && (
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-[#a1a1aa]">
                    GitHub
                  </label>
                  <div className="text-xs text-[#a1a1aa] font-mono">
                    @{profile.githubLogin || validatedUser.login}
                  </div>
                </div>
              )}

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-[#a1a1aa]">
                  About You
                </label>
                <textarea
                  value={bioDraft}
                  onChange={(e) => setBioDraft(e.target.value.slice(0, 300))}
                  onBlur={handleBioBlur}
                  rows={3}
                  maxLength={300}
                  placeholder="Anything you want the assistant to know about you"
                  className="w-full rounded-lg border border-[#1a1a1a] bg-[#0d0d0d] px-3 py-2 text-sm text-[#fafafa] placeholder:text-[#52525b] focus:outline-none focus:border-[#3f3f46] resize-none"
                />
                <p className="text-[10px] text-[#52525b]">
                  {bioDraft.length}/300
                </p>
              </div>

              {profile.displayName.trim().length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    clearProfile();
                    setDisplayNameDraft('');
                    setBioDraft('');
                  }}
                  className="text-[#a1a1aa] hover:text-red-400 w-full justify-start"
                >
                  Clear Profile
                </Button>
              )}
            </div>
            )}

            {/* AI Provider */}
            {settingsTab === 'ai' && (<>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-[#fafafa]">
                  AI Provider
                </label>
                <div className="flex items-center gap-1.5">
                  <div
                    className={`h-2 w-2 rounded-full ${
                      hasOllamaKey || hasKimiKey || hasMistralKey ? 'bg-emerald-500' : 'bg-[#52525b]'
                    }`}
                  />
                  <span className="text-xs text-[#a1a1aa]">
                    {isProviderLocked 
                      ? `${PROVIDER_LABELS[lockedProvider || 'demo']} 🔒` 
                      : (PROVIDER_LABELS[activeProviderLabel] || 'Offline')}
                  </span>
                </div>
              </div>

              {/* Provider lock warning for current chat */}
              {isProviderLocked && lockedProvider && (
                <div className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2">
                  <p className="text-xs text-amber-400">
                    🔒 {PROVIDER_LABELS[lockedProvider]} locked for this chat
                  </p>
                  <p className="text-xs text-[#71717a] mt-0.5">
                    Start a new chat to switch providers
                  </p>
                  {lockedModel && (
                    <p className="text-xs text-[#71717a] mt-0.5">
                      Model locked for this chat: <span className="font-mono text-[#a1a1aa]">{lockedModel}</span>
                    </p>
                  )}
                </div>
              )}

              {/* Backend picker — shown when 2+ providers have keys, disabled when locked */}
              {availableProviders.length >= 2 && (
                <div className={`space-y-1.5 ${isProviderLocked ? 'opacity-50' : ''}`}>
                  <label className="text-xs font-medium text-[#a1a1aa]">
                    Active backend
                    {isProviderLocked && ' (locked)'}
                  </label>
                  <div className="flex gap-2">
                    {availableProviders.map(([value, label]) => (
                      <button
                        key={value}
                        onClick={() => {
                          if (isProviderLocked) return;
                          setPreferredProvider(value);
                          setActiveBackend(value);
                        }}
                        disabled={isProviderLocked}
                        className={`flex-1 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                          (activeBackend ?? activeProviderLabel) === value
                            ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400'
                            : 'border-[#1a1a1a] bg-[#0d0d0d] text-[#71717a] hover:text-[#a1a1aa]'
                        } ${isProviderLocked ? 'cursor-not-allowed' : ''}`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* ... rest of provider config sections ... */}
              
              {/* Ollama */}
              <div className="space-y-2">
                <label className="text-xs font-medium text-[#a1a1aa]">Ollama</label>
                {hasOllamaKey ? (
                  <div className="space-y-2">
                    <div className="rounded-lg border border-[#1a1a1a] bg-[#0d0d0d] px-3 py-2">
                      <p className="text-sm text-[#a1a1aa] font-mono">Key Saved</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-[#71717a] shrink-0">Model:</span>
                      <select
                        value={ollamaModel}
                        onChange={(e) => setOllamaModel(e.target.value)}
                        disabled={ollamaModelOptions.length === 0 || isOllamaModelLocked}
                        className="flex-1 rounded-md border border-[#1a1a1a] bg-[#0d0d0d] px-2 py-1 text-xs text-[#fafafa] font-mono focus:outline-none focus:border-[#3f3f46] disabled:opacity-50"
                      >
                        {ollamaModelOptions.length === 0 ? (
                          <option value={ollamaModel}>{ollamaModel}</option>
                        ) : (
                          ollamaModelOptions.map((model) => (
                            <option key={model} value={model}>
                              {model}
                            </option>
                          ))
                        )}
                      </select>
                      <button
                        type="button"
                        onClick={refreshOllamaModels}
                        disabled={ollamaModelsLoading || isOllamaModelLocked}
                        className="rounded-md border border-[#1a1a1a] bg-[#0d0d0d] p-1.5 text-[#a1a1aa] hover:text-[#fafafa] disabled:opacity-50"
                        aria-label="Refresh Ollama models"
                        title="Refresh Ollama models"
                      >
                        {ollamaModelsLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                    {ollamaModelsError && (
                      <p className="text-xs text-amber-400">
                        {ollamaModelsError}
                      </p>
                    )}
                    {ollamaModelsUpdatedAt && (
                      <p className="text-xs text-[#52525b]">
                        Updated {new Date(ollamaModelsUpdatedAt).toLocaleTimeString()}
                      </p>
                    )}
                    {isOllamaModelLocked && lockedModel && (
                      <p className="text-xs text-amber-400">
                        Locked to {lockedModel} for this chat. Start a new chat to change model.
                      </p>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        clearOllamaKey();
                        if (activeBackend === 'ollama') {
                          clearPreferredProvider();
                          setActiveBackend(null);
                        }
                      }}
                      className="text-[#a1a1aa] hover:text-red-400 w-full justify-start"
                    >
                      Remove key
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <input
                      type="password"
                      value={ollamaKeyInput}
                      onChange={(e) => setOllamaKeyInput(e.target.value)}
                      placeholder="Ollama API key"
                      className="w-full rounded-lg border border-[#1a1a1a] bg-[#0d0d0d] px-3 py-2 text-sm text-[#fafafa] placeholder:text-[#52525b] focus:outline-none focus:border-[#3f3f46]"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && ollamaKeyInput.trim()) {
                          setOllamaKey(ollamaKeyInput.trim());
                          setOllamaKeyInput('');
                        }
                      }}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        if (ollamaKeyInput.trim()) {
                          setOllamaKey(ollamaKeyInput.trim());
                          setOllamaKeyInput('');
                        }
                      }}
                      disabled={!ollamaKeyInput.trim()}
                      className="text-[#a1a1aa] hover:text-[#fafafa] w-full justify-start"
                    >
                      Save Ollama key
                    </Button>
                    <p className="text-xs text-[#52525b]">
                      Ollama API key (local or cloud).
                    </p>
                  </div>
                )}
              </div>

              {/* Kimi */}
              <div className="space-y-2">
                <label className="text-xs font-medium text-[#a1a1aa]">Kimi</label>
                {hasKimiKey ? (
                  <div className="space-y-2">
                    <div className="rounded-lg border border-[#1a1a1a] bg-[#0d0d0d] px-3 py-2">
                      <p className="text-sm text-[#a1a1aa] font-mono">
                        Key Saved
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        clearKimiKey();
                        if (activeBackend === 'moonshot') {
                          clearPreferredProvider();
                          setActiveBackend(null);
                        }
                      }}
                      className="text-[#a1a1aa] hover:text-red-400 w-full justify-start"
                    >
                      Remove key
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <input
                      type="password"
                      value={kimiKeyInput}
                      onChange={(e) => setKimiKeyInput(e.target.value)}
                      placeholder="sk-kimi-..."
                      className="w-full rounded-lg border border-[#1a1a1a] bg-[#0d0d0d] px-3 py-2 text-sm text-[#fafafa] placeholder:text-[#52525b] focus:outline-none focus:border-[#3f3f46]"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && kimiKeyInput.trim()) {
                          setKimiKey(kimiKeyInput.trim());
                          setKimiKeyInput('');
                        }
                      }}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        if (kimiKeyInput.trim()) {
                          setKimiKey(kimiKeyInput.trim());
                          setKimiKeyInput('');
                        }
                      }}
                      disabled={!kimiKeyInput.trim()}
                      className="text-[#a1a1aa] hover:text-[#fafafa] w-full justify-start"
                    >
                      Save Kimi key
                    </Button>
                    <p className="text-xs text-[#52525b]">
                      Kimi For Coding API key (starts with sk-kimi-).
                    </p>
                  </div>
                )}
              </div>

              {/* Mistral */}
              <div className="space-y-2">
                <label className="text-xs font-medium text-[#a1a1aa]">Mistral</label>
                {hasMistralKey ? (
                  <div className="space-y-2">
                    <div className="rounded-lg border border-[#1a1a1a] bg-[#0d0d0d] px-3 py-2">
                      <p className="text-sm text-[#a1a1aa] font-mono">Key Saved</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-[#71717a] shrink-0">Model:</span>
                      <select
                        value={mistralModel}
                        onChange={(e) => setMistralModel(e.target.value)}
                        disabled={mistralModelOptions.length === 0 || isMistralModelLocked}
                        className="flex-1 rounded-md border border-[#1a1a1a] bg-[#0d0d0d] px-2 py-1 text-xs text-[#fafafa] font-mono focus:outline-none focus:border-[#3f3f46] disabled:opacity-50"
                      >
                        {mistralModelOptions.length === 0 ? (
                          <option value={mistralModel}>{mistralModel}</option>
                        ) : (
                          mistralModelOptions.map((model) => (
                            <option key={model} value={model}>
                              {model}
                            </option>
                          ))
                        )}
                      </select>
                      <button
                        type="button"
                        onClick={refreshMistralModels}
                        disabled={mistralModelsLoading || isMistralModelLocked}
                        className="rounded-md border border-[#1a1a1a] bg-[#0d0d0d] p-1.5 text-[#a1a1aa] hover:text-[#fafafa] disabled:opacity-50"
                        aria-label="Refresh Mistral models"
                        title="Refresh Mistral models"
                      >
                        {mistralModelsLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                    {mistralModelsError && (
                      <p className="text-xs text-amber-400">
                        {mistralModelsError}
                      </p>
                    )}
                    {mistralModelsUpdatedAt && (
                      <p className="text-xs text-[#52525b]">
                        Updated {new Date(mistralModelsUpdatedAt).toLocaleTimeString()}
                      </p>
                    )}
                    {isMistralModelLocked && lockedModel && (
                      <p className="text-xs text-amber-400">
                        Locked to {lockedModel} for this chat. Start a new chat to change model.
                      </p>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        clearMistralKey();
                        if (activeBackend === 'mistral') {
                          clearPreferredProvider();
                          setActiveBackend(null);
                        }
                      }}
                      className="text-[#a1a1aa] hover:text-red-400 w-full justify-start"
                    >
                      Remove key
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <input
                      type="password"
                      value={mistralKeyInput}
                      onChange={(e) => setMistralKeyInput(e.target.value)}
                      placeholder="Mistral API key"
                      className="w-full rounded-lg border border-[#1a1a1a] bg-[#0d0d0d] px-3 py-2 text-sm text-[#fafafa] placeholder:text-[#52525b] focus:outline-none focus:border-[#3f3f46]"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && mistralKeyInput.trim()) {
                          setMistralKey(mistralKeyInput.trim());
                          setMistralKeyInput('');
                        }
                      }}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        if (mistralKeyInput.trim()) {
                          setMistralKey(mistralKeyInput.trim());
                          setMistralKeyInput('');
                        }
                      }}
                      disabled={!mistralKeyInput.trim()}
                      className="text-[#a1a1aa] hover:text-[#fafafa] w-full justify-start"
                    >
                      Save Mistral key
                    </Button>
                    <p className="text-xs text-[#52525b]">
                      Mistral API key from console.mistral.ai.
                    </p>
                  </div>
                )}
              </div>

            </div>

            {/* Web Search (optional Tavily upgrade) */}
            <div className="space-y-3 pt-2 border-t border-[#1a1a1a]">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-[#fafafa]">
                  Web Search
                </label>
                <span className="text-xs text-[#52525b]">Optional</span>
              </div>
              <div className="space-y-2">
                {hasTavilyKey ? (
                  <div className="space-y-2">
                    <div className="rounded-lg border border-[#1a1a1a] bg-[#0d0d0d] px-3 py-2">
                      <p className="text-sm text-[#a1a1aa] font-mono">Tavily Key Saved</p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => clearTavilyKey()}
                      className="text-[#a1a1aa] hover:text-red-400 w-full justify-start"
                    >
                      Remove key
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <input
                      type="password"
                      value={tavilyKeyInput}
                      onChange={(e) => setTavilyKeyInput(e.target.value)}
                      placeholder="tvly-..."
                      className="w-full rounded-lg border border-[#1a1a1a] bg-[#0d0d0d] px-3 py-2 text-sm text-[#fafafa] placeholder:text-[#52525b] focus:outline-none focus:border-[#3f3f46]"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && tavilyKeyInput.trim()) {
                          setTavilyKey(tavilyKeyInput.trim());
                          setTavilyKeyInput('');
                        }
                      }}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        if (tavilyKeyInput.trim()) {
                          setTavilyKey(tavilyKeyInput.trim());
                          setTavilyKeyInput('');
                        }
                      }}
                      disabled={!tavilyKeyInput.trim()}
                      className="text-[#a1a1aa] hover:text-[#fafafa] w-full justify-start"
                    >
                      Save Tavily key
                    </Button>
                    <p className="text-xs text-[#52525b]">
                      Not required — web search works without this. Add a Tavily API key for higher-quality, LLM-optimized results. Free tier: 1,000 searches/month.
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Danger Zone */}
            <div className="space-y-3 pt-2 border-t border-[#1a1a1a]">
              <label className="text-sm font-medium text-[#fafafa]">
                Data
              </label>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  deleteAllChats();
                  setSettingsOpen(false);
                }}
                className="text-[#a1a1aa] hover:text-red-400 w-full justify-start gap-2"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete all chats{activeRepo ? ` for ${activeRepo.name}` : ''}
              </Button>
            </div>
            </>)}
          </div>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

export default App;
