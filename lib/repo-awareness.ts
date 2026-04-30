/**
 * Shared repo awareness logic for summarizing project types and parsing git status.
 * This file must remain environment-agnostic (no node:fs or node:child_process).
 */

export interface GitInfo {
  branch: string;
  modified: string[];
  added: string[];
  deleted: string[];
  untracked: string[];
  ahead: number;
  behind: number;
}

/**
 * Parses `git status --short --branch` (or `--porcelain -b`) output.
 */
export function parseGitStatus(stdout: string): GitInfo {
  const lines = stdout.trim().split('\n');
  const headerLine = lines[0] || '';

  // Header looks like: "## main...origin/main [ahead 2, behind 1]"
  let branch = '(unknown)';
  const branchMatch = headerLine.match(/^## (.+?)(?:\.\.\.|$)/);
  if (branchMatch) {
    branch = branchMatch[1].trim();
  }

  let ahead = 0;
  let behind = 0;
  const aheadMatch = headerLine.match(/\[ahead\s+(\d+)/);
  const behindMatch = headerLine.match(/behind\s+(\d+)\]/);
  if (aheadMatch) ahead = parseInt(aheadMatch[1], 10);
  if (behindMatch) behind = parseInt(behindMatch[1], 10);

  const info: GitInfo = {
    branch,
    modified: [],
    added: [],
    deleted: [],
    untracked: [],
    ahead,
    behind,
  };

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const code = line.slice(0, 2);
    const file = line.slice(3).trim();

    if (code === ' M' || code === 'M ') info.modified.push(file);
    else if (code === ' A' || code === 'A ') info.added.push(file);
    else if (code === ' D' || code === 'D ') info.deleted.push(file);
    else if (code === '??') info.untracked.push(file);
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
