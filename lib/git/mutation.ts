/**
 * lib/git/mutation.ts — repo-mutation heuristic for `sandbox_exec`.
 *
 * `detectGitMutation` answers a different question from `classifyGitCommand`
 * (the policy oracle in `./policy.ts`): not "is this allowed / where should it
 * route" but "did this command likely change the workspace?" — the signal
 * that drives file-version cache invalidation and ledger stale-marking after
 * an exec. The two are intentionally decoupled: staleness must not be coupled
 * to policy blocking. They can share parsing helpers later, but compose only
 * where a caller needs both.
 *
 * Heuristic, not exact: it biases toward marking mutating (a missed mutation
 * leaves stale caches, which is worse than an unnecessary refresh).
 */

export interface GitMutationResult {
  isLikelyMutating: boolean;
  /** Short category of the matched mutation, when one fired. */
  reason?: string;
}

// Read-only command shapes (optionally prefixed by a single `cd … &&`) that
// never mutate — short-circuit these to non-mutating.
const READONLY_PREFIX =
  /^(cd\s+\S+\s*&&\s*)?(pwd|ls|find|cat|head|tail|wc|stat|file|rg|grep|sed -n|awk|git status|git diff|git show|git branch --show-current)\b/;

export function detectGitMutation(command: string): GitMutationResult {
  const normalized = command.trim().toLowerCase();
  if (!normalized) return { isLikelyMutating: false };

  if (READONLY_PREFIX.test(normalized)) return { isLikelyMutating: false };

  // Output redirect (`>`/`>>`, but not an fd number like `2>`).
  if (/(^|[^0-9])>>?/.test(normalized)) {
    return { isLikelyMutating: true, reason: 'output redirect' };
  }
  if (/\b(rm|mv|cp|mkdir|rmdir|touch|chmod|chown|tee|patch)\b/.test(normalized)) {
    return { isLikelyMutating: true, reason: 'filesystem mutation' };
  }
  if (
    /\bgit\s+(add|commit|checkout|switch|merge|rebase|reset|restore|clean|stash|cherry-pick|apply|am|push)\b/.test(
      normalized,
    )
  ) {
    return { isLikelyMutating: true, reason: 'git mutation' };
  }
  if (/\b(npm|pnpm|yarn)\s+(install|add|remove|uninstall|update|up|ci)\b/.test(normalized)) {
    return { isLikelyMutating: true, reason: 'package install' };
  }
  if (/\b(pip|pip3)\s+install\b/.test(normalized)) {
    return { isLikelyMutating: true, reason: 'package install' };
  }
  if (/\bgo\s+mod\b/.test(normalized)) {
    return { isLikelyMutating: true, reason: 'package install' };
  }
  if (/\bcargo\s+(add|remove)\b/.test(normalized)) {
    return { isLikelyMutating: true, reason: 'package install' };
  }
  if (/\bsed\s+-i\b/.test(normalized)) {
    return { isLikelyMutating: true, reason: 'in-place edit' };
  }
  if (/\bperl\s+-pi\b/.test(normalized)) {
    return { isLikelyMutating: true, reason: 'in-place edit' };
  }

  return { isLikelyMutating: false };
}
