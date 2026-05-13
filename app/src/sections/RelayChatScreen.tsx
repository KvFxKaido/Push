/**
 * RelayChatScreen — chat surface for a paired `kind: 'relay'`
 * workspace session. Phase 2.f sibling to `LocalPcChatScreen`.
 *
 * Structurally near-identical to LocalPcChatScreen — it mounts
 * `useRelayDaemon` for the long-lived WS, `useChat` for the round
 * loop, and renders header chip + reconnect banner + approval
 * prompt + chat + compose. Diffs from the loopback screen:
 *
 *   - Hook: `useRelayDaemon` (Worker relay transport) instead of
 *     `useLocalDaemon` (loopback).
 *   - Binding: `RelayBinding` (deploymentUrl + sessionId + attach
 *     token) instead of `LocalPcBinding` (port + token).
 *   - Mode chip: `RelayModeChip` shows the deployment host and
 *     flashes amber for ~3s on `replayUnavailableAt` (the 2.f
 *     scope's "you missed events while disconnected" signal).
 *   - Storage: `clearPairedRemote` on unpair.
 *   - Workspace context: built with `transport: 'relay'` so the
 *     model sees the "Paired Remote Computer" heading.
 *
 * TODO (follow-up): the chat shell, approval queue, reconnect
 * banner, and compose box are duplicated between this screen and
 * `LocalPcChatScreen`. The right next step is to extract a generic
 * `DaemonChatBody` and have these two be thin wrappers selecting
 * the hook + chip. Kept as a clone for the 2.f scope to keep this
 * PR focused on the relay transport landing.
 */
import { Globe, RefreshCw, Send, Square } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChatContainer } from '@/components/chat/ChatContainer';
import { RelayModeChip } from '@/components/RelayModeChip';
import { ApprovalPrompt, type PendingApproval } from '@/components/local-pc/ApprovalPrompt';
import { LocalPcModelPicker } from '@/components/local-pc/LocalPcModelPicker';
import { useChat } from '@/hooks/useChat';
import { useRelayDaemon } from '@/hooks/useRelayDaemon';
import { useModelCatalog } from '@/hooks/useModelCatalog';
import { clearPairedRemote } from '@/lib/relay-storage';
import { setPreferredProvider, type PreferredProvider } from '@/lib/providers';
import { buildLocalPcWorkspaceContext } from '@/lib/workspace-context';
import type { Conversation, RelayBinding } from '@/types';

interface RelayChatScreenProps {
  binding: RelayBinding;
  /** Called after the user unpairs — caller ends the workspace session. */
  onUnpair: () => void;
}

