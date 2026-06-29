/**
 * lib/git/worktree-disposal.ts — shared keep/remove decision for an isolated
 * work area at teardown.
 *
 * Branch-on-first-prompt gives every repo-backed session its own throwaway
 * branch in an isolated work area: a real `git worktree` on the CLI lead, a
 * cloned sandbox on the web/Modal surfaces. When the session ends (or its
 * branch/sandbox is reclaimed) we want that area gone — but never at the cost
 * of destroying work that isn't safely on the remote. The CLI lead routes its
 * teardown through this decision today; the web/Modal sandbox-reclaim path is
 * the second surface this is promoted ahead of, so both can act on one verdict
 * and the "never silently destroy unpushed work" guarantee is defined once here
 * rather than re-derived per surface (CLAUDE.md: promote to lib the moment a
 * second surface needs it).
 *
 * The criterion is *recoverability*, not merely "has commits". A clean branch
 * whose commits are all on the remote is safe to remove — it can be re-fetched
 * — even though it has commits beyond its fork base. The older CLI rule
 * ("commits beyond base ⇒ keep") never reclaimed pushed branches, so worktrees
 * accumulated under ~/.push/worktrees; routing through this decision fixes that.
 */

export interface WorktreeWorkState {
  /** Uncommitted or untracked changes are present in the work area. */
  dirty: boolean;
  /**
   * Commits on the branch beyond its fork base — work produced this session.
   * Used only when the branch has never been pushed (`unpushedCommits === null`),
   * where every such commit is by definition unpushed.
   */
  commitsAhead: number;
  /**
   * Commits on HEAD not present on the branch's remote tracking ref, or `null`
   * when the branch has no remote ref yet (never pushed). `null` falls back to
   * `commitsAhead`: a never-pushed branch's local commits are all at risk.
   */
  unpushedCommits: number | null;
}

export type WorktreeDisposal =
  | { action: 'remove'; reason: 'clean' | 'fully-pushed' }
  | { action: 'keep'; reason: 'dirty' | 'unpushed' };

/**
 * Decide whether an isolated work area can be reclaimed. Pure — callers observe
 * the state (and must bias it toward "has work" on a read failure, so an
 * unreadable area is kept, never deleted on uncertainty) and act on the verdict.
 *
 * - `keep`   → work would be lost: uncommitted/untracked changes (`dirty`), or
 *              commits not on the remote (`unpushed`).
 * - `remove` → nothing would be lost: no changes, and either no session commits
 *              (`clean`) or every commit is already on the remote
 *              (`fully-pushed`).
 *
 * `dirty` is checked before `unpushed` only so the kept-reason is the most
 * actionable one ("commit first" precedes "push first"); both block removal.
 */
export function decideWorktreeDisposal(state: WorktreeWorkState): WorktreeDisposal {
  if (state.dirty) return { action: 'keep', reason: 'dirty' };
  const unpushed = state.unpushedCommits ?? state.commitsAhead;
  if (unpushed > 0) return { action: 'keep', reason: 'unpushed' };
  return { action: 'remove', reason: state.commitsAhead > 0 ? 'fully-pushed' : 'clean' };
}
