import { useState, useEffect, useCallback, useMemo, useRef, Suspense } from 'react';
import { useAuthSession } from '@/hooks/useAuthSession';
import { useRepos } from '@/hooks/useRepos';
import { useActiveRepo } from '@/hooks/useActiveRepo';
import { useRepoAppearance } from '@/hooks/useRepoAppearance';
import { replaceAllConversations, migrateConversationsToIndexedDB } from '@/lib/conversation-store';
import { toConversationIndex } from '@/lib/conversation-index';
import { safeStorageGet, safeStorageRemove, safeStorageSet } from '@/lib/safe-storage';
import { lazyWithRecovery, toDefaultExport } from '@/lib/lazy-import';
import { perfMark, perfMeasure } from '@/lib/perf-marks';
import { getPairedDevice } from '@/lib/local-pc-storage';
import { getPairedRemote } from '@/lib/relay-storage';
import type {
  ActiveRepo,
  AppShellScreen,
  ConversationIndex,
  LocalPcBinding,
  RelayBinding,
  RepoWithActivity,
  WorkspaceSession,
} from '@/types';
import './App.css';
import {
  createIndexedDbStore,
  setDefaultMemoryStore,
  getDefaultMemoryStore,
} from '@/lib/context-memory-store';
import { createPolicyEnforcedStore } from '@push/lib/context-memory-policy-store';

