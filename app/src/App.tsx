import { useState } from 'react';
import { Settings, Trash2 } from 'lucide-react';
import { useChat } from '@/hooks/useChat';
import { useGitHubAuth } from '@/hooks/useGitHubAuth';
import { ChatContainer } from '@/components/chat/ChatContainer';
import { ChatInput } from '@/components/chat/ChatInput';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import './App.css';

function App() {
  const { messages, sendMessage, clearHistory, agentStatus, isStreaming } = useChat();
  const { token, setTokenManually, logout, configured } = useGitHubAuth();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [patInput, setPatInput] = useState('');

  const handleSavePat = () => {
    if (patInput.trim()) {
      setTokenManually(patInput.trim());
      setPatInput('');
    }
  };

  const isConnected = Boolean(token);

  return (
    <div className="flex h-dvh flex-col bg-[#09090b] safe-area-top">
      {/* Top bar */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-[#1a1a1e]">
        <h1 className="text-base font-semibold text-[#fafafa] tracking-tight">
          Diff
        </h1>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <div
              className={`h-2 w-2 rounded-full transition-colors duration-200 ${
                isConnected ? 'bg-emerald-500' : 'bg-[#52525b]'
              }`}
            />
            <span className="text-xs text-[#52525b]">
              {isConnected ? 'GitHub' : 'Offline'}
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
      <ChatContainer messages={messages} agentStatus={agentStatus} />

      {/* Input */}
      <ChatInput onSend={sendMessage} disabled={isStreaming} />

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
                    {isConnected ? 'Connected' : 'Not connected'}
                  </span>
                </div>
              </div>

              {isConnected ? (
                <div className="space-y-2">
                  <div className="rounded-lg border border-[#1a1a1e] bg-[#111113] px-3 py-2">
                    <p className="text-xs text-[#52525b] mb-0.5">Token</p>
                    <p className="text-sm text-[#a1a1aa] font-mono">
                      {token.slice(0, 8)}{'...'}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={logout}
                    className="text-[#a1a1aa] hover:text-red-400 w-full justify-start"
                  >
                    Disconnect
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <Input
                    type="password"
                    placeholder="ghp_xxxxxxxxxxxx"
                    value={patInput}
                    onChange={(e) => setPatInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSavePat()}
                    className="bg-[#111113] border-[#1a1a1e] text-[#fafafa] placeholder:text-[#52525b] font-mono text-sm"
                  />
                  <Button
                    onClick={handleSavePat}
                    disabled={!patInput.trim()}
                    size="sm"
                    className="w-full bg-[#0070f3] text-white hover:bg-[#0060d3]"
                  >
                    Connect
                  </Button>
                  <p className="text-xs text-[#52525b] leading-relaxed">
                    Personal access token with <code className="text-[#a1a1aa] font-mono">repo</code> scope.
                    Stored locally, never sent to our servers.
                  </p>
                </div>
              )}
            </div>

            {/* Danger Zone */}
            {configured && (
              <div className="space-y-3 pt-2 border-t border-[#1a1a1e]">
                <label className="text-sm font-medium text-[#fafafa]">
                  Data
                </label>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    clearHistory();
                    setSettingsOpen(false);
                  }}
                  className="text-[#a1a1aa] hover:text-red-400 w-full justify-start gap-2"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Clear chat history
                </Button>
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

export default App;
