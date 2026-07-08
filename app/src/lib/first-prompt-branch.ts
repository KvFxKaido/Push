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
import {
  deriveBranchNameFromPrompt,
  deriveBranchNameFromPromptSuggestion,
  getBranchSuggestionPrefix,
} from './branch-names';
import { isBranchExistsMessage } from './ensure-commit-target-branch';
import { forkBranchInWorkspace } from './fork-branch-in-workspace';
import {
  getActiveProvider,
  getProviderPushStream,
  type ActiveProvider,
} from './orchestrator-provider-routing';
import { getModelForRole } from './providers';
import { iteratePushStreamText } from '@push/lib/stream-utils';
import type { ChatMessage } from '@/types';

/** Bounded suffix retries on a name collision, mirroring the commit-time
 *  fail-safe's `withNumericSuffix` loop. Keeps common/repeated first prompts
 *  ("Fix login") in the same repo from silently staying on the default branch. */
const MAX_BRANCH_NAME_ATTEMPTS = 5;
const PROMPT_BRANCH_NAME_TIMEOUT_MS = 2500;

const PROMPT_BRANCH_NAME_SYSTEM_PROMPT = `You generate git branch names.

Return ONLY one branch name, nothing else.

Rules:
- lowercase only
- kebab-case words
- use the required prefix exactly
- summarize the user's intent; do not copy the whole prompt
- no spaces, quotes, markdown, bullets, or explanations
- keep the topic to 2-5 words`;

export type FirstPromptBranchNameProposer = (input: {
  promptText: string;
  repoFullName: string;
  prefix: string;
}) => Promise<string | null | undefined>;

type FirstPromptBranchNameInput = Pick<
  FirstPromptBranchInput,
  | 'enabled'
  | 'isFirstMessage'
  | 'promptText'
  | 'repoFullName'
  | 'currentBranch'
  | 'defaultBranch'
  | 'provider'
  | 'model'
>;

export interface ModelFirstPromptBranchNameProposerOptions {
  providerOverride?: ActiveProvider | null;
  modelOverride?: string | null;
}

export function createModelFirstPromptBranchNameProposer(
  options: ModelFirstPromptBranchNameProposerOptions = {},
): FirstPromptBranchNameProposer {
  return async ({ promptText, repoFullName, prefix }) => {
    const provider = options.providerOverride || getActiveProvider();
    if (provider === 'demo') return null;
    const model = options.modelOverride?.trim() || getModelForRole(provider, 'orchestrator')?.id;
    if (!model) return null;

    const messages: ChatMessage[] = [
      {
        id: 'first-prompt-branch-name-request',
        role: 'user',
        content: [
          "Name the git branch for this new workspace from the user's first prompt.",
          `Required prefix: ${prefix}/`,
          `Repository: ${repoFullName}`,
          'Return exactly one branch name.',
          '',
          'First prompt:',
          promptText.slice(0, 2000),
        ].join('\n'),
        timestamp: Date.now(),
      },
    ];

    const { error, text } = await iteratePushStreamText(
      getProviderPushStream(provider),
      {
        provider,
        model,
        messages,
        systemPromptOverride: PROMPT_BRANCH_NAME_SYSTEM_PROMPT,
        hasSandbox: false,
      },
      PROMPT_BRANCH_NAME_TIMEOUT_MS,
      `Branch name suggestion timed out after ${PROMPT_BRANCH_NAME_TIMEOUT_MS / 1000}s.`,
    );

    return error ? null : text;
  };
}

export function shouldStartFirstPromptBranchNameSuggestion(
  input: FirstPromptBranchNameInput,
): boolean {
  if (!input.enabled) return false;
  if (!input.isFirstMessage) return false;
  if (!input.repoFullName) return false;
  if (!input.currentBranch) return false;
  const defaultBranch = input.defaultBranch ?? 'main';
  return input.currentBranch === defaultBranch;
}

export function startFirstPromptBranchNameSuggestion(
  input: FirstPromptBranchNameInput,
  proposer: FirstPromptBranchNameProposer = createModelFirstPromptBranchNameProposer({
    providerOverride: input.provider,
    modelOverride: input.model,
  }),
): Promise<string | null | undefined> | undefined {
  if (!shouldStartFirstPromptBranchNameSuggestion(input)) return undefined;
  const repoFullName = input.repoFullName;
  if (!repoFullName) return undefined;
  const prefix = getBranchSuggestionPrefix(repoFullName);
  return proposer({
    promptText: input.promptText,
    repoFullName,
    prefix,
  }).catch(() => null);
}

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
  /**
   * The branch the session is on. Must be the *raw* value (undefined when not
   * yet known), not collapsed to the default branch — branching only fires when
   * this is known and equals `defaultBranch`, so an undefined here means "leave
   * the session where it is".
   */
  currentBranch?: string;
  defaultBranch?: string;
  /** Provider/model already locked for this chat send. */
  provider?: ActiveProvider | null;
  model?: string | null;
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
 * in, and the session is *positively known* to be on the default branch. Pure
 * — exported for testing.
 *
 * The branch must be known and equal to the default: an unknown current branch
 * is treated as "not on the default branch" so a session the user deliberately
 * started on an existing branch is never force-forked off it. (The earlier rule
 * defaulted unknown → on-default, which auto-branched branch-started sessions
 * the moment branch metadata hadn't loaded yet.) The commit-time fail-safe in
 * `ensure-commit-target-branch.ts` still guards an actual commit landing on the
 * default branch, so erring toward "don't branch" here loses no protection.
 */
export function shouldBranchOnFirstPrompt(input: FirstPromptBranchInput): boolean {
  if (!input.sandboxId) return false;
  return shouldStartFirstPromptBranchNameSuggestion(input);
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
    proposedName?: Promise<string | null | undefined>;
    proposeName?: FirstPromptBranchNameProposer;
  } = {},
): Promise<FirstPromptBranchResult> {
  if (!shouldBranchOnFirstPrompt(input)) return { branched: false };

  const repoFullName = input.repoFullName;
  if (!repoFullName) return { branched: false };

  const fork = deps.fork ?? forkBranchInWorkspace;
  const apply = deps.apply ?? applyBranchSwitchPayload;
  const prefix = getBranchSuggestionPrefix(repoFullName);
  const fallbackBase = deriveBranchNameFromPrompt(input.promptText, prefix);
  let base = fallbackBase;

  const proposeName =
    deps.proposeName ??
    createModelFirstPromptBranchNameProposer({
      providerOverride: input.provider,
      modelOverride: input.model,
    });
  try {
    const proposed = await (deps.proposedName ??
      proposeName({
        promptText: input.promptText,
        repoFullName,
        prefix,
      }));
    if (proposed?.trim()) {
      base = deriveBranchNameFromPromptSuggestion(proposed, prefix);
    }
  } catch {
    base = fallbackBase;
  }

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
          repoFullName,
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
      repoFullName,
      error: lastError,
    }),
  );
  return { branched: false, name: base, error: lastError };
}
