import { useCallback, useEffect, useRef, useState } from 'react';
import {
  applyAutoBackRestore,
  detectAutoBackRestore,
  type RestoreAvailability,
  type RestoreResult,
} from '@/lib/sandbox-auto-back-restore';

export interface WorkspaceSandboxRestoreContext {
  sandboxId: string | null;
  branch: string | null | undefined;
  enabled: boolean;
}

export interface RestoreDetectionPlanState {
  probedSandboxIds: readonly string[];
}

export interface RestoreDetectionPlan {
  state: RestoreDetectionPlanState;
  probe: { sandboxId: string; branch: string } | null;
}

export const INITIAL_RESTORE_DETECTION_PLAN_STATE: RestoreDetectionPlanState = {
  probedSandboxIds: [],
};

/**
 * Pure once-per-sandbox planner for auto-back restore detection. The hook marks
 * a sandbox as probed before the async detection starts so React re-renders
 * cannot duplicate the fetch.
 */
export function planAutoBackRestoreDetection(
  state: RestoreDetectionPlanState,
  ctx: WorkspaceSandboxRestoreContext,
): RestoreDetectionPlan {
  const branch = ctx.branch?.trim();
  if (!ctx.enabled || !ctx.sandboxId || !branch) return { state, probe: null };
  if (state.probedSandboxIds.includes(ctx.sandboxId)) return { state, probe: null };
  return {
    state: { probedSandboxIds: [...state.probedSandboxIds, ctx.sandboxId] },
    probe: { sandboxId: ctx.sandboxId, branch },
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

export interface UseWorkspaceSandboxRestoreArgs extends WorkspaceSandboxRestoreContext {
  detect?: typeof detectAutoBackRestore;
  apply?: typeof applyAutoBackRestore;
}

interface RestoreBannerState {
  sandboxId: string | null;
  available: boolean;
  summary: string;
  sha: string | null;
  restoring: boolean;
  error: string | null;
}

const initialBannerState: RestoreBannerState = {
  sandboxId: null,
  available: false,
  summary: '',
  sha: null,
  restoring: false,
  error: null,
};

function restoreErrorMessage(result: Exclude<RestoreResult, { status: 'restored' }>): string {
  if (result.status === 'skipped-dirty') {
    return 'Restore skipped because the workspace changed.';
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
  enabled,
  detect = detectAutoBackRestore,
  apply = applyAutoBackRestore,
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

    const plan = planAutoBackRestoreDetection(planRef.current, { sandboxId, branch, enabled });
    planRef.current = plan.state;
    if (!plan.probe) return;
    const probe = plan.probe;

    let cancelled = false;
    detectRef
      .current(probe.sandboxId, probe.branch)
      .then((availability: RestoreAvailability) => {
        if (cancelled) return;
        if (!availability.available) {
          setBanner(initialBannerState);
          return;
        }
        setBanner({
          sandboxId: probe.sandboxId,
          available: true,
          summary: availability.summary,
          sha: availability.sha,
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
  }, [sandboxId, branch, enabled]);

  const visible = enabled && banner.sandboxId === sandboxId && banner.available;

  const dismiss = useCallback(() => {
    setBanner(initialBannerState);
  }, []);

  const restore = useCallback(async () => {
    if (!sandboxId || !branch || !banner.available || !banner.sha) return;
    // Pin the SHA detection summarized — apply bails if the ref has since moved
    // (a new auto-back), so we never restore a different backup than offered.
    const sha = banner.sha;
    setBanner((current) =>
      current.available ? { ...current, restoring: true, error: null } : current,
    );
    const result = await applyRef.current(sandboxId, branch, sha);
    if (result.status === 'restored') {
      setBanner(initialBannerState);
      return;
    }
    setBanner((current) => ({
      ...current,
      restoring: false,
      error: restoreErrorMessage(result),
    }));
  }, [sandboxId, branch, banner.available, banner.sha]);

  return {
    available: visible,
    summary: visible ? banner.summary : '',
    restore,
    dismiss,
    restoring: visible ? banner.restoring : false,
    error: visible ? banner.error : null,
  };
}
