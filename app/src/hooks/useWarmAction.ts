/**
 * Accept-warm-run for work actions (Runtime Silence Census, Wave 3).
 *
 * The census law's corollary: a work action is never refused because the
 * runtime is cold. `run` warms the workspace via the sandbox controller's
 * `ensureSandbox` and then executes the action with the live id; the pressed
 * button renders `warming` as its progress affordance — the only visible
 * trace the warm is allowed to leave. `onUnavailable` fires only when the
 * warm itself fails, so refusal copy is replaced by honest failure copy.
 *
 * A second `run` while one is in flight is a no-op: the ref is reserved
 * before the first await, so a double-tap cannot race the warm into two
 * starts (see the check-then-write rule in CLAUDE.md's self-review pass).
 */
import { useCallback, useRef, useState } from 'react';

export interface WarmAction {
  /** True from tap until the warmed action settles — drives the pressed button's affordance. */
  warming: boolean;
  /** Warm, then run with the live workspace id. `onUnavailable` fires only if the warm fails. */
  run: (
    action: (workspaceId: string) => void | Promise<void>,
    onUnavailable: () => void,
  ) => Promise<void>;
}

export function useWarmAction(ensure: () => Promise<string | null>): WarmAction {
  const [warming, setWarming] = useState(false);
  const inFlightRef = useRef(false);

  const run = useCallback(
    async (action: (workspaceId: string) => void | Promise<void>, onUnavailable: () => void) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      setWarming(true);
      try {
        const id = await ensure();
        if (!id) {
          onUnavailable();
          return;
        }
        await action(id);
      } finally {
        inFlightRef.current = false;
        setWarming(false);
      }
    },
    [ensure],
  );

  return { warming, run };
}
