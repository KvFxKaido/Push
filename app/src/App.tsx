import { useState, useEffect, useCallback, useMemo } from 'react';
import { Settings, Trash2 } from 'lucide-react';
import { useChat } from '@/hooks/useChat';
import { useGitHubAuth } from '@/hooks/useGitHubAuth';
import { useRepos } from '@/hooks/useRepos';
import { useActiveRepo } from '@/hooks/useActiveRepo';
import { useOpenRouterKey } from '@/hooks/useOpenRouterKey';
import { buildWorkspaceContext } from '@/lib/workspace-context';
import { ChatContainer } from '@/components/chat/ChatContainer';
import { ChatInput } from '@/components/chat/ChatInput';
import { RepoAndChatSelector } from '@/components/chat/RepoAndChatSelector';
import { OnboardingScreen } from '@/sections/OnboardingScreen';
import { RepoPicker } from '@/sections/RepoPicker';
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
  } = useChat(activeRepo?.full_name ?? null);
  const {
    token,
    setTokenManually,
    logout,
    loading: authLoading,
    error: authError,
    validatedUser,
  } = useGitHubAuth();
  const { repos, loading: reposLoading, sync: syncRepos } = useRepos();
  const { key: orKey, setKey: setOrKey, clearKey: clearOrKey, hasKey: hasOrKey } = useOpenRouterKey();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isDemo, setIsDemo] = useState(false);
  const [orKeyInput, setOrKeyInput] = useState('');

  // Screen state machine
  const screen: AppScreen = useMemo(() => {
    if (isDemo) return 'chat';
    if (!token) return 'onboarding';
    if (!activeRepo) return 'repo-picker';
    return 'chat';
  }, [token, activeRepo, isDemo]);

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

  // Disconnect: clear everything
  const handleDisconnect = useCallback(() => {
    logout();
    clearActiveRepo();
    deleteAllChats();
    setIsDemo(false);
  }, [logout, clearActiveRepo, deleteAllChats]);

  // Build workspace context when repos or active repo change
  useEffect(() => {
    if (repos.length > 0) {
      setWorkspaceContext(buildWorkspaceContext(repos, activeRepo));
    } else {
      setWorkspaceContext(null);
    }
  }, [repos, activeRepo, setWorkspaceContext]);

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
      <OnboardingScreen
        onConnect={handleConnect}
        onDemo={handleDemo}
        loading={authLoading}
        error={authError}
        validatedUser={validatedUser}
      />
    );
  }

  if (screen === 'repo-picker') {
    return (
      <RepoPicker
        repos={repos}
        loading={reposLoading}
        onSelect={handleSelectRepo}
        onDisconnect={handleDisconnect}
        user={validatedUser}
      />
    );
  }

  // ----- Chat screen -----

  const isConnected = Boolean(token) || isDemo;

  return (
    <div className="flex h-dvh flex-col bg-[#09090b] safe-area-top">
      {/* Top bar */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-[#1a1a1e]">
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
          <div className="flex items-center gap-1.5">
            <div
              className={`h-2 w-2 rounded-full transition-colors duration-200 ${
                isConnected ? 'bg-emerald-500' : 'bg-[#52525b]'
              }`}
            />
            <span className="text-xs text-[#52525b]">
              {isDemo ? 'Demo' : hasOrKey ? 'OpenRouter' : isConnected ? 'GitHub' : 'Offline'}
            </span>
          </div>
          <button
            onClick={() => setSettingsOpen(true)}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-[#52525b] transition-colors duration-200 hover:text-[#a1a1aa] hover:bg-[#111113] active:scale-95"
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
      />

      {/* Input */}
      <ChatInput
        onSend={sendMessage}
        disabled={isStreaming}
        repoName={activeRepo?.name}
      />

      {/* Settings Sheet */}
      <Sheet open={settingsOpen} onOpenChange={setSettingsOpen}>
        <SheetContent side="right" className="bg-[#09090b] border-[#1a1a1e]">
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
                    <div className="rounded-lg border border-[#1a1a1e] bg-[#111113] px-3 py-2">
                      <p className="text-sm text-[#a1a1aa] font-mono">
                        {token.startsWith('ghp_') ? 'ghp_••••••••' : 'Token saved'}
                      </p>
                    </div>
                  )}
                  {/* Security note: PAT is stored in localStorage (accessible to same-origin JS). */}
                  {/* Mitigated by: no innerHTML/dangerouslySetInnerHTML usage, strict CSP in production. */}
                  {/* Future: consider HttpOnly cookie via backend session. */}
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
            <div className="space-y-3 pt-2 border-t border-[#1a1a1e]">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-[#fafafa]">
                  AI Provider
                </label>
                <div className="flex items-center gap-1.5">
                  <div
                    className={`h-2 w-2 rounded-full ${
                      hasOrKey ? 'bg-emerald-500' : 'bg-[#52525b]'
                    }`}
                  />
                  <span className="text-xs text-[#a1a1aa]">
                    {hasOrKey ? 'OpenRouter' : 'Ollama Cloud'}
                  </span>
                </div>
              </div>

              {hasOrKey ? (
                <div className="space-y-2">
                  <div className="rounded-lg border border-[#1a1a1e] bg-[#111113] px-3 py-2">
                    <p className="text-sm text-[#a1a1aa] font-mono">
                      {orKey?.startsWith('sk-or-') ? 'sk-or-••••••••' : 'Key saved'}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => clearOrKey()}
                    className="text-[#a1a1aa] hover:text-red-400 w-full justify-start"
                  >
                    Remove key
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <input
                    type="password"
                    value={orKeyInput}
                    onChange={(e) => setOrKeyInput(e.target.value)}
                    placeholder="sk-or-..."
                    className="w-full rounded-lg border border-[#1a1a1e] bg-[#111113] px-3 py-2 text-sm text-[#fafafa] placeholder:text-[#52525b] focus:outline-none focus:border-[#3f3f46]"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && orKeyInput.trim()) {
                        setOrKey(orKeyInput.trim());
                        setOrKeyInput('');
                      }
                    }}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (orKeyInput.trim()) {
                        setOrKey(orKeyInput.trim());
                        setOrKeyInput('');
                      }
                    }}
                    disabled={!orKeyInput.trim()}
                    className="text-[#a1a1aa] hover:text-[#fafafa] w-full justify-start"
                  >
                    Save OpenRouter key
                  </Button>
                  <p className="text-xs text-[#52525b]">
                    Optional. Adds OpenRouter as the AI provider.
                  </p>
                </div>
              )}
            </div>

            {/* Danger Zone */}
            <div className="space-y-3 pt-2 border-t border-[#1a1a1e]">
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
