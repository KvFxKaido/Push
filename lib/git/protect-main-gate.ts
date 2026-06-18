/**
 * lib/git/protect-main-gate.ts — builds a `PrePushGate` that enforces Protect
 * Main at the push boundary itself, independent of the `PreToolUse` Protect Main
 * hook (`default-pre-hooks.ts`).
 *
 * This is defense-in-depth, not a replacement: the pre-hook gates the *tool
 * call*; this gate guards the *actual push*. The push handler reads the real
 * HEAD branch right before `git push` — when the sandbox must be up anyway — so
 * even if the pre-hook is ever bypassed (not wired, a desynced live read, a new
 * push path), a push to the protected branch still cannot leave the boundary.
 *
 * Failure posture is the INVERSE of the secret-scan gate (see
 * `secret-scan-gate.ts`): this is a **safety** gate, so it fails **closed**. A
 * match blocks, and so does any inability to prove the branch is safe
 * (unreadable / detached / empty HEAD). The secret scan fails open because a
 * diff-read hiccup must not brick every push; here, "can't verify the target
 * branch" is exactly the state a protection gate must refuse — blocking a legit
 * push is a recoverable retry, leaking a commit onto main is not.
 *
 * Symmetric structured logs, one per branch (see CLAUDE.md):
 * `protect_main_push_clean` ↔ `protect_main_push_blocked` (with a `reason`
 * sub-tag) ↔ `protect_main_push_skipped`.
 */

import type { PrePushGate } from './push-git.js';

type LogLevel = 'info' | 'warn' | 'error';
type LogFn = (level: LogLevel, event: string, ctx: Record<string, unknown>) => void;

const defaultLog: LogFn = (level, event, ctx) => {
  console.log(JSON.stringify({ level, event, ...ctx }));
};

/**
 * Resolve the branch a push refspec will actually update, or null when the ref
 * is absent or targets the checked-out branch (so the caller reads live HEAD).
 *
 * `git push origin <ref>` accepts `src:dst`, a plain branch/ref, or `HEAD`; a
 * leading `+` forces. The destination side is what lands on the remote, so a
 * refspec like `HEAD:refs/heads/main` from a feature branch still updates main
 * — a current-branch-only check would miss it.
 */
export function resolvePushTargetBranch(ref: string | undefined): string | null {
  if (!ref) return null;
  const spec = ref.trim().replace(/^\+/, '');
  const dst = spec.includes(':') ? spec.slice(spec.indexOf(':') + 1) : spec;
  const name = dst.replace(/^refs\/heads\//, '').trim();
  // `HEAD` / empty destination → the push targets the checked-out branch; defer
  // to the live read instead of treating "HEAD" as a branch name.
  if (!name || name === 'HEAD') return null;
  return name;
}

export interface ProtectMainPrePushGateOptions {
  /** Whether Protect Main is enabled for this session. */
  enabled: boolean;
  /**
   * Repo default branch name. `main`/`master` are always treated as protected;
   * this adds the repo's configured default when it differs.
   */
  defaultBranch?: string;
  /**
   * Read the branch the push will actually update (the real sandbox/local HEAD).
   * Should resolve to null when the branch can't be determined — the gate then
   * fails closed.
   */
  getCurrentBranch: () => Promise<string | null> | string | null;
  /** Injectable for tests; defaults to a JSON-line `console.log`. */
  log?: LogFn;
}

export function makeProtectMainPrePushGate(opts: ProtectMainPrePushGateOptions): PrePushGate {
  const { enabled, defaultBranch, getCurrentBranch, log = defaultLog } = opts;
  return async (pushOpts) => {
    if (!enabled) {
      log('info', 'protect_main_push_skipped', { reason: 'disabled' });
      return { ok: true };
    }

    // The branch the push actually updates: an explicit refspec destination wins
    // over the checked-out branch (a `HEAD:refs/heads/main` push from a feature
    // branch still lands on main); otherwise the live HEAD is the target.
    const refTarget = resolvePushTargetBranch(pushOpts?.ref);
    let normalized: string;
    if (refTarget) {
      normalized = refTarget;
    } else {
      let branch: string | null;
      try {
        branch = await getCurrentBranch();
      } catch (err) {
        // Fail closed: a safety gate that can't read the branch can't prove the
        // push isn't headed for main, so it must block.
        log('warn', 'protect_main_push_blocked', {
          reason: 'branch_unreadable',
          message: err instanceof Error ? err.message : String(err),
        });
        return {
          ok: false,
          reason:
            'Protect Main: could not verify the target branch before pushing, so the push was blocked as a precaution. Retry once the workspace is responsive.',
        };
      }
      normalized = branch?.trim() ?? '';
      if (!normalized) {
        // Detached / empty / unreadable HEAD — same fail-closed reasoning.
        log('warn', 'protect_main_push_blocked', { reason: 'branch_undetermined' });
        return {
          ok: false,
          reason:
            'Protect Main: the current branch could not be determined, so the push was blocked. Switch to a feature branch and retry.',
        };
      }
    }

    const protectedBranches = new Set(['main', 'master']);
    if (defaultBranch) protectedBranches.add(defaultBranch.trim());
    if (protectedBranches.has(normalized)) {
      log('warn', 'protect_main_push_blocked', {
        reason: 'protected_branch',
        branch: normalized,
        // Distinguish a refspec-targeted push from a checked-out-branch push in
        // the logs so an unusual destination is visible to ops.
        ...(refTarget ? { via: 'refspec' } : {}),
      });
      return {
        ok: false,
        reason: `Protect Main: pushing to the protected branch "${normalized}" is blocked. Create a new branch first, then push.`,
      };
    }

    log('info', 'protect_main_push_clean', { branch: normalized });
    return { ok: true };
  };
}
