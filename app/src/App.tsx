import { useState, useEffect, useCallback, useMemo, useRef, Suspense } from 'react';
import { useAuthSession } from '@/hooks/useAuthSession';
import { useRepos } from '@/hooks/useRepos';
import { useActiveRepo } from '@/hooks/useActiveRepo';
import { useRepoAppearance } from '@/hooks/useRepoAppearance';
import { useModelCatalog } from '@/hooks/useModelCatalog';
import { replaceAllConversations, migrateConversationsToIndexedDB } from '@/lib/conversation-store';
import { toConversationIndex } from '@/lib/conversation-index';
import { safeStorageGet, safeStorageRemove, safeStorageSet } from '@/lib/safe-storage';
import { lazyWithRecovery, toDefaultExport } from '@/lib/lazy-import';
import { perfMark, perfMeasure } from '@/lib/perf-marks';
import { isRelayModeEnabled } from '@/lib/relay-binding';
import { getPairedRemote, setPairedRemote } from '@/lib/relay-storage';
import { initAndroidShell } from '@/lib/android/native-shell';
import { bindAndroidBackHandler } from '@/lib/android/back-handler';
import type {
  ActiveRepo,
  AppShellScreen,
  ConversationIndex,
  DraftComposerSeed,
  PendingNewChat,
  RelayBinding,
  RepoWithActivity,
  WorkspaceSession,
} from '@/types';
import type { ComposerDraftCommit } from '@/sections/ComposerDraftScreen';
import './App.css';
import {
  createIndexedDbStore,
  setDefaultMemoryStore,
  getDefaultMemoryStore,
} from '@/lib/context-memory-store';
import { createPolicyEnforcedStore } from '@push/lib/context-memory-policy-store';
import { setDefaultEmbeddingProvider } from '@push/lib/embedding-provider';
import { createWebEmbeddingProvider } from '@/lib/embedding-provider-web';
import { createIndexedDbVerbatimLog, setDefaultVerbatimLog } from '@/lib/verbatim-log';

setDefaultMemoryStore(createPolicyEnforcedStore(createIndexedDbStore()));
// Verbatim log — durable IndexedDB backing for typed memory's `verbatimRef`
// (LCM #1234), so `memory_expand` resolves full text across reloads, not just
// within a session. Without this the log defaulted to in-memory and expansion
// dead-ended after a reload. Mirrors the typed store above.
setDefaultVerbatimLog(createIndexedDbVerbatimLog());
// Semantic memory retrieval — records embed via /api/memory/embed and the
// scorer blends cosine similarity. Falls back to lexical if the endpoint errors.
setDefaultEmbeddingProvider(createWebEmbeddingProvider());

const WORKSPACE_SESSION_STORAGE_KEY = 'workspace_session';

function isStoredRepo(value: unknown): value is ActiveRepo {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'number' &&
    typeof candidate.name === 'string' &&
    typeof candidate.full_name === 'string' &&
    typeof candidate.owner === 'string' &&
    typeof candidate.default_branch === 'string' &&
    typeof candidate.current_branch === 'string' &&
    typeof candidate.private === 'boolean'
  );
}

function normalizeWorkspaceSession(
  value: unknown,
  activeRepo: ActiveRepo | null,
): WorkspaceSession | null {
  if (!value || typeof value !== 'object')
    return activeRepo
      ? { id: crypto.randomUUID(), kind: 'repo', repo: activeRepo, sandboxId: null }
      : null;

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== 'string' || typeof candidate.kind !== 'string') {
    return activeRepo
      ? { id: crypto.randomUUID(), kind: 'repo', repo: activeRepo, sandboxId: null }
      : null;
  }

  if (candidate.kind === 'chat') {
    return { id: candidate.id, kind: 'chat', sandboxId: null };
  }

  if (candidate.kind === 'scratch') {
    return {
      id: candidate.id,
      kind: 'scratch',
      sandboxId: typeof candidate.sandboxId === 'string' ? candidate.sandboxId : null,
    };
  }

  if (candidate.kind === 'repo') {
    const repo = activeRepo ?? (isStoredRepo(candidate.repo) ? candidate.repo : null);
    if (!repo) return null;
    return {
      id: candidate.id,
      kind: 'repo',
      repo,
      sandboxId: typeof candidate.sandboxId === 'string' ? candidate.sandboxId : null,
    };
  }

  if (candidate.kind === 'relay') {
    // The relay attach-token bearer must not survive localStorage; forcing
    // a re-click of the Remote tile re-hydrates from IndexedDB through the
    // dedicated store, with no second persistence path to keep in sync.
    return null;
  }

  return activeRepo
    ? { id: crypto.randomUUID(), kind: 'repo', repo: activeRepo, sandboxId: null }
    : null;
}

