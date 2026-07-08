/**
 * lib/git/auditor-push-gate.ts — builds a `PrePushGate` over the model Auditor.
 *
 * Move A of "Gate at Push" relocates the SAFE/UNSAFE Auditor verdict from the
 * commit step (where it audited the uncommitted working-tree diff) to the push
 * step, over the *cumulative* diff a push will actually upload — the unit that
 * ships. That diff is the same one the secret scan inspects (`computePushedDiff`
 * in `pushed-diff.ts`), so the two gates review identical content at the same
 * boundary, including the no-upstream / brand-new-branch cases.
 *
 * Kept out of `push-git.ts` (and free of any `auditor-agent` import) the same
 * way the secret-scan gate is: the caller injects an `audit` closure built over
 * the real Auditor runner (provider lock, file contexts, run events), so
 * `lib/git/` never depends on the agent kernels.
 *
 * Failure posture is deliberately split by *source*:
 *   - **A local diff read failing** (`getDiff` returns null/empty or throws)
 *     fails OPEN — same posture, same condition, same justification as the
 *     secret-scan gate: `computePushedDiff` is a local git/JGit read, a hiccup
 *     must not brick every push, and the secret scan already fails open on the
 *     identical failure, so this adds no exposure beyond the accepted baseline.
 *   - **The Auditor backend failing** (`audit` throws — provider down, timeout,
 *     rate-limit) fails CLOSED and marks the verdict `retryable`. Unlike the
 *     deterministic local read, the LLM call is the unreliable part; failing
 *     open here would silently ship unaudited deliveries at real frequency.
 *     Blocking with a *retryable* reason keeps the ship boundary intact while
 *     telling the caller "the Auditor was unreachable, retry" — NOT "your code
 *     is unsafe" (CLAUDE.md: never lump infra trouble into the verdict bucket).
 *   - **An UNSAFE verdict** blocks terminally (the reason is the verdict itself,
 *     not a retry hint; `retryable` stays unset).
 *
 * Symmetric structured logs, one per branch (see CLAUDE.md):
 * `auditor_push_clean` ↔ `auditor_push_blocked` ↔ `auditor_push_skipped` ↔
 * `auditor_push_no_diff` ↔ `auditor_push_diff_error` ↔ `auditor_push_error`.
 */

import type { PrePushGate, PushOptions } from './push-git.js';

type LogLevel = 'info' | 'warn' | 'error';
type LogFn = (level: LogLevel, event: string, ctx: Record<string, unknown>) => void;

const defaultLog: LogFn = (level, event, ctx) => {
  console.log(JSON.stringify({ level, event, ...ctx }));
};

/** The verdict the injected Auditor adapter returns over a pushed diff. */
export interface AuditorPushVerdict {
  verdict: 'safe' | 'unsafe';
  /** Short reason surfaced when UNSAFE (the Auditor card summary). */
  summary: string;
}

export interface AuditorPrePushGateOptions {
  /**
   * Resolve the cumulative diff a push will upload — the handler wires this to
   * `computePushedDiff` over the same git/JGit source the backend uses.
   * Receives the push options so it can scope to the destination `ref`. Return
   * `null`/empty when nothing resolves (the gate then skips, logging
   * `auditor_push_no_diff`).
   */
  getDiff: (opts?: PushOptions) => Promise<string | null> | string | null;
  /**
   * Run the Auditor over the resolved diff. The handler adapts the real runner
   * down to diff → verdict. A throw is treated as a backend failure: the gate
   * fails closed + `retryable`.
   */
  audit: (diff: string) => Promise<AuditorPushVerdict>;
  /** Whether the gate runs. Defaults to true; pass the resolved policy value. */
  enabled?: boolean;
  /** Injectable for tests; defaults to a JSON-line `console.log`. */
  log?: LogFn;
}

export function makeAuditorPrePushGate(opts: AuditorPrePushGateOptions): PrePushGate {
  const { getDiff, audit, enabled = true, log = defaultLog } = opts;
  return async (pushOpts?: PushOptions) => {
    if (!enabled) {
      log('info', 'auditor_push_skipped', { reason: 'disabled' });
      return { ok: true };
    }

    let diff: string | null;
    try {
      diff = await getDiff(pushOpts);
    } catch (err) {
      // Local diff read (git) failed — fail OPEN, mirroring the secret-scan gate
      // on the identical condition. This is not an Auditor backend failure.
      log('error', 'auditor_push_diff_error', {
        message: err instanceof Error ? err.message : String(err),
      });
      return { ok: true };
    }

    if (!diff) {
      // Nothing resolvable to upload (empty or unresolved) → nothing ships →
      // nothing to audit.
      log('info', 'auditor_push_no_diff', { reason: 'empty-or-unresolved' });
      return { ok: true };
    }

    let result: AuditorPushVerdict;
    try {
      result = await audit(diff);
    } catch (err) {
      // Auditor backend (the LLM) failed — fail CLOSED + retryable. Shipping an
      // unaudited delivery because the provider blipped is the exact failure
      // this posture exists to prevent.
      const message = err instanceof Error ? err.message : String(err);
      log('error', 'auditor_push_error', { message });
      return {
        ok: false,
        retryable: true,
        reason: `Auditor unavailable — could not review this push; retry. (${message})`,
      };
    }

    if (result.verdict === 'unsafe') {
      log('warn', 'auditor_push_blocked', { summary: result.summary });
      return { ok: false, reason: result.summary };
    }

    log('info', 'auditor_push_clean', {});
    return { ok: true };
  };
}
