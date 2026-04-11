import { useState, useEffect, useCallback, useRef, type MutableRefObject } from 'react';
import { buildWorkspaceScratchActions, type SnapshotManager } from '@/hooks/useSnapshotManager';
import type { SandboxStatus } from '@/hooks/useSandbox';
import { downloadFromSandbox, execInSandbox } from '@/lib/sandbox-client';
import type {
  ActiveRepo,
  NewChatWorkspaceState,
  SandboxStateCardData,
  WorkspaceCapabilities,
  WorkspaceScratchActions,
  WorkspaceSession,
} from '@/types';

function parseSandboxGitStatus(sandboxId: string, stdout: string): SandboxStateCardData {
  const lines = stdout
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean);
  const statusLine =
    lines
      .find((line) => line.startsWith('##'))
      ?.slice(2)
      .trim() || 'unknown';
  const branch = statusLine.split('...')[0].trim() || 'unknown';
  const entries = lines.filter((line) => !line.startsWith('##'));

  let stagedFiles = 0;
  let unstagedFiles = 0;
  let untrackedFiles = 0;
  for (const entry of entries) {
    const x = entry[0] || ' ';
    const y = entry[1] || ' ';
    if (x === '?' && y === '?') {
      untrackedFiles++;
      continue;
    }
    if (x !== ' ') stagedFiles++;
    if (y !== ' ') unstagedFiles++;
  }

  return {
    sandboxId,
    repoPath: '/workspace',
    branch,
    statusLine,
    changedFiles: entries.length,
    stagedFiles,
    unstagedFiles,
    untrackedFiles,
    preview: entries
      .slice(0, 6)
      .map((line) => (line.length > 120 ? `${line.slice(0, 120)}...` : line)),
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

  const fetchSandboxState = useCallback(
    async (id: string): Promise<SandboxStateCardData | null> => {
      setSandboxStateLoading(true);
      try {
        const result = await execInSandbox(id, 'cd /workspace && git status -sb --porcelain=1');
        if (result.exitCode !== 0) return null;

        const nextState = parseSandboxGitStatus(id, result.stdout);
        setSandboxState(nextState);
        return nextState;
      } catch {
        return null;
      } finally {
        setSandboxStateLoading(false);
      }
    },
    [],
  );

  const inspectNewChatWorkspace = useCallback(async (): Promise<NewChatWorkspaceState | null> => {
    if (sandboxStatus !== 'ready' || !sandboxId) return null;

    if (isScratch) {
      try {
        const result = await execInSandbox(
          sandboxId,
          "cd /workspace && total=$(find . -path './.git' -prune -o -type f -print | sed 's#^\\./##' | sort | wc -l | tr -d ' '); printf '__COUNT__%s\\n' \"$total\"; find . -path './.git' -prune -o -type f -print | sed 's#^\\./##' | sort | head -6",
        );
        if (result.exitCode !== 0) return null;

        const lines = result.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
        const countLine = lines.find((line) => line.startsWith('__COUNT__'));
        const fileCount = Number.parseInt(countLine?.slice('__COUNT__'.length) || '0', 10);
        if (!Number.isFinite(fileCount) || fileCount <= 0) return null;

        return {
          mode: 'scratch',
          sandboxId,
          branch: 'scratch',
          changedFiles: fileCount,
          stagedFiles: 0,
          unstagedFiles: fileCount,
          untrackedFiles: fileCount,
          preview: lines.filter((line) => !line.startsWith('__COUNT__')).slice(0, 6),
          fetchedAt: new Date().toISOString(),
        };
      } catch {
        return null;
      }
    }

    const nextState = await fetchSandboxState(sandboxId);
    if (!nextState || nextState.changedFiles <= 0) return null;

    return {
      mode: 'repo',
      sandboxId: nextState.sandboxId,
      branch: nextState.branch,
      changedFiles: nextState.changedFiles,
      stagedFiles: nextState.stagedFiles,
      unstagedFiles: nextState.unstagedFiles,
      untrackedFiles: nextState.untrackedFiles,
      preview: nextState.preview,
      fetchedAt: nextState.fetchedAt,
    };
  }, [fetchSandboxState, isScratch, sandboxId, sandboxStatus]);

  useEffect(() => {
    if (sandboxStatus !== 'ready' || !sandboxId) {
      if (sandboxStatus === 'idle') {
        setSandboxState(null);
        sandboxStateFetchedFor.current = null;
      }
      return;
    }
    if (sandboxStateFetchedFor.current === sandboxId) return;
    sandboxStateFetchedFor.current = sandboxId;
    void fetchSandboxState(sandboxId);
  }, [sandboxStatus, sandboxId, fetchSandboxState]);

  const ensureSandbox = useCallback(async (): Promise<string | null> => {
    if (sandboxId) return sandboxId;
    if (isScratch) return sandboxStart('', 'main');
    if (!workspaceRepo) return null;
    return sandboxStart(
      workspaceRepo.full_name,
      workspaceRepo.current_branch || workspaceRepo.default_branch,
    );
  }, [sandboxId, sandboxStart, isScratch, workspaceRepo]);

  useEffect(() => {
    setEnsureSandbox(ensureSandbox);
  }, [ensureSandbox, setEnsureSandbox]);

  useEffect(() => {
    setSandboxId(sandboxId);
    if (workspaceSession.kind === 'chat') return;
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
    onDisconnect();
  }, [abortStream, isStreaming, onDisconnect]);

  // Stop sandbox on unmount only — stopSandbox is extracted at the top
  // of the hook as a stable reference.
  useEffect(() => {
    return () => {
      void stopSandbox();
    };
  }, [stopSandbox]);

  return {
    showFileBrowser,
    setShowFileBrowser,
    sandboxState,
    sandboxStateLoading,
    sandboxDownloading,
    fetchSandboxState,
    inspectNewChatWorkspace,
    ensureSandbox,
    handleSandboxRestart,
    handleSandboxDownload,
    fileBrowserCapabilities,
    fileBrowserScratchActions,
    handleExitWorkspace,
    handleDisconnectFromWorkspace,
  };
}