function loadWorkspaceSession(activeRepo: ActiveRepo | null): WorkspaceSession | null {
  const raw = safeStorageGet(WORKSPACE_SESSION_STORAGE_KEY);
  if (!raw) {
    return activeRepo
      ? { id: crypto.randomUUID(), kind: 'repo', repo: activeRepo, sandboxId: null }
      : null;
  }

  try {
    return normalizeWorkspaceSession(JSON.parse(raw), activeRepo);
  } catch {
    return activeRepo
      ? { id: crypto.randomUUID(), kind: 'repo', repo: activeRepo, sandboxId: null }
      : null;
  }
}

const OnboardingScreen = lazyWithRecovery(
  toDefaultExport(
    () => import('@/sections/OnboardingScreen'),
    (module) => module.OnboardingScreen,
  ),
);
const HomeScreen = lazyWithRecovery(
  toDefaultExport(
    () => import('@/sections/HomeScreen'),
    (module) => module.HomeScreen,
  ),
);
const WorkspaceScreen = lazyWithRecovery(
  toDefaultExport(
    () => import('@/sections/WorkspaceScreen'),
    (module) => module.WorkspaceScreen,
  ),
);
const RelayPairing = lazyWithRecovery(
  toDefaultExport(
    () => import('@/sections/RelayPairing'),
    (module) => module.RelayPairing,
  ),
);
const ComposerDraftScreen = lazyWithRecovery(
  toDefaultExport(
    () => import('@/sections/ComposerDraftScreen'),
    (module) => module.ComposerDraftScreen,
  ),
);

