/**
 * Shared repo awareness logic for summarizing project types and parsing git status.
 * This file must remain environment-agnostic (no node:fs or node:child_process).
 */

export interface GitInfo {
  branch: string;
  modified: string[];
  added: string[];
  deleted: string[];
  renamed: string[];
  copied: string[];
  conflicted: string[];
  untracked: string[];
  ahead: number;
  behind: number;
  detached: boolean;
}

/**
 * Parses `git status --short --branch` (or `--porcelain -b`) output.
 *
 * Porcelain v1 format: each tracked entry is `XY <path>` where X is the index
 * (staged) status and Y is the worktree (unstaged) status. Renames and copies
 * use the form `XY <old> -> <new>`. Unmerged (conflict) entries use a set of
 * two-letter codes (UU, AA, DD, AU, UA, UD, DU).
 *
 * The header line starts with `## ` and reports branch, upstream, and ahead/
 * behind counts. `## HEAD (no branch)` indicates a detached HEAD.
 */
export function parseGitStatus(stdout: string): GitInfo {
  const lines = stdout.trim().split('\n');
  const headerLine = lines[0] || '';

  const info: GitInfo = {
    branch: '(unknown)',
    modified: [],
    added: [],
    deleted: [],
    renamed: [],
    copied: [],
    conflicted: [],
    untracked: [],
    ahead: 0,
    behind: 0,
    detached: false,
  };

  if (headerLine.startsWith('## ')) {
    const rest = headerLine.slice(3);
    if (rest.startsWith('HEAD (no branch)') || rest.startsWith('No commits yet')) {
      info.detached = rest.startsWith('HEAD');
      info.branch = info.detached ? '(detached)' : '(no commits)';
    } else {
      const branchMatch = rest.match(/^(.+?)(?:\.\.\.|\s|$)/);
      if (branchMatch) info.branch = branchMatch[1].trim();
    }

    const aheadMatch = headerLine.match(/\[ahead\s+(\d+)/);
    const behindMatch = headerLine.match(/behind\s+(\d+)\]/);
    if (aheadMatch) info.ahead = parseInt(aheadMatch[1], 10);
    if (behindMatch) info.behind = parseInt(behindMatch[1], 10);
  }

  // Unmerged/conflict two-letter codes per git porcelain v1.
  const CONFLICT_CODES = new Set(['UU', 'AA', 'DD', 'AU', 'UA', 'UD', 'DU']);

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    // Porcelain entries are exactly `XY <space> <path>`. Short lines are skipped.
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    const rest = line.slice(3);

    // Rename/copy entries encode both old and new paths separated by ` -> `.
    // We surface only the new path for dirty-file accounting.
    const arrowIdx = rest.indexOf(' -> ');
    const file = arrowIdx >= 0 ? rest.slice(arrowIdx + 4).trim() : rest.trim();

    if (code === '??') {
      info.untracked.push(file);
      continue;
    }

    if (CONFLICT_CODES.has(code)) {
      info.conflicted.push(file);
      continue;
    }

    // Classify by the union of staged (X) and unstaged (Y) columns so combined
    // states like `MM` (modified both staged+unstaged) and `AM` (added then
    // modified) count exactly once. Priority: rename > copy > delete > add > modify.
    const x = code[0];
    const y = code[1];
    const chars = new Set([x, y]);

    if (chars.has('R')) info.renamed.push(file);
    else if (chars.has('C')) info.copied.push(file);
    else if (chars.has('D')) info.deleted.push(file);
    else if (chars.has('A')) info.added.push(file);
    else if (chars.has('M') || chars.has('T')) info.modified.push(file);
    // Anything else (e.g. ' ' for clean on one side only) falls through silently.
  }

  return info;
}

export type ManifestSummarizer = (content: string) => string | null;

export const summarizePackageJson: ManifestSummarizer = (content) => {
  try {
    const pkg = JSON.parse(content);
    const name = pkg.name || '(unnamed)';
    const version = pkg.version || '(no version)';
    const depCount = Object.keys(pkg.dependencies || {}).length;
    return `package.json — ${name}@${version}, ${depCount} dependencies`;
  } catch {
    return null;
  }
};

export const summarizeCargoToml: ManifestSummarizer = (content) => {
  const nameMatch = content.match(/^name\s*=\s*"(.+?)"/m);
  const versionMatch = content.match(/^version\s*=\s*"(.+?)"/m);
  if (!nameMatch) return null;
  return `Cargo.toml — ${nameMatch[1]}@${versionMatch ? versionMatch[1] : '(no version)'}`;
};

export const summarizePyprojectToml: ManifestSummarizer = (content) => {
  const nameMatch = content.match(/^name\s*=\s*"(.+?)"/m);
  const versionMatch = content.match(/^version\s*=\s*"(.+?)"/m);
  if (!nameMatch) return null;
  return `pyproject.toml — ${nameMatch[1]}@${versionMatch ? versionMatch[1] : '(no version)'}`;
};

export const summarizeGoMod: ManifestSummarizer = (content) => {
  const modMatch = content.match(/^module\s+(.+)$/m);
  if (!modMatch) return null;
  return `go.mod — ${modMatch[1].trim()}`;
};

export const summarizeGemfile: ManifestSummarizer = () => {
  return 'Gemfile — Ruby project';
};

export const summarizePomXml: ManifestSummarizer = () => {
  return 'pom.xml — Maven project';
};

export const MANIFEST_PARSERS: Record<string, ManifestSummarizer> = {
  'package.json': summarizePackageJson,
  'Cargo.toml': summarizeCargoToml,
  'pyproject.toml': summarizePyprojectToml,
  'go.mod': summarizeGoMod,
  Gemfile: summarizeGemfile,
  'pom.xml': summarizePomXml,
};
