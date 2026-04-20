/**
 * Sandbox git/release tool handlers.
 *
 * Second extraction out of the `sandbox-tools.ts` dispatcher, mirroring
 * the verification-family pattern established in
 * `sandbox-verification-handlers.ts`. This module owns the five
 * git/release-family tools:
 *
 *   - `sandbox_diff`            → {@link handleSandboxDiff}
 *   - `sandbox_prepare_commit`  → {@link handlePrepareCommit}
 *   - `sandbox_push`            → {@link handleSandboxPush}
 *   - `sandbox_save_draft`      → {@link handleSaveDraft}
 *   - `promote_to_github`       → {@link handlePromoteToGithub}
 *
 * ## Design
 *
 * The handlers accept a {@link GitReleaseHandlerContext} carrying the
 * sandboxId and ten injected infrastructure dependencies (exec,
 * diff/read primitives, the Auditor, file-context fetcher, GitHub repo
 * creation, active-token accessor, two cache clearers used by
 * `sandbox_save_draft`). They return a `ToolExecutionResult` identical
 * in shape to what the inline `case` arms in the dispatcher used to
 * return. Behavior is preserved byte for byte — characterization tests
 * live at two layers: dispatcher-level in `sandbox-tools.test.ts`
 * (describes: `sandbox_diff`, `sandbox_prepare_commit characterization`,
 * `sandbox_push`, `promote_to_github`, `sandbox_save_draft`) and
 * handler-level in `sandbox-git-release-handlers.test.ts` (one
 * describe per handler). Both layers are the regression gate.
 *
 * ## Fitness rules (from the remediation plan)
 *
 *   - **Boundary:** this module imports no React hooks, no orchestrator,
 *     no dispatcher (`sandbox-tools.ts`), and no sibling tool handlers.
 *     All sandbox/platform functions enter through the handler context.
 *   - **API:** the dispatcher's `executeSandboxToolCall` remains the
 *     public entry point. This module exports the five handler
 *     functions plus the `GitReleaseHandlerContext` interface and the
 *     narrow per-handler argument types; nothing else.
 *   - **Dependency:** no import cycles. No barrel masking. No import
 *     from `./sandbox-tools`.
 *   - **Locality:** a future git/release change should touch only this
 *     file and its tests.
 */

import type {
  AuditVerdictCardData,
  CommitReviewCardData,
  DiffPreviewCardData,
  ToolExecutionResult,
} from '@/types';
import type { runAuditor as runAuditorFn } from './auditor-agent';
import type { ActiveProvider } from './orchestrator-provider-routing';
import type {
  AuditorFileContext,
  fetchAuditorFileContexts as fetchAuditorFileContextsFn,
} from './auditor-file-context';
import type { DiffResult, ExecResult, FileReadResult } from './sandbox-client';
import type { CreatedRepoResponse } from './sandbox-tool-utils';

import { parseDiffStats } from './diff-utils';
import {
  classifyError,
  formatStructuredError,
  sanitizeGitOutput,
  shellEscape,
} from './sandbox-tool-utils';

// ---------------------------------------------------------------------------
// Handler context
// ---------------------------------------------------------------------------

/** Signature of the exec-in-sandbox primitive the handlers call through. */
export type GitReleaseExecInSandbox = (
  sandboxId: string,
  command: string,
  workdir?: string,
  options?: { markWorkspaceMutated?: boolean },
) => Promise<ExecResult>;

/** Signature of the diff-fetch primitive the handlers call through. */
export type GitReleaseGetSandboxDiff = (sandboxId: string) => Promise<DiffResult>;

/** Signature of the sandbox read primitive used for Auditor file contexts. */
export type GitReleaseReadFromSandbox = (
  sandboxId: string,
  path: string,
  startLine?: number,
  endLine?: number,
) => Promise<FileReadResult>;

/** Signature of the repo-creation primitive used by `promote_to_github`. */
export type GitReleaseCreateGitHubRepo = (
  name: string,
  description: string | undefined,
  isPrivate: boolean,
) => Promise<CreatedRepoResponse>;

