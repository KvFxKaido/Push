import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Settings, Trash2, FolderOpen, Cpu } from 'lucide-react';
import { Toaster } from '@/components/ui/sonner';
import { useChat } from '@/hooks/useChat';
import { useGitHubAuth } from '@/hooks/useGitHubAuth';
import { useGitHubAppAuth } from '@/hooks/useGitHubAppAuth';
import { useRepos } from '@/hooks/useRepos';
import { useActiveRepo } from '@/hooks/useActiveRepo';
import { useMoonshotKey } from '@/hooks/useMoonshotKey';
import { useOllamaConfig } from '@/hooks/useOllamaConfig';
import { useMistralConfig } from '@/hooks/useMistralConfig';
import { getPreferredProvider, setPreferredProvider, clearPreferredProvider, type PreferredProvider } from '@/lib/providers';
import { getActiveProvider, getContextMode, setContextMode, type ContextMode } from '@/lib/orchestrator';
import { useSandbox } from '@/hooks/useSandbox';
import { useScratchpad } from '@/hooks/useScratchpad';
import { buildWorkspaceContext } from '@/lib/workspace-context';
import { readFromSandbox, execInSandbox } from '@/lib/sandbox-client';
import { fetchProjectInstructions } from '@/lib/github-tools';
import { getSandboxStartMode, setSandboxStartMode, type SandboxStartMode } from '@/lib/sandbox-start-mode';
import { ChatContainer } from '@/components/chat/ChatContainer';
import { ChatInput } from '@/components/chat/ChatInput';
import { RepoAndChatSelector } from '@/components/chat/RepoAndChatSelector';
import { ScratchpadDrawer } from '@/components/chat/ScratchpadDrawer';
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

