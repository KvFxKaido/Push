import { parseBooleanSetting } from './auditor-policy.js';

/** Env var that toggles auto-branch-on-commit across surfaces. */
export const AUTO_BRANCH_ON_COMMIT_ENV_VAR = 'PUSH_AUTO_BRANCH_ON_COMMIT';

/** Auto-branch is the default persistence model; disabling is an opt-out. */
export const AUTO_BRANCH_ON_COMMIT_DEFAULT = true;

/**
 * Resolve whether commits requested on the default branch should first fork to
 * a work branch. Mirrors the Auditor/secret-scan resolver precedence:
 * operator env override, then explicit per-surface setting, then default-on.
 */
export function resolveAutoBranchOnCommitEnabled(
  opts: { explicit?: unknown; env?: unknown } = {},
): boolean {
  const fromEnv = parseBooleanSetting(opts.env);
  if (fromEnv !== undefined) return fromEnv;
  const fromExplicit = parseBooleanSetting(opts.explicit);
  if (fromExplicit !== undefined) return fromExplicit;
  return AUTO_BRANCH_ON_COMMIT_DEFAULT;
}
