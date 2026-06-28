/**
 * Branch-on-first-prompt.
 *
 * The persistence model: a repo-backed session forks a work branch the moment
 * the user sends their first message — named from that prompt — so you never
 * *work* on the default branch. This replaces "talk on main, branch at the
 * first commit" (`ensure-commit-target-branch.ts`) as the primary path; that
 * commit-time fork stays as a fail-safe and self-neutralizes once we've already
 * moved off the default branch here.
 *
 * Mechanics (pragmatic ordering): the sandbox has already cloned `main` by the
 * time this runs (prewarm in `chat-prepare-send.ts`); we immediately
 * `sandbox_create_branch` (→ `git checkout -b`) before any tool call or visible
 * work, then migrate the just-sent conversation onto the new branch via the
 * shared dispatcher. The branch stays local in the sandbox until the first
 * commit (gate-at-push), so pure Q&A sessions never create a remote branch — no
 * branch sprawl, even though every first prompt branches.
 *
 * Logic lives here (not in `useChat.ts`, which is at its line cap) and is
 * invoked from `prepareSendContext`. Pure decision + orchestration; the refs it
 * needs are threaded in so it stays testable without a hook context.
 */

import { applyBranchSwitchPayload, type BranchForkMigrationContext } from './branch-fork-migration';
import { deriveBranchNameFromPrompt, getBranchSuggestionPrefix } from './branch-names';
import { isBranchExistsMessage } from './ensure-commit-target-branch';
import { forkBranchInWorkspace } from './fork-branch-in-workspace';

/** Bounded suffix retries on a name collision, mirroring the commit-time
 *  fail-safe's `withNumericSuffix` loop. Keeps common/repeated first prompts
 *  ("Fix login") in the same repo from silently staying on the default branch. */
const MAX_BRANCH_NAME_ATTEMPTS = 5;

export interface FirstPromptBranchInput {
  /** Operator/setting gate. Mirrors auto-branch-on-commit's enablement. */
  enabled: boolean;
  /** True only for the very first message of the conversation. */
  isFirstMessage: boolean;
  /** Raw user prompt text — the branch name is derived from this. */
  promptText: string;
  /** owner/name, or null for scratch / no-repo (which never branches). */
  repoFullName: string | null;
  /** Live sandbox id — required, the fork runs git inside it. */
  sandboxId: string | null;
  currentBranch?: string;
  defaultBranch?: string;
}

export interface FirstPromptBranchResult {
  branched: boolean;
  name?: string;
  error?: string;
}

/**
 * Decide whether a fresh session's first prompt should fork a work branch:
 * only when enabled, it is genuinely the first message, the workspace is
 * repo-backed (scratch/no-repo has no git), a sandbox exists to run the fork
 * in, and we are still on the default branch. Pure — exported for testing.
 */
export function shouldBranchOnFirstPrompt(input: FirstPromptBranchInput): boolean {
  if (!input.enabled) return false;
  if (!input.isFirstMessage) return false;
  if (!input.repoFullName) return false;
  if (!input.sandboxId) return false;
  const defaultBranch = input.defaultBranch ?? 'main';
  return (input.currentBranch ?? defaultBranch) === defaultBranch;
}

/**
 * Fork a work branch from the first prompt and migrate the conversation onto
 * it. A no-op when the preconditions don't hold. Best-effort: a fork failure is
 * logged and reported but never blocks the turn — the run continues on the
 * default branch and the commit-time fail-safe still applies. Emits symmetric
 * structured logs on the created/failed branches so a silent skip is
 * distinguishable from a degraded fork.
 */
export async function maybeBranchOnFirstPrompt(
  input: FirstPromptBranchInput,
  migrationCtx: BranchForkMigrationContext,
  deps: {
    fork?: typeof forkBranchInWorkspace;
    apply?: typeof applyBranchSwitchPayload;
  } = {},
): Promise<FirstPromptBranchResult> {
  if (!shouldBranchOnFirstPrompt(input)) return { branched: false };

  const fork = deps.fork ?? forkBranchInWorkspace;
  const apply = deps.apply ?? applyBranchSwitchPayload;
  const base = deriveBranchNameFromPrompt(
    input.promptText,
    getBranchSuggestionPrefix(input.repoFullName ?? undefined),
  );

  let lastError: string | undefined;
  for (let attempt = 0; attempt < MAX_BRANCH_NAME_ATTEMPTS; attempt++) {
    const name = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const result = await fork(input.sandboxId, name);
    if (result.ok && result.branchSwitch) {
      apply(result.branchSwitch, migrationCtx);
      console.log(
        JSON.stringify({
          level: 'info',
          event: 'branch_on_first_prompt_created',
          name,
          repoFullName: input.repoFullName,
        }),
      );
      return { branched: true, name };
    }
    lastError = result.errorMessage;
    // Only a name collision is worth another attempt — a different name won't
    // fix a missing sandbox or a git-level failure, so bail on those.
    if (!isBranchExistsMessage(result.errorMessage)) break;
  }

  console.log(
    JSON.stringify({
      level: 'warn',
      event: 'branch_on_first_prompt_failed',
      name: base,
      repoFullName: input.repoFullName,
      error: lastError,
    }),
  );
  return { branched: false, name: base, error: lastError };
}
