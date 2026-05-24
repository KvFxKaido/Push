/**
 * Git mutation detection — the `sandbox_exec` git guard's block/allow
 * heuristic.
 *
 * The implementation now lives in `lib/git/policy.ts` as part of the
 * `classifyGitCommand` oracle; `detectBlockedGitCommand` is the legacy
 * label adapter over it (block/route ⇒ a label, else null). This module
 * re-exports it so existing callers and the established label test corpus
 * (`git-mutation-detection.test.ts`) keep working unchanged.
 */

export { detectBlockedGitCommand } from './git/policy.ts';
