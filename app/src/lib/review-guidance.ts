import { readFromSandbox } from '@/lib/sandbox-client';
import { fetchReviewGuidance as fetchReviewGuidanceFromGitHub } from '@/lib/github-tools';
import {
  capReviewGuidanceLines,
  REVIEW_GUIDANCE_MAX_LINES,
  REVIEW_GUIDANCE_SANDBOX_PATH,
  resolveReviewGuidance as resolveReviewGuidanceCore,
} from '../../../lib/review-guidance';

export { REVIEW_GUIDANCE_SANDBOX_PATH } from '../../../lib/review-guidance';

export interface ResolveReviewGuidanceArgs {
  /** owner/name — omitted in Sandbox/Scratch mode. */
  repoFullName?: string | null;
  /** Branch to read REVIEW.md from when falling back to GitHub. Use the branch under review. */
  ref?: string | null;
  /** Sandbox to read the working-copy REVIEW.md from, when one is ready. */
  sandboxId?: string | null;
}

/**
 * Resolve repo-root REVIEW.md for the in-app Reviewer.
 *
 * Web binding over the shared `lib/review-guidance` resolver: the sandbox
 * working copy is the working-copy source (reflects unpushed edits) and the
 * repo's GitHub copy on `ref` is the committed fallback. Returns null when no
 * REVIEW.md exists anywhere, in which case the Reviewer keeps its built-in
 * guidance. Never throws.
 */
export async function resolveReviewGuidance({
  repoFullName,
  ref,
  sandboxId,
}: ResolveReviewGuidanceArgs): Promise<string | null> {
  return resolveReviewGuidanceCore({
    readWorkingCopy: sandboxId
      ? async () => {
          // Read one past the cap as an overflow sentinel so capReviewGuidanceLines
          // can mark a truncation the bare line cap would otherwise hide.
          const result = await readFromSandbox(
            sandboxId,
            REVIEW_GUIDANCE_SANDBOX_PATH,
            1,
            REVIEW_GUIDANCE_MAX_LINES + 1,
          );
          return result.error || !result.content ? null : capReviewGuidanceLines(result.content);
        }
      : undefined,
    fetchCommitted: repoFullName
      ? async () => (await fetchReviewGuidanceFromGitHub(repoFullName, ref ?? undefined)) ?? null
      : undefined,
  });
}
