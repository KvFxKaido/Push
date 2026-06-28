/**
 * Sequential Auditor delegation handler — Phase 4 of the
 * useAgentDelegation extraction track (see
 * `docs/decisions/useAgentDelegation Coupling Recon.md`, §"Recommended
 * Extraction Order — Phase 4: Sequential Auditor Handler").
 *
 * ## Design — boring leaf handler
 *
 * Unlike Phase 3 (Coder), the Auditor is a leaf seam with a single
 * semantic job: produce an evaluation verdict, or explain why it
 * couldn't. The hook gates whether the handler fires, then consumes
 * the handler's return value for final outcome assembly. Because the
 * fail-open catch is internal, the handler's return shape can stay
 * flat — no discriminated union needed:
 *
 *   - `evalResult: EvaluationResult | null` — the Auditor's verdict
 *     (`complete` or `incomplete`) with summary and gaps, or null if
 *     the Auditor returned no result or the underlying call threw.
 *   - `auditorSummaryLine: string | null` — a pre-formatted
 *     "[Evaluation: VERDICT] summary" line the hook can push onto
 *     its `summaries` array. Null when `evalResult` is null.
 *
 * The Auditor-summary formatting lives here (not in the hook)
 * because it encodes Auditor semantics — verdict uppercase, gap
 * bullets — that belong with the role kernel's output shape.
 * Splitting the formatting across files would leak Auditor
 * presentation concerns into the hook.
 *
 * ## Fitness rules
 *
 *   - **Boundary:** imports from `@/lib/*`, `@/hooks/chat-persistence`,
 *     `@push/lib/correlation-context`, and type-only from
 *     `@/lib/orchestrator` / `@/lib/verification-policy` /
 *     `./coder-delegation-handler`. Never imports the hook or other
 *     handlers.
 *   - **API:** exports `AuditorHandlerContext`,
 *     `HandleCoderAuditorInput`, `AuditorHandlerResult`, and the
 *     `handleCoderAuditor` async handler. The build-context helper
 *     lives in the dispatcher (hook) so the one-way extraction
 *     boundary holds.
 *   - **Gating stays in the hook.** The handler is reactive — it
 *     assumes its caller already decided the Auditor should fire.
 *     No internal `shouldRun` branch. The recon's containment rule
 *     is explicit on this: "policy decisions stay in the hook;
 *     handlers are reactive, not gated."
 *   - **Latest Coder state stays hook-owned.** The handler reads
 *     the latest coder working memory through a bound
 *     `readLatestCoderState` getter — called exactly once, near the
 *     working-memory decision point, so the ref's read semantics
 *     don't leak across the handler's body.
 *   - **Behavior preservation:** byte-for-byte equivalent to the
 *     inline seam (lines 271–411 pre-extraction). Four
 *     characterization tests (commit 296ff1a) gate the regression:
 *     null return, thrown error, verdict=incomplete, and the
 *     single-task-vs-multi-task `evalWorkingMemory` policy.
 */

import type React from 'react';
import { runAuditorEvaluation, type EvaluationResult } from '@/lib/auditor-agent';
import { getSandboxDiff } from '@/lib/sandbox-client';
import { buildMemoryScope } from '@/lib/memory-context-helpers';
import { recordVerificationGateResult } from '@/lib/verification-runtime';
import { summarizeToolResultPreview } from '@/lib/chat-run-events';
import { setSpanAttributes, withActiveSpan, SpanKind, SpanStatusCode } from '@/lib/tracing';
import {
  correlationToSpanAttributes,
  extendCorrelation,
  type CorrelationContext,
} from '@push/lib/correlation-context';
import { createId } from '@/hooks/chat-persistence';
import type { ActiveProvider } from '@/lib/orchestrator';
import type { VerificationPolicy } from '@/lib/verification-policy';
import type { CoderAuditorInput } from '@/lib/coder-delegation-handler';
import type {
  AgentStatus,
  AgentStatusSource,
  CoderWorkingMemory,
  RunEventInput,
  VerificationRuntimeState,
} from '@/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The ambient context passed to {@link handleCoderAuditor}. All refs
 * and callbacks the handler reaches for are enumerated here so the
 * seam has zero implicit reach into the hook's closure.
 * `readLatestCoderState` is a getter — the handler reads it once
 * internally and stores the value near the working-memory decision
 * point so the call semantics don't leak into the rest of the body.
 */
