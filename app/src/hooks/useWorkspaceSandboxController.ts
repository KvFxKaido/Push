import { useState, useEffect, useCallback, useRef, type MutableRefObject } from 'react';
import { buildWorkspaceScratchActions, type SnapshotManager } from '@/hooks/useSnapshotManager';
import type { SandboxStatus } from '@/hooks/useSandbox';
import { downloadFromSandbox } from '@/lib/sandbox-client';
import { getActiveGitBackend } from '@/lib/git-session';
import { isNativePlatform } from '@/lib/platform';
import { isNativeWorkingCopyEnabled } from '@/lib/feature-flags';
import { ensureWorkingCopy, forgetWorkingCopy } from '@/lib/native-working-copy';
import { getActiveGitHubToken } from '@/lib/github-auth';
import type { GitStatusInfo } from '@push/lib/git/status';
import {
  createWorkspaceStateProducer,
  gitStatusInfoToWorkspaceState,
  reduceWorkspaceStateEvent,
  type WorkspaceStateEvent,
  type WorkspaceStateProducer,
  type WorkspaceStateView,
} from '@push/lib/workspace-state';
import type {
  ActiveRepo,
  SandboxStateCardData,
  WorkspaceCapabilities,
  WorkspaceScratchActions,
  WorkspaceSession,
} from '@/types';

function gitStatusToCard(sandboxId: string, info: GitStatusInfo): SandboxStateCardData {
  return {
    sandboxId,
    repoPath: '/workspace',
    branch: info.branch,
    statusLine: info.statusLine || 'unknown',
    changedFiles: info.entries.length,
    stagedFiles: info.staged,
    unstagedFiles: info.unstaged,
    untrackedFiles: info.untracked.length,
    preview: info.entries
      .slice(0, 6)
      .map((entry) => (entry.raw.length > 120 ? `${entry.raw.slice(0, 120)}...` : entry.raw)),
    fetchedAt: new Date().toISOString(),
  };
}

type SandboxControllerArgs = {
  workspaceSession: WorkspaceSession;
  workspaceRepo: ActiveRepo | null;
  isScratch: boolean;
  sandbox: {
    sandboxId: string | null;
    status: SandboxStatus;
    start: (repo: string, branch?: string) => Promise<string | null>;
    stop: () => Promise<void>;
  };
  snapshots: SnapshotManager;
  isStreaming: boolean;
  abortStream: (options?: { clearQueuedFollowUps?: boolean }) => void;
  createNewChat: () => string;
  onWorkspaceSessionChange: (session: WorkspaceSession) => void;
  onEndWorkspace: () => void;
  onDisconnect: () => void;
  setEnsureSandbox: (fn: () => Promise<string | null>) => void;
  setSandboxId: (id: string | null) => void;
  setWorkspaceSessionId: (id: string | null) => void;
  skipBranchTeardownRef: MutableRefObject<boolean>;
  /** Current `Protect Main` setting, stamped into the live workspace state.
   *  Optional so existing call sites keep compiling; defaults to the
   *  product's off-by-default state until threaded from settings. */
  protectMain?: boolean;
  /** Sink for the workspace-state timeline (`workspace.state_snapshot` /
   *  `workspace.state_delta`). Optional: the controller is the first
   *  producer adapter; a consumer that forwards these onto the run-event
   *  stream is a later increment. */
  onWorkspaceStateEvent?: (event: WorkspaceStateEvent) => void;
};

