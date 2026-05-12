/**
 * LocalPcChatScreen — chat surface for a paired `kind: 'local-pc'`
 * workspace session. PR 3c.2b: gives local-pc sessions a real chat
 * so the daemon-dispatch seam shipped in PRs #514 / #515 is reachable
 * from a real user turn instead of only from unit tests.
 *
 * Scope of this screen (intentionally narrow per "save UI for last"):
 *   - Mounts `useLocalDaemon` for a long-lived WS binding so the mode
 *     chip in the header reflects live status, NOT the transient
 *     per-tool-call binding used by `executeSandboxToolCall`.
 *   - Mounts `useChat` with minimal cloud-free args (no sandbox
 *     controller, no branch sync, no GitHub repo). Wires
 *     `setLocalDaemonBinding(session.binding)` on mount and clears
 *     on unmount so chat tool calls route through the daemon.
 *   - Stop button in the header aborts the in-flight web round via
 *     `abortStream`. NB: there is no daemon-side mid-run cancellation
 *     today — the dispatch model is transient (one tool per WS), so
 *     any in-flight `sandbox_exec` runs to its own 60s timeout. Real
 *     daemon-side cancel needs a persistent session/runId abstraction
 *     and lands separately.
 *   - Unpair clears the paired-device record and exits the workspace.
 *
 * What this screen still does NOT do (deferred):
 *   - Model/provider picker UI. The orchestrator's last-selected
 *     provider/model is used silently. Production UX surfaces this
 *     in the input area like the cloud chat does.
 *   - File browser, attachments, snapshots, branch switcher — all
 *     cloud-shaped concerns that don't apply to a paired daemon
 *     today.
 *   - Multi-chat sidebar. One conversation per local-pc session.
 *
 * Routed from `WorkspaceScreen` for any `kind: 'local-pc'` session;
 * replaces the previous `LocalPcWorkspace` probe-only surface.
 */
import { MonitorOff, Send, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ChatContainer } from '@/components/chat/ChatContainer';
import { LocalPcModeChip } from '@/components/LocalPcModeChip';
import { useChat } from '@/hooks/useChat';
import { useLocalDaemon } from '@/hooks/useLocalDaemon';
import { clearPairedDevice } from '@/lib/local-pc-storage';
import type { Conversation, LocalPcBinding } from '@/types';

interface LocalPcChatScreenProps {
  binding: LocalPcBinding;
  /** Called after the user unpairs — caller ends the workspace session. */
  onUnpair: () => void;
}

