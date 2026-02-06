import { useState, useEffect, useCallback, useMemo } from 'react';
import { Settings, Trash2, FolderOpen } from 'lucide-react';
import { Toaster } from '@/components/ui/sonner';
import { useChat } from '@/hooks/useChat';
import { useGitHubAuth } from '@/hooks/useGitHubAuth';
import { useGitHubAppAuth } from '@/hooks/useGitHubAppAuth';
import { useRepos } from '@/hooks/useRepos';
import { useActiveRepo } from '@/hooks/useActiveRepo';
import { useMoonshotKey } from '@/hooks/useMoonshotKey';
import { useOllamaConfig } from '@/hooks/useOllamaConfig';
import { getPreferredProvider, setPreferredProvider, clearPreferredProvider, type PreferredProvider } from '@/lib/providers';
import { getActiveProvider } from '@/lib/orchestrator';
import { useSandbox } from '@/hooks/useSandbox';
import { useScratchpad } from '@/hooks/useScratchpad';
import { buildWorkspaceContext } from '@/lib/workspace-context';
import { readFromSandbox } from '@/lib/sandbox-client';
import { ChatContainer } from '@/components/chat/ChatContainer';
import { ChatInput } from '@/components/chat/ChatInput';
import { RepoAndChatSelector } from '@/components/chat/RepoAndChatSelector';
import { ScratchpadDrawer } from '@/components/chat/ScratchpadDrawer';
import { OnboardingScreen } from '@/sections/OnboardingScreen';
import { RepoPicker } from '@/sections/RepoPicker';
import { FileBrowser } from '@/sections/FileBrowser';
import type { AppScreen, RepoWithActivity } from '@/types';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import './App.css';

function App() {
  const { activeRepo, setActiveRepo, clearActiveRepo } = useActiveRepo();
  const scratchpad = useScratchpad(activeRepo?.full_name ?? null);
  const {
    messages,
    sendMessage,
    agentStatus,
    isStreaming,
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
  } = useChat(activeRepo?.full_name ?? null, {
    content: scratchpad.content,
    replace: scratchpad.replace,
    append: scratchpad.append,
  });
  const sandbox = useSandbox();
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
  const { key: kimiKey, setKey: setKimiKey, clearKey: clearKimiKey, hasKey: hasKimiKey } = useMoonshotKey();
  const { setKey: setOllamaKey, clearKey: clearOllamaKey, hasKey: hasOllamaKey, model: ollamaModel, setModel: setOllamaModel } = useOllamaConfig();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isDemo, setIsDemo] = useState(false);
  const [kimiKeyInput, setKimiKeyInput] = useState('');
  const [ollamaKeyInput, setOllamaKeyInput] = useState('');
  const [ollamaModelInput, setOllamaModelInput] = useState('');
  const [activeBackend, setActiveBackend] = useState<PreferredProvider | null>(() => getPreferredProvider());

  // Derive display label from actual active provider
  const activeProviderLabel = getActiveProvider();
  const [showFileBrowser, setShowFileBrowser] = useState(false);
  const [installIdInput, setInstallIdInput] = useState('');
  const [showInstallIdInput, setShowInstallIdInput] = useState(false);

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

  // --- AGENTS.md: read from sandbox when ready ---

  const [agentsMdContent, setAgentsMdContent] = useState<string | null>(null);

  useEffect(() => {
    if (sandbox.status !== 'ready' || !sandbox.sandboxId) {
      setAgentsMdContent(null);
      setAgentsMd(null);
      return;
    }
    readFromSandbox(sandbox.sandboxId, '/workspace/AGENTS.md')
      .then((result) => {
        setAgentsMdContent(result.content);
        setAgentsMd(result.content); // Coder path
      })
      .catch(() => {
        setAgentsMdContent(null);
        setAgentsMd(null);
      });
  }, [sandbox.status, sandbox.sandboxId, setAgentsMd]);

  // Build workspace context when repos, active repo, or AGENTS.md change
  useEffect(() => {
    if (repos.length > 0) {
      let ctx = buildWorkspaceContext(repos, activeRepo);
      if (agentsMdContent) {
        ctx += '\n\nAGENTS.MD — Project instructions from the repository:\n' + agentsMdContent;
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
          <div className="flex items-center gap-1.5">
            <div
              className={`h-2 w-2 rounded-full transition-colors duration-200 ${
                isConnected ? 'bg-emerald-500' : 'bg-[#52525b]'
              }`}
            />
            <span className="text-xs text-[#52525b]">
              {isDemo ? 'Demo' : hasKimiKey ? 'Kimi' : isConnected ? 'GitHub' : 'Offline'}
            </span>
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
      />

      {/* Input */}
      <ChatInput
        onSend={sendMessage}
        disabled={isStreaming}
        repoName={activeRepo?.name}
        onScratchpadToggle={scratchpad.toggle}
        scratchpadHasContent={scratchpad.hasContent}
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
                        <p className="text-xs text-red-400">{appError}</p>
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

            {/* AI Provider */}
            <div className="space-y-3 pt-2 border-t border-[#1a1a1a]">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-[#fafafa]">
                  AI Provider
                </label>
                <div className="flex items-center gap-1.5">
                  <div
                    className={`h-2 w-2 rounded-full ${
                      hasOllamaKey || hasKimiKey ? 'bg-emerald-500' : 'bg-[#52525b]'
                    }`}
                  />
                  <span className="text-xs text-[#a1a1aa]">
                    {activeProviderLabel === 'ollama' ? 'Ollama' : activeProviderLabel === 'moonshot' ? 'Kimi' : isDemo ? 'Demo' : 'Offline'}
                  </span>
                </div>
              </div>

              {/* Backend picker — shown when both providers have keys */}
              {hasKimiKey && hasOllamaKey && (
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-[#a1a1aa]">Active backend</label>
                  <div className="flex gap-2">
                    {([['moonshot', 'Kimi'], ['ollama', 'Ollama']] as const).map(([value, label]) => (
                      <button
                        key={value}
                        onClick={() => {
                          setPreferredProvider(value);
                          setActiveBackend(value);
                        }}
                        className={`flex-1 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                          (activeBackend ?? activeProviderLabel) === value
                            ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400'
                            : 'border-[#1a1a1a] bg-[#0d0d0d] text-[#71717a] hover:text-[#a1a1aa]'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Ollama Cloud */}
              <div className="space-y-2">
                <label className="text-xs font-medium text-[#a1a1aa]">Ollama Cloud</label>
                {hasOllamaKey ? (
                  <div className="space-y-2">
                    <div className="rounded-lg border border-[#1a1a1a] bg-[#0d0d0d] px-3 py-2">
                      <p className="text-sm text-[#a1a1aa] font-mono">Key saved</p>
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
                        placeholder="kimi-k2.5:cloud"
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
                      placeholder="Ollama Cloud API key"
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
                      Ollama Cloud API key from ollama.com/cloud.
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
                        {kimiKey?.startsWith('sk-kimi-') ? 'sk-kimi-••••••••' : 'Key saved'}
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
