/**
 * lib/git/status.ts — canonical typed git status.
 *
 * `GitStatusInfo` is the one typed status shape the GitBackend returns. It
 * extends the existing `GitInfo` (branch label + category arrays +
 * ahead/behind/detached, parsed by `repo-awareness.parseGitStatus`) with
 * the extras the workspace status card needs: the raw header line, per-entry
 * X/Y porcelain codes, and staged/unstaged counts. Consumers project the
 * fields they need rather than each re-parsing porcelain.
 *
 * Input is porcelain v1 with the branch header (`git status --porcelain -b`,
 * equivalently `--short --branch`).
 */

import { parseGitStatus, type GitInfo } from '../repo-awareness.js';

export interface GitStatusEntry {
  /** Index (staged) column, e.g. 'M', 'A', ' ', '?'. */
  x: string;
  /** Worktree (unstaged) column. */
  y: string;
  /** New path (rename/copy entries surface the post-arrow path). */
  path: string;
  /** Original porcelain line (used for the card preview). */
  raw: string;
}

export interface GitStatusInfo extends GitInfo {
  /** Raw header content after `## ` (e.g. `main...origin/main [ahead 1]`). */
  statusLine: string;
  entries: GitStatusEntry[];
  /** Count of entries with a non-space index column (excludes untracked). */
  staged: number;
  /** Count of entries with a non-space worktree column (excludes untracked). */
  unstaged: number;
}

/**
 * Parse `git status --porcelain -b` into the canonical `GitStatusInfo`.
 * Reuses `parseGitStatus` for branch/category/ahead-behind classification,
 * then layers the entry-level + staged/unstaged detail on top.
 */
export function parseGitStatusInfo(stdout: string): GitStatusInfo {
  const base = parseGitStatus(stdout);
  const lines = stdout
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean);

  const headerLine = lines.find((line) => line.startsWith('## '));
  const statusLine = headerLine ? headerLine.slice(3).trim() : '';

  const entries: GitStatusEntry[] = [];
  let staged = 0;
  let unstaged = 0;
  for (const line of lines) {
    if (line.startsWith('##')) continue;
    if (line.length < 3) continue;
    const x = line[0] ?? ' ';
    const y = line[1] ?? ' ';
    const rest = line.slice(3);
    const arrowIdx = rest.indexOf(' -> ');
    const path = arrowIdx >= 0 ? rest.slice(arrowIdx + 4).trim() : rest.trim();
    entries.push({ x, y, path, raw: line });

    // Untracked (`??`) counts toward neither staged nor unstaged — it mirrors
    // the card's prior accounting where `??` is tallied separately.
    if (x === '?' && y === '?') continue;
    if (x !== ' ') staged++;
    if (y !== ' ') unstaged++;
  }

  return { ...base, statusLine, entries, staged, unstaged };
}