/** Signature of the active-token accessor used by `promote_to_github`. */
export type GitReleaseGetActiveGitHubToken = () => string;

/** Signature of the file-version-cache clearer used by `sandbox_save_draft`. */
export type GitReleaseClearFileVersionCache = (sandboxId: string) => void;

/** Signature of the prefetched-edit-file-cache clearer used by `sandbox_save_draft`. */
export type GitReleaseClearPrefetchedEditFileCache = (sandboxId: string) => void;

/**
 * The ambient context passed to every git/release handler.
 *
 * All sandbox/platform/auth primitives enter through this shape so the
 * module itself has zero runtime coupling to the infrastructure layer.
 * The dispatcher (`sandbox-tools.ts:executeSandboxToolCall`) is the one
 * place that wires up the real implementations.
 */
export interface GitReleaseHandlerContext {
  /** The sandbox to execute against. */
  sandboxId: string;
  /** Execute a shell command in the sandbox. */
  execInSandbox: GitReleaseExecInSandbox;
  /** Produce a unified diff of the sandbox working tree. */
  getSandboxDiff: GitReleaseGetSandboxDiff;
  /** Read a file out of the sandbox (used by Auditor file contexts). */
  readFromSandbox: GitReleaseReadFromSandbox;
  /** Run the Auditor agent over a diff. */
  runAuditor: typeof runAuditorFn;
  /** Fetch file contexts for the Auditor from a list of paths. */
  fetchAuditorFileContexts: typeof fetchAuditorFileContextsFn;
  /** Create a GitHub repository (first step of `promote_to_github`). */
  createGitHubRepo: GitReleaseCreateGitHubRepo;
  /** Read the active GitHub token from the ambient auth state. */
  getActiveGitHubToken: GitReleaseGetActiveGitHubToken;
  /** Clear the file-version cache after a workspace mutation (`sandbox_save_draft`). */
  clearFileVersionCache: GitReleaseClearFileVersionCache;
  /** Clear the prefetched-edit-file cache after a workspace mutation (`sandbox_save_draft`). */
  clearPrefetchedEditFileCache: GitReleaseClearPrefetchedEditFileCache;
}

// ---------------------------------------------------------------------------
// Narrow per-handler argument shapes
// ---------------------------------------------------------------------------

/** Args accepted by `sandbox_prepare_commit`. */
export interface PrepareCommitArgs {
  message: string;
}

/** Auditor provider/model overrides threaded through the dispatcher options. */
export interface PrepareCommitAuditorOverrides {
  providerOverride?: ActiveProvider;
  modelOverride?: string;
}

/** Args accepted by `promote_to_github`. */
export interface PromoteToGithubArgs {
  repo_name: string;
  description?: string;
  private?: boolean;
}

