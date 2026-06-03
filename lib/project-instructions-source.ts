/**
 * Shared acquisition for project instructions.
 *
 * Push reads an orientation file (PUSH.md / AGENTS.md / CLAUDE.md / GEMINI.md)
 * on substrates with genuinely different ground truth — the CLI reads a local
 * checkout, the web fetches over GitHub REST before a sandbox exists, and the
 * web *again* re-reads from the booted sandbox's filesystem. Those three only
 * differ in HOW a single candidate is read; the precedence ("first found wins")
 * and the candidate list are identical, and were previously hand-copied into
 * four places (`github-tools.ts`, `project-instructions-utils.ts`,
 * `cli/workspace-context.ts`, and a prose "keep these in sync" comment).
 *
 * This module owns the one canonical list and the one precedence loop. The
 * substrate-specific part is reduced to a single function: `read(filename)`.
 * Acquisition returns RAW bytes — capping and delimiter-escaping are the
 * injection-time chokepoint's job (`formatProjectInstructionsBlock` /
 * `sanitizeProjectInstructions`), so a source must not truncate or escape.
 */

/**
 * Canonical, ordered candidate filenames — first found wins. The single source
 * of truth every surface resolves against; `project-instructions-source.test.ts`
 * pins the value so a careless reorder shows up in one diff instead of silently
 * disagreeing across surfaces.
 */
export const PROJECT_INSTRUCTION_FILENAMES = [
  'PUSH.md',
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
] as const;

export type ProjectInstructionFilename = (typeof PROJECT_INSTRUCTION_FILENAMES)[number];

/** Raw, unbounded, unescaped instructions as acquired from a substrate. */
export interface RawProjectInstructions {
  /** File contents exactly as read — NOT capped or escaped. */
  content: string;
  /** Which candidate won, for provenance (e.g. `"AGENTS.md"`). */
  filename: ProjectInstructionFilename;
}

/**
 * Read a single candidate from some substrate. Return its contents, or `null`
 * when the file is absent (so resolution falls through to the next candidate).
 * A hard failure the caller should NOT treat as "absent" — e.g. a non-404 HTTP
 * status from the GitHub REST reader — must throw, not return `null`.
 */
export type ProjectInstructionFileReader = (
  filename: ProjectInstructionFilename,
) => Promise<string | null>;

/**
 * Resolve project instructions by trying the canonical filenames in order and
 * returning the first non-empty hit. The shared precedence loop; the only
 * surface-specific input is `read`. Errors from `read` propagate (a 500 must
 * surface, not masquerade as a missing file).
 */
export async function resolveProjectInstructions(
  read: ProjectInstructionFileReader,
): Promise<RawProjectInstructions | null> {
  for (const filename of PROJECT_INSTRUCTION_FILENAMES) {
    const content = await read(filename);
    if (content && content.trim()) return { content, filename };
  }
  return null;
}
