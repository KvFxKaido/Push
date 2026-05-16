/**
 * DaemonChatBody — shared chat shell for daemon-backed sessions.
 * Phase 2.i extraction from `LocalPcChatScreen` / `RelayChatScreen`,
 * which were 95% identical: same `useChat(null)` mount, same
 * conversation init, same compose box, same reconnect banner, same
 * approval queue rendering. The screens become thin wrappers that
 * mount the right daemon hook (`useLocalDaemon` vs `useRelayDaemon`)
 * and pass everything else here.
 *
 * What stays in the screen, by design:
 *   - The daemon hook mount — `useLocalDaemon` and `useRelayDaemon`
 *     have divergent return shapes (the relay hook adds
 *     `replayUnavailableAt`), and Rules-of-Hooks means we can't pick
 *     the hook conditionally inside this body.
 *   - The mode chip — rendered with the transport-specific component
 *     (`LocalPcModeChip` vs `RelayModeChip`) and passed in as a
 *     ready-to-render `ReactNode`.
 *   - Unpair behavior — `clearPairedDevice` vs `clearPairedRemote`
 *     are storage-side differences the screen owns.
 *   - The approval queue — owned via the shared `useApprovalQueue`
 *     hook called at the screen so it can wire `handleDaemonEvent`
 *     into the daemon hook's `onEvent` callback.
 *
 * Everything else (compose state, send/enter handling, ReconnectBanner,
 * ApprovalPrompt placement, ChatContainer wiring, `useChat` mount,
 * conversation init, workspace context, picker placement, layout)
 * lives here so the screens don't drift.
 */
