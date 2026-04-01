/**
 * Reviewer Agent — advisory code review on diffs.
 *
 * Fourth agent role alongside Orchestrator, Coder, and Auditor.
 * Unlike the Auditor (binary gate, fail-safe UNSAFE), the Reviewer is
 * user-initiated, purely advisory, and accepts an explicit provider+model
 * override so users can choose which model reviews their code.
 */

import type { ChatMessage, ReviewComment, ReviewResult } from '@/types';
import type { AIProviderType } from '@/types';
import { getProviderStreamFn } from './orchestrator';
import { getModelForRole } from './providers';
import { buildReviewerContextBlock, type ReviewerPromptContext } from './role-context';
import { readSymbolsFromSandbox, type SandboxSymbol } from './sandbox-client';
import { SystemPromptBuilder } from './system-prompt-builder';
import { asRecord, streamWithTimeout } from './utils';
import { parseDiffStats, parseDiffIntoFiles, chunkDiffByFile, classifyFilePath } from './diff-utils';

const REVIEWER_TIMEOUT_MS = 90_000; // 90s — reviews can be thorough
const REVIEWER_FILE_STRUCTURE_LIMIT = 2_000;
const REVIEWER_FILE_STRUCTURE_MAX_FILES = 3;

/**
 * Annotate added lines in a unified diff with [Lxxx] line-number markers.
 *
 * Parses each @@ hunk header to track the new-file line counter, then stamps
 * every `+` line (added content) with its actual line number. Context lines
 * advance the counter silently. This gives the model explicit anchors instead
 * of asking it to count lines itself.
 */
export function annotateDiffWithLineNumbers(diff: string): string {
  const lines = diff.split('\n');
  const out: string[] = [];
  let newLine = 0;

  for (const line of lines) {
    if (line.startsWith('@@')) {
      // @@ -old_start[,old_count] +new_start[,new_count] @@
      const match = line.match(/\+(\d+)/);
      if (match) newLine = parseInt(match[1], 10) - 1;
      out.push(line);
    } else if (
      line.startsWith('+++') ||
      line.startsWith('---') ||
      line.startsWith('diff ') ||
      line.startsWith('index ')
    ) {
      out.push(line);
    } else if (line.startsWith('+')) {
      newLine++;
      out.push(`${line} [L${newLine}]`);
    } else if (line.startsWith('-')) {
      // removed — does not advance new-file line counter
      out.push(line);
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file"
      out.push(line);
    } else {
      // context line — advances new-file counter, no annotation
      newLine++;
      out.push(line);
    }
  }

  return out.join('\n');
}

/** Shared severity guide + review checklist — used by both quick and deep reviewer. */
export const REVIEWER_CRITERIA_BLOCK = `Severity guide:
- critical: correctness bugs, data loss risk, broken functionality, security vulnerabilities
- warning: potential bugs, missing error handling, risky patterns, unhandled edge cases
- suggestion: better approaches, refactoring opportunities, performance improvements
- note: genuinely useful informational comments only; avoid low-value nits

Review for:
- Correctness: logic errors, off-by-ones, null/undefined handling, race conditions
- Regressions: user-visible behavior changes, broken flows, or subtle changes from previous behavior
- Testing: missing tests, insufficient coverage for risky logic, or assertions that should be added
- Compatibility: API contract drift, schema/localStorage changes, migration assumptions, versioning risk
- State/async edges: loading, resume, reconnect, branch switching, stale state, ordering, and cancellation issues
- Security: injection vectors, auth issues, secret exposure (flag but don't block — that is the Auditor's job)
- Code quality: readability, maintainability, appropriate abstractions, dead code
- Conventions: consistency with surrounding code patterns visible in the diff
- Performance: obvious inefficiencies, unnecessary re-renders, expensive operations in hot paths
- Documentation: README/doc changes that contradict the code diff, outdated examples, missing docs for new public APIs or changed behavior, unclear or misleading prose in comments or markdown files`;

// ---------------------------------------------------------------------------
// Coalesced promise — dedup concurrent reviews on the same diff+provider+context
// ---------------------------------------------------------------------------
const pendingReviews = new Map<string, Promise<ReviewResult>>();
const reviewListeners = new Map<string, Set<(phase: string) => void>>();
const reviewLatestPhase = new Map<string, string>();

function reviewCoalesceKey(
  diff: string,
  provider: string,
  modelId: string | undefined,
  runtimeContext: string,
  sandboxId?: string,
): string {
  return JSON.stringify({
    provider,
    modelId: modelId ?? '',
    runtimeContext,
    sandboxId: sandboxId ?? '',
    diff,
  });
}