function App() {
  const { activeRepo, setActiveRepo, clearActiveRepo, setCurrentBranch } = useActiveRepo();
  const [workspaceSession, setWorkspaceSession] = useState<WorkspaceSession | null>(() =>
    loadWorkspaceSession(activeRepo),
  );
  const [conversationIndex, setConversationIndex] = useState<ConversationIndex>({});
  const [pendingResumeChatId, setPendingResumeChatId] = useState<string | null>(null);
  // The paired_remotes IDB lookup is async; bumping `relayGenRef` on every
  // flow-changing handler keeps a slow resolver from teleporting the user into
  // a relay session after they've moved on.
  const [relayPairingActive, setRelayPairingActive] = useState(false);
  const relayGenRef = useRef(0);

  // Pre-flight context menu overlay. `draftComposerOpen` controls
  // visibility; `draftSeed` lets callers prefill the target
  // repo/branch/mode/model so the user only changes what they need to.
  // Commits go through `handleCommitDraft`, which materializes (or
  // reuses) a WorkspaceSession — message entry happens later in the
  // workspace's own ChatInput.
  const [draftComposerOpen, setDraftComposerOpen] = useState(false);
  const [draftSeed, setDraftSeed] = useState<DraftComposerSeed | null>(null);
  // Signal to the workspace that it should mint a fresh chat — and,
  // when the menu picked a provider/model override, anchor that fresh
  // chat to those without moving the workspace-wide default. Required
  // for the same-context "+ New chat" path (drawer → menu → confirm
  // when target context matches current workspace): the workspace
  // isn't remounted so the chat-management auto-create effect never
  // fires. WorkspaceSessionScreen drains this by calling
  // `createNewChat()` (when the active chat has messages) and then
  // `upsertChatDraft` to apply the override.
  const [pendingNewChat, setPendingNewChat] = useState<PendingNewChat | null>(null);

  const { resolveRepoAppearance, setRepoAppearance, clearRepoAppearance } = useRepoAppearance();
  // Catalog is lifted to App so both the pre-flight composer and the
  // in-workspace ChatInput consume the same instance. Previously hooked
  // inside WorkspaceSessionScreen; mounting it twice would duplicate
  // every model-list fetch and split the configured-provider truth.
  const catalog = useModelCatalog();

  useEffect(() => {
    perfMark('app:first-render');
    perfMeasure('app:boot', 'app:first-render');
  }, []);

  // Native (Android) shell affordances — status bar + keyboard setup and the
  // hardware/gesture Back binding. All native-gated and best-effort; inert on web.
  useEffect(() => {
    void initAndroidShell();
    void bindAndroidBackHandler();
  }, []);

  useEffect(() => {
    void Promise.resolve(getDefaultMemoryStore().pruneExpired()).catch((e: unknown) => {
      // Fail-open: log cleanup errors without crashing app boot
      console.warn('Memory pruning failed on boot:', e);
    });
  }, []);

  useEffect(() => {
    perfMark('conversations:migrate-start');
    let cancelled = false;
    migrateConversationsToIndexedDB()
      .then((conversations) => {
        if (cancelled) return;
        setConversationIndex(toConversationIndex(conversations));
        perfMark('conversations:migrate-end');
        perfMeasure('conversations:migrate-start', 'conversations:migrate-end');
      })
      .catch(() => {
        // Best effort bootstrap for HomeScreen history.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const auth = useAuthSession();
  const {
    token: authToken,
    tokenKind,
    validatedUser,
    isAppAuth,
    loading: authLoading,
    error: authError,
    patToken,
    installationId,
    appLoading,
    appError,
    connectPat,
    connectApp,
    installApp,
    setInstallationIdManually,
    disconnect: disconnectAuth,
  } = auth;
  const { repos, loading: reposLoading, error: reposError, sync: syncRepos } = useRepos();

  const handleConnect = useCallback(
    async (pat: string): Promise<boolean> => {
      const success = await connectPat(pat);
      if (success) syncRepos();
      return success;
    },
    [connectPat, syncRepos],
  );

  const handleStartScratchWorkspace = useCallback(() => {
    setPendingResumeChatId(null);
    clearActiveRepo();
    setWorkspaceSession({ id: crypto.randomUUID(), kind: 'scratch', sandboxId: null });
  }, [clearActiveRepo]);

  const handleStartChatMode = useCallback(() => {
    setPendingResumeChatId(null);
    clearActiveRepo();
    setWorkspaceSession({ id: crypto.randomUUID(), kind: 'chat', sandboxId: null });
  }, [clearActiveRepo]);

  const handleStartRelay = useCallback(async () => {
    const myGen = ++relayGenRef.current;
    setPendingResumeChatId(null);
    clearActiveRepo();
    setWorkspaceSession(null);

    const record = await getPairedRemote();
    if (relayGenRef.current !== myGen) return;

    if (record) {
      setRelayPairingActive(false);
      setWorkspaceSession({
        id: crypto.randomUUID(),
        kind: 'relay',
        binding: {
          deploymentUrl: record.deploymentUrl,
          sessionId: record.sessionId,
          token: record.token,
          attachTokenId: record.attachTokenId,
          deviceTokenId: record.deviceTokenId,
          targetSessionId: record.targetSessionId,
          targetAttachToken: record.targetAttachToken,
        },
        sandboxId: null,
      });
    } else {
      setRelayPairingActive(true);
    }
  }, [clearActiveRepo]);

  // Tap-to-resume: enter the Remote surface attached to a specific
  // daemon session. Same shape as handleStartRelay, but the target
  // comes from the tapped Connected row (bearer freshly granted via
  // `grant_session_attach`) instead of the pair bundle. The stored
  // record is updated so the next plain "Remote" entry resumes the
  // same session — "last attached" is the sticky target.
  const handleResumeRelaySession = useCallback(
    async (targetSessionId: string, targetAttachToken: string) => {
      const myGen = ++relayGenRef.current;
      setPendingResumeChatId(null);
      clearActiveRepo();

      const record = await getPairedRemote();
      if (relayGenRef.current !== myGen) return;
      if (!record) {
        // Pairing vanished between the grant and the tap landing
        // (unpair in another tab) — fall back to the pairing screen.
        setWorkspaceSession(null);
        setRelayPairingActive(true);
        return;
      }

      // Best-effort: a failed write means the sticky-target contract
      // (next plain Remote entry resumes this session) silently reverts
      // to the old target — log it so ops can see the branch, but don't
      // block the resume, which only needs the in-memory binding.
      setPairedRemote({ ...record, targetSessionId, targetAttachToken }).catch((err: unknown) => {
        console.log(
          JSON.stringify({
            level: 'warn',
            event: 'relay_resume_sticky_target_persist_failed',
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      });
      setRelayPairingActive(false);
      setWorkspaceSession({
        id: crypto.randomUUID(),
        kind: 'relay',
        binding: {
          deploymentUrl: record.deploymentUrl,
          sessionId: record.sessionId,
          token: record.token,
          attachTokenId: record.attachTokenId,
          deviceTokenId: record.deviceTokenId,
          targetSessionId,
          targetAttachToken,
        },
        sandboxId: null,
      });
    },
    [clearActiveRepo],
  );

  const handleRelayPaired = useCallback((binding: RelayBinding) => {
    relayGenRef.current += 1;
    setRelayPairingActive(false);
    setWorkspaceSession({
      id: crypto.randomUUID(),
      kind: 'relay',
      binding,
      sandboxId: null,
    });
  }, []);

  const handleRelayPairingCancel = useCallback(() => {
    relayGenRef.current += 1;
    setRelayPairingActive(false);
    setWorkspaceSession(null);
  }, []);

  const handleEndWorkspace = useCallback(() => {
    relayGenRef.current += 1;
    setPendingResumeChatId(null);
    setWorkspaceSession(null);
    setRelayPairingActive(false);
  }, []);

  const handleSelectRepo = useCallback(
    (repo: RepoWithActivity, branch?: string) => {
      const repoData = {
        id: repo.id,
        name: repo.name,
        full_name: repo.full_name,
        owner: repo.owner,
        default_branch: repo.default_branch,
        current_branch: branch || repo.default_branch,
        private: repo.private,
      };
      setPendingResumeChatId(null);
      setActiveRepo(repoData);
      setWorkspaceSession({
        id: crypto.randomUUID(),
        kind: 'repo',
        repo: repoData,
        sandboxId: null,
      });
    },
    [setActiveRepo],
  );

  const handleOpenDraftComposer = useCallback(
    (seed?: DraftComposerSeed | null) => {
      // Composer is gated on `authToken` in the screen selector (it
      // lists repos via GitHub REST). Short-circuit here so an unauthed
      // tap can't latch `draftComposerOpen` — the screen memo re-runs
      // on auth changes and would otherwise surface the stale seed the
      // moment the user signs in.
      if (!authToken) return;
      setDraftSeed(seed ?? null);
      setDraftComposerOpen(true);
    },
    [authToken],
  );

  const handleCancelDraftComposer = useCallback(() => {
    setDraftComposerOpen(false);
    setDraftSeed(null);
  }, []);

  // HomeScreen launcher tile wrappers — every "new chat" entry routes
  // through the pre-flight menu so the user picks (or confirms) context
  // in one surface. Remote stays direct because it needs pairing.
  // OnboardingScreen keeps the direct handlers since the menu is auth-gated
  // (needs the repo list).
  const handleStartScratchFromHome = useCallback(
    () => handleOpenDraftComposer({ mode: 'scratch' }),
    [handleOpenDraftComposer],
  );

  const handleStartChatFromHome = useCallback(
    () => handleOpenDraftComposer({ mode: 'chat' }),
    [handleOpenDraftComposer],
  );

  const handleSelectRepoFromHome = useCallback(
    (repo: RepoWithActivity, branch?: string) => {
      handleOpenDraftComposer({
        mode: 'repo',
        repoFullName: repo.full_name,
        branch: branch ?? null,
      });
    },
    [handleOpenDraftComposer],
  );

  const handlePendingNewChatConsumed = useCallback(() => {
    setPendingNewChat(null);
  }, []);

  // Commits the pre-flight menu into a real workspace session. Same-
  // context commits keep the existing session (no sandbox restart);
  // cross-context commits swap to a new session id, which remounts
  // WorkspaceSessionScreen and starts a fresh sandbox via the same
  // path the navigation handlers use to swap workspaces. Either way
  // we stamp `pendingNewChat` so the workspace mints a fresh chat
  // even when the session is reused — confirming the menu always
  // means "open a new chat here", not "stay in the current one".
  // When the menu picked a provider/model override the workspace
  // anchors the new chat to that via its own draft store; the
  // catalog-wide default is left alone. Message entry happens later
  // in the workspace's own ChatInput.
  const handleCommitDraft = useCallback(
    (commit: ComposerDraftCommit) => {
      setPendingNewChat({
        key: crypto.randomUUID(),
        provider: commit.provider,
        model: commit.model,
      });
      setDraftComposerOpen(false);
      setDraftSeed(null);
      setPendingResumeChatId(null);

      if (commit.mode === 'chat') {
        clearActiveRepo();
        setWorkspaceSession((prev) =>
          prev?.kind === 'chat' ? prev : { id: crypto.randomUUID(), kind: 'chat', sandboxId: null },
        );
        return;
      }

      if (commit.mode === 'scratch') {
        clearActiveRepo();
        setWorkspaceSession((prev) =>
          prev?.kind === 'scratch'
            ? prev
            : { id: crypto.randomUUID(), kind: 'scratch', sandboxId: null },
        );
        return;
      }

      if (!commit.repoFullName) return;
      const repo = repos.find((r) => r.full_name === commit.repoFullName);
      if (!repo) return;
      const desiredBranch = commit.branch || repo.default_branch;
      const repoData = {
        id: repo.id,
        name: repo.name,
        full_name: repo.full_name,
        owner: repo.owner,
        default_branch: repo.default_branch,
        current_branch: desiredBranch,
        private: repo.private,
      };
      setActiveRepo(repoData);
      setWorkspaceSession((prev) => {
        if (
          prev?.kind === 'repo' &&
          prev.repo.full_name === repo.full_name &&
          prev.repo.current_branch === desiredBranch
        ) {
          return prev;
        }
        return {
          id: crypto.randomUUID(),
          kind: 'repo',
          repo: repoData,
          sandboxId: null,
        };
      });
    },
    [clearActiveRepo, repos, setActiveRepo],
  );

  const handleResumeConversationFromHome = useCallback(
    (chatId: string) => {
      const conversation = conversationIndex[chatId];
      if (!conversation) return;

      // Chat mode conversations have no repo — resume directly into chat workspace.
      if (conversation.mode === 'chat') {
        setPendingResumeChatId(chatId);
        clearActiveRepo();
        setWorkspaceSession({ id: crypto.randomUUID(), kind: 'chat', sandboxId: null });
        return;
      }

      // Scratch workspace conversations — resume into scratch workspace.
      if (conversation.mode === 'scratch' || (!conversation.repoFullName && !conversation.mode)) {
        setPendingResumeChatId(chatId);
        clearActiveRepo();
        setWorkspaceSession({ id: crypto.randomUUID(), kind: 'scratch', sandboxId: null });
        return;
      }

      if (!conversation.repoFullName) return;

      const repo = repos.find((candidate) => candidate.full_name === conversation.repoFullName);
      if (!repo) return;

      handleSelectRepo(repo, conversation.branch || undefined);
      setPendingResumeChatId(chatId);
    },
    [conversationIndex, repos, handleSelectRepo, clearActiveRepo],
  );

  // Tapping a chat in the sidebar must migrate the workspace to match the
  // chat's mode/repo. Branch is mutable session state now: same-repo chat
  // taps are routed through the workspace screen so it can warm-restore the
  // saved branch, while cross-repo resumes seed the new repo session from the
  // chat's last branch.
  const handleResumeChatFromDrawer = useCallback(
    (chatId: string) => {
      const conversation = conversationIndex[chatId];
      if (!conversation) return;

      if (conversation.mode === 'chat') {
        if (workspaceSession?.kind !== 'chat') {
          clearActiveRepo();
          setWorkspaceSession({ id: crypto.randomUUID(), kind: 'chat', sandboxId: null });
        }
        setPendingResumeChatId(chatId);
        return;
      }

      const isScratchConv =
        conversation.mode === 'scratch' || (!conversation.repoFullName && !conversation.mode);
      if (isScratchConv) {
        if (workspaceSession?.kind !== 'scratch') {
          clearActiveRepo();
          setWorkspaceSession({ id: crypto.randomUUID(), kind: 'scratch', sandboxId: null });
        }
        setPendingResumeChatId(chatId);
        return;
      }

      if (!conversation.repoFullName) return;
      const repo = repos.find((candidate) => candidate.full_name === conversation.repoFullName);
      if (!repo) return;

      const targetBranch = conversation.branch || undefined;
      const sameContext =
        workspaceSession?.kind === 'repo' && workspaceSession.repo.full_name === repo.full_name;

      if (!sameContext) {
        // handleSelectRepo resets pendingResumeChatId internally; (re-)set
        // it after so the resume bridge picks the tapped chat in the new
        // session.
        handleSelectRepo(repo, targetBranch);
      }
      setPendingResumeChatId(chatId);
    },
    [conversationIndex, repos, workspaceSession, handleSelectRepo, clearActiveRepo],
  );

  const handleSetCurrentBranch = useCallback(
    (branch: string) => {
      setCurrentBranch(branch);
      setWorkspaceSession((prev) => {
        if (!prev || prev.kind !== 'repo') return prev;
        if (prev.repo.current_branch === branch) return prev;
        return {
          ...prev,
          repo: {
            ...prev.repo,
            current_branch: branch,
          },
        };
      });
    },
    [setCurrentBranch],
  );

  const handleDisconnect = useCallback(() => {
    disconnectAuth();
    clearActiveRepo();
    setWorkspaceSession(null);
    setPendingResumeChatId(null);
    setConversationIndex({});
    safeStorageRemove('diff_active_chat');
    safeStorageRemove('diff_conversations');
    safeStorageRemove('diff_chat_history');
    void replaceAllConversations({});
  }, [clearActiveRepo, disconnectAuth]);

  useEffect(() => {
    if (authToken) syncRepos();
  }, [authToken, syncRepos]);

  useEffect(() => {
    if (!workspaceSession) {
      safeStorageRemove(WORKSPACE_SESSION_STORAGE_KEY);
      return;
    }
    // Relay sessions get stripped to a bearerless tombstone before
    // serialization. The bearer token lives in IndexedDB (`paired_remotes`) and
    // is re-hydrated on the next tile click; persisting it here too would
    // create a second exfiltration surface and a sync hazard.
    const persisted =
      workspaceSession.kind === 'relay'
        ? { id: workspaceSession.id, kind: 'relay' as const, sandboxId: null }
        : workspaceSession;
    safeStorageSet(WORKSPACE_SESSION_STORAGE_KEY, JSON.stringify(persisted));
  }, [workspaceSession]);

  const screen: AppShellScreen = useMemo(() => {
    // Relay paths short-circuit auth: the daemon-paired flow doesn't need
    // GitHub creds, so a pairing interstitial or a relay workspace renders even
    // when the user is signed out of GitHub. Same goes for the accountless
    // scratch / chat entry points wired on OnboardingScreen — the auth guard
    // must stay below them so the "try without an account" tiles actually land
    // the user in a workspace.
    if (relayPairingActive) return 'relay-pairing';
    if (workspaceSession?.kind === 'relay') return 'workspace';
    // Pre-flight composer sits above the scratch/chat short-circuits so
    // "+ New chat" on those workspaces actually renders it. Gated on
    // `authToken` because the picker lists repos via GitHub REST — the
    // accountless scratch/chat tiles on OnboardingScreen still fall
    // through to the workspace short-circuits below.
    if (draftComposerOpen && authToken) return 'draft-composer';
    if (workspaceSession?.kind === 'scratch') return 'workspace';
    if (workspaceSession?.kind === 'chat') return 'workspace';
    if (!authToken) return 'onboarding';
    if (workspaceSession?.kind === 'repo') return 'workspace';
    return 'home';
  }, [authToken, workspaceSession, relayPairingActive, draftComposerOpen]);

  const suspenseFallback = <div className="h-dvh bg-push-surface-inset" />;

  // Instrument screen transitions — mark which screen is about to render.
  // The corresponding "painted" mark lives inside each screen component.
  useEffect(() => {
    perfMark(`screen:${screen}`);
  }, [screen]);

  if (screen === 'onboarding') {
    return (
      <Suspense fallback={suspenseFallback}>
        <div className="flex h-dvh flex-col bg-push-surface-inset safe-area-top safe-area-bottom">
          <OnboardingScreen
            onConnect={handleConnect}
            onConnectOAuth={connectApp}
            onStartWorkspace={handleStartScratchWorkspace}
            onStartChat={handleStartChatMode}
            onStartRelay={isRelayModeEnabled() ? handleStartRelay : undefined}
            onInstallApp={installApp}
            onConnectInstallationId={setInstallationIdManually}
            loading={authLoading}
            error={authError}
            validatedUser={validatedUser}
            isAppAuth={isAppAuth}
          />
        </div>
      </Suspense>
    );
  }

  if (screen === 'home') {
    return (
      <Suspense fallback={suspenseFallback}>
        <div className="flex h-dvh flex-col bg-push-surface-inset safe-area-top safe-area-bottom">
          <HomeScreen
            repos={repos}
            loading={reposLoading}
            error={reposError}
            conversations={conversationIndex}
            activeRepo={activeRepo}
            resolveRepoAppearance={resolveRepoAppearance}
            setRepoAppearance={setRepoAppearance}
            clearRepoAppearance={clearRepoAppearance}
            onSelectRepo={handleSelectRepoFromHome}
            onResumeConversation={handleResumeConversationFromHome}
            onDisconnect={handleDisconnect}
            onStartWorkspace={handleStartScratchFromHome}
            onStartChat={handleStartChatFromHome}
            onStartRelay={isRelayModeEnabled() ? handleStartRelay : undefined}
            user={validatedUser}
          />
        </div>
      </Suspense>
    );
  }

  if (screen === 'relay-pairing') {
    return (
      <Suspense fallback={suspenseFallback}>
        <RelayPairing onPaired={handleRelayPaired} onCancel={handleRelayPairingCancel} />
      </Suspense>
    );
  }

  if (screen === 'draft-composer') {
    return (
      <Suspense fallback={suspenseFallback}>
        <ComposerDraftScreen
          seed={draftSeed}
          repos={repos}
          resolveRepoAppearance={resolveRepoAppearance}
          catalog={catalog}
          onCancel={handleCancelDraftComposer}
          onCommit={handleCommitDraft}
        />
      </Suspense>
    );
  }

  if (!workspaceSession) {
    return suspenseFallback;
  }

  return (
    <Suspense fallback={suspenseFallback}>
      <WorkspaceScreen
        workspace={{
          workspaceSession,
          onWorkspaceSessionChange: setWorkspaceSession,
        }}
        repoShell={{
          setActiveRepo,
          setCurrentBranch: handleSetCurrentBranch,
          repos,
          reposLoading,
          reposError,
          resolveRepoAppearance,
          setRepoAppearance,
          clearRepoAppearance,
        }}
        auth={{
          token: authToken,
          tokenKind,
          patToken,
          validatedUser,
          isAppAuth,
          installationId,
          appLoading,
          appError,
          connectApp,
          installApp,
          setInstallationIdManually,
        }}
        navigation={{
          onDisconnect: handleDisconnect,
          onSelectRepo: handleSelectRepo,
          onStartScratchWorkspace: handleStartScratchWorkspace,
          onStartChat: handleStartChatMode,
          onStartRelay: isRelayModeEnabled() ? handleStartRelay : undefined,
          onResumeRelaySession: isRelayModeEnabled() ? handleResumeRelaySession : undefined,
          onEndWorkspace: handleEndWorkspace,
          onOpenDraftComposer: handleOpenDraftComposer,
        }}
        homeBridge={{
          pendingResumeChatId,
          onConversationIndexChange: setConversationIndex,
          pendingNewChat,
          onPendingNewChatConsumed: handlePendingNewChatConsumed,
          onResumeChatFromDrawer: handleResumeChatFromDrawer,
        }}
        catalog={catalog}
      />
    </Suspense>
  );
}

export default App;
