/**
 * Sandbox git/release tool handlers.
 *
 * Second extraction out of the `sandbox-tools.ts` dispatcher, mirroring
 * the verification-family pattern established in
 * `sandbox-verification-handlers.ts`. This module owns the five
 * git/release-family tools:
 *
 *   - `sandbox_diff`            → {@link handleSandboxDiff}
 *   - `sandbox_commit`          → {@link handleSandboxCommit}
 *   - `prepare_push`            → {@link handlePreparePush}
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
 * (describes: `sandbox_diff`, `sandbox_commit`, `prepare_push`,
 * `sandbox_push`, `promote_to_github`, `sandbox_save_draft`) and
 * handler-level in `sandbox-git-release-handlers.test.ts` (one
 * describe per handler). Both layers are the regression gate.
 *
 * ## Gate-at-Push Move A
 *
 * The SAFE/UNSAFE Auditor gate lives at the *push* step, not the commit step.
 * `sandbox_commit` makes a silent local commit (pre-commit hook + auto-branch
 * off main, NO Auditor, NO review card). `prepare_push` audits the cumulative
 * push diff and returns the review card; approval pushes (gated). The retired
 * prepare-commit tool (audit-at-commit) is replaced by this pair.
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
  PushPlanSummary,
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
  createModelCommitBranchNameProposer,
  ensureCommitTargetBranch,
  type CommitTargetForkFn,
} from './ensure-commit-target-branch';
import {
  computeSandboxPushedDiff,
  computeSandboxPushPlan,
  createSandboxPushGit,
  resolveWebAuditAtPushEnabled,
} from './git-backend';
import type { AuditorPushVerdict } from '@push/lib/git/auditor-push-gate';
import type { PushGit } from '@push/lib/git/push-git';
import type { PushPlan } from '@push/lib/git/push-plan';
import { GIT_REF_VALIDATION_DETAIL, isInvalidGitRef } from './git-ref-validation';
import { isDefinitivelyGoneMessage } from './sandbox-error-utils';
import {
  classifyError,
  formatStructuredError,
  sanitizeGitOutput,
  shellEscape,
} from './sandbox-tool-utils';
import type { StructuredToolError } from '@/types';
import { notifyWorkspaceMutation } from './sandbox-mutation-signal';

// ---------------------------------------------------------------------------
// Handler context
// ---------------------------------------------------------------------------

/** Signature of the exec-in-sandbox primitive the handlers call through. */
export type GitReleaseExecInSandbox = (
  sandboxId: string,
  command: string,
  workdir?: string,
  options?: { markWorkspaceMutated?: boolean; suppressWorkspaceMutationSignal?: boolean },
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

type SandboxPushGitOptions = NonNullable<Parameters<typeof createSandboxPushGit>[1]>;
type PushedDiffReadOptions = { ref?: string; remote?: string };
type PushPlanReadOptions = { ref?: string; remote?: string };

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
  /** Push's active branch for this workspace, threaded from the UI/tool runtime. */
  currentBranch?: string;
  /** The repo default branch for this workspace, threaded from the UI/tool runtime. */
  defaultBranch?: string;
  /**
   * Protect Main toggle for this session, threaded from the tool runtime. When
   * true, `sandbox_push` enforces it at the push boundary (a fail-closed
   * pre-push gate that reads the real HEAD), independent of the Protect Main
   * `PreToolUse` hook — defense-in-depth, not a replacement.
   */
  isMainProtected?: boolean;
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
  /** PushGit factory for the active git surface. Defaults to sandbox PushGit. */
  createPushGit?: (opts?: SandboxPushGitOptions) => PushGit;
  /** Active git surface for staleness pins carried on push-review cards. */
  gitSurface?: 'sandbox' | 'native';
  /** Pushed-diff reader for the active git surface. Defaults to sandbox git. */
  computePushedDiff?: (opts?: PushedDiffReadOptions) => Promise<string | null>;
  /**
   * Ref-only push-plan reader. `null` means this surface cannot establish a
   * force-with-lease plan yet (native slice 3); approval relies on pinned
   * branch/head/remote plus git's own non-fast-forward rejection.
   */
  computePushPlan?: ((opts?: PushPlanReadOptions) => Promise<PushPlan>) | null;
  /** Pre-commit hook runner. Native has no shell and supplies a no-op. */
  runPreCommitHook?: () => Promise<ExecResult>;
  /** Optional untracked-diff synthesizer. Native working-tree diff already includes untracked files. */
  collectUntrackedDiff?: () => Promise<string>;
  /** Optional branch collision check for auto-branch-on-commit. */
  branchExists?: (branch: string) => Promise<boolean>;
  /** Optional fork implementation for auto-branch-on-commit. */
  forkCommitTargetBranch?: CommitTargetForkFn;
  /** Optional notification after a handler-created branch switch succeeds. */
  onBranchChanged?: (branch: string) => void;
}

// ---------------------------------------------------------------------------
// Narrow per-handler argument shapes
// ---------------------------------------------------------------------------