function addReviewListener(key: string, onStatus: (phase: string) => void): void {
  const listeners = reviewListeners.get(key);
  if (!listeners) return;
  listeners.add(onStatus);
  const latestPhase = reviewLatestPhase.get(key);
  if (latestPhase) onStatus(latestPhase);
}

function broadcastReviewStatus(key: string, phase: string): void {
  reviewLatestPhase.set(key, phase);
  reviewListeners.get(key)?.forEach((listener) => listener(phase));
}

const REVIEWER_IDENTITY = `You are the Reviewer agent for Push, a mobile AI coding assistant. Your role is to provide advisory code review feedback on diffs.

You MUST respond with ONLY a valid JSON object. No other text, no markdown fences.

Schema:
{
  "summary": "2-3 sentences summarizing the overall quality of the changes",
  "comments": [
    {
      "file": "path/to/file.ts",
      "line": 42,
      "severity": "critical" | "warning" | "suggestion" | "note",
      "comment": "Specific, actionable feedback about this file or section"
    }
  ]
}

Added lines in the diff are annotated with [Lxxx] indicating their line number in the new file. When your comment targets a specific added line, include "line": <that number>. Omit "line" for file-level or general comments that span multiple lines or the whole file.`;

const REVIEWER_GUIDELINES = `${REVIEWER_CRITERIA_BLOCK}

Keep comments specific and actionable. Prefer 0-5 high-signal comments total. Use "note" sparingly, and skip low-value style nits unless they materially affect maintainability or correctness. If the diff does not give you enough context to assess something, skip it rather than guessing. One precise comment is worth more than three vague ones.`;

const REVIEWER_FILE_STRUCTURE_NOTE = "File structure is auto-fetched and shows the outline of changed files. Use it for orientation but don't assume it's complete.";

function toSandboxWorkspacePath(path: string): string {
  if (path.startsWith('/workspace/')) return path;
  return `/workspace/${path.replace(/^\/+/, '')}`;
}

function buildFileStructureBlock(entries: Array<{ path: string; symbols: SandboxSymbol[] }>): string | null {
  const lines = ['[FILE STRUCTURE — auto-fetched from changed files]'];
  let totalChars = lines[0].length;
  let includedEntries = 0;

  for (const entry of entries) {
    if (entry.symbols.length === 0) continue;

    const sectionLines = [
      `--- ${entry.path} ---`,
      ...entry.symbols.map((symbol) => `${symbol.signature} [L${symbol.line}]`),
    ];

    let sectionChars = 0;
    const acceptedSectionLines: string[] = [];

    for (const line of sectionLines) {
      const lineChars = line.length + 1;
      if (totalChars + sectionChars + lineChars > REVIEWER_FILE_STRUCTURE_LIMIT) {
        break;
      }
      acceptedSectionLines.push(line);
      sectionChars += lineChars;
    }

    if (acceptedSectionLines.length === 0) break;

    lines.push(...acceptedSectionLines);
    totalChars += sectionChars;
    includedEntries++;
  }

  return includedEntries > 0 ? lines.join('\n') : null;
}

async function fetchFileStructure(
  diff: string,
  sandboxId: string,
): Promise<string | null> {
  const filePaths = parseDiffIntoFiles(diff)
    .map((file) => file.path)
    .slice(0, REVIEWER_FILE_STRUCTURE_MAX_FILES);

  if (filePaths.length === 0) return null;

  const settled = await Promise.allSettled(
    filePaths.map(async (path) => ({
      path,
      ...(await readSymbolsFromSandbox(sandboxId, toSandboxWorkspacePath(path))),
    })),
  );

  const entries = settled
    .filter((result): result is PromiseFulfilledResult<{ path: string; symbols: SandboxSymbol[]; totalLines: number }> => result.status === 'fulfilled')
    .map((result) => ({ path: result.value.path, symbols: result.value.symbols }));

  return buildFileStructureBlock(entries);
}

export interface ReviewerOptions {
  provider: AIProviderType;
  model?: string; // explicit override; falls back to role default
  context?: ReviewerPromptContext;
  sandboxId?: string;
}