export function LocalPcChatScreen({ binding, onUnpair }: LocalPcChatScreenProps) {
  // Long-lived binding for status display (mode chip). The actual
  // chat dispatch opens its own transient binding per tool call via
  // `executeSandboxToolCall`'s daemon fork.
  const { status } = useLocalDaemon(binding);

  const {
    messages,
    sendMessage,
    agentStatus,
    isStreaming,
    abortStream,
    interruptedCheckpoint,
    resumeInterruptedRun,
    dismissResume,
    handleCardAction,
    setLocalDaemonBinding,
    setWorkspaceMode,
    conversations,
    conversationsLoaded,
    activeChatId,
    switchChat,
    createNewChat,
  } = useChat(
    // No GitHub repo — local-pc sessions are bound to the daemon cwd,
    // not a remote repo.
    null,
    // No scratchpad / usageHandler / runtimeHandlers / branchInfo /
    // todoHandlers — those are cloud-shaped. The orchestrator falls
    // back gracefully when they're absent.
  );

  // Wire the binding into the chat's tool-dispatch context. The setter
  // mutates a ref synchronously; useEffect is right (not useMemo) so
  // the cleanup clears the ref when the user unpairs or navigates away.
  useEffect(() => {
    setLocalDaemonBinding(binding);
    return () => {
      setLocalDaemonBinding(null);
    };
  }, [binding, setLocalDaemonBinding]);

  // Tag local-pc as its own workspace mode (matches the union member
  // in @/types). `createNewChat` reads this ref synchronously when it
  // builds a Conversation, so future-sent turns are persisted under a
  // local-pc-scoped key rather than mixed into cloud chat history.
  // Codex C2 / Copilot on PR #516.
  setWorkspaceMode('local-pc');

  // Conversation scope: useChatAutoSwitch only auto-creates when an
  // activeRepoFullName is set, which local-pc doesn't have. Without
  // this, opening Local PC after a cloud chat would land the user in
  // that cloud conversation and `sendMessage` would append daemon
  // turns to the wrong record. On first mount we either switch to the
  // most recent local-pc-tagged chat, or create a fresh one. The
  // reentrancy guard keeps the effect idempotent across re-renders.
  // Codex C2 on PR #516.
  const initializedConversationRef = useRef(false);
  useEffect(() => {
    if (!conversationsLoaded || initializedConversationRef.current) return;
    initializedConversationRef.current = true;
    const activeConv = conversations[activeChatId] as Conversation | undefined;
    if (activeConv?.mode === 'local-pc') return;
    const localPcChats = Object.values(conversations)
      .filter((c) => c.mode === 'local-pc')
      .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    if (localPcChats.length > 0) {
      switchChat(localPcChats[0].id);
    } else {
      createNewChat();
    }
  }, [conversationsLoaded, conversations, activeChatId, switchChat, createNewChat]);

  const [composeText, setComposeText] = useState('');
  const handleSend = () => {
    const text = composeText.trim();
    if (!text || isStreaming) return;
    setComposeText('');
    void sendMessage(text);
  };
  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, Shift+Enter inserts newline. Mirrors the cloud
    // ChatInput conventions in spirit, intentionally simpler.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  };

  const handleUnpair = async () => {
    await clearPairedDevice();
    onUnpair();
  };

  return (
    <div className="flex h-dvh flex-col bg-[linear-gradient(180deg,rgba(4,6,10,1)_0%,rgba(2,4,8,1)_100%)] safe-area-top safe-area-bottom">
      <header className="flex items-center justify-between gap-3 border-b border-push-edge/40 px-4 py-3">
        <LocalPcModeChip port={binding.port} status={status} />
        <div className="flex items-center gap-2">
          {isStreaming ? (
            <button
              type="button"
              onClick={() => abortStream()}
              aria-label="Stop"
              title="Stop the in-flight turn"
              className="inline-flex items-center gap-1.5 rounded-full border border-rose-400/40 px-3 py-1.5 text-xs text-rose-200 transition hover:border-rose-400/60 hover:bg-rose-400/10"
            >
              <Square className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Stop</span>
            </button>
          ) : null}
          <button
            type="button"
            onClick={handleUnpair}
            aria-label="Unpair"
            className="inline-flex items-center gap-1.5 rounded-full border border-push-edge/60 px-3 py-1.5 text-xs text-push-fg-secondary transition hover:border-rose-400/40 hover:text-rose-200"
          >
            <MonitorOff className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Unpair</span>
          </button>
        </div>
      </header>

      <ChatContainer
        messages={messages}
        agentStatus={agentStatus}
        activeRepo={null}
        hasSandbox={false}
        isChat={true}
        onCardAction={handleCardAction}
        interruptedCheckpoint={interruptedCheckpoint}
        onResumeRun={resumeInterruptedRun}
        onDismissResume={dismissResume}
      />

      <div className="border-t border-push-edge/40 bg-[#000]/80 px-3 py-2 backdrop-blur safe-area-bottom">
        <div className="flex items-end gap-2">
          <textarea
            value={composeText}
            onChange={(e) => setComposeText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              status.state === 'open'
                ? 'Ask the local daemon…'
                : status.state === 'connecting'
                  ? 'Connecting to local daemon…'
                  : 'Local daemon unreachable'
            }
            rows={1}
            className="min-h-[40px] max-h-[160px] flex-1 resize-none rounded-2xl border border-push-edge/60 bg-[#000] px-3 py-2 text-sm text-push-fg outline-none focus:border-push-edge"
            disabled={isStreaming || status.state !== 'open'}
            aria-label="Message"
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={!composeText.trim() || isStreaming || status.state !== 'open'}
            aria-label="Send"
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-push-edge/60 text-push-fg-secondary transition enabled:hover:border-push-fg/60 enabled:hover:text-push-fg disabled:opacity-40"
          >
            <Send className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