/** Args accepted by `sandbox_commit`. */
export interface SandboxCommitArgs {
  message: string;
}

/**
 * Auditor provider/model overrides threaded through the dispatcher options.
 * Reused by `handleSandboxPush`, `handleSandboxCommit` (for the branch-name
 * proposer), and `handlePreparePush` (for the push-time Auditor).
 */
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
 * `sandbox_commit` result text. Applied to the hook-fail / post-hook-empty
 * previews appended to the commit result message.
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

/** Cap on `git show` output forwarded to the model (chars). Large commits
 *  truncate rather than blow the turn's context budget. */
const SHOW_COMMIT_MAX_OUTPUT = 60_000;

/** Single-quote a shell argument (validated upstream by `isSafeGitRef` /
 *  `sanitizeGitPathspecs`); the quoting is the second safety layer. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Read-only inspection of a committed diff via `git show <ref>`. The command is
 * assembled by Push from validated args (never a model-supplied shell string),
 * which is what lets this be a `readOnly` tool — several can batch in one turn,
 * unlike `sandbox_exec git show` which is opaque and capped to one per turn.
 */
export async function handleShowCommit(
  ctx: GitReleaseHandlerContext,
  args: { ref: string; paths?: string[]; stat?: boolean },
): Promise<ToolExecutionResult> {
  // `--no-ext-diff` / `--no-textconv` disable repo-configured external diff and
  // textconv drivers (`.gitattributes` + git config). Without them, `git show`
  // on an attacker-controlled repo could execute arbitrary repo-defined
  // commands during what is registered as a read-only inspection — and this
  // tool runs in the parallel read phase with no side-effecting guard (Codex P1).
  const parts = ['git', '--no-pager', 'show', '--no-color', '--no-ext-diff', '--no-textconv'];
  if (args.stat) parts.push('--stat');
  parts.push(shellQuote(args.ref));
  if (args.paths && args.paths.length > 0) {
    parts.push('--', ...args.paths.map(shellQuote));
  }
  const command = parts.join(' ');

  const result = await ctx.execInSandbox(ctx.sandboxId, command, '/workspace');
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';

  if ((result.exitCode ?? 0) !== 0) {
    const reason = stderr.trim() || stdout.trim() || `git show exited ${result.exitCode}`;
    const err = classifyError(reason, 'sandbox_show_commit');
    err.detail = `ref: ${args.ref}`;
    return {
      text: formatStructuredError(err, `[Tool Error — sandbox_show_commit]\n${reason}`),
      structuredError: err,
    };
  }

  if (!stdout.trim()) {
    return {
      text: `[Tool Result — sandbox_show_commit]\nRef: ${args.ref}\n\n(no output — the ref resolved but the diff was empty for the given paths)`,
    };
  }

  const truncated = stdout.length > SHOW_COMMIT_MAX_OUTPUT;
  const body = truncated ? stdout.slice(0, SHOW_COMMIT_MAX_OUTPUT) : stdout;

  // `--stat` output is a summary, not a unified diff — skip diff stats / card.
  if (args.stat) {
    const header = [
      `[Tool Result — sandbox_show_commit]`,
      `Ref: ${args.ref} (--stat)`,
      truncated ? `(truncated to ${SHOW_COMMIT_MAX_OUTPUT} chars)` : '',
    ]
      .filter(Boolean)
      .join('\n');
    return { text: `${header}\n\n${body}` };
  }

  const stats = parseDiffStats(body);
  const header = [
    `[Tool Result — sandbox_show_commit]`,
    `Ref: ${args.ref}`,
    `${stats.filesChanged} file${stats.filesChanged !== 1 ? 's' : ''} changed, +${stats.additions} -${stats.deletions}`,
    truncated ? `(truncated to ${SHOW_COMMIT_MAX_OUTPUT} chars)` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const cardData: DiffPreviewCardData = {
    diff: body,
    filesChanged: stats.filesChanged,
    additions: stats.additions,
    deletions: stats.deletions,
    truncated,
  };
  return { text: `${header}\n\n${body}`, card: { type: 'diff-preview', data: cardData } };
}

/**
 * `git diff HEAD` (what the sandbox `diff` route returns) never lists brand-new
 * untracked files, so a commit whose only change is a new file looks empty and
 * the gate in `handleSandboxCommit` would short-circuit before the backend's
 * `add -A` ever runs (issue #1075). Untracked files surface in
 * `git status --porcelain` as `??` entries — detect them so the commit proceeds.
 */
function statusHasUntracked(gitStatus: string | undefined): boolean {
  if (!gitStatus) return false;
  return gitStatus.split('\n').some((line) => line.startsWith('??'));
}

/**
 * Synthesize new-file diffs for untracked files so the commit's stats and the
 * auto-branch-name proposer reflect them — the working-tree `git diff HEAD`
 * omits untracked content (#1075). Read-only: `git diff --no-index /dev/null
 * <file>` never touches the index, and the trailing `|| true` keeps git's
 * "differences found" exit 1 from looking like a failure. `--no-ext-diff` /
 * `--no-textconv` disable any repo-configured external/textconv diff drivers so
 * this read-only probe can't trigger a helper (matching `handleShowCommit`).
 * Returns '' when there are no untracked files.
 */
async function collectUntrackedDiff(ctx: GitReleaseHandlerContext): Promise<string> {
  const res = await ctx.execInSandbox(
    ctx.sandboxId,
    'git ls-files --others --exclude-standard -z | ' +
      'xargs -0 -r -I{} git --no-pager diff --no-ext-diff --no-textconv --no-index /dev/null {} || true',
    '/workspace',
  );
  return res.stdout ?? '';
}

function createReleasePushGit(
  ctx: GitReleaseHandlerContext,
  opts?: SandboxPushGitOptions,
): PushGit {
  if (ctx.createPushGit) return ctx.createPushGit(opts);
  return createSandboxPushGit(ctx.sandboxId, {
    ...opts,
    execFn: opts?.execFn ?? ctx.execInSandbox,
  });
}

function computeReleasePushedDiff(
  ctx: GitReleaseHandlerContext,
  opts?: PushedDiffReadOptions,
): Promise<string | null> {
  if (ctx.computePushedDiff) return ctx.computePushedDiff(opts);
  return computeSandboxPushedDiff(ctx.sandboxId, ctx.execInSandbox, opts);
}

async function computeReleasePushPlan(
  ctx: GitReleaseHandlerContext,
  opts?: PushPlanReadOptions,
): Promise<PushPlan | null> {
  if (ctx.computePushPlan === null) return null;
  if (ctx.computePushPlan) return ctx.computePushPlan(opts);
  return computeSandboxPushPlan(ctx.sandboxId, ctx.execInSandbox, opts);
}

function runReleasePreCommitHook(ctx: GitReleaseHandlerContext): Promise<ExecResult> {
  if (ctx.runPreCommitHook) return ctx.runPreCommitHook();
  return ctx.execInSandbox(
    ctx.sandboxId,
    'if [ -x .git/hooks/pre-commit ]; then .git/hooks/pre-commit 2>&1 || exit $?; fi',
    '/workspace',
    { markWorkspaceMutated: true },
  );
}

/**
 * `sandbox_commit` (Gate-at-Push Move A) — make a SILENT local commit.
 *
 * No Auditor, no review card: commits are now cheap and unaudited; the
 * SAFE/UNSAFE gate has moved to the push step (`prepare_push`). This runs the
 * repo's pre-commit hook (so formatters/codegen still fire), auto-forks off the
 * default branch first (a commit must never land on main), then commits via the
 * active git facade (`PushGit.commit()` — NOT a raw `git commit`, which stays
 * blocked in `sandbox_exec`).
 */
export async function handleSandboxCommit(
  ctx: GitReleaseHandlerContext,
  args: SandboxCommitArgs,
  overrides?: PrepareCommitAuditorOverrides,
): Promise<ToolExecutionResult> {
  // Step 1: Get the diff — nothing to commit short-circuits.
  const diffResult = await ctx.getSandboxDiff(ctx.sandboxId);

  if (diffResult.error) {
    const commitDiffErr = classifyError(diffResult.error, 'sandbox_commit');
    console.log(
      JSON.stringify({
        level: 'error',
        event: 'sandbox_commit_diff_failed',
        sandboxId: ctx.sandboxId,
        error: diffResult.error,
      }),
    );
    return {
      text: formatStructuredError(
        commitDiffErr,
        `[Tool Error — sandbox_commit]\n${diffResult.error}`,
      ),
      structuredError: commitDiffErr,
    };
  }

  if (!diffResult.diff && !statusHasUntracked(diffResult.git_status)) {
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'sandbox_commit_empty',
        sandboxId: ctx.sandboxId,
        phase: 'pre-hook',
      }),
    );
    const lines = [`[Tool Result — sandbox_commit]\nNothing to commit.`];
    if (diffResult.git_status) {
      lines.push(`git status shows: ${diffResult.git_status}`);
    } else {
      lines.push(
        `Working tree is clean. Verify files were written inside /workspace and content differs from the original.`,
      );
    }
    return { text: lines.join('\n') };
  }

  // Step 2: Run pre-commit hook before committing so hooks still fire.
  const hookResult = await runReleasePreCommitHook(ctx);
  const hookOutput = [hookResult.stdout, hookResult.stderr]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join('\n')
    .trim();

  if ((hookResult.exitCode ?? 0) !== 0) {
    const outputPreview = hookOutput
      ? hookOutput.slice(0, HOOK_OUTPUT_TRUNCATION_LIMIT)
      : 'The hook exited without any output.';
    console.log(
      JSON.stringify({
        level: 'warn',
        event: 'sandbox_commit_hook_failed',
        sandboxId: ctx.sandboxId,
        exitCode: hookResult.exitCode,
      }),
    );
    return {
      text: `[Tool Result — sandbox_commit]\nCommit BLOCKED by pre-commit hook (exit ${hookResult.exitCode}).\n${outputPreview}`,
    };
  }

  // Re-read the diff after the hook — a formatter/codegen hook may have rewritten
  // tracked files, and the commit is over the post-hook tree.
  const postHookDiffResult = await ctx.getSandboxDiff(ctx.sandboxId);
  if (postHookDiffResult.error) {
    const commitDiffErr = classifyError(postHookDiffResult.error, 'sandbox_commit');
    console.log(
      JSON.stringify({
        level: 'error',
        event: 'sandbox_commit_diff_failed',
        sandboxId: ctx.sandboxId,
        phase: 'post-hook',
        error: postHookDiffResult.error,
      }),
    );
    return {
      text: formatStructuredError(
        commitDiffErr,
        `[Tool Error — sandbox_commit]\n${postHookDiffResult.error}`,
      ),
      structuredError: commitDiffErr,
    };
  }

  if (!postHookDiffResult.diff && !statusHasUntracked(postHookDiffResult.git_status)) {
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'sandbox_commit_empty',
        sandboxId: ctx.sandboxId,
        phase: 'post-hook',
      }),
    );
    const lines = [
      `[Tool Result — sandbox_commit]\nNothing to commit after running the pre-commit hook.`,
    ];
    if (postHookDiffResult.git_status) {
      lines.push(`git status shows: ${postHookDiffResult.git_status}`);
    }
    if (hookOutput) {
      lines.push(`pre-commit output:\n${hookOutput.slice(0, HOOK_OUTPUT_TRUNCATION_LIMIT)}`);
    }
    return { text: lines.join('\n') };
  }

  // `git diff HEAD` omits untracked files; fold in new-file diffs so the
  // branch-name proposer and the commit stats below reflect them (#1075). Must
  // run before the commit — once committed, the files are tracked and
  // `ls-files --others` no longer lists them.
  let effectiveDiff = postHookDiffResult.diff;
  if (statusHasUntracked(postHookDiffResult.git_status)) {
    const untrackedDiff = ctx.collectUntrackedDiff
      ? await ctx.collectUntrackedDiff()
      : await collectUntrackedDiff(ctx);
    if (untrackedDiff) {
      effectiveDiff = effectiveDiff ? `${effectiveDiff}\n${untrackedDiff}` : untrackedDiff;
      console.log(
        JSON.stringify({
          level: 'info',
          event: 'sandbox_commit_untracked_included',
          sandboxId: ctx.sandboxId,
        }),
      );
    }
  }

  // Step 3: If committing from the default branch, fork first so the commit
  // cannot land on main. Same proposer path the prepare-commit flow used.
  const branchTarget = await ensureCommitTargetBranch({
    sandboxId: ctx.sandboxId,
    currentBranch: ctx.currentBranch,
    defaultBranch: ctx.defaultBranch,
    diff: effectiveDiff,
    commitMessage: args.message,
    proposeName: createModelCommitBranchNameProposer({
      providerOverride: overrides?.providerOverride,
      modelOverride: overrides?.modelOverride,
    }),
    fork: ctx.forkCommitTargetBranch,
    branchExists: ctx.branchExists,
  });

  // Protect Main (fail-closed): the auto-branch above normally forks off the
  // default branch. If it did NOT fork (auto-branch disabled, or HEAD already
  // off-default) and Protect Main is on, verify we aren't about to commit onto
  // the protected branch. The shared pre-hook intentionally does not match
  // `sandbox_commit` (it runs before the in-handler fork), so this is the
  // authoritative guard — it mirrors the retired prepare-commit approval check.
  if (!branchTarget.switched && ctx.isMainProtected) {
    const liveBranch = await createReleasePushGit(ctx).currentBranch();
    const protectedBranches = new Set(['main', 'master']);
    if (ctx.defaultBranch) protectedBranches.add(ctx.defaultBranch);
    // Fail closed: an unreadable HEAD under Protect Main is treated as on-main —
    // blocking a legit commit is a retry; committing onto main is not.
    if (!liveBranch || protectedBranches.has(liveBranch)) {
      console.log(
        JSON.stringify({
          level: 'warn',
          event: 'sandbox_commit_protect_main_blocked',
          sandboxId: ctx.sandboxId,
          branch: liveBranch,
        }),
      );
      const protectErr: StructuredToolError = {
        type: 'PROTECT_MAIN_BLOCKED',
        retryable: false,
        message:
          'Protect Main is enabled and auto-branch is off — this commit would land on the protected branch. Create a feature branch first, then retry.',
      };
      return {
        text: formatStructuredError(
          protectErr,
          `[Tool Error — sandbox_commit]\n${protectErr.message}`,
        ),
        structuredError: protectErr,
      };
    }
  }

  // Step 4: Commit locally via the backend (no gate — silent commit). The
  // backend stages (`add -A`) then commits and shell-escapes the message.
  const commitResult = await createReleasePushGit(ctx).commit({ message: args.message });

  if (!commitResult.ok) {
    notifyWorkspaceMutation(ctx.sandboxId);
    const reason = commitResult.result?.stderr || commitResult.result?.stdout || 'commit failed';
    const err = classifyError(reason, 'sandbox_commit');
    console.log(
      JSON.stringify({
        level: 'error',
        event: 'sandbox_commit_failed',
        sandboxId: ctx.sandboxId,
        blocked: commitResult.blocked,
      }),
    );
    return {
      text: formatStructuredError(err, `[Tool Error — sandbox_commit]\n${reason}`),
      structuredError: err,
    };
  }

  const stats = parseDiffStats(effectiveDiff);
  console.log(
    JSON.stringify({
      level: 'info',
      event: 'sandbox_commit_done',
      sandboxId: ctx.sandboxId,
      filesChanged: stats.filesChanged,
      switched: branchTarget.switched,
    }),
  );

  return {
    text: `[Tool Result — sandbox_commit]\nCommitted: "${args.message}" (${stats.filesChanged} file${stats.filesChanged !== 1 ? 's' : ''}, +${stats.additions} -${stats.deletions}).${branchTarget.switched ? ` Forked off the default branch first.` : ''} Use prepare_push to ship.`,
    ...(branchTarget.switched ? { branchSwitch: branchTarget.branchSwitch } : {}),
  };
}

