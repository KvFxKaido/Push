/**
 * Built-in project context for the Push repo itself.
 *
 * Push supports repo-authored instruction files, but the app should not depend
 * on this repository's root markdown to understand its own core architecture.
 * This block keeps the highest-signal operational context close to the runtime.
 *
 * Keep this high-level summary in sync with major architecture/policy changes
 * documented in the root repo docs. It is intentionally condensed, not generated.
 */

const CANONICAL_PUSH_REPO = 'kvfxkaido/push';

const PUSH_REPO_CONTEXT = `# Push Built-In Project Context

Push is an AI coding agent with a web app plus a local CLI/TUI.

Current terminal work is focused on the CLI's full-screen TUI, while classic REPL and headless runs remain supported.

Core roles:
- Orchestrator: primary conversational lead
- Coder: autonomous sandbox implementer
- Reviewer: advisory diff reviewer
- Auditor: binary SAFE/UNSAFE gate for standard commits and merge flow

Backend routing:
- Chat locks the Orchestrator to a per-chat provider/model on first send
- Delegated Coder runs inherit that chat-locked provider/model
- Reviewer keeps its own sticky provider/model selection
- Auditor follows the current chat's locked provider/model when available, otherwise the active backend

Repo/session model:
- Exactly one active branch per repo session
- Switching branches tears down the sandbox and starts fresh on the target branch
- Chats are branch-scoped and stay bound to the branch where they started
- Branch creation is UI-owned; the assistant should not create or switch branches itself

Workspace Hub:
- Scratchpad, Console, Files, Diff, PRs, Review, and commit/push live in the Workspace Hub
- Reviewer sources are Branch diff, Last commit, and Working tree
- Review findings can jump to Diff or be sent into chat as fix requests
- Only PR-backed Branch diff reviews can be posted back to GitHub as PR reviews

Safety and delivery:
- Standard commits go through Auditor review
- All merges go through GitHub PR flow; Push never runs local git merge
- Protect Main can block direct commits to main

Sandbox:
- Modal provides an ephemeral Linux workspace with a 30-minute lifetime
- Hashline-based edits and workspace-revision stale checks are the preferred safe write path
- sandbox_save_draft is an intentional unaudited WIP checkpoint, not a normal save action`;

export function isPushRepo(repoFullName?: string | null): boolean {
  const value = (repoFullName || '').trim().toLowerCase();
  return value === CANONICAL_PUSH_REPO;
}

export function getBuiltInProjectInstructions(repoFullName?: string | null): string | null {
  return isPushRepo(repoFullName) ? PUSH_REPO_CONTEXT : null;
}

export function buildEffectiveProjectInstructions(
  repoFullName: string | null | undefined,
  repoInstructions: string | null | undefined,
): string | null {
  const builtIn = getBuiltInProjectInstructions(repoFullName);
  const repoText = (repoInstructions || '').trim();

  if (builtIn && repoText) {
    return `${builtIn}\n\n# Repo Instruction File\n\n${repoText}`;
  }
  return builtIn || (repoText || null);
}
