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
 *     `abortStream`. Phase 1.f wires `abortControllerRef.signal`
 *     through `executeSandboxToolCall` so an in-flight `sandbox_exec`
 *     also has its daemon-side child SIGTERMed via a `cancel_run` on
 *     the same WS (see `local-daemon-sandbox-client.withTransient-
 *     Binding` and `cli/pushd.handleSandboxExec`'s active-runs map).
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
import { MonitorOff, RefreshCw, Send, Square } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChatContainer } from '@/components/chat/ChatContainer';
import { LocalPcModeChip } from '@/components/LocalPcModeChip';
import { ApprovalPrompt, type PendingApproval } from '@/components/local-pc/ApprovalPrompt';
import { LocalPcModelPicker } from '@/components/local-pc/LocalPcModelPicker';
import { useChat } from '@/hooks/useChat';
import { useLocalDaemon } from '@/hooks/useLocalDaemon';
import { useModelCatalog } from '@/hooks/useModelCatalog';
import { clearPairedDevice } from '@/lib/local-pc-storage';
import { setPreferredProvider, type PreferredProvider } from '@/lib/providers';
import type { Conversation, LocalPcBinding } from '@/types';

interface LocalPcChatScreenProps {
  binding: LocalPcBinding;
  /** Called after the user unpairs — caller ends the workspace session. */
  onUnpair: () => void;
}

export function LocalPcChatScreen({ binding, onUnpair }: LocalPcChatScreenProps) {
  // Model/provider picker (deferred 3c.2b polish item). Without this,
  // the local-pc chat inherits whatever the user last picked on the
  // cloud surface with no in-chat surface to see or change it. The
  // catalog hook owns the reactive `activeBackend` state — the picker
  // surfaces it, the select handler updates both the durable
  // preference (via providers.ts) AND the catalog's reactive state
  // so `getActiveProvider()` returns the new value on the next read.
  const catalog = useModelCatalog();
  const handleSelectProvider = useCallback(
    (provider: PreferredProvider) => {
      // Order matters: persist FIRST so a re-render mid-switch sees
      // the same value the catalog is about to report. The catalog's
      // setActiveBackend is what actually triggers the re-render —
      // setPreferredProvider alone wouldn't.
      setPreferredProvider(provider);
      catalog.setActiveBackend(provider);
    },
    [catalog],
  );

  // Phase 3 slice 4: queue of pending approvals from the daemon's
  // `approval_required` events. Daemon-side delegated agents (e.g.
  // delegate_coder) emit these when a sandbox guard fires; without a
  // listener they silently timed out after 60s. The queue is FIFO —
  // we render the head and surface a counter for the rest.
  const [approvalQueue, setApprovalQueue] = useState<PendingApproval[]>([]);
  // Mirror of approvalQueue in a ref. decideApproval reads the head
  // from here so the request() call lives OUTSIDE the setState
  // updater — keeping the updater a pure function as React's
  // concurrent/StrictMode contract requires. Without the mirror, the
  // updater would have to extract the head AND fire the side-effect,
  // which can double-dispatch under double-invocation. #521 review.
  const approvalQueueRef = useRef<PendingApproval[]>([]);
  useEffect(() => {
    approvalQueueRef.current = approvalQueue;
  }, [approvalQueue]);
  const enqueueApproval = useCallback((approval: PendingApproval) => {
    // Dedupe by approvalId — the daemon broadcasts to every attached
    // client, and if the same WS reconnects mid-approval the event
    // log can include the same id twice. Without dedupe the user
    // sees duplicate prompts.
    setApprovalQueue((prev) =>
      prev.some((p) => p.approvalId === approval.approvalId) ? prev : [...prev, approval],
    );
  }, []);

  // Long-lived binding for status display (mode chip) AND approval
  // event subscription. The chat dispatch still opens its own
  // transient bindings per tool call via `executeSandboxToolCall`'s
  // daemon fork; this binding is for events the daemon pushes
  // unsolicited.
  // Drop a resolved approval from the local queue regardless of which
  // client decided it. Without this, multi-client sessions stale-head
  // their queues: clients that didn't click keep showing the prompt
  // until the user clicks it and gets `APPROVAL_NOT_FOUND`, hiding
  // every later approval behind a stale entry. #521 Codex P2.
  const dropApproval = useCallback((approvalId: string) => {
    setApprovalQueue((prev) => prev.filter((p) => p.approvalId !== approvalId));
  }, []);

  const { status, reconnect, reconnectInfo, request } = useLocalDaemon(binding, {
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
        // Daemon broadcasts approval_received to every attached
        // client after any one of them answers (or the approval
        // timed out). Drop the matching entry so the queue stays
        // live across tabs / phones. #521 Codex P2.
        const payload = event.payload as { approvalId?: unknown } | undefined;
        if (payload && typeof payload.approvalId === 'string') {
          dropApproval(payload.approvalId);
        }
      }
    },
  });

  const decideApproval = useCallback(
    (decision: 'approve' | 'deny') => {
      // Read the current head from the ref (a synchronous mirror of
      // approvalQueue) so the side-effect lives OUTSIDE the setState
      // updater — React's concurrent/StrictMode contract requires
      // updaters to be pure. Without this, double-invocation under
      // StrictMode could double-dispatch the request.
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
        // Errors are surfaced in the daemon's audit log; the user
        // has already moved on UX-wise. A future polish PR could
        // show a "decision failed to register" toast.
      });
      // Pop the same approvalId we just dispatched against — defends
      // against the race where the queue was rewritten between
      // `head` capture and this updater running (e.g. a new approval
      // arriving). #521 review.
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
    setWorkspaceMode,
    conversations,
    conversationsLoaded,
    activeChatId,
    switchChat,
    createNewChat,
    // Slice 1.d polish: once the active chat has sent its first
    // message, useChat locks the conversation to its original
    // provider. The picker reads these to render the locked
    // provider and disable in-place switching, so the chip doesn't
    // lie about what the next turn uses. Codex P2 on #522.
    lockedProvider,
    isProviderLocked,
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

  // Live countdown for the reconnect banner. When a retry is scheduled
  // (`nextAttemptAt` is set), tick the clock every 500ms so the
  // displayed "Reconnecting in Xs" updates. The interval is cleared
  // when no retry is scheduled — we never tick in the idle/open path.
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