/**
 * `prepare_push` (Gate-at-Push Move A) — audit the cumulative push diff and
 * return the review card.
 *
 * This is the delivery gate: it computes everything the next push would upload
 * (via the active pushed-diff source), runs the Auditor over it, and on SAFE returns a
 * `commit-review` card with `kind: 'push'` for approval. On UNSAFE it returns an
 * `audit-verdict` card and blocks. The actual push happens on approval, which
 * re-runs only the cheap deterministic gates (Protect Main + secret scan) and
 * verifies the pinned `auditedHeadSha`, `auditedBranch`, `auditedUpstream`, and
 * `auditedRemoteUrl` still match the sandbox destination — it does NOT
 * re-audit (this verdict stands; re-running a non-deterministic LLM check could
 * flip an approved SAFE delivery). A direct `sandbox_push` that bypasses this
 * flow is still gated by the always-on push-time Auditor. An Auditor-backend
 * throw here is surfaced as a retryable `AUDITOR_UNAVAILABLE` error.
 */
export async function handlePreparePush(
  ctx: GitReleaseHandlerContext,
  overrides?: PrepareCommitAuditorOverrides,
): Promise<ToolExecutionResult> {
  // Pin the tip BEFORE computing the diff so the pin is conservative: if a
  // commit lands between this read and the diff/audit, the pin is the OLDER tip,
  // so approval (which compares live HEAD to the pin) fails closed and forces a
  // refresh rather than shipping a newer diff under this verdict. The realistic
  // staleness vector — committing more in a later turn, then approving this
  // stale card — is caught the same way.
  const pushGit = createReleasePushGit(ctx);
  const [auditedHeadSha, auditedBranch, auditedUpstream, auditedRemoteUrl] = await Promise.all([
    pushGit.headSha(),
    pushGit.currentBranch(),
    pushGit.upstreamRef(),
    pushGit.remoteUrl('origin', { push: true }),
  ]);

  // Step 1: Compute the cumulative push diff (commits the push would upload).
  // Reuse the branch pin captured above when available so the audited diff and
  // ref-only plan share the same explicit destination instead of independently
  // resolving HEAD's branch.
  const auditedPushRef = auditedBranch || undefined;
  const auditedPushRefOpts = auditedPushRef ? { ref: auditedPushRef } : undefined;
  let diff: string | null;
  try {
    diff = await computeReleasePushedDiff(ctx, auditedPushRefOpts);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const pushDiffErr = classifyError(reason, 'prepare_push');
    console.log(
      JSON.stringify({
        level: 'error',
        event: 'prepare_push_diff_failed',
        sandboxId: ctx.sandboxId,
        error: reason,
      }),
    );
    return {
      text: formatStructuredError(pushDiffErr, `[Tool Error — prepare_push]\n${reason}`),
      structuredError: pushDiffErr,
    };
  }

  if (diff === null) {
    // The pushed-diff reader returns null on a diff-read FAILURE (no
    // resolvable commits / invalid ref / unreachable sandbox), NOT on an empty
    // diff — and the GitExec adapter resolves errors instead of throwing, so the
    // catch above usually won't fire. Surface it as infra trouble, never as
    // "nothing to push" (which would hide a broken read).
    console.log(
      JSON.stringify({
        level: 'error',
        event: 'prepare_push_diff_failed',
        sandboxId: ctx.sandboxId,
        error: 'computeReleasePushedDiff returned null',
      }),
    );
    const pushDiffErr = classifyError('could not read the diff to push', 'prepare_push');
    return {
      text: formatStructuredError(
        pushDiffErr,
        `[Tool Error — prepare_push]\nCould not compute the diff to push (the sandbox may be unreachable). Retry shortly.`,
      ),
      structuredError: pushDiffErr,
    };
  }

  if (!diff.trim()) {
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'prepare_push_empty',
        sandboxId: ctx.sandboxId,
      }),
    );
    return {
      text: `[Tool Result — prepare_push]\nNothing to push — no committed changes the remote doesn't already have. Use sandbox_commit to commit your work first.`,
    };
  }

  // Step 1b: Compute the ref-only push plan (create / fast-forward / force /
  // skip) against origin's LIVE tip. Two jobs: (a) block a diverged push up
  // front — Push never force-pushes (`git merge`/rebase are policy-blocked), so
  // a diverged remote is a reconcile-via-PR situation, not something to retry
  // into git's opaque non-fast-forward rejection; (b) pin origin's live tip as a
  // force-with-lease value so approval can detect a remote that moved between
  // review and push (the audited diff was computed against the old base). The
  // read is side-effect-free; an unreadable origin yields `leaseEstablished:
  // false` and we simply don't pin (git's own rejection remains the backstop).
  const plan = await computeReleasePushPlan(ctx, auditedPushRefOpts);
  if (plan?.requiresForce) {
    console.log(
      JSON.stringify({
        level: 'warn',
        event: 'prepare_push_diverged',
        sandboxId: ctx.sandboxId,
        branch: plan.move.branch,
        ahead: plan.move.ahead,
        behind: plan.move.behind,
      }),
    );
    return {
      text: `[Tool Result — prepare_push]\nPush BLOCKED: ${plan.move.reason}. Push only fast-forwards a single branch — it never force-pushes, and local merge/rebase are disabled. Open a PR to reconcile with origin, or create a fresh branch from the current work and push that instead.`,
    };
  }

  // Step 2: Run the Auditor over the cumulative push diff. A backend throw
  // (Auditor unreachable) surfaces as a retryable AUDITOR_UNAVAILABLE error,
  // matching handleSandboxPush's gate-failure mapping.
  let auditVerdict: AuditorPushVerdict;
  try {
    auditVerdict = await auditPushedDiff(ctx, diff, overrides);
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'Auditor unavailable';
    console.log(
      JSON.stringify({
        level: 'error',
        event: 'prepare_push_auditor_unavailable',
        sandboxId: ctx.sandboxId,
        error: reason,
      }),
    );
    const auditorErr: StructuredToolError = {
      type: 'AUDITOR_UNAVAILABLE',
      retryable: true,
      message: reason,
    };
    return {
      text: formatStructuredError(auditorErr, `[Tool Error — prepare_push]\n${reason}`),
      structuredError: auditorErr,
    };
  }

  const stats = parseDiffStats(diff);

  if (auditVerdict.verdict === 'unsafe') {
    console.log(
      JSON.stringify({
        level: 'warn',
        event: 'prepare_push_blocked',
        sandboxId: ctx.sandboxId,
        filesChanged: stats.filesChanged,
      }),
    );
    const verdictCard: AuditVerdictCardData = {
      verdict: 'unsafe',
      summary: auditVerdict.summary,
      risks: [],
      filesReviewed: stats.filesChanged,
    };
    return {
      text: `[Tool Result — prepare_push]\nPush BLOCKED by Auditor: ${auditVerdict.summary}`,
      card: { type: 'audit-verdict', data: verdictCard },
    };
  }

  // Step 3: SAFE — return a push-kind review card for user approval. Approval
  // re-runs the cheap deterministic gates (Protect Main + secret scan) and
  // pushes; it does NOT re-audit (this verdict stands), but it verifies the
  // pinned `auditedHeadSha` and destination still match so commits or branch
  // routing changes after this review can't ride along unaudited. No
  // commitMessage: commits already exist.
  console.log(
    JSON.stringify({
      level: 'info',
      event: 'prepare_push_ready',
      sandboxId: ctx.sandboxId,
      filesChanged: stats.filesChanged,
    }),
  );
  const reviewData: CommitReviewCardData = {
    kind: 'push',
    diff: {
      diff,
      filesChanged: stats.filesChanged,
      additions: stats.additions,
      deletions: stats.deletions,
      truncated: false,
    },
    auditVerdict: {
      verdict: 'safe',
      summary: auditVerdict.summary,
      risks: [],
      filesReviewed: stats.filesChanged,
    },
    commitMessage: '',
    status: 'pending',
    ...(auditedHeadSha ? { auditedHeadSha } : {}),
    ...(ctx.gitSurface ? { auditedGitSurface: ctx.gitSurface } : {}),
    ...(auditedBranch ? { auditedBranch } : {}),
    ...(auditedUpstream ? { auditedUpstream } : {}),
    ...(auditedRemoteUrl ? { auditedRemoteUrl } : {}),
    // Force-with-lease pin: only set when origin was actually read, so a
    // network blip can't manufacture a spurious mismatch at approval.
    ...(plan?.leaseEstablished && plan.leasedRemoteSha
      ? { auditedRemoteTipSha: plan.leasedRemoteSha }
      : {}),
    // Display-only plan summary (force is already ruled out above).
    ...(plan
      ? {
          pushPlan: {
            kind: plan.move.kind as PushPlanSummary['kind'],
            ahead: plan.move.ahead,
            behind: plan.move.behind,
          },
        }
      : {}),
  };

  const shaNote = auditedHeadSha ? ` at ${auditedHeadSha.slice(0, 12)}` : '';
  return {
    text: `[Tool Result — prepare_push]\nWork has landed locally: committed${shaNote}. Push is staged and awaiting user approval (${stats.filesChanged} file${stats.filesChanged !== 1 ? 's' : ''}, +${stats.additions} -${stats.deletions}). Auditor verdict: SAFE.`,
    card: { type: 'commit-review', data: reviewData },
  };
}

