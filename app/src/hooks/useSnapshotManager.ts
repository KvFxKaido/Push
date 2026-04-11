import { useState, useCallback, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import {
  createSnapshot,
  saveSnapshotToIndexedDB,
  getLatestSnapshotBlob,
  getLatestSnapshotMeta,
  hydrateSnapshot,
  type SnapshotMeta,
  type HydrateProgress,
} from '@/lib/snapshot-manager';
import type { ActiveRepo, WorkspaceScratchActions, WorkspaceSession } from '@/types';
import type { SandboxStatus } from '@/hooks/useSandbox';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;
const SNAPSHOT_IDLE_MS = 5 * 60 * 1000;
const SNAPSHOT_HARD_CAP_MS = 4 * 60 * 60 * 1000;
const SNAPSHOT_MIN_GAP_MS = 60 * 1000;
export const SNAPSHOT_STALE_MS = 7 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function formatSnapshotAge(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  if (diffMs < 60_000) return 'just now';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function isSnapshotStale(createdAt: number): boolean {
  return Date.now() - createdAt > SNAPSHOT_STALE_MS;
}

export function snapshotStagePercent(stage: HydrateProgress['stage']): number {
  switch (stage) {
    case 'uploading':
      return 20;
    case 'restoring':
      return 60;
    case 'validating':
      return 85;
    case 'done':
      return 100;
    default:
      return 0;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SnapshotManager {
  latestSnapshot: SnapshotMeta | null;
  snapshotSaving: boolean;
  snapshotRestoring: boolean;
  snapshotRestoreProgress: HydrateProgress | null;
  markSnapshotActivity: () => void;
  captureSnapshot: (reason: 'manual' | 'interval' | 'idle') => Promise<boolean>;
  handleRestoreFromSnapshot: () => Promise<void>;
  refreshLatestSnapshot: () => Promise<void>;
}

interface BuildWorkspaceScratchActionsOptions {
  snapshots: Pick<
    SnapshotManager,
    | 'latestSnapshot'
    | 'snapshotSaving'
    | 'snapshotRestoring'
    | 'captureSnapshot'
    | 'handleRestoreFromSnapshot'
  >;
  sandboxStatus: SandboxStatus;
  downloadingWorkspace: boolean;
  onDownloadWorkspace: () => void;
  emptyStateText: string;
}

export function buildWorkspaceScratchActions({
  snapshots,
  sandboxStatus,
  downloadingWorkspace,
  onDownloadWorkspace,
  emptyStateText,
}: BuildWorkspaceScratchActionsOptions): WorkspaceScratchActions {
  const snapshotAgeLabel = snapshots.latestSnapshot
    ? formatSnapshotAge(snapshots.latestSnapshot.createdAt)
    : 'recently';
  const snapshotIsStale = snapshots.latestSnapshot
    ? isSnapshotStale(snapshots.latestSnapshot.createdAt)
    : false;

  return {
    statusText: snapshots.latestSnapshot
      ? snapshotIsStale
        ? `Latest snapshot stale (${snapshotAgeLabel})`
        : `Latest snapshot ${snapshotAgeLabel}`
      : emptyStateText,
    tone: snapshotIsStale ? 'stale' : 'default',
    canSaveSnapshot:
      sandboxStatus === 'ready' && !snapshots.snapshotSaving && !snapshots.snapshotRestoring,
    canRestoreSnapshot:
      Boolean(snapshots.latestSnapshot) &&
      !snapshots.snapshotSaving &&
      !snapshots.snapshotRestoring &&
      sandboxStatus !== 'creating',
    canDownloadWorkspace: sandboxStatus === 'ready' && !downloadingWorkspace,
    snapshotSaving: snapshots.snapshotSaving,
    snapshotRestoring: snapshots.snapshotRestoring,
    downloadingWorkspace,
    onSaveSnapshot: () => {
      void snapshots.captureSnapshot('manual');
    },
    onRestoreSnapshot: () => {
      void snapshots.handleRestoreFromSnapshot();
    },
    onDownloadWorkspace,
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useSnapshotManager(
  workspaceSession: WorkspaceSession | null,
  sandbox: {
    sandboxId: string | null;
    status: SandboxStatus;
    start: (repo: string, branch: string) => Promise<string | null>;
  },
  activeRepo: ActiveRepo | null,
  isStreaming: boolean,
): SnapshotManager {
  const isScratch = workspaceSession?.kind === 'scratch';
  const sessionId = workspaceSession?.id;
  const [latestSnapshot, setLatestSnapshot] = useState<SnapshotMeta | null>(null);
  const [snapshotSaving, setSnapshotSaving] = useState(false);
  const [snapshotRestoring, setSnapshotRestoring] = useState(false);
  const [snapshotRestoreProgress, setSnapshotRestoreProgress] = useState<HydrateProgress | null>(
    null,
  );

  const snapshotLastActivityRef = useRef<number>(Date.now());
  const snapshotLastSavedAtRef = useRef<number>(0);
  const snapshotSessionStartedAtRef = useRef<number>(Date.now());
  const snapshotHardCapNotifiedRef = useRef(false);

  const markSnapshotActivity = useCallback(() => {
    snapshotLastActivityRef.current = Date.now();
  }, []);

  const refreshLatestSnapshot = useCallback(async () => {
    try {
      const meta = await getLatestSnapshotMeta(sessionId);
      setLatestSnapshot(meta);
    } catch {
      setLatestSnapshot(null);
    }
  }, [sessionId]);

  const captureSnapshot = useCallback(
    async (reason: 'manual' | 'interval' | 'idle') => {
      if (!sandbox.sandboxId || sandbox.status !== 'ready') return false;
      const now = Date.now();
      if (reason !== 'manual' && now - snapshotLastSavedAtRef.current < SNAPSHOT_MIN_GAP_MS) {
        return false;
      }

      setSnapshotSaving(true);
      try {
        const blob = await createSnapshot('/workspace', sandbox.sandboxId);
        const label = `workspace-${new Date().toISOString()}`;
        await saveSnapshotToIndexedDB(label, blob, sessionId);
        snapshotLastSavedAtRef.current = Date.now();
        await refreshLatestSnapshot();
        if (reason === 'manual') {
          toast.success('Snapshot saved');
        }
        return true;
      } catch (err) {
        if (reason === 'manual') {
          const message = err instanceof Error ? err.message : 'Snapshot save failed';
          toast.error(message);
        }
        return false;
      } finally {
        setSnapshotSaving(false);
      }
    },
    [sandbox.sandboxId, sandbox.status, sessionId, refreshLatestSnapshot],
  );

  const handleRestoreFromSnapshot = useCallback(async () => {
    if (snapshotRestoring) return;
    const blob = await getLatestSnapshotBlob(sessionId);
    if (!blob) {
      toast.error('No snapshot found');
      return;
    }

    let targetSandboxId = sandbox.sandboxId;
    if (!targetSandboxId) {
      targetSandboxId = isScratch
        ? await sandbox.start('', 'main')
        : activeRepo
          ? await sandbox.start(
              activeRepo.full_name,
              activeRepo.current_branch || activeRepo.default_branch,
            )
          : null;
    }
    if (!targetSandboxId) {
      toast.error('Sandbox is not ready');
      return;
    }

    const shouldProceed =
      !sandbox.sandboxId || window.confirm('Restore will overwrite files in /workspace. Continue?');
    if (!shouldProceed) return;

    setSnapshotRestoring(true);
    setSnapshotRestoreProgress({ stage: 'uploading', message: 'Uploading snapshot...' });
    try {
      const result = await hydrateSnapshot(
        blob,
        '/workspace',
        targetSandboxId,
        setSnapshotRestoreProgress,
      );
      if (!result.ok) {
        toast.error(result.error || 'Restore failed');
        return;
      }
      markSnapshotActivity();
      toast.success(`Snapshot restored (${result.restoredFiles ?? 0} files)`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Restore failed';
      toast.error(message);
    } finally {
      setSnapshotRestoring(false);
      setSnapshotRestoreProgress(null);
    }
  }, [snapshotRestoring, sandbox, isScratch, sessionId, activeRepo, markSnapshotActivity]);

  // Load latest snapshot metadata when scratch workspace is active
  useEffect(() => {
    if (!isScratch) return;
    refreshLatestSnapshot();
  }, [isScratch, refreshLatestSnapshot]);

  // Snapshot activity heartbeat: user input + chat agent activity
  useEffect(() => {
    if (!isScratch) return;
    const mark = () => markSnapshotActivity();
    window.addEventListener('keydown', mark);
    window.addEventListener('pointerdown', mark);
    return () => {
      window.removeEventListener('keydown', mark);
      window.removeEventListener('pointerdown', mark);
    };
  }, [isScratch, markSnapshotActivity]);

  useEffect(() => {
    if (isStreaming) markSnapshotActivity();
  }, [isStreaming, markSnapshotActivity]);

  // Reset session timer when new sandbox created
  useEffect(() => {
    if (!sandbox.sandboxId) return;
    snapshotSessionStartedAtRef.current = Date.now();
    snapshotHardCapNotifiedRef.current = false;
  }, [sandbox.sandboxId]);

  // Auto-save every 5 minutes and on idle heartbeat, with a 4-hour hard cap
  useEffect(() => {
    if (!isScratch || sandbox.status !== 'ready' || !sandbox.sandboxId) return;
    const timer = window.setInterval(async () => {
      const now = Date.now();
      const age = now - snapshotSessionStartedAtRef.current;
      if (age > SNAPSHOT_HARD_CAP_MS) {
        if (!snapshotHardCapNotifiedRef.current) {
          snapshotHardCapNotifiedRef.current = true;
          toast.message('Snapshot autosave paused after 4 hours');
        }
        return;
      }

      const lastSavedAgo = now - snapshotLastSavedAtRef.current;
      const idleFor = now - snapshotLastActivityRef.current;
      if (lastSavedAgo >= SNAPSHOT_INTERVAL_MS) {
        await captureSnapshot('interval');
        return;
      }
      if (idleFor >= SNAPSHOT_IDLE_MS) {
        await captureSnapshot('idle');
      }
    }, 15_000);

    return () => window.clearInterval(timer);
  }, [isScratch, sandbox.status, sandbox.sandboxId, captureSnapshot]);

  return {
    latestSnapshot,
    snapshotSaving,
    snapshotRestoring,
    snapshotRestoreProgress,
    markSnapshotActivity,
    captureSnapshot,
    handleRestoreFromSnapshot,
    refreshLatestSnapshot,
  };
}