export interface AuditorHandlerContext {
  repoRef: React.MutableRefObject<string | null>;
  branchInfoRef: React.RefObject<
    { currentBranch?: string; defaultBranch?: string } | undefined | null
  >;
  /**
   * Returns the latest Coder working memory. The handler never touches
   * the hook-owned state carrier directly — it only depends on this read API.
   */
  readLatestCoderState: () => CoderWorkingMemory | null;

  appendRunEvent: (chatId: string, event: RunEventInput) => void;
  updateAgentStatus: (
    status: AgentStatus,
    meta?: { chatId?: string; source?: AgentStatusSource; log?: boolean },
  ) => void;
  updateVerificationStateForChat: (
    chatId: string,
    updater: (state: VerificationRuntimeState) => VerificationRuntimeState,
  ) => void;
}

export interface HandleCoderAuditorInput {
  chatId: string;
  baseCorrelation: CorrelationContext;
  lockedProviderForChat: ActiveProvider;
  resolvedModelForChat: string | undefined;
  verificationPolicy: VerificationPolicy;
  /** Aggregated Coder-arc state produced by `handleCoderDelegation`. */
  auditorInput: CoderAuditorInput;
}

export interface AuditorHandlerResult {
  evalResult: EvaluationResult | null;
  /**
   * Pre-formatted Auditor-summary line to push onto the hook's
   * `summaries` array. Null when `evalResult` is null (the hook
   * skips the push, preserving the "no auditor line on failure"
   * invariant the characterization tests pin).
   */
  auditorSummaryLine: string | null;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleCoderAuditor(
  ctx: AuditorHandlerContext,
  input: HandleCoderAuditorInput,
): Promise<AuditorHandlerResult> {
  const {
    chatId,
    baseCorrelation,
    lockedProviderForChat,
    resolvedModelForChat,
    verificationPolicy,
    auditorInput,
  } = input;

  const auditorExecutionId = createId();
  try {
    ctx.appendRunEvent(chatId, {
      type: 'subagent.started',
      executionId: auditorExecutionId,
      agent: 'auditor',
      detail: 'Evaluating coder output',
    });
    ctx.updateAgentStatus(
      { active: true, phase: 'Evaluating output...' },
      { chatId, source: 'coder' },
    );

    let evalDiff: string | null = null;
    let diffFetchSucceeded = false;
    let commitsMade = false;
    let untrackedFilesPresent = false;
    try {
      // Pass the pre-Coder HEAD captured by coder-delegation-handler so
      // the sandbox also returns `diff_since_ref` (the committed-but-
      // no-longer-in-working-tree work that the post-commit case in
      // PR #601 was misclassifying). When preCoderHead is undefined
      // the worker silently omits the ranged diff and behavior matches
      // the pre-#604 path. See PR #604.
      const diffResult = await getSandboxDiff(auditorInput.currentSandboxId, {
        sinceRef: auditorInput.preCoderHead,
      });
      // Combine the working-tree diff (uncommitted edits) with the
      // ranged diff (committed work since the Coder started). The LLM
      // Auditor and the deterministic short-circuit both need to see
      // either as evidence that the Coder actually did something.
      const workingTreeDiff = diffResult.diff || '';
      const rangedDiff = diffResult.diff_since_ref || '';
      // Tri-state commitsMade. The handler is the only production
      // caller of the predicate, so we collapse "unknown" to true here:
      // when a legacy sandbox or mixed-version response omits head_sha,
      // we can't establish that no commits happened, and the safer
      // default is to fall through to the LLM Auditor rather than
      // re-fire PR #601's false-positive. Copilot review on PR #604.
      // True ⇒ we either confirmed HEAD advanced OR can't be sure; in
      //         both cases the predicate refuses to short-circuit.
      // False ⇒ both pre/post HEAD are known and equal — verifiably
      //         no commits, predicate is free to short-circuit.
      const canDetermineCommits =
        Boolean(auditorInput.preCoderHead) && typeof diffResult.head_sha === 'string';
      commitsMade = canDetermineCommits ? diffResult.head_sha !== auditorInput.preCoderHead : true;
      // Untracked-file detection. `sandbox_write_file` creating a brand
      // new file produces no `git diff HEAD` content (the file is
      // unstaged and untracked) and no HEAD advance — the deterministic
      // short-circuit fired "no workspace changes" on that case in the
      // 2026-05-20 retry session even though real work happened. The
      // porcelain status was already in the diff response, just unused.
      //
      // We compare the post-Coder untracked set against the pre-Coder
      // baseline captured in coder-delegation-handler so pre-existing
      // ambient gunk (node_modules, build artifacts) doesn't false-
      // positive as Coder work. Codex P1 review on PR #606.
      const postUntrackedSet = parseUntrackedFileSet(diffResult.git_status);
      const preUntrackedSet = auditorInput.preCoderUntrackedFiles
        ? new Set(auditorInput.preCoderUntrackedFiles)
        : undefined;
      const newUntrackedFiles = findNewUntrackedFiles(postUntrackedSet, preUntrackedSet);
      untrackedFilesPresent = newUntrackedFiles.length > 0;
      // Inject only the NEW untracked `??` lines into the LLM Auditor's
      // diff envelope, capped at MAX_UNTRACKED_LINES_IN_DIFF. Full
      // porcelain output (Copilot review on PR #606) could bloat the
      // prompt with hundreds of irrelevant lines on a repo that ran
      // `npm install`; this stays compact and only surfaces the files
      // the Coder actually created.
      let untrackedSection = '';
      if (untrackedFilesPresent) {
        const truncated = newUntrackedFiles.length > MAX_UNTRACKED_LINES_IN_DIFF;
        const lines = newUntrackedFiles.slice(0, MAX_UNTRACKED_LINES_IN_DIFF).map((p) => `?? ${p}`);
        if (truncated) {
          lines.push(
            `…[truncated ${newUntrackedFiles.length - MAX_UNTRACKED_LINES_IN_DIFF} more new untracked files]`,
          );
        }
        untrackedSection = `--- new untracked files (created during this Coder run) ---\n${lines.join('\n')}`;
      }
      const parts = [workingTreeDiff, rangedDiff, untrackedSection].filter((s) => s.length > 0);
      if (parts.length === 0) {
        evalDiff = null;
      } else if (parts.length === 1) {
        evalDiff = parts[0];
      } else {
        // Multi-part: insert the "committed since coder started" marker
        // between working-tree and ranged halves (matches the pre-#606
        // text so older snapshot tests/log greps still find it), then
        // append the untracked section if present.
        const headSections: string[] = [];
        if (workingTreeDiff) headSections.push(workingTreeDiff);
        if (rangedDiff) {
          headSections.push(
            workingTreeDiff ? `--- committed since coder started ---\n${rangedDiff}` : rangedDiff,
          );
        }
        if (untrackedSection) headSections.push(untrackedSection);
        evalDiff = headSections.join('\n');
      }
      // `getSandboxDiff` can resolve with HTTP 200 and a populated `error`
      // field (git failure inside the sandbox, see `routeDiff` in
      // worker-cf-sandbox.ts). In that case `diff` is empty but the data
      // is unreliable — flagging this as a successful fetch would let the
      // deterministic short-circuit fire and misclassify a sandbox/git
      // failure as a coder no-op. Both Codex and Copilot caught this on
      // PR #601 review.
      diffFetchSucceeded = !diffResult.error;
    } catch {
      /* no diff available — evaluation proceeds without it */
    }

    // Short-circuit when there's verifiably nothing to audit. Cuts an LLM
    // round-trip on the common Coder-loop case where the model claims
    // completion without actually editing (parser drops malformed edits,
    // model hallucinates completion, etc.) and gives the Orchestrator a
    // crisp deterministic verdict instead of a vague "no diff evidence"
    // phrasing the LLM has to compose. See `deterministicEmptyDiffVerdict`
    // for the eligibility predicate.
    const deterministicResult = deterministicEmptyDiffVerdict({
      diffFetchSucceeded,
      evalDiff,
      criteriaResults: auditorInput.allCriteriaResults,
      commitsMade,
      untrackedFilesPresent,
      leadMode: auditorInput.leadMode,
    });
    if (deterministicResult) {
      ctx.updateVerificationStateForChat(chatId, (state) =>
        recordVerificationGateResult(state, 'auditor', 'failed', deterministicResult.summary),
      );
      ctx.appendRunEvent(chatId, {
        type: 'subagent.completed',
        executionId: auditorExecutionId,
        agent: 'auditor',
        summary: summarizeToolResultPreview(deterministicResult.summary),
      });
      return {
        evalResult: deterministicResult,
        auditorSummaryLine: formatAuditorSummaryLine(deterministicResult),
      };
    }

    const combinedTask = auditorInput.taskList.join('\n\n');
    const combinedSummary = auditorInput.summaries.join('\n');
    // For multi-task delegations, only the last task's working memory is
    // available — pass null to avoid misleading the evaluator. Read the
    // coder state once, here, so the ref-access semantics don't leak
    // elsewhere in the body.
    const evalWorkingMemory = auditorInput.taskList.length <= 1 ? ctx.readLatestCoderState() : null;
    // Scale max rounds by task count so multi-task totals don't falsely
    // trigger the "hit round cap" signal.
    const evalMaxRounds =
      auditorInput.harnessSettings.maxCoderRounds * Math.max(auditorInput.taskList.length, 1);
    const auditorCorrelation = extendCorrelation(baseCorrelation, {
      executionId: auditorExecutionId,
    });

    const evalResult = await withActiveSpan(
      'subagent.auditor',
      {
        scope: 'push.delegation',
        kind: SpanKind.INTERNAL,
        attributes: {
          ...correlationToSpanAttributes(auditorCorrelation),
          'push.agent.role': 'auditor',
          'push.provider': lockedProviderForChat,
          'push.model': resolvedModelForChat,
          'push.criteria_count': auditorInput.allCriteriaResults.length,
        },
      },
      async (span) => {
        const result = await runAuditorEvaluation(
          combinedTask,
          combinedSummary,
          evalWorkingMemory,
          evalDiff,
          (phase) => ctx.updateAgentStatus({ active: true, phase }, { chatId, source: 'coder' }),
          {
            providerOverride: lockedProviderForChat,
            modelOverride: resolvedModelForChat || undefined,
            coderRounds: auditorInput.totalRounds,
            coderMaxRounds: evalMaxRounds,
            criteriaResults:
              auditorInput.allCriteriaResults.length > 0
                ? auditorInput.allCriteriaResults
                : undefined,
            verificationPolicy,
            memoryScope: buildMemoryScope(
              chatId,
              ctx.repoRef.current,
              ctx.branchInfoRef.current?.currentBranch,
            ),
            leadMode: auditorInput.leadMode,
          },
        );
        if (result) {
          setSpanAttributes(span, {
            'push.auditor.verdict': result.verdict,
            'push.auditor.gap_count': result.gaps.length,
          });
        }
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      },
    );

    if (evalResult) {
      const completedEvaluation = evalResult;
      ctx.updateVerificationStateForChat(chatId, (state) =>
        recordVerificationGateResult(
          state,
          'auditor',
          completedEvaluation.verdict === 'complete' ? 'passed' : 'failed',
          completedEvaluation.summary,
        ),
      );
      ctx.appendRunEvent(chatId, {
        type: 'subagent.completed',
        executionId: auditorExecutionId,
        agent: 'auditor',
        summary: summarizeToolResultPreview(evalResult.summary),
      });
      return {
        evalResult,
        auditorSummaryLine: formatAuditorSummaryLine(evalResult),
      };
    }

    ctx.updateVerificationStateForChat(chatId, (state) =>
      recordVerificationGateResult(
        state,
        'auditor',
        'inconclusive',
        'Auditor evaluation returned no result.',
      ),
    );
    ctx.appendRunEvent(chatId, {
      type: 'subagent.failed',
      executionId: auditorExecutionId,
      agent: 'auditor',
      error: 'Auditor returned no evaluation.',
    });
    return { evalResult: null, auditorSummaryLine: null };
  } catch {
    ctx.updateVerificationStateForChat(chatId, (state) =>
      recordVerificationGateResult(state, 'auditor', 'inconclusive', 'Auditor evaluation failed.'),
    );
    ctx.appendRunEvent(chatId, {
      type: 'subagent.failed',
      executionId: auditorExecutionId,
      agent: 'auditor',
      error: 'Evaluation failed.',
    });
    // Fail-open: if evaluation fails, Coder result stands as-is.
    return { evalResult: null, auditorSummaryLine: null };
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function formatAuditorSummaryLine(evalResult: EvaluationResult): string {
  const evalLine = `\n[Evaluation: ${evalResult.verdict.toUpperCase()}] ${evalResult.summary}`;
  const gapLines =
    evalResult.gaps.length > 0 ? evalResult.gaps.map((g) => `  - ${g}`).join('\n') : '';
  return evalLine + (gapLines ? `\n${gapLines}` : '');
}

/**
 * Decide whether the Auditor can short-circuit to a deterministic verdict
 * without spinning up an LLM call. Returns the canned `EvaluationResult`
 * when the empty-diff case is unambiguous, or `null` to let the caller
 * fall through to the LLM evaluator.
 *
 * Five conditions must hold:
 *   1. The diff fetch succeeded — a thrown sandbox call leaves us blind to
 *      what actually happened, so we trust the LLM evaluator instead of
 *      asserting "no changes".
 *   2. The diff body is empty (null or whitespace-only) — the sandbox
 *      confirms no files moved.
 *   3. No acceptance criterion passed — if the user wired up tests or
 *      typechecks that came back green, an empty diff is legitimate
 *      "done with no edits required" (verification-against-already-green
 *      state) and the LLM should make the final call.
 *   4. **No commits were made during the Coder run.** A successful
 *      `git commit` inside the Coder leaves `git diff HEAD` empty even
 *      though real work landed; the pre/post-HEAD comparison in
 *      `handleCoderAuditor` surfaces this as `commitsMade`. When true,
 *      we fall through to the LLM with the ranged diff so it can
 *      evaluate the committed changes. The handler collapses
 *      "couldn't determine" (legacy sandbox without `head_sha`, missing
 *      pre-Coder snapshot) into `commitsMade: true` so we err on the
 *      side of running the LLM rather than firing a false-positive
 *      short-circuit. PR #604 — fix for the post-commit Auditor
 *      false-positive observed against #601.
 *   5. **No untracked files were created.** `sandbox_write_file` creating
 *      a brand new file produces no `git diff HEAD` content (the file
 *      is unstaged and untracked) and no HEAD advance — the predicate
 *      was firing "no workspace changes" on that case in the 2026-05-20
 *      retry session even though the file existed on disk. The handler
 *      parses `git status --porcelain` for `??` entries and sets
 *      `untrackedFilesPresent`. PR #606.
 *
 * Exported for unit testing; the handler above is the only production
 * caller.
 */
export function deterministicEmptyDiffVerdict(input: {
  diffFetchSucceeded: boolean;
  evalDiff: string | null;
  criteriaResults: readonly { passed: boolean }[];
  commitsMade?: boolean;
  untrackedFilesPresent?: boolean;
  /** Inline lead turn rather than a delegated Coder — swaps the user-facing
   *  subject so this deterministic verdict doesn't leak "the Coder" either. */
  leadMode?: boolean;
}): EvaluationResult | null {
  if (!input.diffFetchSucceeded) return null;
  const diffIsEmpty = !input.evalDiff || input.evalDiff.trim().length === 0;
  if (!diffIsEmpty) return null;
  if (input.criteriaResults.some((r) => r.passed)) return null;
  if (input.commitsMade) return null;
  if (input.untrackedFilesPresent) return null;
  const subject = input.leadMode ? 'the assistant' : 'the Coder';
  const Subject = input.leadMode ? 'The assistant' : 'The Coder';
  const runPhrase = input.leadMode ? 'turn' : 'Coder run';
  return {
    verdict: 'incomplete',
    summary: `No workspace changes detected. ${Subject} produced no diff and no acceptance criteria passed.`,
    gaps: [
      `Sandbox diff is empty after the ${runPhrase} — verify ${subject} actually attempted edits. An empty diff typically means a malformed tool call was dropped or ${subject} ended without invoking a write tool.`,
    ],
    confidence: 'high',
  };
}

/**
 * Parse `git status --porcelain` output and return true when any
 * untracked file entries (`??`) are present. Exported for unit
 * testing; the handler is the only production caller. See PR #606.
 *
 * Porcelain format (v1): each line is two status chars + space + path.
 * `??` in the first column means untracked. We tolerate `\r\n`
 * newlines and trailing whitespace from the worker shell.
 *
 * Note: `git status --porcelain` without an explicit version flag
 * defaults to v1 and is stable for the foreseeable future. The CI
 * sandbox shells out without a version flag, so v1 is what we get.
 * If a future Push deployment opts into `--porcelain=v2`, this helper
 * (and `parseUntrackedFileSet` below) will need to be updated — the
 * v2 prefix for untracked entries is a single `?`, not `??`.
 */
export function hasUntrackedFiles(gitStatus: string | undefined | null): boolean {
  if (!gitStatus) return false;
  for (const line of gitStatus.split(/\r?\n/)) {
    if (line.startsWith('??')) return true;
  }
  return false;
}

/**
 * Parse `git status --porcelain` output into a set of untracked file
 * paths. Used by `coder-delegation-handler` to snapshot pre-Coder
 * untracked files so the Auditor can identify which `??` entries in
 * the post-Coder status are NEW vs pre-existing ambient gunk
 * (node_modules, build artifacts). Codex P1 review on PR #606.
 *
 * Each untracked porcelain line is `??<space><path>`. Renames (` -> `)
 * don't apply to untracked entries, so we slice off the prefix and
 * use the remainder as-is. The set is order-independent so callers
 * can compute set difference cheaply with `.has()`.
 */
export function parseUntrackedFileSet(gitStatus: string | undefined | null): Set<string> {
  const out = new Set<string>();
  if (!gitStatus) return out;
  for (const line of gitStatus.split(/\r?\n/)) {
    if (!line.startsWith('?? ')) continue;
    const path = line.slice(3).trim();
    if (path) out.add(path);
  }
  return out;
}

/**
 * Compute the set of untracked file paths that exist in `post` but
 * NOT in `pre`. Used to identify which untracked entries the Coder
 * actually created during this run, ignoring ambient gunk that was
 * already in the workspace. When `pre` is undefined (pre-snapshot
 * failed), returns the full post set conservatively so we don't
 * regress to the pre-#606 false-negative ("no workspace changes
 * detected" when the Coder genuinely wrote a file).
 */
export function findNewUntrackedFiles(post: Set<string>, pre: Set<string> | undefined): string[] {
  if (!pre) return Array.from(post);
  const out: string[] = [];
  for (const path of post) {
    if (!pre.has(path)) out.push(path);
  }
  return out;
}

/**
 * Cap on the number of `??` lines we inject into the LLM Auditor's
 * diff envelope. Most legitimate Coder turns create at most a handful
 * of new files; pathological inputs (e.g., a turn that runs `npm
 * install` and creates thousands of node_modules entries) would
 * otherwise blow up the audit prompt. Copilot review on PR #606.
 */
export const MAX_UNTRACKED_LINES_IN_DIFF = 50;