/**
 * Run the model Auditor over the cumulative diff a push will upload — the
 * `auditAtPush` adapter for `sandbox_push` (Gate-at-Push Move A), and the
 * Auditor pass `prepare_push` runs to build its review card. Fetches file
 * contexts the same way the prepare flow does, runs the Auditor, and
 * reduces its verdict card to the gate's {verdict, summary} shape. A throw
 * (Auditor backend unreachable) propagates to the gate, which fails closed +
 * retryable; the file-context fetch degrades to diff-only on its own errors.
 */
async function auditPushedDiff(
  ctx: GitReleaseHandlerContext,
  diff: string,
  overrides?: PrepareCommitAuditorOverrides,
): Promise<AuditorPushVerdict> {
  let fileContexts: AuditorFileContext[] = [];
  try {
    const filePaths = parseDiffStats(diff).fileNames;
    fileContexts = await ctx.fetchAuditorFileContexts(filePaths, async (path) => {
      const result = await ctx.readFromSandbox(ctx.sandboxId, `/workspace/${path}`);
      if (result.error) return null;
      return { content: result.content, truncated: result.truncated };
    });
  } catch {
    // Degrade gracefully — proceed with diff-only (mirrors prepare_commit).
  }
  const res = await ctx.runAuditor(
    diff,
    (phase) => console.log(`[Push] Auditor (push): ${phase}`),
    { source: 'sandbox-push', sourceLabel: 'sandbox_push pre-push gate' },
    undefined,
    {
      providerOverride: overrides?.providerOverride,
      modelOverride: overrides?.modelOverride,
    },
    fileContexts,
  );
  return { verdict: res.verdict, summary: res.card.summary };
}

