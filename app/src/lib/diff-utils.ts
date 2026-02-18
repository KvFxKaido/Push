/**
 * Shared diff parsing utilities.
 *
 * Previously duplicated across WorkspaceHubSheet, useCommitPush, and sandbox-tools.
 */

export interface DiffStats {
  filesChanged: number;
  additions: number;
  deletions: number;
  fileNames: string[];
}

export interface FileDiff {
  path: string;
  additions: number;
  deletions: number;
  hunks: string; // raw diff text for this file section
}

/** Count files/additions/deletions from a unified diff string. */
export function parseDiffStats(diff: string): DiffStats {
  const files = new Set<string>();
  let additions = 0;
  let deletions = 0;

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) {
      const match = line.match(/b\/(.+)$/);
      if (match) files.add(match[1]);
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      additions++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      deletions++;
    }
  }

  return { filesChanged: files.size, additions, deletions, fileNames: [...files] };
}

/** Split a unified diff into per-file sections with stats. */
export function parseDiffIntoFiles(rawDiff: string): FileDiff[] {
  const files: FileDiff[] = [];
  // Split on "diff --git" boundaries, keeping the delimiter
  const sections = rawDiff.split(/(?=^diff --git )/m);

  for (const section of sections) {
    if (!section.startsWith('diff --git')) continue;

    const pathMatch = section.match(/^diff --git a\/.+ b\/(.+)$/m);
    if (!pathMatch) continue;

    let additions = 0;
    let deletions = 0;
    for (const line of section.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) additions++;
      else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
    }

    files.push({
      path: pathMatch[1],
      additions,
      deletions,
      hunks: section,
    });
  }

  return files;
}

/** Human-friendly byte size label. */
export function formatSize(bytes: number): string {
  if (bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
