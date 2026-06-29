/**
 * Default `PreToolUse` hook factories for Push's sandbox tools.
 *
 * Each factory returns a single `PreToolHookEntry` that surfaces (matcher,
 * hook). Per-surface bindings register these on their `ToolHookRegistry`,
 * so web and CLI evaluate the same predicates against the same context.
 *
 * Hooks here are pure: they don't import surface-specific helpers. State
 * a hook needs (current branch, sandbox state, …) flows in through
 * `ToolHookContext` populated by the binding.
 */

import { classifyGitCommand } from './git/policy.ts';
import type { GitBlockDecision, GitRouteDecision } from './git/policy.ts';
import type { ApprovalMode } from './approval-gates.ts';
import type { PreToolHookEntry, PreToolUseResult, ToolHookContext } from './tool-hooks.ts';

// ---------------------------------------------------------------------------
// Git guard helpers (see factory at end of file)
// ---------------------------------------------------------------------------

interface GitGuardOptions {
  /**
   * Returns the current approval mode. In full-auto the guard short-circuits a
   * raw `git commit` (it has a safe form); a raw `git push` is always routed to
   * the audited tool (Gate-at-Push) and the forbidden ops (merge / rebase /
   * cherry-pick) are always blocked, regardless of mode or `allowDirectGit`
   * (#985/#986). Branch create / switch are blocked regardless of mode — the
   * issue there is state synchronization, not consent.
   */
  modeProvider: () => ApprovalMode;
}

/**
 * Build the user-facing block text + structured error code for a blocked
 * git decision. The guidance variant is selected from the structured route
 * target (`decision.to`); the decision's legacy label is interpolated into
 * the message text. Mirrors the inline branching the web tool executor used
 * before this hook was ported (see git history of `app/src/lib/sandbox-tools.ts`).
 */
function formatGitGuardBlock(
  decision: GitRouteDecision | GitBlockDecision,
  mode: ApprovalMode,
): { reason: string; errorType: string } {
  const label = decision.label;
  const isBranchCreate = decision.kind === 'route' && decision.to === 'create_branch';
  const isBranchSwitch = decision.kind === 'route' && decision.to === 'switch_branch';

  const isLocalMerge = decision.kind === 'block' && decision.reason === 'no-local-merge';
  const isRemoteMutation = decision.kind === 'block' && decision.reason === 'remote-mutation';

  let guidance: string;
  if (isBranchCreate) {
    guidance = `Direct "${label}" is blocked. Use sandbox_create_branch({"name": "<branch-name>"}) — it creates the branch in the sandbox and keeps Push's branch state in sync. Pass "from": "<base>" to branch from a specific ref instead of HEAD.`;
  } else if (isBranchSwitch) {
    guidance = `Direct "${label}" is blocked. Use sandbox_switch_branch({"branch": "<branch-name>"}) — it switches the sandbox and updates Push's active branch state for the current conversation. For branch-restore-as-file flows, pass an explicit flag (e.g. "git checkout -- <path>").`;
  } else if (isLocalMerge) {
    // Distinct from commit/push: there is NO consented form — "allowDirectGit"
    // does not apply (it would bypass the push-time audit; see the guard).
    guidance = `Direct "${label}" is blocked. Push never runs local merges — integrate branches through the GitHub PR flow (open a PR, then merge it there). "allowDirectGit" does NOT apply to a local merge.`;
  } else if (isRemoteMutation) {
    // Distinct from history rewrites: the harm is destination integrity, not
    // history. Repointing origin (set-url / add / rename / git config
    // remote.* / url.*InsteadOf) would redirect an audited push to another repo
    // while the Gate-at-Push pins (HEAD, branch, upstream ref) still match. No
    // consented form — the session's remote is fixed, so "allowDirectGit" does
    // NOT apply.
    guidance = `Direct "${label}" is blocked. Push pins the session's remote — changing it (e.g. \`git remote set-url\` or \`git config remote.origin.pushurl\`) would redirect an audited push to a different repository while the push-time destination checks still pass. "allowDirectGit" does NOT apply. The remote is fixed for the session; it can't be changed from inside the sandbox.`;
  } else if (decision.kind === 'block') {
    // History rewrites (rebase / cherry-pick): forbidden, no consented form.
    guidance = `Direct "${label}" is blocked. Push doesn't run local history rewrites — commit normally with sandbox_commit and ship via prepare_push (PRs squash-merge, so local history cleanup isn't needed). "allowDirectGit" does NOT apply.`;
  } else if (mode === 'autonomous') {
    guidance = `Direct "${label}" is blocked. Use sandbox_commit to commit and prepare_push to ship (the Auditor runs at push). If the standard flow fails, retry with "allowDirectGit": true — you have autonomous permission.`;
  } else {
    guidance = [
      `Direct "${label}" is blocked. Commit locally with sandbox_commit, then ship through prepare_push (Auditor review at the push boundary).`,
      ``,
      `If the standard flow is failing, use ask_user to explain the problem and request explicit permission from the user.`,
      `If the user approves, retry with "allowDirectGit": true in your sandbox_exec args.`,
    ].join('\n');
  }

  return { reason: guidance, errorType: 'GIT_GUARD_BLOCKED' };
}

