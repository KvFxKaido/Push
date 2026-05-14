/**
 * `goal.md` file store for the user-goal anchor (v2).
 *
 * Push's compaction-time anchor is seeded from `<cwd>/.push/goal.md` when
 * present, falling back to the runtime-derived first user turn when not.
 * The file is the user's source of truth: agents read it but do not write
 * to it directly (agent-write semantics will land in v3 with provenance +
 * stale-write protection). The one exception is auto-seed — Push writes
 * the file *once*, the first time compaction fires in a session, if no
 * file exists yet. After that the file is user-owned.
 *
 * Path: `<cwd>/.push/goal.md`. `.push/` is gitignored at repo root, so
 * the file lives next to the workspace without polluting commits. CLI
 * only for v2; the web sandbox's ephemerality makes "user can edit this
 * file" a half-truth, so web stays on the inline v1 derivation until the
 * sandbox revision system can carry the file across restarts. See the
 * v2.5 design discussion in PR description.
 */

import { promises as fs } from 'node:fs';
import nodePath from 'node:path';
import {
  formatUserGoalMarkdown,
  parseUserGoalMarkdown,
  type UserGoalAnchor,
} from '../lib/user-goal-anchor.ts';

export const GOAL_FILE_RELATIVE_PATH = nodePath.join('.push', 'goal.md');

export function resolveGoalFilePath(cwd: string): string {
  return nodePath.join(cwd, GOAL_FILE_RELATIVE_PATH);
}

/**
 * Read + parse `goal.md`. Returns null on any failure (missing file,
 * permission error, unparseable content). A failed read is *not* a hard
 * error — the caller falls back to runtime derivation, so the worst case
 * is "behaves like v1 today" rather than "blocks the turn".
 */
export async function loadUserGoalFile(cwd: string): Promise<UserGoalAnchor | null> {
  const filePath = resolveGoalFilePath(cwd);
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  return parseUserGoalMarkdown(content);
}

export interface SeedUserGoalInputs {
  /** Verbatim first user turn — populates `Initial ask`. Required. */
  firstUserTurn: string;
  /** Cleaned-up first-compaction digest content — populates
   *  `Current working goal`. Optional; when absent the section emits
   *  empty and waits for the user to fill it in. */
  workingGoalSeed?: string;
  /** ISO-8601 timestamp for `Last refreshed`. Tests pin this; production
   *  callers default to now(). */
  refreshedAt?: string;
}

export interface SeedResult {
  /** True iff we wrote a new file. False when the file already existed
   *  (user-owned — never overwrite) or when seeding inputs were unusable. */
  wrote: boolean;
  path: string;
}

/**
 * Auto-seed `goal.md` from compaction inputs. Idempotent against an
 * existing file — if `goal.md` is already on disk, this is a no-op. Uses
 * `wx` flag so the existence check + write is atomic on POSIX (no
 * race between two background tasks seeding concurrently).
 *
 * Creates the parent `.push/` directory if absent. No-op if
 * `firstUserTurn` is empty after trimming.
 */
export async function seedUserGoalFile(
  cwd: string,
  inputs: SeedUserGoalInputs,
): Promise<SeedResult> {
  const path = resolveGoalFilePath(cwd);
  const firstUserTurn = inputs.firstUserTurn.trim();
  if (!firstUserTurn) {
    return { wrote: false, path };
  }

  const anchor: UserGoalAnchor = {
    initialAsk: firstUserTurn,
    lastRefreshedAt: inputs.refreshedAt ?? new Date().toISOString(),
  };
  const workingGoalSeed = inputs.workingGoalSeed?.trim();
  if (workingGoalSeed) anchor.currentWorkingGoal = workingGoalSeed;

  const content = formatUserGoalMarkdown(anchor);

  await fs.mkdir(nodePath.dirname(path), { recursive: true });
  try {
    await fs.writeFile(path, content, { encoding: 'utf8', flag: 'wx' });
    return { wrote: true, path };
  } catch (err: unknown) {
    // EEXIST is the expected path when goal.md is already user-owned —
    // never overwrite. Other errors (EACCES, ENOSPC, etc.) surface as
    // "didn't seed" without throwing: a non-load-bearing best-effort
    // write shouldn't take down the turn.
    const code = (err as { code?: string } | null)?.code;
    if (code === 'EEXIST' || code === 'EACCES' || code === 'ENOSPC') {
      return { wrote: false, path };
    }
    return { wrote: false, path };
  }
}

/**
 * Strip the `[CONTEXT DIGEST]` wrapper from a compaction digest message,
 * returning the plain body suitable for use as the `workingGoalSeed`.
 * Returns empty string when input lacks the expected wrapper, leaving
 * the caller to fall back to a section-less seed.
 */
export function extractDigestBody(digestContent: string): string {
  const open = '[CONTEXT DIGEST]';
  const close = '[/CONTEXT DIGEST]';
  const startIdx = digestContent.indexOf(open);
  if (startIdx < 0) return '';
  const bodyStart = startIdx + open.length;
  const endIdx = digestContent.indexOf(close, bodyStart);
  const body = (
    endIdx < 0 ? digestContent.slice(bodyStart) : digestContent.slice(bodyStart, endIdx)
  ).trim();
  // Drop the literal intro line that both compactors emit ahead of the
  // bullet list so the seed reads cleanly when surfaced in the file.
  return body.replace(/^Earlier messages were condensed[^\n]*\n?/, '').trim();
}