export function useWorkspaceSandboxController({
  workspaceSession,
  workspaceRepo,
  isScratch,
  sandbox,
  snapshots,
  isStreaming,
  abortStream,
  createNewChat,
  onWorkspaceSessionChange,
  onEndWorkspace,
  onDisconnect,
  setEnsureSandbox,
  setSandboxId,
  setWorkspaceSessionId,
  skipBranchTeardownRef,
  protectMain = false,
  onWorkspaceStateEvent,
}: SandboxControllerArgs) {
  // Decompose sandbox into stable individual references to avoid depending
  // on the full object (which is a new identity every render).
  const sandboxId = sandbox.sandboxId;
  const sandboxStatus = sandbox.status;
  const sandboxStart = sandbox.start; // stable useCallback
  const stopSandbox = sandbox.stop; // stable useCallback

  const [showFileBrowser, setShowFileBrowser] = useState(false);
  const [sandboxState, setSandboxState] = useState<SandboxStateCardData | null>(null);
  const [sandboxStateLoading, setSandboxStateLoading] = useState(false);
  const [sandboxDownloading, setSandboxDownloading] = useState(false);
  const sandboxStateFetchedFor = useRef<string | null>(null);

  // Live workspace-state timeline (see lib/workspace-state.ts). The controller
  // is the first producer adapter: it already owns sandbox lifecycle + the
  // desync signal, so it drives snapshot/delta emission off the same git-status
  // reads that feed the status card. `producerRef` is keyed by sandboxId — a
  // new sandbox (restart, different repo) starts a fresh rev timeline.
  const [workspaceStateView, setWorkspaceStateView] = useState<WorkspaceStateView | null>(null);
  const producerRef = useRef<WorkspaceStateProducer | null>(null);
  const producerWorkspaceIdRef = useRef<string | null>(null);
  const workspaceViewRef = useRef<WorkspaceStateView | null>(null);
  // Volatile inputs read by the []-stable driver below; mirrored into refs so
  // the driver's identity stays stable and doesn't perturb the fetch effect.
  const sandboxStatusRef = useRef(sandboxStatus);
  const protectMainRef = useRef(protectMain);
  const onWorkspaceStateEventRef = useRef(onWorkspaceStateEvent);
  useEffect(() => {
    sandboxStatusRef.current = sandboxStatus;
  }, [sandboxStatus]);
  useEffect(() => {
    protectMainRef.current = protectMain;
  }, [protectMain]);
  useEffect(() => {
    onWorkspaceStateEventRef.current = onWorkspaceStateEvent;
  }, [onWorkspaceStateEvent]);

  // Ref-only teardown of the producer timeline (no setState — callers defer the
  // `setWorkspaceStateView(null)` to dodge react-hooks/set-state-in-effect, the
  // same reason the sandbox card nulls through a setTimeout below).
  const resetWorkspaceStateRefs = useCallback(() => {
    producerRef.current = null;
    producerWorkspaceIdRef.current = null;
    workspaceViewRef.current = null;
  }, []);

  // Durable native scope for the working-copy registry (native only; undefined
  // for scratch, which never clones). Passed alongside `sandboxId` so the git
  // seam resolves the on-device clone on native and the cloud sandbox on web.
  const nativeScope = useCallback(
    (id: string) => ({
      sandboxId: id,
      repoFullName: workspaceRepo?.full_name,
      branch: workspaceRepo?.current_branch || workspaceRepo?.default_branch,
    }),
    [workspaceRepo],
  );

  // Fold a fresh git-status read into the workspace-state timeline: snapshot on
  // a new sandbox identity, minimal delta otherwise. Reduces the event through
  // the shared reducer so the exposed view is the delta-reconciled one, and
  // forwards the event to any sink. HEAD sha isn't in the status payload, so we
  // fetch it in parallel-friendly form (its own await) and fall back to a
  // stable non-empty placeholder on an unborn branch / read failure.
  const driveWorkspaceState = useCallback(
    async (id: string, info: GitStatusInfo) => {
      const headSha = await getActiveGitBackend(nativeScope(id))
        .headSha({ short: true })
        .catch(() => null);
      const nextState = gitStatusInfoToWorkspaceState(info, {
        headSha: headSha ?? '(unborn)',
        protectMain: protectMainRef.current,
        sandboxReady: sandboxStatusRef.current === 'ready',
      });

      let event: WorkspaceStateEvent;
      if (!producerRef.current || producerWorkspaceIdRef.current !== id) {
        producerRef.current = createWorkspaceStateProducer(id, nextState);
        producerWorkspaceIdRef.current = id;
        event = producerRef.current.snapshot();
      } else {
        const delta = producerRef.current.update(nextState);
        if (!delta) return; // nothing changed → no event on the wire
        event = delta;
      }

      const { view } = reduceWorkspaceStateEvent(workspaceViewRef.current, event);
      workspaceViewRef.current = view;
      setWorkspaceStateView(view);
      onWorkspaceStateEventRef.current?.(event);
    },
    [nativeScope],
  );

  // Re-forward the current snapshot without advancing the timeline. Callers use
  // this to re-anchor a *new* sink that never saw the earlier events — e.g. a
  // chat switch, where the run-event stream is per-chat but the producer is
  // workspace-scoped, so the incoming chat would otherwise drop deltas for lack
  // of a base. No setState: the controller's own view is already current.
  const resyncWorkspaceState = useCallback(() => {
    if (!producerRef.current) return;
    onWorkspaceStateEventRef.current?.(producerRef.current.snapshot());
  }, []);

  // Emit a guard-only delta when Protect Main toggles while the sandbox is
  // already ready. The ready effect fetches once per sandbox id, so without
  // this a mid-session toggle would only update `protectMainRef` and consumers
  // would keep showing the stale delivery guard until a manual refresh. Async
  // (matching `driveWorkspaceState`) so the internal setState isn't a
  // synchronous set-state-in-effect. No git read — we patch the one field on
  // the current reduced state and let the producer diff it.
  const emitProtectMainDelta = useCallback(async (nextProtectMain: boolean) => {
    const producer = producerRef.current;
    const view = workspaceViewRef.current;
    if (!producer || !view || view.state.protectMain === nextProtectMain) return;
    const event = producer.update({ ...view.state, protectMain: nextProtectMain });
    if (!event) return;
    const { view: nextView } = reduceWorkspaceStateEvent(view, event);
    workspaceViewRef.current = nextView;
    setWorkspaceStateView(nextView);
    onWorkspaceStateEventRef.current?.(event);
  }, []);
  useEffect(() => {
    void emitProtectMainDelta(protectMain);
  }, [protectMain, emitProtectMainDelta]);

  const fetchSandboxState = useCallback(
    async (id: string): Promise<SandboxStateCardData | null> => {
      setSandboxStateLoading(true);
      try {
        const info = await getActiveGitBackend(nativeScope(id)).status();
        if (!info) return null;

        const nextState = gitStatusToCard(id, info);
        setSandboxState(nextState);
        // Fire-and-forget: drives the workspace-state timeline off the same
        // read. It never rejects (headSha is caught inside), but log any
        // unexpected throw rather than swallowing it.
        void driveWorkspaceState(id, info).catch((err) => {
          console.error(
            JSON.stringify({
              level: 'warn',
              event: 'workspace_state_drive_failed',
              sandboxId: id,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        });
        return nextState;
      } catch {
        return null;
      } finally {
        setSandboxStateLoading(false);
      }
    },
    [driveWorkspaceState, nativeScope],
  );

  useEffect(() => {
    if (sandboxStatus !== 'ready' || !sandboxId) {
      if (sandboxStatus === 'idle') {
        sandboxStateFetchedFor.current = null;
        resetWorkspaceStateRefs();
        const id = setTimeout(() => {
          setSandboxState(null);
          setWorkspaceStateView(null);
        }, 0);
        return () => clearTimeout(id);
      }
      return;
    }
    if (sandboxStateFetchedFor.current === sandboxId) return;
    sandboxStateFetchedFor.current = sandboxId;
    void fetchSandboxState(sandboxId);
  }, [sandboxStatus, sandboxId, fetchSandboxState, resetWorkspaceStateRefs]);

  const ensureSandbox = useCallback(async (): Promise<string | null> => {
    if (sandboxId && sandboxStatus !== 'error') return sandboxId;
    if (isScratch) return sandboxStart('', 'main');
    if (!workspaceRepo) return null;
    return sandboxStart(
      workspaceRepo.full_name,
      workspaceRepo.current_branch || workspaceRepo.default_branch,
    );
  }, [sandboxId, sandboxStatus, sandboxStart, isScratch, workspaceRepo]);

  useEffect(() => {
    setEnsureSandbox(ensureSandbox);
  }, [ensureSandbox, setEnsureSandbox]);

  useEffect(() => {
    setSandboxId(sandboxId);
    // chat / relay sessions don't run a cloud sandbox: chat has no workspace
    // at all, and relay routes through the Worker relay via RelayChatScreen.
    // Either reaching this controller is an upstream routing bug; we still keep
    // the type narrow before the spread below because their `sandboxId` is
    // `null`-only.
    if (workspaceSession.kind === 'chat' || workspaceSession.kind === 'relay') {
      return;
    }
    if (workspaceSession.sandboxId === sandboxId) return;
    onWorkspaceSessionChange({ ...workspaceSession, sandboxId });
  }, [onWorkspaceSessionChange, sandboxId, setSandboxId, workspaceSession]);

  useEffect(() => {
    setWorkspaceSessionId(workspaceSession.id ?? null);
  }, [workspaceSession.id, setWorkspaceSessionId]);

  const previousSessionIdRef = useRef(workspaceSession.id);
  useEffect(() => {
    const previousSessionId = previousSessionIdRef.current;
    previousSessionIdRef.current = workspaceSession.id;
    if (previousSessionId === workspaceSession.id) return;

    setShowFileBrowser(false);
    setSandboxState(null);
    setWorkspaceStateView(null);
    resetWorkspaceStateRefs();
    sandboxStateFetchedFor.current = null;

    if (isStreaming) {
      abortStream({ clearQueuedFollowUps: true });
    }
    void stopSandbox();

    if (workspaceSession.kind === 'scratch') {
      createNewChat();
    }
  }, [
    abortStream,
    resetWorkspaceStateRefs,
    createNewChat,
    isStreaming,
    stopSandbox,
    workspaceSession.id,
    workspaceSession.kind,
  ]);

  const prevBranchRef = useRef<string | undefined>(workspaceRepo?.current_branch);
  useEffect(() => {
    const currentBranchValue = workspaceRepo?.current_branch;
    const prevBranch = prevBranchRef.current;
    prevBranchRef.current = currentBranchValue;

    if (prevBranch === currentBranchValue) return;
    if (isScratch) return;
    if (prevBranch === undefined) return;

    if (skipBranchTeardownRef.current) {
      console.log(
        `[WorkspaceScreen] Branch changed: ${prevBranch} → ${currentBranchValue} (sandbox-initiated, skipping teardown)`,
      );
      skipBranchTeardownRef.current = false;
      return;
    }

    console.log(
      `[WorkspaceScreen] Branch changed: ${prevBranch} → ${currentBranchValue}, tearing down sandbox`,
    );
    void stopSandbox();
  }, [workspaceRepo?.current_branch, isScratch, stopSandbox, skipBranchTeardownRef]);

  useEffect(() => {
    if (isScratch && sandboxStatus === 'idle' && !sandboxId) {
      void sandboxStart('', 'main');
    }
  }, [isScratch, sandboxStatus, sandboxId, sandboxStart]);

  // On-device working-copy trigger (native/APK only, flag-gated). Clones the
  // repo session to a local working copy so git ops resolve the on-device clone
  // via git-session's native binding. Dormant on web and until the flag is on.
  // Runs alongside — NOT in place of — the cloud sandbox: the non-git tools
  // still route by `sandboxId`, so this is the git-read half of the native
  // workspace until the HTTP surface is native-routed (see the flag doc). The
  // clone is registry-deduped, so re-runs on re-render collapse to a reused hit.
  // Depends on the durable scope primitives (not the `workspaceRepo` identity)
  // so it fires once per (repo, branch), not on every render.
  const repoFullName = workspaceRepo?.full_name;
  const repoBranch = workspaceRepo?.current_branch || workspaceRepo?.default_branch;
  useEffect(() => {
    if (!isNativePlatform() || !isNativeWorkingCopyEnabled()) return;
    if (isScratch || !repoFullName || !repoBranch) return;
    void ensureWorkingCopy(
      { repoFullName, branch: repoBranch },
      { getToken: () => getActiveGitHubToken() || undefined },
    );
  }, [isScratch, repoFullName, repoBranch]);

  const handleSandboxDownload = useCallback(async () => {
    if (!sandboxId || sandboxDownloading) return;
    setSandboxDownloading(true);
    try {
      const result = await downloadFromSandbox(sandboxId);
      if (result.ok && result.archiveBase64) {
        const raw = atob(result.archiveBase64);
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        const blob = new Blob([bytes], { type: 'application/gzip' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `workspace-${Date.now()}.tar.gz`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch {
      // Best effort
    } finally {
      setSandboxDownloading(false);
    }
  }, [sandboxId, sandboxDownloading]);

  const handleSandboxRestart = useCallback(async () => {
    await stopSandbox();
    if (isScratch) {
      await sandboxStart('', 'main');
      return;
    }
    if (!workspaceRepo) return;
    await sandboxStart(
      workspaceRepo.full_name,
      workspaceRepo.current_branch || workspaceRepo.default_branch,
    );
  }, [isScratch, stopSandbox, sandboxStart, workspaceRepo]);

  const fileBrowserCapabilities: Pick<WorkspaceCapabilities, 'canCommitAndPush'> = {
    canCommitAndPush: !isScratch,
  };

  const fileBrowserScratchActions: WorkspaceScratchActions | null = isScratch
    ? buildWorkspaceScratchActions({
        snapshots,
        sandboxStatus,
        downloadingWorkspace: sandboxDownloading,
        onDownloadWorkspace: () => {
          void handleSandboxDownload();
        },
        emptyStateText: 'Save a snapshot or download your files from this workspace.',
      })
    : null;

  const handleExitWorkspace = useCallback(() => {
    if (isStreaming) {
      abortStream({ clearQueuedFollowUps: true });
    }
    setShowFileBrowser(false);
    onEndWorkspace();
  }, [abortStream, isStreaming, onEndWorkspace]);

  const handleDisconnectFromWorkspace = useCallback(() => {
    if (isStreaming) {
      abortStream({ clearQueuedFollowUps: true });
    }
    setShowFileBrowser(false);
    // Explicit disconnect is a deliberate "I'm done / sever this" — unlike a
    // transient navigate-away (Home/Settings), which now persists for warm
    // re-attach. So tear the container down here rather than waiting on the
    // sleepAfter reclaim (Codex P2 on #1001).
    void stopSandbox();
    // Symmetric native teardown: drop the working-copy registry entry so the
    // seam falls back to sandbox on re-attach. Bytes stay on disk (warm
    // re-attach), matching the container's persist posture above. No flag guard
    // — `forgetWorkingCopy` is a no-op when nothing was registered.
    if (isNativePlatform() && !isScratch && repoFullName && repoBranch) {
      forgetWorkingCopy({ repoFullName, branch: repoBranch });
    }
    onDisconnect();
  }, [abortStream, isStreaming, onDisconnect, stopSandbox, isScratch, repoFullName, repoBranch]);

  // Deliberately NO destroy on unmount. Leaving the workspace view (Home,
  // Settings, another chat, PWA backgrounding) used to destroy the container,
  // so returning meant a cold start — the "sandbox disappeared while I just
  // navigated away" complaint. We now let the container persist: returning
  // remounts and the useSandbox reconnect effect warm-reattaches to the live
  // container. Abandoned containers are reclaimed by Cloudflare's sleepAfter
  // (raised to ~1h in worker-cf-sandbox.ts), so nothing leaks — the unmount
  // destroy was a multi-tenant cost guard that doesn't apply to this
  // single-user deployment. Explicit disconnect still tears down (above), and
  // branch swaps / cross-workspace session changes still tear down as before.
  //
  // We do log the persist (declared after the other refs so the test harness's
  // by-index ref tracking isn't shifted) so a "container missing on return"
  // report is traceable to whether the sandbox was left warm.
  const lastSandboxIdRef = useRef(sandboxId);
  useEffect(() => {
    lastSandboxIdRef.current = sandboxId;
  }, [sandboxId]);
  useEffect(() => {
    return () => {
      if (lastSandboxIdRef.current) {
        console.log(
          JSON.stringify({
            level: 'info',
            event: 'sandbox_persisted_on_unmount',
            sandboxId: lastSandboxIdRef.current,
          }),
        );
      }
    };
  }, []);

  return {
    showFileBrowser,
    setShowFileBrowser,
    sandboxState,
    sandboxStateLoading,
    sandboxDownloading,
    workspaceStateView,
    resyncWorkspaceState,
    fetchSandboxState,
    ensureSandbox,
    handleSandboxRestart,
    handleSandboxDownload,
    fileBrowserCapabilities,
    fileBrowserScratchActions,
    handleExitWorkspace,
    handleDisconnectFromWorkspace,
  };
}
