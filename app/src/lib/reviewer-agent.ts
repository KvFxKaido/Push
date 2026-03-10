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
import { asRecord, streamWithTimeout } from './utils';
import { parseDiffStats } from './diff-utils';

const REVIEWER_TIMEOUT_MS = 90_000; // 90s — reviews can be thorough

const REVIEWER_SYSTEM_PROMPT = `You are the Reviewer agent for Push, a mobile AI coding assistant. Your role is to provide advisory code review feedback on diffs.

You MUST respond with ONLY a valid JSON object. No other text, no markdown fences.

Schema:
{
  "summary": "2-3 sentences summarizing the overall quality of the changes",
  "comments": [
    {
      "file": "path/to/file.ts",
      "severity": "critical" | "warning" | "suggestion" | "note",
      "comment": "Specific, actionable feedback about this file or section"
    }
  ]
}

Severity guide:
- critical: correctness bugs, data loss risk, broken functionality, security vulnerabilities
- warning: potential bugs, missing error handling, risky patterns, unhandled edge cases
- suggestion: better approaches, refactoring opportunities, performance improvements
- note: style observations, minor nitpicks, informational comments

Review for:
- Correctness: logic errors, off-by-ones, null/undefined handling, race conditions
- Security: injection vectors, auth issues, secret exposure (flag but don't block — that is the Auditor's job)
- Code quality: readability, maintainability, appropriate abstractions, dead code
- Conventions: consistency with surrounding code patterns visible in the diff
- Performance: obvious inefficiencies, unnecessary re-renders, expensive operations in hot paths

Keep comments specific and actionable. If the diff does not give you enough context to assess something, skip it rather than guessing. One precise comment is worth more than three vague ones.`;

export interface ReviewerOptions {
  provider: AIProviderType;
  model?: string; // explicit override; falls back to role default
}

export async function runReviewer(
  diff: string,
  options: ReviewerOptions,
  onStatus: (phase: string) => void,
): Promise<ReviewResult> {
  const DIFF_LIMIT = 40_000;
  const slicedDiff = diff.length > DIFF_LIMIT ? diff.slice(0, DIFF_LIMIT) : diff;
  const truncated = slicedDiff.length < diff.length;
  const totalFiles = parseDiffStats(diff).filesChanged;
  const filesReviewed = truncated ? parseDiffStats(slicedDiff).filesChanged : totalFiles;
  const { provider, model: modelOverride } = options;

  const { streamFn } = getProviderStreamFn(provider);
  const roleModel = getModelForRole(provider, 'reviewer');
  const modelId = modelOverride || roleModel?.id;

  onStatus('Reviewer reading diff…');

  const messages: ChatMessage[] = [
    {
      id: 'review-request',
      role: 'user',
      content: `Review this diff:\n\n\`\`\`diff\n${slicedDiff.replace(/`/g, '\\`')}\n\`\`\``,
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
        REVIEWER_SYSTEM_PROMPT,
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
    return {
      file: typeof rc?.file === 'string' ? rc.file : 'unknown',
      severity,
      comment: typeof rc?.comment === 'string' ? rc.comment : '',
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