export async function runReviewer(
  diff: string,
  options: ReviewerOptions,
  onStatus: (phase: string) => void,
): Promise<ReviewResult> {
  const roleModel = getModelForRole(options.provider, 'reviewer');
  const modelId = options.model?.trim() || roleModel?.id;
  const runtimeContext = buildReviewerContextBlock(options.context);
  const key = reviewCoalesceKey(diff, options.provider, modelId, runtimeContext, options.sandboxId);

  const inflight = pendingReviews.get(key);
  if (inflight) {
    addReviewListener(key, onStatus);
    return inflight;
  }

  const listeners = new Set([onStatus]);
  reviewListeners.set(key, listeners);

  const run = runReviewerCore(diff, {
    ...options,
    model: modelId,
  }, runtimeContext, (phase) => {
    broadcastReviewStatus(key, phase);
  });
  pendingReviews.set(key, run);
  run.finally(() => {
    pendingReviews.delete(key);
    reviewListeners.delete(key);
    reviewLatestPhase.delete(key);
  });
  return run;
}

async function runReviewerCore(
  diff: string,
  options: ReviewerOptions,
  runtimeContext: string,
  onStatus: (phase: string) => void,
): Promise<ReviewResult> {
  const DIFF_LIMIT = 40_000;
  const annotatedDiff = annotateDiffWithLineNumbers(diff);
  const chunkedDiff = chunkDiffByFile(annotatedDiff, DIFF_LIMIT, classifyFilePath);
  const totalFiles = parseDiffStats(diff).filesChanged;
  const filesReviewed = parseDiffStats(chunkedDiff).filesChanged;
  const truncated = filesReviewed < totalFiles;
  const { provider, model: modelOverride, sandboxId } = options;

  const { streamFn } = getProviderStreamFn(provider);
  const modelId = modelOverride?.trim() || getModelForRole(provider, 'reviewer')?.id;
  let fileStructureBlock: string | null = null;
  if (sandboxId) {
    onStatus('Preparing review...');
    fileStructureBlock = await fetchFileStructure(chunkedDiff, sandboxId);
  }

  const systemPrompt = new SystemPromptBuilder()
    .set('identity', REVIEWER_IDENTITY)
    .set('guidelines', REVIEWER_GUIDELINES)
    .set('environment', runtimeContext)
    .set('custom', fileStructureBlock ? REVIEWER_FILE_STRUCTURE_NOTE : null)
    .build();

  onStatus('Reviewer reading diff…');
  const reviewPreamble = fileStructureBlock ? `${fileStructureBlock}\n\n` : '';

  const messages: ChatMessage[] = [
    {
      id: 'review-request',
      role: 'user',
      content: `${reviewPreamble}Review this diff:\n\n\`\`\`diff\n${chunkedDiff.replace(/`/g, '\\`')}\n\`\`\``,
      timestamp: Date.now(),
    },
  ];

  const { promise: streamErrorPromise, getAccumulated } = streamWithTimeout(
    REVIEWER_TIMEOUT_MS,
    `Reviewer timed out after ${REVIEWER_TIMEOUT_MS / 1000}s.`,
    (onToken, onDone, onError) => {
      return streamFn(
        messages,
        onToken,
        onDone,
        onError,
        undefined,
        undefined,
        false,
        modelId,
        systemPrompt,
      );
    },
  );

  const streamError = await streamErrorPromise;
  const accumulated = getAccumulated();

  if (streamError) {
    throw new Error(streamError.message);
  }

  // Strip markdown fences if present
  let jsonStr = accumulated.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();

  const parsed = asRecord(JSON.parse(jsonStr));

  const summary = typeof parsed?.summary === 'string' ? parsed.summary : 'No summary provided.';
  const rawComments = Array.isArray(parsed?.comments) ? parsed.comments : [];

  const comments: ReviewComment[] = rawComments.map((c) => {
    const rc = asRecord(c);
    const sev = rc?.severity;
    const severity: ReviewComment['severity'] =
      sev === 'critical' || sev === 'warning' || sev === 'suggestion' || sev === 'note'
        ? sev
        : 'note';
    const rawLine = rc?.line;
    const line = typeof rawLine === 'number' && Number.isInteger(rawLine) && rawLine > 0
      ? rawLine
      : undefined;
    return {
      file: typeof rc?.file === 'string' ? rc.file : 'unknown',
      severity,
      comment: typeof rc?.comment === 'string' ? rc.comment : '',
      ...(line !== undefined && { line }),
    };
  }).filter((c) => c.comment.length > 0);

  return {
    summary,
    comments,
    filesReviewed,
    totalFiles,
    truncated,
    provider,
    model: modelId ?? provider,
    reviewedAt: Date.now(),
  };
}
