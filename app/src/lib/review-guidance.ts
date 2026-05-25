import { readFromSandbox } from '@/lib/sandbox-client';
import { fetchReviewGuidance as fetchReviewGuidanceFromGitHub } from '@/lib/github-tools';

export const REVIEW_GUIDANCE_SANDBOX_PATH = '/workspace/REVIEW.md';

// Defense-in-depth: bound the working-copy read so a pathological REVIEW.md
// can't be pulled whole into memory before the char cap in formatReviewGuidance
// applies. Comfortably covers a real guidance file.
const REVIEW_GUIDANCE_MAX_LINES = 600;

export interface ResolveReviewGuidanceArgs {
  /** owner/name — omitted in Sandbox/Scratch mode. */
  repoFullName?: string | null;
  /** Branch to read REVIEW.md from when falling back to GitHub. Use the base branch. */
  ref?: string | null;
  /** Sandbox to read the working-copy REVIEW.md from, when one is ready. */
  sandboxId?: string | null;
}

/**
 * Resolve repo-root REVIEW.md for the in-app Reviewer.
 *
 * Prefers the sandbox working copy when a sandbox is ready — it reflects the
 * REVIEW.md the user is actually working with, including unpushed edits — and
 * falls back to the repo's GitHub copy on `ref`. Returns null when no REVIEW.md
 * exists anywhere, in which case the Reviewer keeps its built-in guidance.
 *
 * Never throws: a failed lookup must not block the review from running.
 */
export async function resolveReviewGuidance({
  repoFullName,
  ref,
  sandboxId,
}: ResolveReviewGuidanceArgs): Promise<string | null> {
  if (sandboxId) {
    try {
      const result = await readFromSandbox(
        sandboxId,
        REVIEW_GUIDANCE_SANDBOX_PATH,
        1,
        REVIEW_GUIDANCE_MAX_LINES,
      );
      const content = result.error ? '' : result.content.trim();
      if (content) return content;
    } catch {
      // Fall through to GitHub — sandbox read failures shouldn't skip the
      // committed REVIEW.md.
    }
  }

  if (repoFullName) {
    try {
      const content = (await fetchReviewGuidanceFromGitHub(repoFullName, ref ?? undefined))?.trim();
      if (content) return content;
    } catch {
      // No REVIEW.md reachable — reviewer uses its default guidance.
    }
  }

  return null;
}
