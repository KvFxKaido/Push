import type { ProcessRule, StaticPolicy } from '@push/lib/sandbox-policy';
import { detectBlockedGitCommand } from './sandbox-tool-utils';

/**
 * The sandbox_exec git guard expressed as a SandboxPolicy ProcessRule.
 * The predicate body is the existing `detectBlockedGitCommand` heuristic
 * (shell tokenization, redirect filtering, ref-expression carve-outs,
 * checkout-vs-switch path-vs-branch dispatch) — the schema gains a
 * predicate hook so rules can carry that detection logic without trying
 * to encode it in the simple argMatch pattern language.
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