// ---------------------------------------------------------------------------
// Protect Main — block commit/push tools when on the default branch
// ---------------------------------------------------------------------------

/**
 * Tools that push to (or, on CLI, commit to) the upstream branch. When
 * `isMainProtected` is on and the workspace is on the default branch (or
 * `main` / `master`), these are blocked with structured guidance.
 *
 * Covers web push vocab (`prepare_push` / `sandbox_push`) and CLI (`git_commit`).
 * `sandbox_commit` is deliberately NOT matched: it auto-forks off the default
 * branch *inside the handler* (this pre-hook runs too early to see the
 * post-fork branch), and `handleSandboxCommit` carries its own fail-closed
 * Protect Main check for the auto-branch-disabled case. Matching it here would
 * deny the very tool whose job is to move work off main.
 */
const PROTECT_MAIN_TOOLS_MATCHER = 'prepare_push|sandbox_push|git_commit';

export function createProtectMainPreHook(): PreToolHookEntry {
  return {
    matcher: PROTECT_MAIN_TOOLS_MATCHER,
    hook: async (
      _toolName: string,
      _args: Record<string, unknown>,
      context: ToolHookContext,
    ): Promise<PreToolUseResult> => {
      if (!context.isMainProtected) return { decision: 'passthrough' };
      // No `sandboxId` short-circuit: CLI sets `sandboxId: null` because
      // its workspace IS the local working tree. The hook only needs a
      // branch signal — live reader or Push-tracked branch — to decide.
      if (!context.getCurrentBranch && !context.currentBranch) {
        return { decision: 'passthrough' };
      }

      // Branch resolution is deliberately asymmetric (Codex P1 on #975):
      //
      //   - When a live reader exists it is the AUTHORITY on where the commit
      //     will land. If it returns null (transient / unreadable HEAD) we fail
      //     closed — treat as on-main — rather than trusting `currentBranch`. A
      //     desynced session can track a feature branch while sandbox HEAD is
      //     actually main, and `sandbox_push` has no later branch check before
      //     PushGit.push(); falling back to stale tracked state there would let
      //     a push reach main. Blocking a legit commit on a blip is a retry;
      //     bypassing Protect Main is not recoverable.
      //   - When there is NO live reader (e.g. a session that never wired one),
      //     Push's tracked branch is the only signal. Using it is a strict
      //     improvement over the previous always-passthrough: it can now deny a
      //     commit to main on those sessions.
      const currentBranch = context.getCurrentBranch
        ? await context.getCurrentBranch()
        : (context.currentBranch ?? null);
      const mainBranches = new Set(['main', 'master']);
      if (context.defaultBranch) mainBranches.add(context.defaultBranch);
      // Fail-safe: if we still couldn't determine the branch, treat it as
      // on-main — blocking is safer than letting an unverified commit through.
      if (currentBranch && !mainBranches.has(currentBranch)) {
        return { decision: 'passthrough' };
      }

      return {
        decision: 'deny',
        errorType: 'PROTECT_MAIN_BLOCKED',
        // Generic guidance — the rule applies to both web and CLI, so
        // don't name a surface-specific tool here. Web's per-tool block
        // text can layer extra hints in its system prompt.
        reason:
          'Protect Main is enabled. Commits and pushes to the main/default branch are blocked. Create a new branch first, then retry.',
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Git guard — blocks direct git mutations in sandbox_exec
// ---------------------------------------------------------------------------

export function createGitGuardPreHook(options: GitGuardOptions): PreToolHookEntry {
  return {
    matcher: 'sandbox_exec',
    hook: (
      _toolName: string,
      args: Record<string, unknown>,
      context: ToolHookContext,
    ): PreToolUseResult => {
      const command = typeof args.command === 'string' ? args.command : '';
      const decision = classifyGitCommand(command);
      if (decision.kind !== 'block' && decision.kind !== 'route') {
        return { decision: 'passthrough' };
      }

      const isBranchCreate = decision.kind === 'route' && decision.to === 'create_branch';
      const isBranchSwitch = decision.kind === 'route' && decision.to === 'switch_branch';
      const isBranchOp = isBranchCreate || isBranchSwitch;
      const isPush = decision.kind === 'route' && decision.to === 'push';

      // Protect Main (issue #977): a raw `git push` via sandbox_exec is the
      // escape hatch that bypasses the audited push flow (sandbox_push) and its
      // push-boundary Protect Main gate. When Protect Main is on, deny it
      // *regardless of `allowDirectGit`* — the consent hatch must not reopen the
      // hole the boundary gate closes. Pushes go through sandbox_push, which
      // enforces Protect Main at the boundary; the current-branch case the model
      // actually needs is fully served there. This is target-agnostic on
      // purpose: predicting the push destination from a raw command string is
      // the same losing game as refspec prediction (see #976), so block the verb
      // and route to the audited tool instead.
      if (context.isMainProtected && isPush) {
        return {
          decision: 'deny',
          errorType: 'PROTECT_MAIN_BLOCKED',
          reason:
            'Protect Main is on: direct `git push` via sandbox_exec is blocked (it would bypass the audited push gate), even with allowDirectGit. Use the sandbox_push tool — it enforces Protect Main at the push boundary. If you need to push, switch to a feature branch first.',
        };
      }

      const mode = options.modeProvider();
      // Every `kind: 'block'` op (local merge, rebase, cherry-pick) is forbidden
      // and has NO audited typed path, so neither full-auto nor `allowDirectGit`
      // may run it. A local merge is also a push-gate evasion (its
      // conflict-resolution combined diff is omitted by the push-time
      // `git log -p` scan, so a secret there would ship unaudited — #985). Making
      // ALL blocks unescapable also stops chain-masking: the classifier surfaces
      // the most-restrictive segment, and since no block is escapable,
      // `git rebase && git merge` / `git rebase && git push` can't slip the
      // forbidden/gated op through on the rebase. The Push flow doesn't need
      // local rebases — PRs squash-merge.
      const isForbiddenGit = decision.kind === 'block';

      // A raw `git push` is ALWAYS routed to the audited `sandbox_push` tool —
      // even in full-auto, which otherwise lets raw git through. Under
      // Gate-at-Push the Auditor gate lives at the push, so a raw push in
      // full-auto (no human, no typed gate) would ship unaudited — the exact
      // invariant the gate exists to hold. The `allowDirectGit` consent hatch
      // below still applies when Protect Main is off; Protect Main blocks raw
      // push outright (handled above), regardless of consent.
      const shouldBlock = isForbiddenGit || isBranchOp || isPush || mode !== 'full-auto';

      // `allowDirectGit` is the consent escape hatch for commit/push only. It
      // does NOT apply to branch create/switch (would desync Push's tracked
      // branch from sandbox HEAD) or to a forbidden op (merge/rebase/cherry-pick
      // — no safe consented form, only the typed tool or the GitHub PR flow).
      const allowDirectGitApplies = !isForbiddenGit && !isBranchOp && args.allowDirectGit === true;
      if (allowDirectGitApplies || !shouldBlock) return { decision: 'passthrough' };

      const { reason, errorType } = formatGitGuardBlock(decision, mode);
      return { decision: 'deny', reason, errorType };
    },
  };
}
