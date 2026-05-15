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

import { detectBlockedGitCommand } from './git-mutation-detection.ts';
import type { ApprovalMode } from './approval-gates.ts';
import type { PreToolHookEntry, PreToolUseResult, ToolHookContext } from './tool-hooks.ts';

// ---------------------------------------------------------------------------
// Git guard helpers (see factory at end of file)
// ---------------------------------------------------------------------------

interface GitGuardOptions {
  /**
   * Returns the current approval mode. The guard short-circuits non-
   * branch-changing mutations (commit/push/merge/rebase) in full-auto
   * mode; branch create / branch switch are blocked regardless of
   * mode because the issue is state synchronization, not consent.
   */
  modeProvider: () => ApprovalMode;
}

/**
 * Build the user-facing block text + structured error code for a given
 * blocked git op label. Mirrors the inline branching the web tool
 * executor used before this hook was ported (see git history of
 * `app/src/lib/sandbox-tools.ts`).
 */
function formatGitGuardBlock(
  blockedOp: string,
  mode: ApprovalMode,
): { reason: string; errorType: string } {
  const isBranchCreate = blockedOp === 'git checkout -b' || blockedOp === 'git switch -c';
  const isBranchSwitch =
    blockedOp === 'git checkout <branch>' || blockedOp === 'git switch <branch>';

  let guidance: string;
  if (isBranchCreate) {
    guidance = `Direct "${blockedOp}" is blocked. Use sandbox_create_branch({"name": "<branch-name>"}) — it creates the branch in the sandbox and keeps Push's branch state in sync. Pass "from": "<base>" to branch from a specific ref instead of HEAD.`;
  } else if (isBranchSwitch) {
    guidance = `Direct "${blockedOp}" is blocked. Use sandbox_switch_branch({"branch": "<branch-name>"}) — it switches the sandbox and routes the conversation to the existing chat for that branch (or auto-creates one). For branch-restore-as-file flows, pass an explicit flag (e.g. "git checkout -- <path>").`;
  } else if (mode === 'autonomous') {
    guidance = `Direct "${blockedOp}" is blocked. Use sandbox_prepare_commit + sandbox_push for the audited flow. If the standard flow fails, retry with "allowDirectGit": true — you have autonomous permission.`;
  } else {
    guidance = [
      `Direct "${blockedOp}" is blocked. Commits must go through sandbox_prepare_commit (Auditor review) and pushes through sandbox_push.`,
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
 * Tools that mutate the upstream branch. When `isMainProtected` is on
 * and the workspace is on the default branch (or `main` / `master`),
 * these are blocked with structured guidance.
 *
 * Covers both web (`sandbox_prepare_commit` / `sandbox_push`) and CLI
 * (`git_commit`) vocabularies so the same rule applies on both surfaces.
 */
const PROTECT_MAIN_TOOLS_MATCHER = 'sandbox_prepare_commit|sandbox_push|git_commit';

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
      // branch reader to make a decision.
      if (!context.getCurrentBranch) return { decision: 'passthrough' };

      const currentBranch = await context.getCurrentBranch();
      const mainBranches = new Set(['main', 'master']);
      if (context.defaultBranch) mainBranches.add(context.defaultBranch);
      // Fail-safe: if we couldn't determine the current branch, treat
      // it as on-main (the inline check this hook replaces did the
      // same — blocking is safer than letting through).
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
      _context: ToolHookContext,
    ): PreToolUseResult => {
      const command = typeof args.command === 'string' ? args.command : '';
      const blockedOp = detectBlockedGitCommand(command);
      if (!blockedOp) return { decision: 'passthrough' };

      const isBranchCreate = blockedOp === 'git checkout -b' || blockedOp === 'git switch -c';
      const isBranchSwitch =
        blockedOp === 'git checkout <branch>' || blockedOp === 'git switch <branch>';
      const isBranchOp = isBranchCreate || isBranchSwitch;

      const mode = options.modeProvider();
      const shouldBlock = isBranchOp || mode !== 'full-auto';

      // `allowDirectGit` is the consent escape hatch for commit/push/
      // merge/rebase. It does NOT apply to branch create/switch — those
      // would desync Push's tracked branch from sandbox HEAD even with
      // explicit user approval, so the only safe path is the typed tool.
      const allowDirectGitApplies = !isBranchOp && args.allowDirectGit === true;
      if (allowDirectGitApplies || !shouldBlock) return { decision: 'passthrough' };

      const { reason, errorType } = formatGitGuardBlock(blockedOp, mode);
      return { decision: 'deny', reason, errorType };
    },
  };
}