setDefaultMemoryStore(createPolicyEnforcedStore(createIndexedDbStore()));

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

  if (candidate.kind === 'local-pc') {
    // Local-pc sessions are intentionally NOT restored from localStorage.
    // The persistence effect strips bindings before serializing (the
    // bearer must never survive a JSON round trip through localStorage —
    // see PR #510 review), so any persisted record is by design a
    // bearerless tombstone. Forcing a re-click of the Local PC tile
    // re-hydrates from IndexedDB through the same code path that handles
    // first-time entry, with no second persistence path to keep in sync.
    return null;
  }

  if (candidate.kind === 'relay') {
    // Phase 2.f: same posture as local-pc. The relay attach-token
    // bearer must not survive localStorage; forcing a re-click of the
    // Remote tile re-hydrates from IndexedDB through the dedicated
    // store, with no second persistence path to keep in sync.
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
const LocalPcPairing = lazyWithRecovery(
  toDefaultExport(
    () => import('@/sections/LocalPcPairing'),
    (module) => module.LocalPcPairing,
  ),
);
const RelayPairing = lazyWithRecovery(
  toDefaultExport(
    () => import('@/sections/RelayPairing'),
    (module) => module.RelayPairing,
  ),
);

function App() {
  const { activeRepo, setActiveRepo, clearActiveRepo, setCurrentBranch } = useActiveRepo();
  const [workspaceSession, setWorkspaceSession] = useState<WorkspaceSession | null>(() =>
    loadWorkspaceSession(activeRepo),
  );
  const [conversationIndex, setConversationIndex] = useState<ConversationIndex>({});
  const [pendingResumeChatId, setPendingResumeChatId] = useState<string | null>(null);
  // Hub-level interstitial for the Local PC pairing flow. Decoupled from
  // `workspaceSession` because pairing happens *before* a local-pc session
  // record exists: the WorkspaceSession union mandates a `binding` on the
  // 'local-pc' arm, so we route through this state until pairing yields one.
  const [localPcPairingActive, setLocalPcPairingActive] = useState(false);
  // Generation counter for in-flight `handleStartLocalPc` IDB reads. The
  // tile click is async (paired_devices lookup) and the user may navigate
  // away or click another mode before the promise resolves; bumping this
  // ref on every flow-changing handler lets the stale resolver detect
  // that it's been superseded and bail without committing state.
  const localPcGenRef = useRef(0);
  // Phase 2.f: same pattern for the Remote (relay) entry point. The
  // paired_remotes IDB lookup is async; bumping `relayGenRef` on
  // every flow-changing handler keeps a slow resolver from teleporting
  // the user into a relay session after they've moved on.
  const [relayPairingActive, setRelayPairingActive] = useState(false);
  const relayGenRef = useRef(0);

  const { resolveRepoAppearance, setRepoAppearance, clearRepoAppearance } = useRepoAppearance();

  useEffect(() => {
    perfMark('app:first-render');
    perfMeasure('app:boot', 'app:first-render');
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

  const handleStartLocalPc = useCallback(async () => {
    // Capture the generation at click time. Any later flow-changing
    // handler bumps the counter, so a slow IDB read can't "teleport"
    // the user into a local-pc session after they've already moved on.
    const myGen = ++localPcGenRef.current;
    setPendingResumeChatId(null);
    clearActiveRepo();
    setWorkspaceSession(null);

    const record = await getPairedDevice();
    if (localPcGenRef.current !== myGen) return; // superseded — bail

    if (record) {
      setLocalPcPairingActive(false);
      setWorkspaceSession({
        id: crypto.randomUUID(),
        kind: 'local-pc',
        binding: {
          port: record.port,
          token: record.token,
          tokenId: record.tokenId,
          boundOrigin: record.boundOrigin,
        },
        sandboxId: null,
      });
    } else {
      setLocalPcPairingActive(true);
    }
  }, [clearActiveRepo]);

  const handleLocalPcPaired = useCallback((binding: LocalPcBinding) => {
    localPcGenRef.current += 1;
    setLocalPcPairingActive(false);
    setWorkspaceSession({
      id: crypto.randomUUID(),
      kind: 'local-pc',
      binding,
      sandboxId: null,
    });
  }, []);

  const handleLocalPcPairingCancel = useCallback(() => {
    localPcGenRef.current += 1;
    setLocalPcPairingActive(false);
    setWorkspaceSession(null);
  }, []);

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
        },
        sandboxId: null,
      });
    } else {
      setRelayPairingActive(true);
    }
  }, [clearActiveRepo]);

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
    localPcGenRef.current += 1;
    relayGenRef.current += 1;
    setPendingResumeChatId(null);
    setWorkspaceSession(null);
    setLocalPcPairingActive(false);
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
    // Local-pc / relay sessions get stripped to a bearerless tombstone
    // before serialization. The bearer token lives in IndexedDB
    // (`paired_devices` / `paired_remotes`) and is re-hydrated on the
    // next tile click; persisting it here too would create a second
    // exfiltration surface and a sync hazard.
    const persisted =
      workspaceSession.kind === 'local-pc'
        ? { id: workspaceSession.id, kind: 'local-pc' as const, sandboxId: null }
        : workspaceSession.kind === 'relay'
          ? { id: workspaceSession.id, kind: 'relay' as const, sandboxId: null }
          : workspaceSession;
    safeStorageSet(WORKSPACE_SESSION_STORAGE_KEY, JSON.stringify(persisted));
  }, [workspaceSession]);

  const screen: AppShellScreen = useMemo(() => {
    // Local-pc / relay paths short-circuit auth: the daemon-paired
    // flow doesn't need GitHub creds, so a pairing interstitial or a
    // `kind: 'local-pc'` / `'relay'` workspace renders even when the
    // user is signed out of GitHub.
    if (localPcPairingActive) return 'local-pc-pairing';
    if (relayPairingActive) return 'relay-pairing';
    if (workspaceSession?.kind === 'local-pc') return 'workspace';
    if (workspaceSession?.kind === 'relay') return 'workspace';
    if (workspaceSession?.kind === 'scratch') return 'workspace';
    if (workspaceSession?.kind === 'chat') return 'workspace';
    if (!authToken) return 'onboarding';
    if (workspaceSession?.kind === 'repo') return 'workspace';
    return 'home';
  }, [authToken, workspaceSession, localPcPairingActive, relayPairingActive]);

  const suspenseFallback = <div className="h-dvh bg-[#000]" />;

  // Instrument screen transitions — mark which screen is about to render.
  // The corresponding "painted" mark lives inside each screen component.
  useEffect(() => {
    perfMark(`screen:${screen}`);
  }, [screen]);

  if (screen === 'onboarding') {
    return (
      <Suspense fallback={suspenseFallback}>
        <div className="flex h-dvh flex-col bg-[#000] safe-area-top safe-area-bottom">
          <OnboardingScreen
            onConnect={handleConnect}
            onConnectOAuth={connectApp}
            onStartWorkspace={handleStartScratchWorkspace}
            onStartChat={handleStartChatMode}
            onStartLocalPc={handleStartLocalPc}
            onStartRelay={handleStartRelay}
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
        <div className="flex h-dvh flex-col bg-[#000] safe-area-top safe-area-bottom">
          <HomeScreen
            repos={repos}
            loading={reposLoading}
            error={reposError}
            conversations={conversationIndex}
            activeRepo={activeRepo}
            resolveRepoAppearance={resolveRepoAppearance}
            setRepoAppearance={setRepoAppearance}
            clearRepoAppearance={clearRepoAppearance}
            onSelectRepo={handleSelectRepo}
            onResumeConversation={handleResumeConversationFromHome}
            onDisconnect={handleDisconnect}
            onStartWorkspace={handleStartScratchWorkspace}
            onStartChat={handleStartChatMode}
            onStartLocalPc={handleStartLocalPc}
            onStartRelay={handleStartRelay}
            user={validatedUser}
          />
        </div>
      </Suspense>
    );
  }

  if (screen === 'local-pc-pairing') {
    return (
      <Suspense fallback={suspenseFallback}>
        <LocalPcPairing onPaired={handleLocalPcPaired} onCancel={handleLocalPcPairingCancel} />
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
          onStartLocalPc: handleStartLocalPc,
          onStartRelay: handleStartRelay,
          onEndWorkspace: handleEndWorkspace,
        }}
        homeBridge={{
          pendingResumeChatId,
          onConversationIndexChange: setConversationIndex,
        }}
      />
    </Suspense>
  );
}

export default App;