export async function handleSandboxPush(
  ctx: GitReleaseHandlerContext,
  overrides?: PrepareCommitAuditorOverrides,
): Promise<ToolExecutionResult> {
  const pushResult = await createReleasePushGit(ctx, {
    secretScan: true,
    protectMain: ctx.isMainProtected,
    defaultBranch: ctx.defaultBranch,
    // Gate-at-Push Move A (flipped ON): `resolveWebAuditAtPushEnabled()`
    // defaults true, so this is the LIVE delivery gate. Commits are silent
    // (`sandbox_commit`); the SAFE/UNSAFE Auditor runs here over the cumulative
    // push diff. `prepare_push` runs the same audit to build its review card,
    // and this re-runs it at execution (defense-in-depth, no drift).
    auditAtPush: {
      enabled: resolveWebAuditAtPushEnabled(),
      audit: (diff) => auditPushedDiff(ctx, diff, overrides),
    },
  }).push();

  if (!pushResult.ok) {
    const reason = pushResult.error || pushResult.stderr || pushResult.stdout || 'push failed';
    // Transient gate failure (the Auditor backend was unreachable), NOT a policy
    // violation: surface as retryable so the runtime re-runs the push and
    // re-audits, instead of treating it as an UNSAFE verdict.
    if (pushResult.blocked && pushResult.retryable) {
      const err: StructuredToolError = {
        type: 'AUDITOR_UNAVAILABLE',
        retryable: true,
        message: pushResult.stderr || 'Auditor unavailable',
      };
      return {
        text: formatStructuredError(err, `[Tool Error — sandbox_push]\n${pushResult.stderr}`),
        structuredError: err,
      };
    }
    // A deterministic pre-push gate block (Protect Main, the secret scan, or an
    // UNSAFE Auditor verdict), not a git/transport failure: the gate's reason in
    // `stderr` explains what to fix (switch off main, remove the secret, address
    // the finding); retrying as-is won't help.
    if (pushResult.blocked) {
      const err: StructuredToolError = {
        type: 'GIT_GUARD_BLOCKED',
        retryable: false,
        message: pushResult.stderr || 'push blocked',
      };
      return {
        text: formatStructuredError(err, `[Tool Error — sandbox_push]\n${pushResult.stderr}`),
        structuredError: err,
      };
    }
    // exitCode -1, or a transport/gone error the adapter caught, means the
    // container is unreachable. Surface a structured error so the chat runtime
    // can trigger sandbox recovery — the pre-refactor path threw here and the
    // dispatcher's top-level catch classified it the same way.
    if (pushResult.exitCode === -1 || isDefinitivelyGoneMessage(reason)) {
      const err = classifyError(reason, 'sandbox_push');
      err.type = 'SANDBOX_UNREACHABLE';
      err.retryable = false;
      return {
        text: formatStructuredError(err, `[Tool Error — sandbox_push]\n${reason}`),
        structuredError: err,
      };
    }
    return { text: `[Tool Result — sandbox_push]\nPush failed: ${pushResult.stderr || reason}` };
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
  const remoteUrl = `https://github.com/${createdRepo.full_name}.git`;

  // Promote needs the exact current ref, so this read stays raw rather than
  // going through the normalized `currentBranch()`. A detached HEAD must
  // surface as `HEAD` (making the later `git push -u origin HEAD` fail loudly)
  // instead of collapsing to null and falling back to the default branch —
  // which would publish the wrong revision (Codex review on PR #629).
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

  const pushResult = await createSandboxPushGit(ctx.sandboxId, {
    execFn: ctx.execInSandbox,
    secretScan: true,
    getGitHubToken: ctx.getActiveGitHubToken,
  }).push({ setUpstream: true, ref: branchName });

  // A secret-scan block on the first publish: the repo exists but nothing was
  // pushed. Surface it explicitly (sanitized) so the model removes the secret
  // rather than retrying into the same wall.
  if (pushResult.blocked) {
    return {
      text: `[Tool Error] Repo ${createdRepo.full_name} was created, but the push was blocked: ${sanitizeGitOutput(
        pushResult.stderr || 'secret detected',
        authToken,
      )} Remove the credential(s) from the commit history, then retry.`,
    };
  }

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

  // Step 2: Get current branch (null → '' when detached / not a repo).
  // `secretScan` matters most here: save_draft is the one release path that
  // skips the Auditor, so the deterministic pre-push scan is the only gate
  // standing between a draft credential and origin.
  const pushGit = createReleasePushGit(ctx, {
    secretScan: true,
  });
  const currentBranch = (await pushGit.currentBranch()) ?? '';

  // Step 3: Determine draft branch name — must be a valid ref and start with
  // draft/ (unaudited path). Validate ref shape like the typed branch tools
  // so a malformed/leading-hyphen name can't reach createBranch.
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  if (args.branch_name && isInvalidGitRef(args.branch_name)) {
    return {
      text: `[Tool Error — sandbox_save_draft]\nInvalid branch name "${args.branch_name}". ${GIT_REF_VALIDATION_DETAIL}`,
    };
  }
  if (args.branch_name && !args.branch_name.startsWith('draft/')) {
    return {
      text: '[Tool Error — sandbox_save_draft]\nbranch_name must start with "draft/". This tool skips Auditor review and is restricted to draft branches. Use sandbox_commit for non-draft branches.',
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
    const checkoutResult = await pushGit.createBranch(draftBranchName);
    if (!checkoutResult.ok) {
      return {
        text: `[Tool Error — sandbox_save_draft]\nFailed to create draft branch: ${checkoutResult.stderr}`,
      };
    }
    ctx.onBranchChanged?.(draftBranchName);
  }

  const activeDraftBranch = needsNewBranch ? draftBranchName : currentBranch;

  // Step 5: Stage + commit (no Auditor — drafts are WIP). The backend stages
  // (`add -A`) then commits in one call.
  const draftMessage = args.message || 'WIP: draft save';
  const commitResult = await pushGit.commit({ message: draftMessage });
  if (!commitResult.ok) {
    notifyWorkspaceMutation(ctx.sandboxId);
    return {
      text: `[Tool Error — sandbox_save_draft]\nFailed to commit draft: ${commitResult.result?.stderr ?? ''}`,
    };
  }
  // Read the new HEAD via plumbing rather than parsing the commit's human
  // stdout (which varies with locale / git version / root-commit / hooks).
  const commitSha = (await pushGit.headSha({ short: true })) ?? 'unknown';
  // git add + commit changes file hashes tracked by git
  ctx.clearFileVersionCache(ctx.sandboxId);
  ctx.clearPrefetchedEditFileCache(ctx.sandboxId);

  // Step 6: Push to remote
  const pushResult = await pushGit.push({ setUpstream: true, ref: activeDraftBranch });

  const pushOk = pushResult.ok;
  const draftStats = parseDiffStats(draftDiffResult.diff);

  const draftLines: string[] = [
    `[Tool Result — sandbox_save_draft]`,
    `Draft saved to branch: ${activeDraftBranch}`,
    `Commit: ${commitSha}`,
    `Message: ${draftMessage}`,
    `${draftStats.filesChanged} file${draftStats.filesChanged !== 1 ? 's' : ''} changed, +${draftStats.additions} -${draftStats.deletions}`,
    pushOk
      ? 'Pushed to remote.'
      : pushResult.blocked
        ? `Push blocked: ${pushResult.stderr} The draft is committed locally; remove the secret, then use sandbox_push() to retry.`
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
    // Propagate branch switch to app state so chat/merge context stays in
    // sync. 'switched' (not 'forked'): user intent here is checkpointing /
    // staging a commit, not "fork my work into a new conversation". Slice 2
    // may revisit if runtime usage proves this wrong.
    ...(needsNewBranch
      ? {
          branchSwitch: {
            name: activeDraftBranch,
            kind: 'switched' as const,
            source: 'release_draft' as const,
          },
        }
      : {}),
  };
}