export function RelayChatScreen({ binding, onUnpair }: RelayChatScreenProps) {
  const catalog = useModelCatalog();
  const handleSelectProvider = useCallback(
    (provider: PreferredProvider) => {
      setPreferredProvider(provider);
      catalog.setActiveBackend(provider);
    },
    [catalog],
  );

  const [approvalQueue, setApprovalQueue] = useState<PendingApproval[]>([]);
  const approvalQueueRef = useRef<PendingApproval[]>([]);
  useEffect(() => {
    approvalQueueRef.current = approvalQueue;
  }, [approvalQueue]);
  const enqueueApproval = useCallback((approval: PendingApproval) => {
    setApprovalQueue((prev) =>
      prev.some((p) => p.approvalId === approval.approvalId) ? prev : [...prev, approval],
    );
  }, []);
  const dropApproval = useCallback((approvalId: string) => {
    setApprovalQueue((prev) => prev.filter((p) => p.approvalId !== approvalId));
  }, []);

  const { status, reconnect, reconnectInfo, request, replayUnavailableAt } = useRelayDaemon(
    binding,
    {
      onEvent: (event) => {
        if (event.type === 'approval_required') {
          const payload = event.payload as
            | {
                approvalId?: unknown;
                kind?: unknown;
                title?: unknown;
                summary?: unknown;
                options?: unknown;
              }
            | undefined;
          if (!payload || typeof payload.approvalId !== 'string') return;
          enqueueApproval({
            approvalId: payload.approvalId,
            sessionId: event.sessionId,
            runId: event.runId,
            kind: typeof payload.kind === 'string' ? payload.kind : 'tool_execution',
            title: typeof payload.title === 'string' ? payload.title : 'Approval required',
            summary: typeof payload.summary === 'string' ? payload.summary : '',
            options:
              Array.isArray(payload.options) && payload.options.every((o) => typeof o === 'string')
                ? (payload.options as string[])
                : ['approve', 'deny'],
            receivedAt: Date.now(),
          });
          return;
        }
        if (event.type === 'approval_received') {
          const payload = event.payload as { approvalId?: unknown } | undefined;
          if (payload && typeof payload.approvalId === 'string') {
            dropApproval(payload.approvalId);
          }
        }
      },
    },
  );

  const decideApproval = useCallback(
    (decision: 'approve' | 'deny') => {
      const head = approvalQueueRef.current[0];
      if (!head) return;
      void request<{ accepted: boolean }>({
        type: 'submit_approval',
        sessionId: head.sessionId,
        payload: {
          sessionId: head.sessionId,
          approvalId: head.approvalId,
          decision,
        },
      }).catch(() => {
        // see LocalPcChatScreen for why surfacing failure here is deferred
      });
      setApprovalQueue((prev) => (prev[0]?.approvalId === head.approvalId ? prev.slice(1) : prev));
    },
    [request],
  );

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
    setWorkspaceContext,
    setWorkspaceMode,
    conversations,
    conversationsLoaded,
    activeChatId,
    switchChat,
    createNewChat,
    lockedProvider,
    isProviderLocked,
  } = useChat(null);

  useEffect(() => {
    setLocalDaemonBinding(binding);
    return () => {
      setLocalDaemonBinding(null);
    };
  }, [binding, setLocalDaemonBinding]);

  setWorkspaceMode('relay');

  useEffect(() => {
    setWorkspaceContext({
      description: buildLocalPcWorkspaceContext({ transport: 'relay' }),
      includeGitHubTools: false,
      mode: 'relay',
    });
    return () => {
      setWorkspaceContext(null);
    };
  }, [setWorkspaceContext]);

  const initializedConversationRef = useRef(false);
  useEffect(() => {
    if (!conversationsLoaded || initializedConversationRef.current) return;
    initializedConversationRef.current = true;
    const activeConv = conversations[activeChatId] as Conversation | undefined;
    if (activeConv?.mode === 'relay') return;
    const relayChats = Object.values(conversations)
      .filter((c) => c.mode === 'relay')
      .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    if (relayChats.length > 0) {
      switchChat(relayChats[0].id);
    } else {
      createNewChat();
    }
  }, [conversationsLoaded, conversations, activeChatId, switchChat, createNewChat]);

  const [now, setNow] = useState(() => Date.now());
  const hasPendingRetry = reconnectInfo.nextAttemptAt !== null;
  useEffect(() => {
    if (!hasPendingRetry) return;
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [hasPendingRetry]);

  const [composeText, setComposeText] = useState('');
  const handleSend = () => {
    const text = composeText.trim();
    if (!text || isStreaming) return;
    setComposeText('');
    void sendMessage(text);
  };
  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  };

  const handleUnpair = async () => {
    await clearPairedRemote();
    onUnpair();
  };

  return (
    <div className="flex h-dvh flex-col bg-[linear-gradient(180deg,rgba(4,6,10,1)_0%,rgba(2,4,8,1)_100%)] safe-area-top safe-area-bottom">
      <header className="flex items-center justify-between gap-3 border-b border-push-edge/40 px-4 py-3">
        <RelayModeChip
          deploymentUrl={binding.deploymentUrl}
          status={status}
          replayUnavailableAt={replayUnavailableAt}
        />
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
            <Globe className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Unpair</span>
          </button>
        </div>
      </header>

      {status.state !== 'open' && status.state !== 'connecting' ? (
        <ReconnectBanner
          status={status.state}
          attempts={reconnectInfo.attempts}
          maxAttempts={reconnectInfo.maxAttempts}
          nextAttemptAt={reconnectInfo.nextAttemptAt}
          exhausted={reconnectInfo.exhausted}
          now={now}
          onRetry={reconnect}
        />
      ) : null}

      <ApprovalPrompt
        pending={approvalQueue[0] ?? null}
        queuedBehind={Math.max(0, approvalQueue.length - 1)}
        onDecide={decideApproval}
      />

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
        <div className="mb-2 flex items-center">
          <LocalPcModelPicker
            activeProvider={catalog.activeProviderLabel}
            availableProviders={catalog.availableProviders}
            onSelectProvider={handleSelectProvider}
            lockedProvider={lockedProvider}
            isProviderLocked={isProviderLocked}
          />
        </div>
        <div className="flex items-end gap-2">
          <textarea
            value={composeText}
            onChange={(e) => setComposeText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              status.state === 'open'
                ? 'Ask the remote daemon…'
                : status.state === 'connecting'
                  ? 'Connecting to remote daemon…'
                  : 'Remote daemon unreachable'
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

interface ReconnectBannerProps {
  status: 'unreachable' | 'closed';
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: number | null;
  exhausted: boolean;
  now: number;
  onRetry: () => void;
}

function ReconnectBanner({
  status,
  attempts,
  maxAttempts,
  nextAttemptAt,
  exhausted,
  now,
  onRetry,
}: ReconnectBannerProps) {
  let body: React.ReactNode;
  if (exhausted) {
    body = (
      <>
        <span className="text-rose-200">Remote daemon unreachable after {attempts} attempts.</span>
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1.5 rounded-full border border-rose-400/40 px-2.5 py-1 text-xs text-rose-100 transition hover:border-rose-400/60 hover:bg-rose-400/10"
          aria-label="Retry connection"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Retry</span>
        </button>
      </>
    );
  } else if (nextAttemptAt !== null) {
    const remainingMs = Math.max(0, nextAttemptAt - now);
    const seconds = Math.max(1, Math.ceil(remainingMs / 1000));
    body = (
      <span className="text-amber-200/80">
        Reconnecting to remote daemon in {seconds}s (attempt {attempts} of {maxAttempts})…
      </span>
    );
  } else if (status === 'unreachable' || status === 'closed') {
    body = <span className="text-amber-200/80">Reconnecting to remote daemon…</span>;
  } else {
    body = <span className="text-push-fg-secondary">Remote daemon connection closed.</span>;
  }
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center justify-between gap-3 border-b border-push-edge/40 bg-[#1a0b0b]/40 px-4 py-2 text-xs"
    >
      {body}
    </div>
  );
}
