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
  probedScopes: readonly string[];
}

export interface RestoreDetectionPlan {
  state: RestoreDetectionPlanState;
  probe: { sandboxId: string; branch: string; repoFullName: string } | null;
}

export const INITIAL_RESTORE_DETECTION_PLAN_STATE: RestoreDetectionPlanState = {
  probedScopes: [],
};

/** Lane identity for dedup: a checkpoint is scoped by sandbox + repo + branch. */
function scopeKey(sandboxId: string, repoFullName: string, branch: string): string {
  return [sandboxId, repoFullName, branch].join('\u0000');
}

/**
 * Pure once-per-lane planner for checkpoint restore detection. Keyed on the full
 * scope (sandbox + repo + branch), NOT sandboxId alone: a typed branch switch
 * preserves the sandbox (see CLAUDE.md), so a sandbox-only key would suppress
 * detection for the new branch's checkpoints and leave a stale offer up. The hook
 * marks a scope as probed before the async detection starts so React re-renders
 * cannot duplicate the fetch.
 */
export function planAutoBackRestoreDetection(
  state: RestoreDetectionPlanState,
  ctx: WorkspaceSandboxRestoreContext,
): RestoreDetectionPlan {
  const branch = ctx.branch?.trim();
  if (!ctx.enabled || !ctx.sandboxId || !branch || !ctx.repoFullName) return { state, probe: null };
  const key = scopeKey(ctx.sandboxId, ctx.repoFullName, branch);
  if (state.probedScopes.includes(key)) return { state, probe: null };
  return {
    state: { probedScopes: [...state.probedScopes, key] },
    probe: { sandboxId: ctx.sandboxId, branch, repoFullName: ctx.repoFullName },
  };
}

export interface WorkspaceSandboxRestoreState {
  available: boolean;
  summary: string;
  contextLine: string | null;
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
  repoFullName: string | null;
  branch: string | null;
  available: boolean;
  summary: string;
  checkpointId: string | null;
  sourceRef: string | null;
  restoring: boolean;
  error: string | null;
}

interface ActiveRestoreScope {
  sandboxId: string | null;
  repoFullName: string | null;
  branch: string | null;
  enabled: boolean;
}

const initialBannerState: RestoreBannerState = {
  sandboxId: null,
  repoFullName: null,
  branch: null,
  available: false,
  summary: '',
  checkpointId: null,
  sourceRef: null,
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
  const activeScopeRef = useRef<ActiveRestoreScope>({
    sandboxId: null,
    repoFullName: null,
    branch: null,
    enabled: false,
  });

  useEffect(() => {
    activeScopeRef.current = {
      sandboxId,
      repoFullName,
      branch: branch?.trim() ?? null,
      enabled,
    };
  }, [sandboxId, branch, repoFullName, enabled]);

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
    const scopeStillMatchesProbe = () => {
      const current = activeScopeRef.current;
      return (
        current.enabled &&
        current.sandboxId === probe.sandboxId &&
        current.repoFullName === probe.repoFullName &&
        current.branch === probe.branch
      );
    };

    let cancelled = false;
    void (async () => {
      const input = {
        sandboxId: probe.sandboxId,
        branch: probe.branch,
        repoFullName: probe.repoFullName,
      };
      try {
        const availability = await detectRef.current(input);
        if (cancelled) return;
        if (!availability.available) {
          setBanner(initialBannerState);
          return;
        }
        if (!scopeStillMatchesProbe()) return;

        const offer: RestoreBannerState = {
          sandboxId: probe.sandboxId,
          repoFullName: probe.repoFullName,
          branch: probe.branch,
          available: true,
          summary: availability.summary,
          checkpointId: availability.checkpointId,
          sourceRef: availability.sourceRef ?? null,
          restoring: false,
          error: null,
        };
        setBanner(offer);
        console.log(
          JSON.stringify({
            level: 'info',
            event: 'checkpoint_restore_available',
            sandboxId: probe.sandboxId,
            repoFullName: probe.repoFullName,
            branch: probe.branch,
            checkpointId: availability.checkpointId,
            sourceRef: availability.sourceRef,
          }),
        );
      } catch (err: unknown) {
        if (cancelled || !scopeStillMatchesProbe()) return;
        const message = err instanceof Error ? err.message : String(err);
        setBanner({
          ...initialBannerState,
          sandboxId: probe.sandboxId,
          repoFullName: probe.repoFullName,
          branch: probe.branch,
          error: message,
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sandboxId, branch, repoFullName, enabled]);

  // Only show / allow restore when the banner's full lane scope matches the
  // current one — a branch switch on the same sandbox must not surface a stale
  // offer (Codex P2).
  const visible =
    enabled &&
    banner.available &&
    banner.sandboxId === sandboxId &&
    banner.repoFullName === repoFullName &&
    banner.branch === (branch?.trim() ?? null);

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
    let result: CheckpointRestoreResult;
    try {
      result = await applyRef.current({ sandboxId, branch, repoFullName, checkpointId });
    } catch (restoreErr) {
      const message = restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
      setBanner((current) => ({ ...current, restoring: false, error: message }));
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'checkpoint_restore_failed',
          sandboxId,
          repoFullName,
          branch,
          checkpointId,
          reason: message,
        }),
      );
      return;
    }
    if (result.status === 'restored') {
      setBanner(initialBannerState);
      console.log(
        JSON.stringify({
          level: 'info',
          event: 'checkpoint_restore_restored',
          sandboxId,
          repoFullName,
          branch,
          checkpointId: result.checkpointId,
        }),
      );
      return;
    }
    setBanner((current) => ({
      ...current,
      restoring: false,
      error: restoreErrorMessage(result),
    }));
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'checkpoint_restore_deferred',
        sandboxId,
        repoFullName,
        branch,
        checkpointId,
        status: result.status,
        reason: result.status === 'failed' ? result.reason : undefined,
      }),
    );
  }, [sandboxId, branch, repoFullName, banner.available, banner.checkpointId]);

  return {
    available: visible,
    summary: visible ? banner.summary : '',
    contextLine:
      visible && banner.sourceRef
        ? `Unpushed work from this chat exists at origin ref ${banner.sourceRef}; explicit restore is available.`
        : null,
    restore,
    dismiss,
    restoring: visible ? banner.restoring : false,
    error: visible ? banner.error : null,
  };
}