import { ArrowLeft, RefreshCw, Send, Square } from 'lucide-react';
import { NotebookPadIcon } from '@/components/icons/push-custom-icons';
import type { LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';

import { ChatContainer } from '@/components/chat/ChatContainer';
import { ApprovalPrompt } from '@/components/daemon/ApprovalPrompt';
import { cancelPendingApprovals } from '@/lib/daemon-cancel-pending-approvals';
import { DaemonHubSheet } from '@/components/daemon/DaemonHubSheet';
import { DaemonModelPicker } from '@/components/daemon/DaemonModelPicker';
import { ModelPicker } from '@/components/ui/model-picker';
import { useChat } from '@/hooks/useChat';
import { useModelCatalog, buildModelControl } from '@/hooks/useModelCatalog';
import { usePinnedArtifacts } from '@/hooks/usePinnedArtifacts';
import { useScratchpad } from '@/hooks/useScratchpad';
import { useTodo } from '@/hooks/useTodo';
import type { ApprovalQueueHandle } from '@/hooks/useApprovalQueue';
import type { ConnectionStatus, RequestOptions, SessionResponse } from '@/lib/local-daemon-binding';
import type { LiveDaemonBinding, ToolDispatchBinding } from '@/lib/local-daemon-sandbox-client';
import {
  getModelDisplayLeafName,
  setPreferredProvider,
  type PreferredProvider,
} from '@/lib/providers';
import type { Conversation, WorkspaceContext, WorkspaceMode } from '@/types';

/**
 * The reconnect surface the daemon hooks share. Both
 * `useLocalDaemon.reconnectInfo` and `useRelayDaemon.reconnectInfo`
 * satisfy this — declared structurally so the body doesn't import
 * the hook return types directly (and inherit a hook coupling).
 */
export interface DaemonReconnectInfo {
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: number | null;
  exhausted: boolean;
}

export interface DaemonChatBodyProps {
  /** Workspace mode tag used by `useChat`'s conversation scope. */
  mode: Extract<WorkspaceMode, 'local-pc' | 'relay'>;
  /** Human label for placeholder + banner copy. e.g. "local daemon". */
  daemonLabel: string;
  /** Pre-built workspace context the screen wants the orchestrator to read. */
  workspaceContext: WorkspaceContext;

  /** Rendered ahead of the right-side actions; transport-specific chip. */
  modeChip: React.ReactNode;
  /** Icon used on the Unpair button. */
  unpairIcon: LucideIcon;
  /**
   * Storage cleanup + caller notification. Awaited so a failed
   * `clearPaired*` doesn't leave the workspace session dangling.
   */
  onUnpair: () => Promise<void> | void;
  /** Non-destructive exit back to the app shell. Pairing remains stored. */
  onLeave: () => void;

  /** Live connection status from the daemon hook. */
  status: ConnectionStatus;
  /** Manual reconnect (Retry button). */
  reconnect: () => void;
  /** Auto-reconnect scheduler state for the banner. */
  reconnectInfo: DaemonReconnectInfo;

  /**
   * Long-lived binding for chat-layer tool dispatch. Pass `liveBinding`
   * from the daemon hook (null until the WS reaches `open` for the
   * first time). When null we fall back to `paramsBinding` so the
   * very first tool call works through the transient adapter rather
   * than failing with "not connected"; once the WS opens, the next
   * effect run swaps in the live binding.
   */
  liveBinding: LiveDaemonBinding | null;
  /** Params-only binding used as the fallback during the pre-open window. */
  paramsBinding: ToolDispatchBinding;

  /** Approval queue from `useApprovalQueue()`. */
  approvals: ApprovalQueueHandle;
  /**
   * The daemon hook's `request` fn. The body uses it to dispatch
   * `submit_approval` envelopes for the user's approve/deny click.
   * Passed in instead of looking up the daemon hook here because
   * the body can't know which hook the screen mounted.
   */
  request: <T = unknown>(opts: RequestOptions) => Promise<SessionResponse<T>>;
}

export function DaemonChatBody({
  mode,
  daemonLabel,
  workspaceContext,
  modeChip,
  unpairIcon: UnpairIcon,
  onUnpair,
  onLeave,
  status,
  reconnect,
  reconnectInfo,
  liveBinding,
  paramsBinding,
  approvals,
  request,
}: DaemonChatBodyProps) {
  // Provider/model picker plumbing — identical between the two
  // screens. The catalog hook owns reactive `activeBackend` state;
  // the picker reads it, the select handler writes both the durable
  // preference (via providers.ts) AND the catalog's reactive state
  // so `getActiveProvider()` returns the new value on the next read.
  const catalog = useModelCatalog();

  // Hub sheet open state + data feeds for its Notes tab. All three
  // hooks accept `repoFullName: string | null`; daemon sessions have
  // no repo binding, so we pass `null` to get the "global / non-repo
  // scoped" storage key. The hub stays unmounted when closed (state
  // lives here so toggling doesn't reset between renders).
  const [hubOpen, setHubOpen] = useState(false);
  const scratchpad = useScratchpad(null);
  const todo = useTodo(null);
  const pinnedArtifacts = usePinnedArtifacts(null);
  const decideApproval = useCallback(
    (decision: 'approve' | 'deny') => {
      // Read the head from the ref (a synchronous mirror of the
      // queue) so the side-effect lives OUTSIDE the popMatching
      // updater — React's concurrent / StrictMode contract requires
      // updaters to be pure. Without this, double-invocation under
      // StrictMode could double-dispatch the request.
      const head = approvals.headRef.current[0];
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
        // Errors surface in the daemon's audit log; the user has
        // already moved on UX-wise. A future polish PR could show a
        // "decision failed to register" toast.
      });
      approvals.popMatching(head.approvalId);
    },
    [request, approvals],
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
    // Slice 1.d polish: once the active chat has sent its first
    // message, useChat locks the conversation to its original
    // provider. The picker reads these to render the locked
    // provider/model. The daemon pickers surface the locked values;
    // switching starts a fresh daemon chat so the existing transcript
    // does not lie about what routed its earlier turns.
    lockedProvider,
    isProviderLocked,
    lockedModel,
    isModelLocked,
  } = useChat(
    // No GitHub repo — daemon-backed sessions are bound to the
    // daemon cwd, not a remote repo.
    null,
    // Scratchpad handlers — wire so model `set_scratchpad` /
    // `append_scratchpad` tool calls hit the daemon hub's notes
    // surface instead of the chat-hook's "not available" path.
    {
      content: scratchpad.content,
      replace: scratchpad.replace,
      append: scratchpad.append,
    },
    // usageHandler / runtimeHandlers / branchInfo are cloud-sandbox
    // concerns; daemon sessions don't drive them.
    undefined,
    undefined,
    undefined,
    // Todo handlers — wire so model `todo_write` / `todo_clear` calls
    // update the Plan section in the hub.
    {
      todos: todo.todos,
      replace: todo.replace,
      clear: todo.clear,
    },
  );

  const handleSelectProvider = useCallback(
    (provider: PreferredProvider) => {
      // Order matters: persist FIRST so a re-render mid-switch sees
      // the same value the catalog is about to report. The catalog's
      // setActiveBackend is what actually triggers the re-render —
      // setPreferredProvider alone wouldn't.
      setPreferredProvider(provider);
      catalog.setActiveBackend(provider);
      if (isProviderLocked && provider !== lockedProvider) {
        createNewChat();
      }
    },
    [catalog, createNewChat, isProviderLocked, lockedProvider],
  );

  const displayedProvider =
    (lockedProvider as PreferredProvider | null) ?? catalog.activeProviderLabel;
  const modelControl = buildModelControl(catalog, displayedProvider, lockedModel);
  const handleSelectModel = useCallback(
    (model: string) => {
      if (!modelControl || !model.trim()) return;
      if (catalog.activeProviderLabel !== modelControl.provider) {
        setPreferredProvider(modelControl.provider);
        catalog.setActiveBackend(modelControl.provider);
      }
      modelControl.onChange(model);
      if (isModelLocked && model !== lockedModel) {
        createNewChat();
      }
    },
    [catalog, createNewChat, isModelLocked, lockedModel, modelControl],
  );

  // Wire the binding into the chat's tool-dispatch context. Prefer
  // the hook-owned `liveBinding` (long-lived WS) over the raw
  // `paramsBinding` so every `sandbox_*` tool call reuses this WS
  // instead of opening a transient one per call. Falls back to
  // params during the pre-open window (liveBinding is null until
  // the WS reaches `open` once) so the very first tool call still
  // works through the transient path rather than failing with
  // "not connected".
  useEffect(() => {
    setLocalDaemonBinding(liveBinding ?? paramsBinding);
    return () => {
      setLocalDaemonBinding(null);
    };
  }, [liveBinding, paramsBinding, setLocalDaemonBinding]);

  // Tag the workspace mode synchronously — `createNewChat` reads
  // this ref when it builds a Conversation, so future-sent turns
  // are persisted under a mode-scoped key.
  setWorkspaceMode(mode);

  useEffect(() => {
    setWorkspaceContext(workspaceContext);
    return () => {
      setWorkspaceContext(null);
    };
  }, [setWorkspaceContext, workspaceContext]);

  // Conversation scope: useChatAutoSwitch only auto-creates when an
  // activeRepoFullName is set, which daemon-backed sessions don't
  // have. On first mount we either switch to the most recent
  // mode-tagged chat, or create a fresh one. The reentrancy guard
  // keeps the effect idempotent across re-renders.
  const initializedConversationRef = useRef(false);
  useEffect(() => {
    if (!conversationsLoaded || initializedConversationRef.current) return;
    initializedConversationRef.current = true;
    const activeConv = conversations[activeChatId] as Conversation | undefined;
    if (activeConv?.mode === mode) return;
    const modeChats = Object.values(conversations)
      .filter((c) => c.mode === mode)
      .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    if (modeChats.length > 0) {
      switchChat(modeChats[0].id);
    } else {
      createNewChat();
    }
  }, [conversationsLoaded, conversations, activeChatId, switchChat, createNewChat, mode]);

  // Live countdown for the reconnect banner. When a retry is
  // scheduled (`nextAttemptAt` is set), tick the clock every 500ms
  // so the displayed "Reconnecting in Xs" updates. The interval is
  // cleared when no retry is scheduled.
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
    await onUnpair();
  };

  /**
   * Stop button handler. Beyond `abortStream()`, also cancel any
   * pending daemon-side approval prompts the parent round had
   * spawned — see `lib/daemon-cancel-pending-approvals.ts` for the
   * rationale (daemon's Coder agent stays paused waiting on the
   * approval if we don't, local prompt persists, a confused click
   * still executes the tool).
   */
  // Plain function — the React compiler memoizes referentially equal
  // bodies, and useCallback here trips
  // react-hooks/preserve-manual-memoization because the compiler
  // can't statically analyze the `approvals.headRef.current` access.
  // Stop is a low-frequency click; a per-render closure is fine.
  const handleAbort = () => {
    cancelPendingApprovals(approvals.headRef.current, request, approvals.popMatching);
    abortStream();
  };

  return (
    <div className="flex h-dvh flex-col bg-[linear-gradient(180deg,rgba(4,6,10,1)_0%,rgba(2,4,8,1)_100%)] safe-area-top safe-area-bottom">
      <header className="flex items-center justify-between gap-2 border-b border-push-edge/40 px-3 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={onLeave}
            aria-label={`Leave ${daemonLabel}`}
            title={`Leave ${daemonLabel}`}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-push-edge/60 text-push-fg-secondary transition hover:border-push-fg/60 hover:text-push-fg"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          </button>
          <div className="min-w-0 [&>*]:max-w-full">{modeChip}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {isStreaming ? (
            <button
              type="button"
              onClick={handleAbort}
              aria-label="Stop"
              title="Stop the in-flight turn"
              className="inline-flex items-center gap-1.5 rounded-full border border-rose-400/40 px-3 py-1.5 text-xs text-rose-200 transition hover:border-rose-400/60 hover:bg-rose-400/10"
            >
              <Square className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">Stop</span>
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setHubOpen(true)}
            aria-label="Open hub"
            title="Notes + pinned artifacts"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-push-edge/60 text-push-fg-secondary transition hover:border-push-fg/60 hover:text-push-fg"
          >
            <NotebookPadIcon className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={handleUnpair}
            aria-label="Unpair"
            className="inline-flex items-center gap-1.5 rounded-full border border-push-edge/60 px-3 py-1.5 text-xs text-push-fg-secondary transition hover:border-rose-400/40 hover:text-rose-200"
          >
            <UnpairIcon className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">Unpair</span>
          </button>
        </div>
      </header>

      {status.state !== 'open' && status.state !== 'connecting' ? (
        <ReconnectBanner
          daemonLabel={daemonLabel}
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
        pending={approvals.head}
        queuedBehind={approvals.queuedBehind}
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
        // Wire pin so chat messages get the pin action and the
        // result lands in the hub's Kept section.
        onPin={pinnedArtifacts.pin}
      />

      <div className="border-t border-push-edge/40 bg-[#000]/80 px-3 py-2 backdrop-blur safe-area-bottom">
        <div className="mb-2 grid grid-cols-[auto,minmax(0,1fr)] items-center gap-2">
          <DaemonModelPicker
            activeProvider={catalog.activeProviderLabel}
            availableProviders={catalog.availableProviders}
            onSelectProvider={handleSelectProvider}
            lockedProvider={lockedProvider}
            isProviderLocked={isProviderLocked}
            className="max-w-[46vw]"
          />
          {modelControl ? (
            <ModelPicker
              provider={modelControl.provider}
              value={modelControl.value}
              options={modelControl.options}
              onChange={handleSelectModel}
              allowCustom={modelControl.allowCustom}
              disabled={modelControl.loading}
              onRefresh={modelControl.onRefresh}
              isRefreshing={modelControl.loading}
              refreshAriaLabel={`Refresh ${modelControl.providerLabel} models`}
              ariaLabel="Select daemon model"
              searchPlaceholder={`Search ${modelControl.providerLabel} models...`}
              emptyLabel={modelControl.error ?? 'No models found.'}
              triggerLabel={
                <span className="truncate">
                  {modelControl.value
                    ? getModelDisplayLeafName(modelControl.provider, modelControl.value)
                    : 'Select model'}
                </span>
              }
              className="min-w-0"
              triggerClassName="h-7 rounded-full border-push-edge/60 bg-[#070a10] px-2.5 text-xs"
              popoverClassName="w-[min(20rem,calc(100vw-2rem))]"
            />
          ) : null}
        </div>
        <div className="flex items-end gap-2">
          <textarea
            value={composeText}
            onChange={(e) => setComposeText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              status.state === 'open'
                ? `Ask the ${daemonLabel}…`
                : status.state === 'connecting'
                  ? `Connecting to ${daemonLabel}…`
                  : `${capitalize(daemonLabel)} unreachable`
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

      <DaemonHubSheet
        open={hubOpen}
        onOpenChange={setHubOpen}
        daemonLabel={daemonLabel}
        scratchpadContent={scratchpad.content}
        scratchpadMemories={scratchpad.memories}
        activeMemoryId={scratchpad.activeMemoryId}
        onScratchpadContentChange={scratchpad.setContent}
        onScratchpadClear={scratchpad.clear}
        onScratchpadSaveMemory={scratchpad.saveMemory}
        onScratchpadLoadMemory={scratchpad.loadMemory}
        onScratchpadDeleteMemory={scratchpad.deleteMemory}
        pinnedArtifacts={pinnedArtifacts.artifacts}
        onUnpinArtifact={pinnedArtifacts.unpin}
        onUpdateArtifactLabel={pinnedArtifacts.updateLabel}
        todos={todo.todos}
        onTodoClear={todo.clear}
      />
    </div>
  );
}

function capitalize(s: string): string {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
}

interface ReconnectBannerProps {
  daemonLabel: string;
  status: 'unreachable' | 'closed';
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: number | null;
  exhausted: boolean;
  now: number;
  onRetry: () => void;
}

/**
 * Banner rendered when the long-lived daemon WS is in a non-open
 * state (`unreachable` from a pre-open failure, or `closed` post-
 * open). While the auto-reconnect ladder is running it shows the
 * live countdown and the attempt counter; once exhausted it
 * surfaces a manual Retry button the user can hit to re-arm the
 * schedule.
 */
function ReconnectBanner({
  daemonLabel,
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
        <span className="text-rose-200">
          {capitalize(daemonLabel)} unreachable after {attempts} attempts.
        </span>
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
    // Ceil so 0.4s rounds up to 1s in the UI — clamp at 1 so we
    // never flicker "Reconnecting in 0s" while the timer fires.
    const remainingMs = Math.max(0, nextAttemptAt - now);
    const seconds = Math.max(1, Math.ceil(remainingMs / 1000));
    // `attempts` already counts the retry currently pending
    // (1-based) — the hook increments it when the retry is
    // scheduled, not after it completes — so "attempt N of M" reads
    // directly without a `+1`. (#517 review off-by-one.)
    body = (
      <span className="text-amber-200/80">
        Reconnecting to {daemonLabel} in {seconds}s (attempt {attempts} of {maxAttempts})…
      </span>
    );
  } else if (status === 'unreachable' || status === 'closed') {
    // Adapter just transitioned to unreachable; the scheduling
    // effect hasn't populated `nextAttemptAt` for this render yet.
    body = <span className="text-amber-200/80">Reconnecting to {daemonLabel}…</span>;
  } else {
    body = (
      <span className="text-push-fg-secondary">{capitalize(daemonLabel)} connection closed.</span>
    );
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
