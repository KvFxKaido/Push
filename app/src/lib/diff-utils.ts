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

/** File classification for risk calibration and diff priority. */
export type FileClassification = 'production' | 'tooling' | 'test' | 'fixture';

/** Classify a file path by its role in the project. */
export function classifyFilePath(path: string): FileClassification {
  const lower = path.toLowerCase();
  // Fixture / mock data — lowest priority
  if (
    /(?:^|\/)(?:fixtures|mocks|__mocks__|__fixtures__)\//.test(lower) ||
    /(?:^|\/)(?:fixtures|mocks|__mocks__|__fixtures__)$/.test(lower)
  ) {
    return 'fixture';
  }
  // Test files
  if (
    /(?:^|\/)(?:__tests__|tests?)\//i.test(lower) ||
    /\.(?:test|spec)\./i.test(lower)
  ) {
    return 'test';
  }
  // Tooling / scripts
  if (/(?:^|\/)(?:scripts|tools|bin)\//.test(lower)) {
    return 'tooling';
  }
  return 'production';
}

const CLASS_PRIORITY: Record<FileClassification, number> = {
  production: 0,
  tooling: 1,
  test: 2,
  fixture: 3,
};

/**
 * Pack diff sections into a char budget, never splitting a file mid-section.
 *
 * If `classifyFile` is provided, files are sorted by priority (production first,
 * fixture last) before packing — so when space runs out, lower-priority files
 * are the ones that get dropped.
 *
 * Returns the concatenated diff string. If files were omitted, a summary line
 * is appended listing the dropped paths.
 */
export function chunkDiffByFile(
  diff: string,
  charLimit: number,
  classifyFile?: (path: string) => FileClassification,
): string {
  const sections = diff.split(/(?=^diff --git )/m).filter((s) => s.startsWith('diff --git'));

  if (sections.length === 0) {
    // No parseable file sections — fall back to raw slice
    return diff.slice(0, charLimit);
  }

  // Build entries with path + classification
  const entries = sections.map((section) => {
    const pathMatch = section.match(/^diff --git a\/.+ b\/(.+)$/m);
    const path = pathMatch ? pathMatch[1] : 'unknown';
    const classification = classifyFile ? classifyFile(path) : ('production' as FileClassification);
    return { section, path, classification };
  });

  // Sort by classification priority (stable — preserves original order within same class)
  if (classifyFile) {
    entries.sort((a, b) => CLASS_PRIORITY[a.classification] - CLASS_PRIORITY[b.classification]);
  }

  const included: string[] = [];
  const omitted: string[] = [];
  let budget = charLimit;

  for (const entry of entries) {
    if (entry.section.length <= budget) {
      included.push(entry.section);
      budget -= entry.section.length;
    } else {
      omitted.push(entry.path);
    }
  }

  let result = included.join('');

  if (omitted.length > 0) {
    const omitLine = `\n[${omitted.length} file(s) omitted due to size limit: ${omitted.join(', ')}]`;
    result += omitLine;
  }

  return result;
}

/** Human-friendly byte size label. */
export function formatSize(bytes: number): string {
  if (bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
