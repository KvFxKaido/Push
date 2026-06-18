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
 * What a push refspec resolves to, for the purpose of the Protect Main check:
 *   - `current`      — no explicit destination; the push updates the checked-out
 *                      branch, so the gate reads live HEAD.
 *   - `branch`       — a single concrete destination branch to check.
 *   - `unverifiable` — the gate cannot prove a single safe destination, so it
 *                      must fail closed. Covers Git's matching refspec (`:` /
 *                      `+:`, which pushes every same-named branch incl. main),
 *                      option-shaped refs (`--all` / `--mirror` / `-f`, passed
 *                      verbatim to `git push`), and empty/garbage refs.
 */
export type PushTarget =
  | { kind: 'current' }
  | { kind: 'branch'; name: string }
  | { kind: 'unverifiable'; detail: string };

/**
 * Resolve the destination a push refspec will update. A safety gate can't chase
 * every Git refspec/option form, so this is an ALLOWLIST: anything that doesn't
 * resolve to the checked-out branch or one concrete destination branch is
 * `unverifiable` and the gate fails closed. `git push origin <ref>` accepts
 * `src:dst`, a plain branch/ref, `HEAD`/`@`, with a leading `+` forcing.
 */
export function resolvePushTarget(ref: string | undefined): PushTarget {
  if (ref == null) return { kind: 'current' };
  const spec = ref.trim();
  if (!spec) return { kind: 'unverifiable', detail: 'empty ref' };
  // Option-shaped (`--all`, `--mirror`, `--tags`, `-f`, …): Git pushes many refs,
  // which a single-branch check can't cover.
  if (spec.startsWith('-')) return { kind: 'unverifiable', detail: 'option-shaped ref' };
  const body = spec.replace(/^\+/, '');
  if (!body) return { kind: 'unverifiable', detail: 'force marker with no ref' };
  // The matching refspec pushes every same-named branch, including main.
  if (body === ':') return { kind: 'unverifiable', detail: 'matching refspec' };
  if (body === 'HEAD' || body === '@') return { kind: 'current' };
  const dst = body.includes(':') ? body.slice(body.indexOf(':') + 1).trim() : body;
  if (!dst) return { kind: 'unverifiable', detail: 'refspec with empty destination' };
  const name = dst.replace(/^refs\/heads\//, '').trim();
  if (!name) return { kind: 'unverifiable', detail: 'unresolvable destination' };
  if (name === 'HEAD' || name === '@') return { kind: 'current' };
  return { kind: 'branch', name };
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
    // branch still lands on main). A refspec we can't resolve to one safe branch
    // fails closed; otherwise the live HEAD is the target.
    const target = resolvePushTarget(pushOpts?.ref);
    if (target.kind === 'unverifiable') {
      // Can't prove a single safe destination (matching refspec, --all/--mirror,
      // garbage) — block rather than risk an unchecked push to main.
      log('warn', 'protect_main_push_blocked', {
        reason: 'ref_unverifiable',
        detail: target.detail,
        ref: pushOpts?.ref ?? null,
      });
      return {
        ok: false,
        reason: `Protect Main: the push refspec "${pushOpts?.ref}" could not be verified to target a single safe branch (${target.detail}), so it was blocked. Push a single feature branch — or use the default push — and retry.`,
      };
    }

    let normalized: string;
    if (target.kind === 'branch') {
      normalized = target.name;
    } else {
      // target.kind === 'current' → read live HEAD.
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
        ...(target.kind === 'branch' ? { via: 'refspec' } : {}),
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
