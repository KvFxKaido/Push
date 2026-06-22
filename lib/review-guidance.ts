// Repo-root REVIEW.md is the Reviewer's primary repository-specific guidance.
// Resolution is surface-agnostic: callers inject the two reads (web = sandbox
// working copy + GitHub committed; CLI = local fs + git; webhook = GitHub at the
// PR ref). The injection point in role-context's formatReviewGuidance applies
// the sanitizer + char cap, so this module only owns *which copy wins* and the
// fail-open contract.

export const REVIEW_GUIDANCE_FILENAME = 'REVIEW.md';
export const REVIEW_GUIDANCE_SANDBOX_PATH = '/workspace/REVIEW.md';

// Defense-in-depth line cap for working-copy reads (sandbox / local fs): a
// pathological REVIEW.md shouldn't be pulled whole into memory before the char
// cap in role-context applies. Comfortably covers a real guidance file.
export const REVIEW_GUIDANCE_MAX_LINES = 600;

/**
 * Apply the working-copy line cap and mark the cut. The real truncation gate is
 * the char cap in `role-context`'s `formatReviewGuidance` (which already marks),
 * so this only bites the defense-in-depth edge — a REVIEW.md over the line cap
 * whose lines are short enough to stay under the char cap. Shared by both
 * surfaces (CLI reads the file whole; web reads `MAX + 1` lines as an overflow
 * sentinel) so the marker text can't drift between them.
 */
export function capReviewGuidanceLines(text: string): string {
  const lines = text.split('\n');
  if (lines.length <= REVIEW_GUIDANCE_MAX_LINES) return text;
  return `${lines.slice(0, REVIEW_GUIDANCE_MAX_LINES).join('\n')}\n[… REVIEW.md truncated at ${REVIEW_GUIDANCE_MAX_LINES} lines]`;
}

export interface ReviewGuidanceSources {
  /**
   * Read the working-copy REVIEW.md — the version the author is editing right
   * now, including unpushed changes. Sandbox read on web, local fs on CLI.
   * Return null/empty when absent. May throw; the resolver guards it.
   */
  readWorkingCopy?: () => Promise<string | null | undefined>;
  /**
   * Fetch the committed REVIEW.md at the review ref. GitHub REST on web/webhook,
   * `git show` on CLI. Return null/empty when absent. May throw; the resolver
   * guards it.
   */
  fetchCommitted?: () => Promise<string | null | undefined>;
}

/**
 * Resolve repo-root REVIEW.md guidance for the Reviewer — working copy first,
 * committed-at-ref as fallback. Returns null when no REVIEW.md is reachable, in
 * which case the Reviewer keeps its built-in guidance unchanged.
 *
 * Never throws: a failed lookup must not block the review from running. Emits
 * one structured log per outcome (resolved ↔ working-copy-failed ↔
 * committed-failed ↔ absent) so an unreadable or missing REVIEW.md is visible
 * to ops rather than a silent skip — see CLAUDE.md "Symmetric structured logs".
 */
export async function resolveReviewGuidance(
  sources: ReviewGuidanceSources,
): Promise<string | null> {
  const { readWorkingCopy, fetchCommitted } = sources;

  if (readWorkingCopy) {
    try {
      const content = (await readWorkingCopy())?.trim();
      if (content) {
        console.log(
          JSON.stringify({
            level: 'debug',
            event: 'review_guidance_resolved',
            source: 'working-copy',
            chars: content.length,
          }),
        );
        return content;
      }
    } catch (err) {
      console.log(
        JSON.stringify({
          level: 'warn',
          event: 'review_guidance_working_copy_failed',
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      // Fall through to the committed copy — a working-copy read failure must
      // not skip a committed REVIEW.md.
    }
  }

  if (fetchCommitted) {
    try {
      const content = (await fetchCommitted())?.trim();
      if (content) {
        console.log(
          JSON.stringify({
            level: 'debug',
            event: 'review_guidance_resolved',
            source: 'committed',
            chars: content.length,
          }),
        );
        return content;
      }
    } catch (err) {
      console.log(
        JSON.stringify({
          level: 'warn',
          event: 'review_guidance_committed_failed',
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      // No REVIEW.md reachable — reviewer uses its default guidance.
    }
  }

  console.log(JSON.stringify({ level: 'debug', event: 'review_guidance_absent' }));
  return null;
}