function App() {
  const { activeRepo, setActiveRepo, clearActiveRepo } = useActiveRepo();
  const scratchpad = useScratchpad(activeRepo?.full_name ?? null);
  const [isConsoleOpen, setIsConsoleOpen] = useState(false);
  const {
    messages,
    sendMessage,
    agentStatus,
    isStreaming,
    lockedProvider,
    isProviderLocked,
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
    injectAssistantCardMessage,
    handleCardAction,
    contextUsage,
    abortStream,
  } = useChat(activeRepo?.full_name ?? null, {
    content: scratchpad.content,
    replace: scratchpad.replace,
    append: scratchpad.append,
  });
  const sandbox = useSandbox(activeRepo?.full_name ?? null);
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
  const { repos, loading: reposLoading, sync: syncRepos } = useRepos();
  const { setKey: setKimiKey, clearKey: clearKimiKey, hasKey: hasKimiKey } = useMoonshotKey();
  const { setKey: setOllamaKey, clearKey: clearOllamaKey, hasKey: hasOllamaKey, model: ollamaModel, setModel: setOllamaModel } = useOllamaConfig();
  const { setKey: setMistralKey, clearKey: clearMistralKey, hasKey: hasMistralKey, model: mistralModel, setModel: setMistralModel } = useMistralConfig();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isDemo, setIsDemo] = useState(false);
  const [kimiKeyInput, setKimiKeyInput] = useState('');
  const [ollamaKeyInput, setOllamaKeyInput] = useState('');
  const [ollamaModelInput, setOllamaModelInput] = useState('');
  const [mistralKeyInput, setMistralKeyInput] = useState('');
  const [mistralModelInput, setMistralModelInput] = useState('');
  const [activeBackend, setActiveBackend] = useState<PreferredProvider | null>(() => getPreferredProvider());
  const sandboxStateEmittedRef = useRef<Set<string>>(new Set());

  // Derive display label from actual active provider
  const activeProviderLabel = getActiveProvider();
  const availableProviders = ([['moonshot', 'Kimi', hasKimiKey], ['ollama', 'Ollama', hasOllamaKey], ['mistral', 'Mistral', hasMistralKey]] as const).filter(([, , has]) => has);
  
  const [showFileBrowser, setShowFileBrowser] = useState(false);
  const [installIdInput, setInstallIdInput] = useState('');
  const [showInstallIdInput, setShowInstallIdInput] = useState(false);
  const [sandboxStartMode, setSandboxStartModeState] = useState<SandboxStartMode>(() => getSandboxStartMode());
  const [contextMode, setContextModeState] = useState<ContextMode>(() => getContextMode());
  const allowlistSecretCmd = 'npx wrangler secret put GITHUB_ALLOWED_INSTALLATION_IDS';

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
    if (isDemo) return showFileBrowser && sandbox.sandboxId ? 'file-browser' : 'chat';
    if (!token) return 'onboarding';
    if (!activeRepo) return 'repo-picker';
    if (showFileBrowser && sandbox.sandboxId) return 'file-browser';
    return 'chat';
  }, [token, activeRepo, isDemo, showFileBrowser, sandbox.sandboxId]);

  // On PAT connect success: auto-sync repos
  const handleConnect = useCallback(
    async (pat: string): Promise<boolean> => {
      const success = await setTokenManually(pat);
      if (success) syncRepos();
      return success;
    },
    [setTokenManually, syncRepos],
  );

  // Demo mode escape hatch
  const handleDemo = useCallback(() => {
    setIsDemo(true);
    syncRepos(); // Will use mock repos since no token
  }, [syncRepos]);

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
  }, [appDisconnect, patLogout, clearActiveRepo, deleteAllChats]);

  // --- Project instructions: two-phase loading ---
  // Phase A: Fetch via GitHub API immediately when activeRepo changes (no sandbox needed)
  // Phase B: Upgrade from sandbox filesystem when sandbox becomes ready (may have local edits)

  const [agentsMdContent, setAgentsMdContent] = useState<string | null>(null);

  // Phase A — GitHub API fetch (immediate)
  useEffect(() => {
    if (!activeRepo) {
      setAgentsMdContent(null);
      setAgentsMd(null);
      return;
    }
    let cancelled = false;
    fetchProjectInstructions(activeRepo.full_name)
      .then((result) => {
        if (cancelled) return;
        setAgentsMdContent(result?.content ?? null);
        setAgentsMd(result?.content ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        setAgentsMdContent(null);
        setAgentsMd(null);
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

  // Build workspace context when repos, active repo, or project instructions change
  useEffect(() => {
    if (repos.length > 0) {
      let ctx = buildWorkspaceContext(repos, activeRepo);
      if (agentsMdContent) {
        ctx += '\n\nProject instructions from the repository:\n' + agentsMdContent;
      }
      setWorkspaceContext(ctx);
    } else {
      setWorkspaceContext(null);
    }
  }, [repos, activeRepo, agentsMdContent, setWorkspaceContext]);

  // Sync sandbox ID to useChat
  useEffect(() => {
    setSandboxId(sandbox.sandboxId);
  }, [sandbox.sandboxId, setSandboxId]);

  // Emit a sandbox state card when a sandbox is ready/reconnected.
  useEffect(() => {
    if (sandbox.status !== 'ready' || !sandbox.sandboxId || !activeChatId) return;

    const emitKey = `${activeChatId}:${sandbox.sandboxId}`;
    if (sandboxStateEmittedRef.current.has(emitKey)) return;

    let cancelled = false;
    (async () => {
      try {
        const statusResult = await execInSandbox(
          sandbox.sandboxId!,
          'cd /workspace && git status -sb --porcelain=1',
        );
        if (cancelled || statusResult.exitCode !== 0) return;

        const lines = statusResult.stdout
          .split('\n')
          .map((line) => line.trimEnd())
          .filter(Boolean);
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

        const cardData: SandboxStateCardData = {
          sandboxId: sandbox.sandboxId!,
          repoPath: '/workspace',
          branch,
          statusLine,
          changedFiles: entries.length,
          stagedFiles,
          unstagedFiles,
          untrackedFiles,
          preview: entries.slice(0, 6).map((line) => (line.length > 120 ? `${line.slice(0, 120)}...` : line)),
          fetchedAt: new Date().toISOString(),
        };

        injectAssistantCardMessage(activeChatId, `Sandbox attached on \`${branch}\`.`, {
          type: 'sandbox-state',
          data: cardData,
        });
        sandboxStateEmittedRef.current.add(emitKey);
      } catch {
        // Best effort; sandbox state card is informational only.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sandbox.status, sandbox.sandboxId, activeChatId, injectAssistantCardMessage]);

  // Lazy sandbox auto-spin: creates sandbox on demand (called by useChat when sandbox tools are detected)
  const ensureSandbox = useCallback(async (): Promise<string | null> => {
    if (sandbox.sandboxId) return sandbox.sandboxId;
    if (!activeRepo) return null;
    return sandbox.start(activeRepo.full_name, activeRepo.default_branch);
  }, [sandbox, activeRepo]);

  useEffect(() => {
    setEnsureSandbox(ensureSandbox);
  }, [ensureSandbox, setEnsureSandbox]);

  // Sync repos on mount (for returning users who already have a token)
  useEffect(() => {
    if (token) syncRepos();
  }, [token, syncRepos]);

  // Wrap createNewChat to also re-sync repos
  const handleCreateNewChat = useCallback(() => {
    createNewChat();
    syncRepos();
  }, [createNewChat, syncRepos]);

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
          onDemo={handleDemo}
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
          onSelect={handleSelectRepo}
          onDisconnect={handleDisconnect}
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

  const isConnected = Boolean(token) || isDemo;

  return (
    <div className="flex h-dvh flex-col bg-[#000] safe-area-top safe-area-bottom">
      {/* Top bar */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-[#111]">
        <div className="flex items-center gap-2 min-w-0 flex-1">
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
          />
        </div>
        <div className="flex items-center gap-3">
          {/* File browser */}
          {activeRepo && (
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

      {/* Chat */}
      <ChatContainer
        messages={messages}
        agentStatus={agentStatus}
        activeRepo={activeRepo}
        onSuggestion={sendMessage}
        onCardAction={handleCardAction}
        isConsoleOpen={isConsoleOpen}
        onConsoleClose={() => setIsConsoleOpen(false)}
      />

      {/* Input */}
      <ChatInput
        onSend={sendMessage}
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
        <SheetContent side="right" className="bg-[#000] border-[#1a1a1a]">
          <SheetHeader>
            <SheetTitle className="text-[#fafafa]">Settings</SheetTitle>
            <SheetDescription className="text-[#a1a1aa]">
              Connect GitHub and configure your workspace.
            </SheetDescription>
          </SheetHeader>

          <div className="flex flex-col gap-6 px-4 pt-2">
            {/* GitHub Connection */}
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
                            placeholder="Installation ID (e.g., 108161455)"
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
                              installApp();
                              setSettingsOpen(false);
                            }}
                            className="text-[#0070f3] hover:text-[#0060d3] w-full justify-start"
                          >
                            ⬆️ Upgrade to GitHub App
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setShowInstallIdInput(true)}
                            className="text-[#52525b] hover:text-[#a1a1aa] w-full justify-start text-xs"
                          >
                            Already installed? Enter ID manually
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

            {/* Context window behavior */}
            <div className="space-y-3 pt-2 border-t border-[#1a1a1a]">
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

            {/* AI Provider */}
            <div className="space-y-3 pt-2 border-t border-[#1a1a1a]">
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
                      <input
                        type="text"
                        value={ollamaModelInput || ollamaModel}
                        onChange={(e) => setOllamaModelInput(e.target.value)}
                        onBlur={() => {
                          if (ollamaModelInput.trim()) {
                            setOllamaModel(ollamaModelInput.trim());
                          }
                          setOllamaModelInput('');
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && ollamaModelInput.trim()) {
                            setOllamaModel(ollamaModelInput.trim());
                            setOllamaModelInput('');
                          }
                        }}
                        placeholder="kimi-k2.5"
                        className="flex-1 rounded-md border border-[#1a1a1a] bg-[#0d0d0d] px-2 py-1 text-xs text-[#fafafa] font-mono placeholder:text-[#52525b] focus:outline-none focus:border-[#3f3f46]"
                      />
                    </div>
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
                      <input
                        type="text"
                        value={mistralModelInput || mistralModel}
                        onChange={(e) => setMistralModelInput(e.target.value)}
                        onBlur={() => {
                          if (mistralModelInput.trim()) {
                            setMistralModel(mistralModelInput.trim());
                          }
                          setMistralModelInput('');
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && mistralModelInput.trim()) {
                            setMistralModel(mistralModelInput.trim());
                            setMistralModelInput('');
                          }
                        }}
                        placeholder="devstral-small-latest"
                        className="flex-1 rounded-md border border-[#1a1a1a] bg-[#0d0d0d] px-2 py-1 text-xs text-[#fafafa] font-mono placeholder:text-[#52525b] focus:outline-none focus:border-[#3f3f46]"
                      />
                    </div>
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
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

export default App;
