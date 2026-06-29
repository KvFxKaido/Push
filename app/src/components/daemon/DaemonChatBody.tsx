/**
 * DaemonChatBody — shared chat shell for daemon-backed sessions.
 *
 * Phase 2.i extracted this from `LocalPcChatScreen` / `RelayChatScreen`
 * when they were 95% identical clones. The current pass restructures the
 * shell so daemon sessions look like repo / chat mode: same header
 * layout (drawer left, center pill, hub button right), same background
 * glow capacity, same `RepoChatDrawer` (filtered to daemon-mode chats),
 * same `WorkspaceHubSheet` (trimmed to Notes — see
 * `WorkspaceHubSheet.tsx` for the tab gating). Daemon-only affordances —
 * mode chip, reconnect banner, approval prompt, stop, leave, unpair —
 * slot into the matching positions in that shell.
 *
 * What stays in the screen (not here), by design:
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
import { ArrowLeft, Palette, RefreshCw, Square } from 'lucide-react';
import { WorkspaceDockIcon } from '@/components/icons/push-custom-icons';
import type { LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';

import { ChatBackgroundGlow } from '@/components/chat/ChatBackgroundGlow';
import { ChatContainer } from '@/components/chat/ChatContainer';
import { ChatInput } from '@/components/chat/ChatInput';
import { RepoChatDrawer } from '@/components/chat/RepoChatDrawer';
import { WorkspaceHubSheet } from '@/components/chat/WorkspaceHubSheet';
import { HEADER_PILL_BUTTON_CLASS, HEADER_ROUND_BUTTON_CLASS } from '@/components/chat/hub-styles';
import { ApprovalPrompt } from '@/components/daemon/ApprovalPrompt';
import { cancelPendingApprovals } from '@/lib/daemon-cancel-pending-approvals';
import { getChatShellNav, resolveNavMode } from '@/lib/nav-transition';
import { RepoAppearanceSheet } from '@/components/repo/RepoAppearanceSheet';
import { useChat } from '@/hooks/useChat';
import type { DaemonHydratedMessage } from '@/hooks/useRelayDaemon';
import type { ReattachedRun } from '@/hooks/useDaemonRunState';
import { useDaemonAppearance } from '@/hooks/useDaemonAppearance';
import { useDaemonCliSessions } from '@/hooks/useDaemonCliSessions';
import { useDaemonSettingsBundles } from '@/hooks/useDaemonSettingsBundles';
import { useModelCatalog } from '@/hooks/useModelCatalog';
import { usePinnedArtifacts } from '@/hooks/usePinnedArtifacts';
import { useProtectMain } from '@/hooks/useProtectMain';
import { useScratchpad } from '@/hooks/useScratchpad';
import { useTodo } from '@/hooks/useTodo';
import { useWorkspaceChatComposerController } from '@/hooks/useWorkspaceChatComposerController';
import { useWorkspaceComposerState } from '@/hooks/useWorkspaceComposerState';
import { useWorkspacePreferences } from '@/hooks/useWorkspacePreferences';
import type { ApprovalQueueHandle } from '@/hooks/useApprovalQueue';
import type { ConnectionStatus, RequestOptions, SessionResponse } from '@/lib/local-daemon-binding';
import type { LiveDaemonBinding, ToolDispatchBinding } from '@/lib/local-daemon-sandbox-client';
import { getRepoAppearanceColorHex, type RepoAppearance } from '@/lib/repo-appearance';
import type {
  ChatMessage,
  Conversation,
  WorkspaceContext,
  WorkspaceMode,
  WorkspaceScreenAuthProps,
} from '@/types';

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

  /**
   * Session attach token for the bound daemon session, threaded into the
   * bearer-gated `cancel_run` fired on Stop (Addressable Session Verbs phase 2).
   * Present in relay mode (the pair-bundle `targetAttachToken`); `null` in
   * local-PC mode, which never attaches to a daemon session — its cancel
   * resolves to a benign SESSION_NOT_FOUND, so no token is needed.
   */
  sessionAttachToken?: string | null;

  /** GitHub auth, forwarded into the hub's Settings → Auth section so
   *  the user can manage their token without leaving the daemon. */
  auth: WorkspaceScreenAuthProps;
  /** Disconnect handler routed from app navigation. */
  onDisconnect: () => void;

  /**
   * Targeted-attach lifecycle from the relay hook (PR #687). `idle`
   * for local-PC mode and untargeted Remote bundles; relay screens
   * with `targetSessionId` thread through the actual state. Drives
   * the attach-failure banner.
   */
  attachStatus?: 'idle' | 'attaching' | 'attached' | 'attach_failed';
  attachError?: { code: string; message: string } | null;
  /**
   * Conversation history fetched from the daemon's `state.messages`
   * after `attach_session` succeeds. Null for local-PC mode and for
   * Remote bundles without a target. When present, prepended to the
   * chat transcript so the phone sees the TUI session's history.
   */
  hydratedMessages?: DaemonHydratedMessage[] | null;
  /**
   * A foreground run this client reattached to but did not start (from
   * `get_session_snapshot`, see `useDaemonRunState`). When set and the local
   * user isn't streaming, the header shows a "Running…" indicator + a Stop that
   * fires a session-scoped `cancel_run`. Null for local-PC mode / no live run.
   */
  reattachedRun?: ReattachedRun | null;
  /** Clear the reattached-run indicator (local takeover, Stop, or completion). */
  onClearReattachedRun?: () => void;
  /**
   * Live assistant message projected from a TUI-driven turn's broadcast tokens
   * (see useRemoteTurnProjection). Appended to the transcript as a streaming
   * tail so the user watches the remote turn stream. Null when no remote turn.
   */
  remoteTurnMessage?: ChatMessage | null;
}