interface ReconnectBannerProps {
  status: 'unreachable' | 'closed';
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: number | null;
  exhausted: boolean;
  now: number;
  onRetry: () => void;
}

/**
 * Banner rendered when the long-lived daemon WS is in a non-open state
 * (`unreachable` from a pre-open failure, or `closed` post-open). While
 * the auto-reconnect ladder is running it shows the live countdown and
 * the attempt counter; once exhausted it surfaces a manual Retry button
 * the user can hit to re-arm the schedule.
 */
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
        <span className="text-rose-200">Local daemon unreachable after {attempts} attempts.</span>
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
    // Ceil so 0.4s rounds up to 1s in the UI — clamp at 1 so we never
    // flicker "Reconnecting in 0s" while the timer fires.
    const remainingMs = Math.max(0, nextAttemptAt - now);
    const seconds = Math.max(1, Math.ceil(remainingMs / 1000));
    // `attempts` already counts the retry currently pending (1-based)
    // — the hook increments it when the retry is scheduled, not after
    // it completes — so "attempt N of M" reads directly without a
    // `+1`. (#517 review off-by-one.)
    body = (
      <span className="text-amber-200/80">
        Reconnecting to local daemon in {seconds}s (attempt {attempts} of {maxAttempts})…
      </span>
    );
  } else if (status === 'unreachable' || status === 'closed') {
    // Adapter just transitioned to unreachable; the scheduling effect
    // hasn't populated `nextAttemptAt` for this render yet.
    body = <span className="text-amber-200/80">Reconnecting to local daemon…</span>;
  } else {
    body = <span className="text-push-fg-secondary">Local daemon connection closed.</span>;
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
