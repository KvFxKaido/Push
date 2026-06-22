/**
 * useWorkspaceSandboxAutoBack — B2 auto-back coordinator (increment 1b).
 *
 * Wires checkpoint *capture* — via the active `CheckpointStore`
 * (`resolveCheckpointStore`) — to a cadence so in-progress work is continuously
 * checkpointed while it's happening. On web/cloud the store is the remote
 * draft-ref backend (`backUpWorkingTree` → `origin/draft/auto/<branch>`); on the
 * native APK shell it's the on-device store (flagged). The coordinator is
 * storage-agnostic: it threads an opaque dedup token and reads only a status.
 * Cadence (decided): **debounce after edits + flush before the tab goes away.**
 *
 * - Mutations are observed via `onWorkspaceMutation` — a client-side signal
 *   emitted at tool dispatch on a successful file mutation / mutating exec (see
 *   `sandbox-mutation-signal.ts`). Provider-agnostic (not the sandbox's
 *   `workspace_revision`, which is always 0 on Cloudflare) and self-loop-free
 *   (auto-back's own push bypasses the dispatcher, so it can't re-trigger).
 * - A burst of edits debounces to one backup `AUTO_BACK_DEBOUNCE_MS` after the
 *   last mutation.
 * - `visibilitychange → hidden` flushes a pending backup immediately (the user
 *   is leaving; the sandbox is still reachable server-side, so a final push
 *   lands). The 45s debounce already fires well before the 8-min idle hibernate,
 *   so this only covers the leaving-mid-debounce edge.
 *
 * The schedule/coalesce/flush logic lives in a pure `createAutoBackScheduler` so
 * it's testable with fake timers; the hook is the thin React glue (refs for the
 * latest context + subscription + cleanup).
 *
 * Web/cloud-sandbox scoped. Increment 2 (automated recovery on sandbox loss +
 * UI surfacing) is separate.
 */

import { useEffect, useRef } from 'react';
import { onWorkspaceMutation } from '@/lib/sandbox-mutation-signal';
import { resolveCheckpointStore } from '@/lib/checkpoint/resolve-store';
import type {
  CheckpointCaptureInput,
  CheckpointCaptureResult,
} from '@/lib/checkpoint/checkpoint-store';

export const AUTO_BACK_DEBOUNCE_MS = 45_000;

export interface AutoBackContext {
  sandboxId: string | null;
  branch: string | null | undefined;
  /** Durable repo identity — the native store keys its on-device dir on it. */
  repoFullName: string | null;
  enabled: boolean;
}

export interface AutoBackScheduler {
  /** A workspace mutation occurred for `sandboxId` — (re)arm the debounce. */
  onMutation(sandboxId: string): void;
  /** Run a pending backup immediately (e.g. the tab is being hidden). */
  flush(): void;
  /** Stop scheduling and cancel any pending timer. */
  dispose(): void;
}

interface AutoBackSchedulerDeps {
  debounceMs: number;
  /** Read the latest context — the hook backs this with refs. */
  getContext: () => AutoBackContext;
  /**
   * Capture a checkpoint via the active CheckpointStore. `priorToken` is the
   * opaque dedup token of the most recent successful capture for the *same
   * branch* this session, threaded back so the store can skip redundant work
   * when nothing changed (#982). The scheduler never interprets the token —
   * the store encodes whatever identity it needs (the remote store: `tree:head`).
   * Undefined on the first capture or after a branch change.
   */
  capture: (input: CheckpointCaptureInput) => Promise<CheckpointCaptureResult>;
}

/**
 * Pure debounce/coalesce/flush state machine for auto-back. Uses the ambient
 * `setTimeout`/`clearTimeout` so tests drive it with fake timers.
 */
