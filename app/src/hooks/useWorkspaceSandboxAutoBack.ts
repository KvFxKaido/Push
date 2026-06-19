/**
 * useWorkspaceSandboxAutoBack — B2 auto-back coordinator (increment 1b).
 *
 * Wires the working-tree backup primitive (`backUpWorkingTree`) to a cadence so
 * the cloud sandbox is continuously mirrored to its durable `draft/auto/<branch>`
 * ref while work is happening. Cadence (decided): **debounce after edits +
 * flush before the tab goes away.**
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
import { backUpWorkingTree, type AutoBackResult } from '@/lib/sandbox-auto-back';

export const AUTO_BACK_DEBOUNCE_MS = 45_000;

export interface AutoBackContext {
  sandboxId: string | null;
  branch: string | null | undefined;
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
   * `lastBacked` is the (tree, head) of the most recent successful backup for
   * the *same branch* this session, so the primitive can skip re-pushing when
   * both still match (#982). Both are needed: the restore path only accepts a
   * backup whose parent == current HEAD, so a same-tree snapshot on a newer
   * HEAD must still push. Undefined on the first backup or after a branch change.
   */
  backUp: (
    sandboxId: string,
    branch: string,
    lastBacked?: { tree: string; head: string },
  ) => Promise<AutoBackResult>;
}

/**
 * Pure debounce/coalesce/flush state machine for auto-back. Uses the ambient
 * `setTimeout`/`clearTimeout` so tests drive it with fake timers.
 */
export function createAutoBackScheduler(deps: AutoBackSchedulerDeps): AutoBackScheduler {
  const { debounceMs, getContext, backUp } = deps;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let pending = false; // a mutation arrived while a backup was running
  let disposed = false;
  // (tree, head) of the last backup we pushed (or skipped as unchanged), with
  // the branch it belonged to — passed back into the primitive to dedup an
  // unchanged re-push (#982). Reset implicitly when the branch differs; HEAD is
  // tracked so a commit (new HEAD, same tree) still re-pushes onto the new base.
  let lastBacked: { branch: string; tree: string; head: string } | null = null;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const runBackup = async () => {
    clearTimer();
    if (disposed) return;
    const { sandboxId, branch, enabled } = getContext();
    if (!enabled || !sandboxId || !branch) return;
    if (inFlight) {
      // Coalesce: a backup is already running; re-run once it finishes.
      pending = true;
      return;
    }
    inFlight = true;
    pending = false;
    try {
      const carried =
        lastBacked?.branch === branch
          ? { tree: lastBacked.tree, head: lastBacked.head }
          : undefined;
      const result = await backUp(sandboxId, branch, carried);
      // Pin (tree, head) on a real push or an unchanged skip — both confirm the
      // durable ref holds this tree on this base, so the next identical snapshot
      // can dedup.
      if (result.status === 'backed-up' || result.status === 'unchanged') {
        lastBacked = { branch, tree: result.tree, head: result.head };
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
  /** Gate the coordinator (e.g. only when the sandbox is ready). Default true. */
  enabled?: boolean;
  /** Debounce after the last mutation. Default AUTO_BACK_DEBOUNCE_MS. */
  debounceMs?: number;
  /** Injectable for tests. */
  backUp?: typeof backUpWorkingTree;
}

export function useWorkspaceSandboxAutoBack({
  sandboxId,
  branch,
  enabled = true,
  debounceMs = AUTO_BACK_DEBOUNCE_MS,
  backUp = backUpWorkingTree,
}: UseWorkspaceSandboxAutoBackArgs): void {
  // Latest context for the scheduler's callbacks — avoids re-subscribing on
  // every branch/status change while still reading current values. Synced in an
  // effect (not during render) so the scheduler, whose callbacks fire on async
  // events after commit, always reads current values.
  const ctxRef = useRef<AutoBackContext>({ sandboxId, branch, enabled });
  const backUpRef = useRef(backUp);
  useEffect(() => {
    ctxRef.current = { sandboxId, branch, enabled };
    backUpRef.current = backUp;
  });

  useEffect(() => {
    const scheduler = createAutoBackScheduler({
      debounceMs,
      getContext: () => ctxRef.current,
      backUp: (id, br, lastBacked) =>
        backUpRef.current(id, br, {
          lastBackedTree: lastBacked?.tree,
          lastBackedHead: lastBacked?.head,
        }),
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
