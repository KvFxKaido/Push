import { useCallback, useEffect, useRef, useState } from 'react';
import { resolveCheckpointStore } from '@/lib/checkpoint/resolve-store';
import type {
  CheckpointDetectInput,
  CheckpointRestoreAvailability,
  CheckpointRestoreInput,
  CheckpointRestoreResult,
} from '@/lib/checkpoint/checkpoint-store';

export interface WorkspaceSandboxRestoreContext {
  sandboxId: string | null;
  branch: string | null | undefined;
  /** Durable repo identity — the native checkpoint store keys its dir on it. */
  repoFullName: string | null;
  enabled: boolean;
}

export interface RestoreDetectionPlanState {
  probedSandboxIds: readonly string[];
}

export interface RestoreDetectionPlan {
  state: RestoreDetectionPlanState;
  probe: { sandboxId: string; branch: string; repoFullName: string } | null;
}

export const INITIAL_RESTORE_DETECTION_PLAN_STATE: RestoreDetectionPlanState = {
  probedSandboxIds: [],
};

/**
 * Pure once-per-sandbox planner for checkpoint restore detection. The hook marks
 * a sandbox as probed before the async detection starts so React re-renders
 * cannot duplicate the fetch.
 */
export function planAutoBackRestoreDetection(
  state: RestoreDetectionPlanState,
  ctx: WorkspaceSandboxRestoreContext,
): RestoreDetectionPlan {
  const branch = ctx.branch?.trim();
  if (!ctx.enabled || !ctx.sandboxId || !branch || !ctx.repoFullName) return { state, probe: null };
  if (state.probedSandboxIds.includes(ctx.sandboxId)) return { state, probe: null };
  return {
    state: { probedSandboxIds: [...state.probedSandboxIds, ctx.sandboxId] },
    probe: { sandboxId: ctx.sandboxId, branch, repoFullName: ctx.repoFullName },
  };
}

export interface WorkspaceSandboxRestoreState {
  available: boolean;
  summary: string;
  restore: () => Promise<void>;
  dismiss: () => void;
  restoring: boolean;
  error: string | null;
}

type DetectFn = (input: CheckpointDetectInput) => Promise<CheckpointRestoreAvailability>;
type RestoreFn = (input: CheckpointRestoreInput) => Promise<CheckpointRestoreResult>;

/** Defaults resolve the active CheckpointStore per-call (platform/flag current). */
const defaultDetect: DetectFn = (input) => resolveCheckpointStore().detectRestore(input);
const defaultRestore: RestoreFn = (input) => resolveCheckpointStore().restore(input);

export interface UseWorkspaceSandboxRestoreArgs extends WorkspaceSandboxRestoreContext {
  detect?: DetectFn;
  apply?: RestoreFn;
}

interface RestoreBannerState {
  sandboxId: string | null;
  available: boolean;
  summary: string;
  checkpointId: string | null;
  restoring: boolean;
  error: string | null;
}

const initialBannerState: RestoreBannerState = {
  sandboxId: null,
  available: false,
  summary: '',
  checkpointId: null,
  restoring: false,
  error: null,
};

function restoreErrorMessage(
  result: Exclude<CheckpointRestoreResult, { status: 'restored' }>,
): string {
  if (result.status === 'skipped-dirty') {
    return 'Restore skipped because the workspace changed.';
  }
  if (result.status === 'unsupported') {
    return 'Restore is not available for this workspace.';
  }
  if (result.reason === 'backup_changed') {
    return 'The backup was updated — dismiss and reopen to restore the latest.';
  }
  if (result.reason === 'stale_base') {
    return 'The branch moved since this backup, so it can no longer be restored cleanly.';
  }
  return result.reason || 'Restore failed.';
}

export function useWorkspaceSandboxRestore({
  sandboxId,
  branch,
  repoFullName,
  enabled,
  detect = defaultDetect,
  apply = defaultRestore,
}: UseWorkspaceSandboxRestoreArgs): WorkspaceSandboxRestoreState {
  const [banner, setBanner] = useState<RestoreBannerState>(initialBannerState);
  const planRef = useRef<RestoreDetectionPlanState>(INITIAL_RESTORE_DETECTION_PLAN_STATE);
  const detectRef = useRef(detect);
  const applyRef = useRef(apply);

  useEffect(() => {
    detectRef.current = detect;
    applyRef.current = apply;
  }, [detect, apply]);

  useEffect(() => {
    if (!enabled || !sandboxId) return;

    const plan = planAutoBackRestoreDetection(planRef.current, {
      sandboxId,
      branch,
      repoFullName,
      enabled,
    });
    planRef.current = plan.state;
    if (!plan.probe) return;
    const probe = plan.probe;

    let cancelled = false;
    detectRef
      .current({
        sandboxId: probe.sandboxId,
        branch: probe.branch,
        repoFullName: probe.repoFullName,
      })
      .then((availability: CheckpointRestoreAvailability) => {
        if (cancelled) return;
        if (!availability.available) {
          setBanner(initialBannerState);
          return;
        }
        setBanner({
          sandboxId: probe.sandboxId,
          available: true,
          summary: availability.summary,
          checkpointId: availability.checkpointId,
          restoring: false,
          error: null,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setBanner({ ...initialBannerState, sandboxId: probe.sandboxId, error: message });
      });

    return () => {
      cancelled = true;
    };
  }, [sandboxId, branch, repoFullName, enabled]);

  const visible = enabled && banner.sandboxId === sandboxId && banner.available;

  const dismiss = useCallback(() => {
    setBanner(initialBannerState);
  }, []);

  const restore = useCallback(async () => {
    if (!sandboxId || !branch || !repoFullName || !banner.available || !banner.checkpointId) return;
    // Pin the checkpoint detection summarized — the store's restore re-checks the
    // backup, so we never restore a different checkpoint than the one offered.
    const checkpointId = banner.checkpointId;
    setBanner((current) =>
      current.available ? { ...current, restoring: true, error: null } : current,
    );
    const result = await applyRef.current({ sandboxId, branch, repoFullName, checkpointId });
    if (result.status === 'restored') {
      setBanner(initialBannerState);
      return;
    }
    setBanner((current) => ({
      ...current,
      restoring: false,
      error: restoreErrorMessage(result),
    }));
  }, [sandboxId, branch, repoFullName, banner.available, banner.checkpointId]);

  return {
    available: visible,
    summary: visible ? banner.summary : '',
    restore,
    dismiss,
    restoring: visible ? banner.restoring : false,
    error: visible ? banner.error : null,
  };
}