/** Args accepted by `sandbox_save_draft`. */
export interface SaveDraftArgs {
  /**
   * Optional draft branch name. If provided, must start with `draft/`
   * (the case arm rejects non-draft branch names because this tool
   * skips the Auditor — drafts are WIP and unaudited).
   */
  branch_name?: string;
  /** Commit message; defaults to `'WIP: draft save'` when omitted. */
  message?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum length (characters) of pre-commit hook output included in
 * `sandbox_prepare_commit` result text. Applied in two places: the
 * hook-fail preview embedded in the audit-verdict card text, and the
 * post-hook-empty-diff preview appended to the no-changes message.
 */
const HOOK_OUTPUT_TRUNCATION_LIMIT = 1200;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleSandboxDiff(
  ctx: GitReleaseHandlerContext,
): Promise<ToolExecutionResult> {
  const result = await ctx.getSandboxDiff(ctx.sandboxId);

  if (result.error) {
    const diffErr = classifyError(result.error, 'sandbox_diff');
    return {
      text: formatStructuredError(diffErr, `[Tool Error — sandbox_diff]\n${result.error}`),
      structuredError: diffErr,
    };
  }

  if (!result.diff) {
    const diagnosticLines = [`[Tool Result — sandbox_diff]`, `No changes detected.`];
    if (result.git_status) {
      diagnosticLines.push(`\ngit status output:\n${result.git_status}`);
    } else {
      diagnosticLines.push(
        `\nThe working tree is clean. If you expected changes, verify that sandbox_write_file succeeded and the file is inside /workspace.`,
      );
    }
    return { text: diagnosticLines.join('\n') };
  }

  const stats = parseDiffStats(result.diff);
  const lines: string[] = [
    `[Tool Result — sandbox_diff]`,
    `${stats.filesChanged} file${stats.filesChanged !== 1 ? 's' : ''} changed, +${stats.additions} -${stats.deletions}`,
    result.truncated ? `(truncated)\n` : '',
    result.diff,
  ];

  const cardData: DiffPreviewCardData = {
    diff: result.diff,
    filesChanged: stats.filesChanged,
    additions: stats.additions,
    deletions: stats.deletions,
    truncated: result.truncated,
  };

  return { text: lines.join('\n'), card: { type: 'diff-preview', data: cardData } };
}

export async function handlePrepareCommit(
  ctx: GitReleaseHandlerContext,
  args: PrepareCommitArgs,
  overrides?: PrepareCommitAuditorOverrides,
): Promise<ToolExecutionResult> {
  // Step 1: Get the diff
  const diffResult = await ctx.getSandboxDiff(ctx.sandboxId);

  if (diffResult.error) {
    const commitDiffErr = classifyError(diffResult.error, 'sandbox_prepare_commit');
    return {
      text: formatStructuredError(
        commitDiffErr,
        `[Tool Error — sandbox_prepare_commit]\n${diffResult.error}`,
      ),
      structuredError: commitDiffErr,
    };
  }

  if (!diffResult.diff) {
    const lines = [`[Tool Result — sandbox_prepare_commit]\nNo changes to commit.`];
    if (diffResult.git_status) {
      lines.push(`git status shows: ${diffResult.git_status}`);
    } else {
      lines.push(
        `Working tree is clean. Verify files were written inside /workspace and content differs from the original.`,
      );
    }
    return { text: lines.join('\n') };
  }

  // Step 2: Run pre-commit hook before auditing so the review reflects
  // the exact tree the user would commit.
  const hookResult = await ctx.execInSandbox(
    ctx.sandboxId,
    'if [ -x .git/hooks/pre-commit ]; then .git/hooks/pre-commit 2>&1 || exit $?; fi',
    '/workspace',
  );
  const hookOutput = [hookResult.stdout, hookResult.stderr]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join('\n')
    .trim();

  if ((hookResult.exitCode ?? 0) !== 0) {
    const outputPreview = hookOutput
      ? hookOutput.slice(0, HOOK_OUTPUT_TRUNCATION_LIMIT)
      : 'The hook exited without any output.';
    const verdictCard: AuditVerdictCardData = {
      verdict: 'unsafe',
      summary: 'Pre-commit hook failed. Fix the hook errors before preparing this commit.',
      risks: [
        {
          level: 'medium',
          description: `pre-commit exited with code ${hookResult.exitCode}. ${outputPreview}`,
        },
      ],
      filesReviewed: parseDiffStats(diffResult.diff).filesChanged,
    };
    return {
      text: `[Tool Result — sandbox_prepare_commit]\nCommit BLOCKED by pre-commit hook (exit ${hookResult.exitCode}).\n${outputPreview}`,
      card: { type: 'audit-verdict', data: verdictCard },
    };
  }

  const postHookDiffResult = await ctx.getSandboxDiff(ctx.sandboxId);
  if (postHookDiffResult.error) {
    const commitDiffErr = classifyError(postHookDiffResult.error, 'sandbox_prepare_commit');
    return {
      text: formatStructuredError(
        commitDiffErr,
        `[Tool Error — sandbox_prepare_commit]\n${postHookDiffResult.error}`,
      ),
      structuredError: commitDiffErr,
    };
  }

  if (!postHookDiffResult.diff) {
    const lines = [
      `[Tool Result — sandbox_prepare_commit]\nNo changes to commit after running the pre-commit hook.`,
    ];
    if (postHookDiffResult.git_status) {
      lines.push(`git status shows: ${postHookDiffResult.git_status}`);
    }
    if (hookOutput) {
      lines.push(`pre-commit output:\n${hookOutput.slice(0, HOOK_OUTPUT_TRUNCATION_LIMIT)}`);
    }
    return { text: lines.join('\n') };
  }

  // Step 3: Fetch file context for richer Auditor review.
  let fileContexts: AuditorFileContext[] = [];
  try {
    const filePaths = parseDiffStats(postHookDiffResult.diff).fileNames;
    fileContexts = await ctx.fetchAuditorFileContexts(filePaths, async (path) => {
      const result = await ctx.readFromSandbox(ctx.sandboxId, `/workspace/${path}`);
      if (result.error) return null;
      return { content: result.content, truncated: result.truncated };
    });
  } catch {
    // Degrade gracefully — proceed with diff-only
  }

  // Step 4: Run Auditor on the post-hook diff.
  const auditResult = await ctx.runAuditor(
    postHookDiffResult.diff,
    (phase) => console.log(`[Push] Auditor: ${phase}`),
    {
      source: 'sandbox-prepare-commit',
      sourceLabel: 'sandbox_prepare_commit preflight',
    },
    {
      exitCode: hookResult.exitCode ?? 0,
      output: hookResult.stdout + hookResult.stderr,
    },
    {
      providerOverride: overrides?.providerOverride,
      modelOverride: overrides?.modelOverride,
    },
    fileContexts,
  );

  if (auditResult.verdict === 'unsafe') {
    // Blocked — return verdict card only, no review card
    return {
      text: `[Tool Result — sandbox_prepare_commit]\nCommit BLOCKED by Auditor: ${auditResult.card.summary}`,
      card: { type: 'audit-verdict', data: auditResult.card },
    };
  }

  // Step 5: SAFE — return a review card for user approval (do NOT commit)
  const stats = parseDiffStats(postHookDiffResult.diff);
  const reviewData: CommitReviewCardData = {
    diff: {
      diff: postHookDiffResult.diff,
      filesChanged: stats.filesChanged,
      additions: stats.additions,
      deletions: stats.deletions,
      truncated: postHookDiffResult.truncated,
    },
    auditVerdict: auditResult.card,
    commitMessage: args.message,
    status: 'pending',
  };

  return {
    text: `[Tool Result — sandbox_prepare_commit]\nReady for review: "${args.message}" (${stats.filesChanged} file${stats.filesChanged !== 1 ? 's' : ''}, +${stats.additions} -${stats.deletions}). Waiting for user approval.`,
    card: { type: 'commit-review', data: reviewData },
  };
}

export async function handleSandboxPush(
  ctx: GitReleaseHandlerContext,
): Promise<ToolExecutionResult> {
  const pushResult = await ctx.execInSandbox(
    ctx.sandboxId,
    'cd /workspace && git push origin HEAD',
    undefined,
    { markWorkspaceMutated: true },
  );

  if (pushResult.exitCode !== 0) {
    return { text: `[Tool Result — sandbox_push]\nPush failed: ${pushResult.stderr}` };
  }

  return { text: `[Tool Result — sandbox_push]\nPushed successfully.` };
}

export async function handlePromoteToGithub(
  ctx: GitReleaseHandlerContext,
  args: PromoteToGithubArgs,
): Promise<ToolExecutionResult> {
  const requestedName = args.repo_name.trim();
  const repoName = requestedName.includes('/')
    ? requestedName.split('/').pop()!.trim()
    : requestedName;
  if (!repoName) {
    return { text: '[Tool Error] promote_to_github requires a valid repo_name.' };
  }

  const createdRepo = await ctx.createGitHubRepo(
    repoName,
    args.description,
    args.private !== undefined ? args.private : true,
  );

  const authToken = ctx.getActiveGitHubToken();
  if (!authToken) {
    return { text: '[Tool Error] GitHub auth token missing after repo creation.' };
  }
  const remoteUrl = `https://x-access-token:${authToken}@github.com/${createdRepo.full_name}.git`;

  const branchResult = await ctx.execInSandbox(
    ctx.sandboxId,
    'cd /workspace && git rev-parse --abbrev-ref HEAD',
  );
  const branchName =
    branchResult.exitCode === 0
      ? branchResult.stdout.trim() || createdRepo.default_branch || 'main'
      : createdRepo.default_branch || 'main';

  const remoteResult = await ctx.execInSandbox(
    ctx.sandboxId,
    `cd /workspace && if git remote get-url origin >/dev/null 2>&1; then git remote set-url origin ${shellEscape(remoteUrl)}; else git remote add origin ${shellEscape(remoteUrl)}; fi`,
  );
  if (remoteResult.exitCode !== 0) {
    const remoteError = sanitizeGitOutput(
      remoteResult.stderr || remoteResult.stdout || 'unknown error',
      authToken,
    );
    return {
      text: `[Tool Error] Created repo ${createdRepo.full_name}, but failed to configure git remote: ${remoteError}`,
    };
  }

  const pushResult = await ctx.execInSandbox(
    ctx.sandboxId,
    `cd /workspace && git push -u origin ${shellEscape(branchName)}`,
    undefined,
    { markWorkspaceMutated: true },
  );

  const rawPushError = `${pushResult.stderr}\n${pushResult.stdout}`.toLowerCase();
  const noCommitsYet =
    rawPushError.includes('src refspec') ||
    rawPushError.includes('does not match any') ||
    rawPushError.includes('no commits yet');

  const repoObject = {
    id: createdRepo.id,
    name: createdRepo.name,
    full_name: createdRepo.full_name,
    owner: createdRepo.owner?.login || createdRepo.full_name.split('/')[0],
    default_branch: createdRepo.default_branch || branchName || 'main',
    private: createdRepo.private,
  };

  if (pushResult.exitCode !== 0 && !noCommitsYet) {
    const pushError = sanitizeGitOutput(
      pushResult.stderr || pushResult.stdout || 'unknown error',
      authToken,
    );
    return {
      text: `[Tool Error] Repo ${createdRepo.full_name} was created, but push failed: ${pushError}. You can retry after fixing git/auth state.`,
    };
  }

  const warning =
    pushResult.exitCode !== 0 && noCommitsYet
      ? 'Repo created and remote configured, but there were no local commits to push yet.'
      : undefined;

  const lines = [
    '[Tool Result — promote_to_github]',
    `Repository created: ${createdRepo.full_name}`,
    `Visibility: ${createdRepo.private ? 'private' : 'public'}`,
    `Default branch: ${createdRepo.default_branch || branchName || 'main'}`,
    warning ? `Warning: ${warning}` : `Push: successful on branch ${branchName}`,
  ];

  return {
    text: lines.join('\n'),
    promotion: {
      repo: repoObject,
      pushed: !warning,
      warning,
      htmlUrl: createdRepo.html_url,
    },
  };
}

export async function handleSaveDraft(
  ctx: GitReleaseHandlerContext,
  args: SaveDraftArgs,
): Promise<ToolExecutionResult> {
  // Step 1: Check for uncommitted changes
  const draftDiffResult = await ctx.getSandboxDiff(ctx.sandboxId);

  if (draftDiffResult.error) {
    return { text: `[Tool Error — sandbox_save_draft]\n${draftDiffResult.error}` };
  }

  if (!draftDiffResult.diff) {
    return {
      text: '[Tool Result — sandbox_save_draft]\nNo changes to save. Working tree is clean.',
    };
  }

  // Step 2: Get current branch
  const currentBranchResult = await ctx.execInSandbox(
    ctx.sandboxId,
    'cd /workspace && git branch --show-current',
  );
  const currentBranch = currentBranchResult.exitCode === 0 ? currentBranchResult.stdout.trim() : '';

  // Step 3: Determine draft branch name — must start with draft/ (unaudited path)
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  if (args.branch_name && !args.branch_name.startsWith('draft/')) {
    return {
      text: '[Tool Error — sandbox_save_draft]\nbranch_name must start with "draft/". This tool skips Auditor review and is restricted to draft branches. Use sandbox_prepare_commit for non-draft branches.',
    };
  }
  const draftBranchName = args.branch_name || `draft/${currentBranch || 'main'}-${timestamp}`;

  // Step 4: Create draft branch if not already on the requested one. If the
  // caller passed an explicit branch_name and it differs from the current
  // branch, honor the request even when the current branch is also a draft/
  // branch — otherwise an explicit target is silently ignored.
  const needsNewBranch = args.branch_name
    ? args.branch_name !== currentBranch
    : !currentBranch.startsWith('draft/');
  if (needsNewBranch) {
    const checkoutResult = await ctx.execInSandbox(
      ctx.sandboxId,
      `cd /workspace && git checkout -b ${shellEscape(draftBranchName)}`,
      undefined,
      { markWorkspaceMutated: true },
    );
    if (checkoutResult.exitCode !== 0) {
      return {
        text: `[Tool Error — sandbox_save_draft]\nFailed to create draft branch: ${checkoutResult.stderr}`,
      };
    }
  }

  const activeDraftBranch = needsNewBranch ? draftBranchName : currentBranch;

  // Step 5: Stage all changes and commit (no Auditor — drafts are WIP)
  const draftMessage = args.message || 'WIP: draft save';
  const stageResult = await ctx.execInSandbox(
    ctx.sandboxId,
    'cd /workspace && git add -A',
    undefined,
    { markWorkspaceMutated: true },
  );
  if (stageResult.exitCode !== 0) {
    return {
      text: `[Tool Error — sandbox_save_draft]\nFailed to stage changes: ${stageResult.stderr}`,
    };
  }

  const commitResult = await ctx.execInSandbox(
    ctx.sandboxId,
    `cd /workspace && git commit -m ${shellEscape(draftMessage)}`,
    undefined,
    { markWorkspaceMutated: true },
  );
  if (commitResult.exitCode !== 0) {
    return {
      text: `[Tool Error — sandbox_save_draft]\nFailed to commit draft: ${commitResult.stderr}`,
    };
  }
  // git add + commit changes file hashes tracked by git
  ctx.clearFileVersionCache(ctx.sandboxId);
  ctx.clearPrefetchedEditFileCache(ctx.sandboxId);

  // Step 6: Push to remote
  const pushResult = await ctx.execInSandbox(
    ctx.sandboxId,
    `cd /workspace && git push -u origin ${shellEscape(activeDraftBranch)}`,
    undefined,
    { markWorkspaceMutated: true },
  );

  const pushOk = pushResult.exitCode === 0;
  const commitSha = commitResult.stdout.match(/\[.+? ([a-f0-9]+)\]/)?.[1] || 'unknown';
  const draftStats = parseDiffStats(draftDiffResult.diff);

  const draftLines: string[] = [
    `[Tool Result — sandbox_save_draft]`,
    `Draft saved to branch: ${activeDraftBranch}`,
    `Commit: ${commitSha}`,
    `Message: ${draftMessage}`,
    `${draftStats.filesChanged} file${draftStats.filesChanged !== 1 ? 's' : ''} changed, +${draftStats.additions} -${draftStats.deletions}`,
    pushOk
      ? 'Pushed to remote.'
      : `Push failed: ${pushResult.stderr}. Use sandbox_push() to retry.`,
  ];

  const draftCardData: DiffPreviewCardData = {
    diff: draftDiffResult.diff,
    filesChanged: draftStats.filesChanged,
    additions: draftStats.additions,
    deletions: draftStats.deletions,
    truncated: draftDiffResult.truncated,
  };

  return {
    text: draftLines.join('\n'),
    card: { type: 'diff-preview', data: draftCardData },
    // Propagate branch switch to app state so chat/merge context stays in sync
    ...(needsNewBranch ? { branchSwitch: activeDraftBranch } : {}),
  };
}