const MODE_HEADER_LABEL: Record<DaemonChatBodyProps['mode'], string> = {
  'local-pc': 'Local PC',
  relay: 'Remote',
};

// Snapshot activity tracking is a cloud-sandbox concern (the snapshot
// manager debounces autosaves on user activity). Daemon sessions have
// no cloud sandbox, so the composer's `markSnapshotActivity` callback
// is a no-op. Declared at module scope so the function identity is
// stable and doesn't force composerController to re-memoize.
const NOOP_MARK_SNAPSHOT_ACTIVITY = () => {};

const APPEARANCE_SHEET_DESCRIPTION: Record<DaemonChatBodyProps['mode'], string> = {
  'local-pc': 'Pick a quiet accent color for local PC sessions on this device.',
  relay: 'Pick a quiet accent color for remote sessions on this device.',
};

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
  sessionAttachToken = null,
  auth,
  onDisconnect,
  attachStatus = 'idle',
  attachError = null,
  hydratedMessages = null,
  reattachedRun = null,
  onClearReattachedRun,
  remoteTurnMessage = null,
}: DaemonChatBodyProps) {
  // Provider/model picker plumbing — identical between the two
  // screens. The catalog hook owns reactive `activeBackend` state;
  // the picker reads it, the select handler writes both the durable
  // preference (via providers.ts) AND the catalog's reactive state
  // so `getActiveProvider()` returns the new value on the next read.
  const catalog = useModelCatalog();

  // Workspace preferences (profile drafts, approval/context/sandbox
  // modes, install ID input, show-tool-activity flag, allowlist
  // command). Mounting this hook here keeps the daemon screen
  // self-contained: WorkspaceSessionScreen mounts its own instance
  // for repo / scratch / chat modes, and only one of them is mounted
  // at a time (the routing in WorkspaceScreen branches on session
  // kind). Persistence rides through `safeStorage`, so updates made
  // in one mode are visible in the other on remount.
  const workspacePrefs = useWorkspacePreferences(auth.validatedUser?.login ?? null);

  // Protect-main config — global default only; daemon has no per-repo
  // override since there's no active repo. WorkspaceSessionScreen
  // mounts its own instance scoped to the active repo; for daemon we
  // omit the repo argument so only the global toggle is wired.
  const protectMain = useProtectMain();

  // Hub + drawer open state. The hub mirrors `WorkspaceHubSheet`'s
  // slide-in-from-right behavior; the drawer slides in from the left
  // via `RepoChatDrawer`. The chat shell's `chatShellTransform`
  // applies the matching opposite translate so the two surfaces feel
  // like one connected layout, same as `ChatSurfaceScreen`.
  //
  // The two are mutually exclusive — the `chatShellTransform` can only
  // express one side at a time, and overlapping sheets look wrong.
  // Mirrors `useWorkspaceChatPanelsController`'s exclusion in repo /
  // chat mode.
  const [hubOpen, setHubOpenState] = useState(false);
  const [drawerOpen, setDrawerOpenState] = useState(false);
  const [appearanceSheetOpen, setAppearanceSheetOpen] = useState(false);
  // Sticky flag: settings bundles are expensive to compute (the AI
  // bundle alone projects ~60 catalog fields). Defer construction
  // until the hub is opened at least once, then keep it built so
  // re-opens are instant. See `useDaemonSettingsBundles({ enabled })`.
  const [hubEverOpen, setHubEverOpen] = useState(false);
  const openHub = useCallback(() => {
    setDrawerOpenState(false);
    setHubOpenState(true);
    setHubEverOpen(true);
  }, []);
  const handleHubOpenChange = useCallback((open: boolean) => {
    if (open) {
      setDrawerOpenState(false);
      setHubEverOpen(true);
    }
    setHubOpenState(open);
  }, []);
  const handleDrawerOpenChange = useCallback((open: boolean) => {
    if (open) setHubOpenState(false);
    setDrawerOpenState(open);
  }, []);

  // Per-mode appearance — local-pc and relay each persist their own
  // palette so the user can keep the two visually distinct without
  // them bleeding into each other. Mirrors `useChatModeAppearance`.
  const {
    appearance: daemonAppearance,
    setAppearance: setDaemonAppearance,
    resetAppearance: resetDaemonAppearance,
  } = useDaemonAppearance(mode);
  const daemonAppearanceHex = getRepoAppearanceColorHex(daemonAppearance.color);

  const scratchpad = useScratchpad(null);
  const todo = useTodo(null);
  const pinnedArtifacts = usePinnedArtifacts(null);
  // CLI/TUI sessions the daemon already knows about, fetched once
  // per `connecting → open` transition. Surfaced in the drawer's
  // Local PC / Remote section so the user sees sessions started
  // outside this device. Read-only: tap-to-resume needs an
  // attach + replay pipeline that's intentionally out of scope here.
  const { sessions: cliSessions } = useDaemonCliSessions(request, status);
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
          // Bearer required since submit_approval is now session-gated (matches
          // cancel_run). Relay mode threads the pair-bundle token; local-PC mode
          // never attached, so it has no token and the gate's post-existence
          // placement lets its decision resolve normally on a session it owns.
          ...(typeof sessionAttachToken === 'string' && sessionAttachToken.length > 0
            ? { attachToken: sessionAttachToken }
            : {}),
        },
      }).catch(() => {
        // Errors surface in the daemon's audit log; the user has
        // already moved on UX-wise. A future polish PR could show a
        // "decision failed to register" toast.
      });
      approvals.popMatching(head.approvalId);
    },
    [request, approvals, sessionAttachToken],
  );

  const {
    messages,
    sendMessage,
    agentStatus,
    agentEvents,
    runEvents,
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
    deleteChat,
    deleteAllChats,
    renameChat,
    setChatLinkedLibraries,
    editMessageAndResend,
    regenerateLastResponse,
    contextUsage,
    queuedFollowUpCount,
    pendingSteerCount,
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
    // runtimeHandlers / branchInfo are cloud-sandbox concerns; daemon
    // sessions don't drive them.
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

  // Hydrated transcript projection (PR #687, Shape A). When the relay
  // hook reports `hydratedMessages` from `get_session_messages`, we
  // prepend them to the visible transcript so the phone surfaces the
  // TUI session's history. The hydrated entries get monotonically
  // increasing timestamps starting at 0 so ChatContainer renders
  // them in source order — the absolute timestamp doesn't matter,
  // only relative ordering does, and using `Date.now()` here trips
  // the `react-hooks/purity` rule (useMemo must be pure). Hydration
  // is one-shot and non-persistent: a subsequent web-side message
  // goes through useChat's normal path and lives in IndexedDB; the
  // hydrated history re-fetches from the daemon on the next relay
  // attach. Known limitation: tool-call / tool-result bubbles aren't
  // carried over (the daemon's state.messages exposes role+content
  // only), and reasoning blocks are dropped. Both land in a follow-up
  // if the bare transcript proves insufficient.
  // Transcript = hydrated history (prepended) + the web's own messages + a live
  // remote-turn message (appended as a streaming tail) when the TUI is driving.
  const displayMessages = useMemo<ChatMessage[]>(() => {
    const prefix: ChatMessage[] = hydratedMessages?.length
      ? hydratedMessages.map((m, i) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          timestamp: i,
          status: 'done' as const,
        }))
      : [];
    // Hide the remote turn the moment the local user starts their own (their
    // turn appends to `messages`, which must order after the remote one). The
    // just-watched turn is in the daemon's history and returns via
    // `hydratedMessages` on the next attach.
    const tail: ChatMessage[] = remoteTurnMessage && !isStreaming ? [remoteTurnMessage] : [];
    if (prefix.length === 0 && tail.length === 0) return messages;
    return [...prefix, ...messages, ...tail];
  }, [hydratedMessages, messages, remoteTurnMessage, isStreaming]);

  // Composer state — owns the per-chat provider/model drafts that
  // ChatInput's picker reads. `sendMessageWithChatDraft` wraps
  // `sendMessage` so the model + provider that the picker shows is
  // what actually routes the turn. WorkspaceSessionScreen mounts the
  // same hook for repo / scratch / chat modes; daemon mounts it here
  // so ChatInput has the same draft semantics.
  const composerState = useWorkspaceComposerState({
    catalog,
    conversations,
    activeChatId,
    isProviderLocked,
    isModelLocked,
    createNewChat,
    switchChat,
    sendMessage,
  });

  // Composer controller — projects composerState + useChat surfaces
  // into the ~60-field `providerControls` bundle ChatInput needs.
  // Mirrors what WorkspaceChatRoute / ChatSurfaceRoute do; the only
  // daemon-specific bit is `markSnapshotActivity`, which is a cloud-
  // sandbox concern and stays a no-op here.
  const composerController = useWorkspaceChatComposerController({
    messages,
    sendMessage: composerState.sendMessageWithChatDraft,
    editMessageAndResend,
    regenerateLastResponse,
    handleCardAction,
    catalog,
    selectedChatProvider: composerState.selectedChatProvider,
    selectedChatModels: composerState.selectedChatModels,
    handleSelectBackend: composerState.handleSelectBackend,
    handleSelectOllamaModelFromChat: composerState.handleSelectOllamaModelFromChat,
    handleSelectOpenRouterModelFromChat: composerState.handleSelectOpenRouterModelFromChat,
    handleSelectCloudflareModelFromChat: composerState.handleSelectCloudflareModelFromChat,
    handleSelectZenModelFromChat: composerState.handleSelectZenModelFromChat,
    handleSelectNvidiaModelFromChat: composerState.handleSelectNvidiaModelFromChat,
    handleSelectKilocodeModelFromChat: composerState.handleSelectKilocodeModelFromChat,
    handleSelectFireworksModelFromChat: composerState.handleSelectFireworksModelFromChat,
    handleSelectSakanaModelFromChat: composerState.handleSelectSakanaModelFromChat,
    handleSelectDeepSeekModelFromChat: composerState.handleSelectDeepSeekModelFromChat,
    handleSelectAzureModelFromChat: composerState.handleSelectAzureModelFromChat,
    handleSelectBedrockModelFromChat: composerState.handleSelectBedrockModelFromChat,
    handleSelectVertexModelFromChat: composerState.handleSelectVertexModelFromChat,
    handleSelectAnthropicModelFromChat: composerState.handleSelectAnthropicModelFromChat,
    handleSelectOpenAIModelFromChat: composerState.handleSelectOpenAIModelFromChat,
    handleSelectGoogleModelFromChat: composerState.handleSelectGoogleModelFromChat,
    isProviderLocked,
    lockedProvider,
    lockedModel,
    isModelLocked,
    markSnapshotActivity: NOOP_MARK_SNAPSHOT_ACTIVITY,
  });

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

  // Conversation scope: daemon-backed sessions do not have an active repo
  // name. On first mount we either switch to the most recent mode-tagged chat,
  // or create a fresh one. The reentrancy guard keeps the effect idempotent
  // across re-renders.
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

  // Settings prop bundles for WorkspaceHubSheet's Settings tab. With
  // these wired, the daemon hub's tab filter (see
  // `WorkspaceHubSheet.tsx` `hasSettingsBundles`) flips Settings on
  // and the user can manage auth / profile / AI / workspace / data
  // from inside a daemon session without unpairing.
  const { settingsAuth, settingsProfile, settingsAI, settingsWorkspace, settingsData } =
    useDaemonSettingsBundles({
      auth,
      onDisconnect,
      prefs: workspacePrefs,
      catalog,
      protectMain,
      isProviderLocked,
      lockedProvider,
      isModelLocked,
      lockedModel,
      deleteAllChats,
      enabled: hubEverOpen,
    });

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
    cancelPendingApprovals(
      approvals.headRef.current,
      request,
      approvals.popMatching,
      sessionAttachToken,
    );
    abortStream();
  };

  // The reattached run is the daemon's own — once the local user starts a turn
  // (`isStreaming`), their Stop supersedes it, so drop the indicator.
  useEffect(() => {
    if (isStreaming) onClearReattachedRun?.();
  }, [isStreaming, onClearReattachedRun]);

  // Stop a run we reattached to but didn't start: there's no local stream to
  // abort, so fire a session-scoped `cancel_run` directly (same shape as the
  // pending-approval cancel). Clear optimistically; a `run_complete` would clear
  // it anyway. Low-frequency click, so a per-render closure is fine.
  const handleStopReattachedRun = () => {
    if (!reattachedRun) return;
    void request({
      type: 'cancel_run',
      sessionId: reattachedRun.sessionId,
      payload: {
        sessionId: reattachedRun.sessionId,
        ...(typeof sessionAttachToken === 'string' && sessionAttachToken.length > 0
          ? { attachToken: sessionAttachToken }
          : {}),
      },
    }).catch(() => {
      // Surfaces in the daemon audit log; the indicator is cleared regardless.
    });
    onClearReattachedRun?.();
  };

  // Show the busy indicator + remote Stop only when the daemon is mid-run and the
  // local user hasn't taken over with their own turn.
  const showReattachedRun = Boolean(reattachedRun) && !isStreaming;

  // Chat-shell navigation, shared with ChatSurfaceScreen / WorkspaceChatRoute
  // via lib/nav-transition. `pager` (default) cross-fades the chat out as a page
  // swap; `push` keeps the legacy parallax. See that module to revert.
  const chatShellNav = getChatShellNav(resolveNavMode(), { drawerOpen, hubOpen });
  const chatShellTransform = chatShellNav.transform;
  const chatShellShadow = chatShellNav.shadowClass;

  // Pre-filter conversations to the active daemon mode before passing
  // them to the drawer. The daemon screen stays mounted with the same
  // transport binding regardless of which chat the user taps, so
  // cross-mode picks (e.g. tapping a Remote transcript inside a Local
  // PC session) would route the next send through the wrong daemon
  // while displaying the picked transcript. Filtering at the source
  // means the drawer only shows chats this daemon can faithfully
  // resume.
  const daemonScopedConversations = useMemo(() => {
    const filtered: Record<string, Conversation> = {};
    for (const [id, conv] of Object.entries(conversations)) {
      if (conv.mode === mode) filtered[id] = conv as Conversation;
    }
    return filtered;
  }, [conversations, mode]);

  const drawerProps = useMemo<React.ComponentProps<typeof RepoChatDrawer>>(
    () => ({
      open: drawerOpen,
      onOpenChange: handleDrawerOpenChange,
      // Daemon sessions don't enumerate GitHub repos. Passing an empty
      // list collapses the repo accordion section; daemon-mode chats
      // surface in the "Local PC" / "Remote" sections (see
      // RepoChatDrawer's filtered* memos).
      repos: [],
      activeRepo: null,
      conversations: daemonScopedConversations,
      activeChatId,
      // The drawer normally keys repo appearance by repoFullName.
      // Daemon mode has no repo, so any key is irrelevant — both
      // setters route into the per-mode daemon appearance state so the
      // drawer's Customize affordance ends up at the same destination
      // as the header Palette button. Without this, a user customizing
      // a repo row from inside a daemon session would silently drop.
      resolveRepoAppearance: () => daemonAppearance,
      setRepoAppearance: (_: string, next: RepoAppearance) => setDaemonAppearance(next),
      clearRepoAppearance: () => resetDaemonAppearance(),
      onResumeChat: (id: string) => {
        switchChat(id);
      },
      onNewChat: () => {
        createNewChat();
      },
      onDeleteChat: (id: string) => {
        deleteChat(id);
      },
      onRenameChat: (id: string, title: string) => {
        renameChat(id, title);
      },
      cliSessions,
      cliSessionsLabel: mode,
    }),
    [
      drawerOpen,
      handleDrawerOpenChange,
      daemonScopedConversations,
      activeChatId,
      switchChat,
      createNewChat,
      deleteChat,
      renameChat,
      daemonAppearance,
      setDaemonAppearance,
      resetDaemonAppearance,
      cliSessions,
      mode,
    ],
  );

  const headerLabel = MODE_HEADER_LABEL[mode];
  const composePlaceholder =
    status.state === 'open'
      ? `Ask the ${daemonLabel}…`
      : status.state === 'connecting'
        ? `Connecting to ${daemonLabel}…`
        : `${capitalize(daemonLabel)} unreachable`;

  return (
    <>
      <div className="relative flex h-dvh flex-col overflow-hidden bg-push-surface-inset safe-area-top safe-area-bottom">
        <div
          className={`relative z-10 isolate flex min-h-0 flex-1 flex-col bg-push-surface-inset transition-[transform,box-shadow] duration-500 ease-in-out will-change-transform ${chatShellShadow}`}
          style={{ transform: chatShellTransform, ...chatShellNav.style }}
        >
          <ChatBackgroundGlow
            active={daemonAppearance.glowEnabled}
            color={daemonAppearanceHex}
            variant={daemonAppearance.glowStyle}
          />
          <header className="relative z-10 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 px-3 pt-3 pb-2">
            <div className="relative z-20 flex min-w-0 items-center gap-2">
              <div className="flex h-[34px] min-w-0 items-center gap-1 pl-0.5 pr-1">
                <RepoChatDrawer {...drawerProps} />
                <div className="-ml-2.5 flex min-w-0 items-center self-stretch">
                  {/* Brand label, always visible — matches repo/chat mode's
                      "Push" / repo name. The mode (Remote / Local PC) and its
                      connection status live in the center session pill, so we
                      don't repeat it here. */}
                  <p className="truncate text-sm font-medium leading-tight text-push-fg">Push</p>
                </div>
              </div>
            </div>

            <div className="flex min-w-0 justify-center">
              <div className={`${HEADER_PILL_BUTTON_CLASS} cursor-default min-w-0 max-w-full`}>
                <div className="relative z-10 min-w-0 [&>*]:max-w-full">{modeChip}</div>
              </div>
            </div>

            <div className="relative z-20 flex min-w-0 items-center justify-end gap-2">
              {showReattachedRun && (
                <span
                  className="inline-flex items-center gap-1.5 text-push-2xs text-push-fg-dim"
                  title={`This session is mid-run on ${daemonLabel}`}
                >
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
                  Running…
                </span>
              )}
              {(isStreaming || showReattachedRun) && (
                <button
                  type="button"
                  onClick={isStreaming ? handleAbort : handleStopReattachedRun}
                  aria-label="Stop"
                  title={isStreaming ? 'Stop the in-flight turn' : `Stop the run on ${daemonLabel}`}
                  className={`${HEADER_ROUND_BUTTON_CLASS} text-rose-300 hover:text-rose-200`}
                >
                  <Square className="relative z-10 h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
              <button
                type="button"
                onClick={onLeave}
                aria-label={`Leave ${daemonLabel}`}
                title={`Leave ${daemonLabel}`}
                className={HEADER_ROUND_BUTTON_CLASS}
              >
                <ArrowLeft className="relative z-10 h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setAppearanceSheetOpen(true)}
                aria-label={`Customize ${headerLabel} appearance`}
                title={`Customize ${headerLabel}`}
                className={HEADER_ROUND_BUTTON_CLASS}
              >
                <Palette className="relative z-10 h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={openHub}
                aria-label="Open hub"
                title="Notes + pinned artifacts"
                className={HEADER_ROUND_BUTTON_CLASS}
              >
                <WorkspaceDockIcon className="relative z-10 h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={handleUnpair}
                aria-label="Unpair"
                title="Unpair this daemon"
                className={`${HEADER_ROUND_BUTTON_CLASS} hover:text-rose-200`}
              >
                <UnpairIcon className="relative z-10 h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
            <div className="pointer-events-none absolute inset-x-0 top-full h-8 bg-gradient-to-b from-black to-transparent" />
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

          {attachStatus === 'attach_failed' && attachError ? (
            <div className="border-b border-rose-400/30 bg-rose-950/30 px-4 py-3 text-sm">
              <p className="font-medium text-rose-200">
                Couldn't attach to the TUI session ({attachError.code})
              </p>
              <p className="mt-1 break-words text-rose-200/80">{attachError.message}</p>
              <p className="mt-1 text-xs text-rose-200/60">
                You can keep using this as a fresh Remote chat. Re-pair from the TUI to retry.
              </p>
            </div>
          ) : null}

          <ApprovalPrompt
            pending={approvals.head}
            queuedBehind={approvals.queuedBehind}
            onDecide={decideApproval}
          />

          <ChatContainer
            messages={displayMessages}
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
            // Wire the composer controller's edit + regenerate
            // handlers so daemon sessions get the same message-bubble
            // affordances as repo / chat mode. Gated on !isStreaming
            // because the controller writes into composer state, and
            // editing mid-stream would race the in-flight turn. Repo /
            // chat routes share this gating pattern.
            onEditUserMessage={!isStreaming ? composerController.handleEditUserMessage : undefined}
            onRegenerateLastResponse={
              !isStreaming ? composerController.handleRegenerateLastResponse : undefined
            }
          />

          <ChatInput
            onSend={composerController.handleComposerSend}
            // Route Stop through `handleAbort` so the daemon-side
            // pending approval prompts get cancelled too — calling
            // `abortStream` alone leaves the approval queued and a
            // later Approve click would still submit it.
            onStop={handleAbort}
            isStreaming={isStreaming}
            // Hard-disable the composer while the daemon binding isn't
            // open. ChatInput clears the textarea unconditionally after
            // calling onSend, so a wrapper that just `return`-ed when
            // status was off would silently drop the user's draft on
            // the click. The `disabled` prop blocks `canSend` entirely
            // so the draft survives until the daemon reconnects.
            // Also disabled while a TUI-driven turn is mid-run: the daemon
            // rejects a concurrent run with RUN_IN_PROGRESS, so block the send
            // (the "Running…" header explains why) and keep the draft.
            disabled={status.state !== 'open' || showReattachedRun}
            queuedFollowUpCount={queuedFollowUpCount}
            pendingSteerCount={pendingSteerCount}
            placeholder={composePlaceholder}
            contextUsage={contextUsage}
            // Library is a chat-mode affordance backed by client-side
            // attachments storage; daemon sessions inherit that
            // ergonomics since they have no repo to act as the
            // persistence layer.
            libraryEnabled={true}
            linkedLibraryIds={
              (activeChatId && conversations[activeChatId]?.linkedLibraryIds) || undefined
            }
            onSetLinkedLibraries={
              activeChatId ? (ids) => setChatLinkedLibraries(activeChatId, ids) : undefined
            }
            draftKey={activeChatId}
            prefillRequest={composerController.composerPrefillRequest}
            editState={composerController.editState}
            providerControls={composerController.providerControls}
          />
        </div>
      </div>

      <WorkspaceHubSheet
        open={hubOpen}
        onOpenChange={handleHubOpenChange}
        messages={messages}
        agentEvents={agentEvents}
        runEvents={runEvents}
        sandboxId={null}
        sandboxStatus="idle"
        sandboxError={null}
        ensureSandbox={async () => null}
        onStartSandbox={() => {}}
        onRetrySandbox={() => {}}
        onNewSandbox={() => {}}
        reviewProviders={catalog.availableProviders}
        reviewActiveProvider={catalog.activeProviderLabel}
        lockedProvider={lockedProvider}
        lockedModel={lockedModel}
        workspaceMode={mode}
        capabilities={{
          canManageBranches: false,
          canBrowsePullRequests: false,
          canCommitAndPush: false,
        }}
        scratchActions={null}
        repoName={daemonLabel}
        projectInstructions={null}
        protectMainEnabled={protectMain.isProtected}
        showToolActivity={workspacePrefs.showToolActivity}
        settingsAuth={settingsAuth}
        settingsProfile={settingsProfile}
        settingsAI={settingsAI}
        settingsWorkspace={settingsWorkspace}
        settingsData={settingsData}
        scratchpadContent={scratchpad.content}
        scratchpadMemories={scratchpad.memories}
        activeMemoryId={scratchpad.activeMemoryId}
        onScratchpadContentChange={scratchpad.setContent}
        onScratchpadClear={scratchpad.clear}
        onScratchpadSaveMemory={scratchpad.saveMemory}
        onScratchpadLoadMemory={scratchpad.loadMemory}
        onScratchpadDeleteMemory={scratchpad.deleteMemory}
        todos={todo.todos}
        onTodoClear={todo.clear}
        branchProps={{
          currentBranch: undefined,
          defaultBranch: undefined,
          availableBranches: [],
          branchesLoading: false,
          branchesError: null,
          onSwitchBranch: () => {},
          onRefreshBranches: () => {},
          onShowBranchCreate: () => {},
          onShowBranchFork: () => {},
          onShowMergeFlow: () => {},
          onDeleteBranch: async () => false,
        }}
        onFixReviewFinding={() => {}}
        pinnedArtifacts={pinnedArtifacts.artifacts}
        onUnpinArtifact={pinnedArtifacts.unpin}
        onUpdateArtifactLabel={pinnedArtifacts.updateLabel}
      />

      {appearanceSheetOpen && (
        <RepoAppearanceSheet
          open={appearanceSheetOpen}
          onOpenChange={setAppearanceSheetOpen}
          repoName={headerLabel}
          appearance={daemonAppearance}
          onSave={setDaemonAppearance}
          onReset={resetDaemonAppearance}
          description={APPEARANCE_SHEET_DESCRIPTION[mode]}
        />
      )}
    </>
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
      className="flex items-center justify-between gap-3 border-b border-push-edge/40 bg-push-surface-raised/40 px-4 py-2 text-xs"
    >
      {body}
    </div>
  );
}
