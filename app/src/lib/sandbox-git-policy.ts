import type { ProcessRule, StaticPolicy } from '@push/lib/sandbox-policy';
import { classifyGitCommand } from '@push/lib/git/policy';

/**
 * The sandbox_exec git guard expressed as a SandboxPolicy ProcessRule.
 * Thin adapter over the `classifyGitCommand` oracle: a `block` or `route`
 * decision denies, surfacing the decision's legacy label as the reason
 * (consumed as the blocked-op name in `coder-job-executor-adapter.ts`);
 * `passthrough` / `allow` decisions return null so the rule doesn't fire.
 */
const gitMutationGuard: ProcessRule = {
  command: '*',
  predicate: (req) => {
    const decision = classifyGitCommand(req.raw ?? '');
    return decision.kind === 'block' || decision.kind === 'route' ? decision.label : null;
  },
  action: 'deny',
};

export const SANDBOX_EXEC_POLICY: StaticPolicy = {
  filesystem: [],
  process: [gitMutationGuard],
};
