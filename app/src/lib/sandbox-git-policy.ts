import type { ProcessRule, StaticPolicy } from '@push/lib/sandbox-policy';
import { detectBlockedGitCommand } from '@push/lib/git/policy';

/**
 * The sandbox_exec git guard expressed as a SandboxPolicy ProcessRule.
 * Thin adapter over the git policy oracle: `detectBlockedGitCommand` is the
 * oracle's label adapter (a `block`/`route` decision ⇒ its label, else
 * null). A non-null label denies, surfacing the label as the reason
 * (consumed as the blocked-op name in `coder-job-executor-adapter.ts`).
 * Reusing the adapter keeps this rule from drifting from the canonical
 * block/route mapping.
 */
const gitMutationGuard: ProcessRule = {
  command: '*',
  predicate: (req) => detectBlockedGitCommand(req.raw ?? ''),
  action: 'deny',
};

export const SANDBOX_EXEC_POLICY: StaticPolicy = {
  filesystem: [],
  process: [gitMutationGuard],
};