export function createAutoBackScheduler(deps: AutoBackSchedulerDeps): AutoBackScheduler {
  const { debounceMs, getContext, capture } = deps;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let pending = false; // a mutation arrived while a backup was running
  let disposed = false;
  // Opaque dedup token of the last successful capture (or unchanged skip), with
  // the branch it belonged to — passed back into the store to dedup an unchanged
  // re-capture (#982). Reset implicitly when the branch differs; the token
  // encodes base identity so a commit (new HEAD, same tree) still re-captures.
  let lastBacked: { branch: string; token: string } | null = null;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const runBackup = async () => {
    clearTimer();
    if (disposed) return;
    const { sandboxId, branch, repoFullName, enabled } = getContext();
    if (!enabled || !sandboxId || !branch || !repoFullName) {
      // Symmetric structured log (CLAUDE.md): a fired debounce that finds the
      // context not ready is otherwise invisible — exactly the silent path that
      // masked the inline-lane trigger gap (device finding 2026-06-22). Pairs
      // with the eventual capture success/failure events.
      console.log(
        JSON.stringify({
          level: 'info',
          event: 'auto_back_skipped_unready',
          enabled,
          hasSandbox: Boolean(sandboxId),
          hasBranch: Boolean(branch),
          hasRepo: Boolean(repoFullName),
        }),
      );
      return;
    }
    if (inFlight) {
      // Coalesce: a backup is already running; re-run once it finishes.
      pending = true;
      return;
    }
    inFlight = true;
    pending = false;
    try {
      const priorToken = lastBacked?.branch === branch ? lastBacked.token : undefined;
      const result = await capture({ repoFullName, sandboxId, branch, priorToken });
      // Pin the token on a real capture or an unchanged skip — both confirm the
      // store holds this content on this base, so the next identical snapshot
      // can dedup.
      if (result.status === 'captured' || result.status === 'unchanged') {
        lastBacked = { branch, token: result.dedupToken };
      }
    } finally {
      inFlight = false;
      if (!disposed && pending) {
        pending = false;
        schedule();
      }
    }
  };

  const schedule = () => {
    if (disposed || !getContext().enabled) return;
    clearTimer();
    timer = setTimeout(() => void runBackup(), debounceMs);
  };

  return {
    onMutation(sandboxId: string) {
      if (disposed) return;
      const ctx = getContext();
      if (!ctx.enabled || sandboxId !== ctx.sandboxId) return;
      schedule();
    },
    flush() {
      if (disposed || !timer) return; // nothing pending
      void runBackup();
    },
    dispose() {
      disposed = true;
      clearTimer();
    },
  };
}

export interface UseWorkspaceSandboxAutoBackArgs {
  sandboxId: string | null;
  branch: string | null | undefined;
  /** Durable repo identity (owner/name); required for the native checkpoint store. */
  repoFullName: string | null;
  /** Gate the coordinator (e.g. only when the sandbox is ready). Default true. */
  enabled?: boolean;
  /** Debounce after the last mutation. Default AUTO_BACK_DEBOUNCE_MS. */
  debounceMs?: number;
  /**
   * Capture function override (tests inject a fake). Defaults to the active
   * CheckpointStore's `capture`, resolved per-call so the platform/flag pick
   * is current.
   */
  capture?: (input: CheckpointCaptureInput) => Promise<CheckpointCaptureResult>;
}

const defaultCapture = (input: CheckpointCaptureInput): Promise<CheckpointCaptureResult> =>
  resolveCheckpointStore().capture(input);

export function useWorkspaceSandboxAutoBack({
  sandboxId,
  branch,
  repoFullName,
  enabled = true,
  debounceMs = AUTO_BACK_DEBOUNCE_MS,
  capture = defaultCapture,
}: UseWorkspaceSandboxAutoBackArgs): void {
  // Latest context for the scheduler's callbacks — avoids re-subscribing on
  // every branch/status change while still reading current values. Synced in an
  // effect (not during render) so the scheduler, whose callbacks fire on async
  // events after commit, always reads current values.
  const ctxRef = useRef<AutoBackContext>({ sandboxId, branch, repoFullName, enabled });
  const captureRef = useRef(capture);
  useEffect(() => {
    ctxRef.current = { sandboxId, branch, repoFullName, enabled };
    captureRef.current = capture;
  });

  useEffect(() => {
    const scheduler = createAutoBackScheduler({
      debounceMs,
      getContext: () => ctxRef.current,
      capture: (input) => captureRef.current(input),
    });
    const unsubscribe = onWorkspaceMutation((mutatedSandboxId) => {
      scheduler.onMutation(mutatedSandboxId);
    });
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') scheduler.flush();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      unsubscribe();
      document.removeEventListener('visibilitychange', onVisibility);
      scheduler.dispose();
    };
  }, [debounceMs]);
}
