/**
 * Shared read-only GitHub tool core.
 *
 * This module is runtime-agnostic: callers provide fetch/auth/sensitive-data
 * primitives, and the shared core handles GitHub API orchestration plus the
 * user-facing text/card shaping for the read-only tool subset.
 */

export interface GitHubReadonlyBranch {
  name: string;
  isDefault: boolean;
  isProtected: boolean;
}

export interface GitHubReadonlyPRFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface GitHubReadonlyPRListItem {
  number: number;
  title: string;
  author: string;
  additions?: number;
  deletions?: number;
  createdAt: string;
}

export interface GitHubReadonlyPRListCardData {
  repo: string;
  state: string;
  prs: GitHubReadonlyPRListItem[];
}

export interface GitHubReadonlyCommitListItem {
  sha: string;
  message: string;
  author: string;
  date: string;
}

export interface GitHubReadonlyCommitListCardData {
  repo: string;
  commits: GitHubReadonlyCommitListItem[];
}

export interface GitHubReadonlyFileListEntry {
  name: string;
  type: 'file' | 'directory';
  size?: number;
}

export interface GitHubReadonlyFileListCardData {
  repo?: string;
  path: string;
  entries: GitHubReadonlyFileListEntry[];
}

export interface GitHubReadonlyEditorCardData {
  path: string;
  content: string;
  language: string;
  truncated: boolean;
  source: 'github';
  repo: string;
}

export interface GitHubReadonlyCommitFileItem {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface GitHubReadonlyCommitFilesCardData {
  repo: string;
  ref: string;
  sha: string;
  message: string;
  author: string;
  date: string;
  files: GitHubReadonlyCommitFileItem[];
  totalChanges: { additions: number; deletions: number };
}

export interface GitHubReadonlyPRCardData {
  number: number;
  title: string;
  author: string;
  state: 'open' | 'closed' | 'merged';
  additions: number;
  deletions: number;
  changedFiles: number;
  branch: string;
  baseBranch: string;
  createdAt: string;
  description?: string;
  files?: GitHubReadonlyPRFile[];
}

export interface GitHubReadonlyBranchListCardData {
  repo: string;
  defaultBranch: string;
  branches: GitHubReadonlyBranch[];
}

export interface GitHubReadonlyFileSearchMatch {
  path: string;
  line: number;
  content: string;
}

export interface GitHubReadonlyFileSearchCardData {
  repo: string;
  query: string;
  path?: string;
  matches: GitHubReadonlyFileSearchMatch[];
  totalCount: number;
  truncated: boolean;
}

export interface GitHubReadonlyCICheck {
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required' | null;
  detailsUrl?: string;
}

export type GitHubReadonlyCIOverallStatus = 'pending' | 'success' | 'failure' | 'neutral' | 'no-checks';

export interface GitHubReadonlyCIStatusCardData {
  type: 'ci-status';
  overall: GitHubReadonlyCIOverallStatus;
  repo: string;
  ref: string;
  fetchedAt: string;
  checks: GitHubReadonlyCICheck[];
}

export type GitHubReadonlyCard =
  | { type: 'pr'; data: GitHubReadonlyPRCardData }
  | { type: 'pr-list'; data: GitHubReadonlyPRListCardData }
  | { type: 'commit-list'; data: GitHubReadonlyCommitListCardData }
  | { type: 'branch-list'; data: GitHubReadonlyBranchListCardData }
  | { type: 'file-list'; data: GitHubReadonlyFileListCardData }
  | { type: 'ci-status'; data: GitHubReadonlyCIStatusCardData }
  | { type: 'editor'; data: GitHubReadonlyEditorCardData }
  | { type: 'file-search'; data: GitHubReadonlyFileSearchCardData }
  | { type: 'commit-files'; data: GitHubReadonlyCommitFilesCardData };

export interface GitHubReadonlyToolResult {
  text: string;
  card?: GitHubReadonlyCard;
}

export type GitHubReadonlyToolCall =
  | { tool: 'fetch_pr'; args: { repo: string; pr: number } }
  | { tool: 'list_prs'; args: { repo: string; state?: string } }
  | { tool: 'list_commits'; args: { repo: string; count?: number } }
  | { tool: 'read_file'; args: { repo: string; path: string; branch?: string; start_line?: number; end_line?: number } }
  | { tool: 'grep_file'; args: { repo: string; path: string; pattern: string; branch?: string } }
  | { tool: 'list_directory'; args: { repo: string; path?: string; branch?: string } }
  | { tool: 'list_branches'; args: { repo: string; maxBranches?: number } }
  | { tool: 'fetch_checks'; args: { repo: string; ref?: string } }
  | { tool: 'search_files'; args: { repo: string; query: string; path?: string; branch?: string } }
  | { tool: 'list_commit_files'; args: { repo: string; ref: string } };

export interface GitHubReadonlyRuntime {
  githubFetch(url: string, options?: RequestInit): Promise<Response>;
  buildHeaders(accept?: string): Record<string, string>;
  buildApiUrl(path: string): string;
  decodeBase64(content: string): string;
  isSensitivePath(path: string): boolean;
  redactSensitiveText(text: string): { text: string; redacted: boolean };
  formatSensitivePathToolError(path: string): string;
}

const DEFAULT_ACCEPT = 'application/vnd.github.v3+json';
const SEARCH_ACCEPT = 'application/vnd.github.v3.text-match+json';
const DIFF_ACCEPT = 'application/vnd.github.v3.diff';
const READ_FILE_RANGE_CHAR_LIMIT = 30_000;
const READ_FILE_FULL_CHAR_LIMIT = 15_000;
const utf8Encoder = new TextEncoder();

interface RepoBranchApi {
  name?: string;
  protected?: boolean;
}

interface RepoContentEntryApi {
  name?: string;
  type?: string;
  size?: number;
}

interface RepoFileContentApi {
  type?: string;
  size?: number;
  content?: string;
}

interface PullRequestListApi {
  number: number;
  title: string;
  additions?: number;
  deletions?: number;
  created_at: string;
  user: { login: string };
}

interface CommitListApi {
  sha: string;
  commit: {
    message: string;
    author?: {
      name?: string;
      date?: string;
    };
  };
  author?: {
    login?: string;
  };
}

interface CommitDetailsApi {
  sha: string;
  author?: { login?: string };
  commit: {
    message: string;
    author?: {
      name?: string;
      date?: string;
    };
  };
  files?: Array<{
    filename: string;
    status: string;
    additions?: number;
    deletions?: number;
  }>;
}

function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

function formatGitHubError(status: number, context: string, branch?: string): string {
  switch (status) {
    case 404: {
      const branchHint = branch ? ` on branch "${branch}"` : '';
      return `Not found: ${context}${branchHint}. The file may not exist, the path might be incorrect, or the branch may be different. Try list_directory to browse, or list_branches to see available branches.`;
    }
    case 403:
      return `Access forbidden (403) for ${context}. Your GitHub token may lack permissions, or you have hit API rate limits.`;
    case 429:
      return `Rate limited (429) for ${context}. GitHub is throttling requests. Retry shortly.`;
    case 401:
      return `Unauthorized (401) for ${context}. Your GitHub token is invalid or expired.`;
    case 500:
    case 502:
    case 503:
      return `GitHub server error (${status}) for ${context}. This is temporary — retry shortly.`;
    default:
      return `GitHub API returned ${status} for ${context}`;
  }
}

function buildGitHubApiUrl(runtime: GitHubReadonlyRuntime, path: string): string {
  return runtime.buildApiUrl(path.startsWith('/') ? path : `/${path}`);
}

function byteLength(text: string): number {
  return utf8Encoder.encode(text).length;
}

function truncateDisplayLines(
  sourceLines: string[],
  displayLines: string[],
  startLine: number,
  maxChars: number,
): {
  displayLines: string[];
  truncated: boolean;
  truncatedAtLine?: number;
  remainingBytes?: number;
} {
  if (displayLines.length === 0) {
    return { displayLines, truncated: false };
  }

  let keptCount = 0;
  let usedChars = 0;
  for (let i = 0; i < displayLines.length; i += 1) {
    const lineChars = displayLines[i].length + (i > 0 ? 1 : 0);
    if (usedChars + lineChars > maxChars) {
      if (keptCount === 0) keptCount = 1;
      break;
    }
    usedChars += lineChars;
    keptCount += 1;
  }

  if (keptCount >= displayLines.length) {
    return { displayLines, truncated: false };
  }

  return {
    displayLines: displayLines.slice(0, keptCount),
    truncated: true,
    truncatedAtLine: startLine + keptCount,
    remainingBytes: byteLength(sourceLines.slice(keptCount).join('\n')),
  };
}

function buildReadTruncationLines(truncatedAtLine?: number, remainingBytes?: number): string[] {
  return [
    typeof truncatedAtLine === 'number' ? `truncated_at_line: ${truncatedAtLine}` : null,
    typeof remainingBytes === 'number' ? `remaining_bytes: ${remainingBytes}` : null,
  ].filter((line): line is string => Boolean(line));
}

function guessLanguageFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  const langMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    py: 'python',
    rs: 'rust',
    go: 'go',
    rb: 'ruby',
    java: 'java',
    md: 'markdown',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    css: 'css',
    html: 'html',
    sh: 'shell',
    bash: 'shell',
    toml: 'toml',
    sql: 'sql',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
  };
  return langMap[ext] || ext;
}

function buildContentsApiUrl(
  runtime: GitHubReadonlyRuntime,
  repo: string,
  path: string,
  branch?: string,
): string {
  const ref = branch ? `?ref=${encodeURIComponent(branch)}` : '';
  return buildGitHubApiUrl(runtime, `/repos/${repo}/contents/${encodeURIComponent(path)}${ref}`);
}

function buildDirectoryEntryPath(parentPath: string, entryName: string): string {
  return `${parentPath ? parentPath.replace(/\/$/, '') : ''}/${entryName}`.replace(/^\/+/, '/');
}

export function normalizeGitHubRepoName(repo: string): string {
  return repo
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .toLowerCase();
}

export async function fetchRepoBranchesData(
  runtime: GitHubReadonlyRuntime,
  repo: string,
  maxBranches: number = 500,
): Promise<GitHubReadonlyBranchListCardData> {
  const headers = runtime.buildHeaders(DEFAULT_ACCEPT);

  const repoRes = await runtime.githubFetch(buildGitHubApiUrl(runtime, `/repos/${repo}`), { headers });
  if (!repoRes.ok) {
    throw new Error(formatGitHubError(repoRes.status, `repo info for ${repo}`));
  }
  const repoData = await repoRes.json() as { default_branch?: string };
  const defaultBranch = repoData.default_branch || 'main';

  const pageSize = 100;
  const maxPages = Math.max(1, Math.ceil(maxBranches / pageSize));
  const all: RepoBranchApi[] = [];
  let pageCount = 0;
  let nextUrl: string | null = buildGitHubApiUrl(runtime, `/repos/${repo}/branches?per_page=${pageSize}&page=1`);

  while (nextUrl && pageCount < maxPages && all.length < maxBranches) {
    const res = await runtime.githubFetch(nextUrl, { headers });
    if (!res.ok) {
      throw new Error(formatGitHubError(res.status, `branches on ${repo}`));
    }
    const pageData = await res.json();
    if (!Array.isArray(pageData)) break;
    all.push(...(pageData as RepoBranchApi[]));
    nextUrl = parseNextLink(res.headers.get('Link'));
    pageCount += 1;
  }

  const branches: GitHubReadonlyBranch[] = all
    .filter((branch) => typeof branch.name === 'string' && branch.name.trim().length > 0)
    .map((branch) => ({
      name: branch.name as string,
      isDefault: branch.name === defaultBranch,
      isProtected: Boolean(branch.protected),
    }))
    .sort((a, b) => {
      if (a.name === defaultBranch) return -1;
      if (b.name === defaultBranch) return 1;
      return a.name.localeCompare(b.name);
    });

  return { repo, defaultBranch, branches };
}

export async function executeListBranchesTool(
  runtime: GitHubReadonlyRuntime,
  repo: string,
  maxBranches: number = 30,
): Promise<GitHubReadonlyToolResult> {
  const cardData = await fetchRepoBranchesData(runtime, repo, maxBranches);
  const { defaultBranch, branches } = cardData;

  if (branches.length === 0) {
    return { text: `[Tool Result — list_branches]\nNo branches found on ${repo}.` };
  }

  const lines: string[] = [
    `[Tool Result — list_branches]`,
    `${branches.length} branch${branches.length > 1 ? 'es' : ''} on ${repo} (default: ${defaultBranch}):\n`,
  ];

  for (const branch of branches) {
    const marker = branch.isDefault ? ' ★' : '';
    const protectedMark = branch.isProtected ? ' 🔒' : '';
    lines.push(`  ${branch.name}${marker}${protectedMark}`);
  }

  return {
    text: lines.join('\n'),
    card: { type: 'branch-list', data: cardData },
  };
}

export async function executeFetchPRTool(
  runtime: GitHubReadonlyRuntime,
  repo: string,
  pr: number,
): Promise<GitHubReadonlyToolResult> {
  const headers = runtime.buildHeaders(DEFAULT_ACCEPT);

  const prRes = await runtime.githubFetch(buildGitHubApiUrl(runtime, `/repos/${repo}/pulls/${pr}`), { headers });
  if (!prRes.ok) {
    throw new Error(formatGitHubError(prRes.status, `PR #${pr} on ${repo}`));
  }
  const prData = await prRes.json() as {
    merged?: boolean;
    state: 'open' | 'closed';
    title: string;
    body?: string;
    additions: number;
    deletions: number;
    changed_files: number;
    created_at: string;
    user: { login: string };
    head: { ref: string };
    base: { ref: string };
  };

  const linkedIssues: Array<{ number: number; title?: string }> = [];
  if (prData.body) {
    const issuePattern = /(?:fixes|closes|resolves|#)\s*#(\d+)/gi;
    const matches = [...prData.body.matchAll(issuePattern)];
    for (const match of matches.slice(0, 3)) {
      linkedIssues.push({ number: parseInt(match[1], 10) });
    }
  }

  for (const issue of linkedIssues) {
    try {
      const issueRes = await runtime.githubFetch(buildGitHubApiUrl(runtime, `/repos/${repo}/issues/${issue.number}`), { headers });
      if (issueRes.ok) {
        const issueData = await issueRes.json() as { title?: string };
        issue.title = issueData.title;
      }
    } catch {
      // Best-effort enrichment only.
    }
  }

  let branchCommits: Array<{ sha: string; message: string; author: string }> = [];
  try {
    const commitsRes = await runtime.githubFetch(buildGitHubApiUrl(runtime, `/repos/${repo}/pulls/${pr}/commits`), { headers });
    if (commitsRes.ok) {
      const commitsData = await commitsRes.json() as Array<{
        sha: string;
        commit?: { message?: string; author?: { name?: string } };
        author?: { login?: string };
      }>;
      branchCommits = commitsData.slice(0, 5).map((commit) => ({
        sha: (commit.sha || '').slice(0, 7),
        message: (commit.commit?.message || '').split('\n')[0].slice(0, 60),
        author: commit.commit?.author?.name || commit.author?.login || 'unknown',
      }));
    }
  } catch {
    // Best-effort enrichment only.
  }

  const diffRes = await runtime.githubFetch(buildGitHubApiUrl(runtime, `/repos/${repo}/pulls/${pr}`), {
    headers: runtime.buildHeaders(DIFF_ACCEPT),
  });
  let diff = '';
  if (diffRes.ok) {
    diff = await diffRes.text();
    if (diff.length > 10_000) {
      diff = `${diff.slice(0, 10_000)}\n\n[...diff truncated at 10K chars]`;
    }
  }

  const filesRes = await runtime.githubFetch(buildGitHubApiUrl(runtime, `/repos/${repo}/pulls/${pr}/files`), { headers });
  let filesData: GitHubReadonlyPRFile[] = [];
  let filesSummary = '';
  if (filesRes.ok) {
    const files = await filesRes.json() as GitHubReadonlyPRFile[];
    filesData = files.slice(0, 20).map((file) => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
    }));
    filesSummary = filesData
      .map((file) => `  ${file.status} ${file.filename} (+${file.additions} -${file.deletions})`)
      .join('\n');
    if (files.length > 20) {
      filesSummary += `\n  ...and ${files.length - 20} more files`;
    }
  }

  const prState: 'open' | 'closed' | 'merged' = prData.merged ? 'merged' : prData.state;
  const lines: string[] = [
    `[Tool Result — fetch_pr]`,
    `Title: ${prData.title}`,
    `Author: ${prData.user.login}`,
    `State: ${prState}`,
    `+${prData.additions} -${prData.deletions} across ${prData.changed_files} files`,
    `Created: ${new Date(prData.created_at).toLocaleDateString()}`,
    `Branch: ${prData.head.ref} → ${prData.base.ref}`,
  ];

  if (prData.body) {
    const description = prData.body.length > 500 ? `${prData.body.slice(0, 500)}...` : prData.body;
    lines.push(`\nDescription:\n${description}`);
  }

  if (linkedIssues.length > 0) {
    lines.push(
      `\nLinked Issues:\n${linkedIssues.map((issue) => issue.title ? `  #${issue.number}: ${issue.title}` : `  #${issue.number}`).join('\n')}`,
    );
  }

  if (branchCommits.length > 0) {
    lines.push(
      `\nRecent Commits:\n${branchCommits.map((commit) => `  ${commit.sha} — ${commit.message}${commit.message.length >= 60 ? '...' : ''} (${commit.author})`).join('\n')}`,
    );
  }

  if (filesSummary) {
    lines.push(`\nFiles:\n${filesSummary}`);
  }

  if (diff) {
    lines.push(`\n--- Diff ---\n${diff}`);
  }

  const card: GitHubReadonlyPRCardData = {
    number: pr,
    title: prData.title,
    author: prData.user.login,
    state: prState,
    additions: prData.additions,
    deletions: prData.deletions,
    changedFiles: prData.changed_files,
    branch: prData.head.ref,
    baseBranch: prData.base.ref,
    createdAt: prData.created_at,
    description: prData.body ? (prData.body.length > 300 ? `${prData.body.slice(0, 300)}...` : prData.body) : undefined,
    files: filesData.length > 0 ? filesData : undefined,
  };

  return { text: lines.join('\n'), card: { type: 'pr', data: card } };
}

export async function executeListPRsTool(
  runtime: GitHubReadonlyRuntime,
  repo: string,
  state: string = 'open',
): Promise<GitHubReadonlyToolResult> {
  const headers = runtime.buildHeaders(DEFAULT_ACCEPT);
  const res = await runtime.githubFetch(
    buildGitHubApiUrl(
      runtime,
      `/repos/${repo}/pulls?state=${encodeURIComponent(state)}&per_page=20&sort=updated&direction=desc`,
    ),
    { headers },
  );

  if (!res.ok) {
    throw new Error(formatGitHubError(res.status, `PRs on ${repo}`));
  }

  const prs = await res.json() as PullRequestListApi[];
  if (prs.length === 0) {
    return { text: `[Tool Result — list_prs]\nNo ${state} PRs found on ${repo}.` };
  }

  const lines: string[] = [
    `[Tool Result — list_prs]`,
    `${prs.length} ${state} PR${prs.length > 1 ? 's' : ''} on ${repo}:\n`,
  ];

  const prItems: GitHubReadonlyPRListItem[] = [];
  for (const prItem of prs) {
    const age = new Date(prItem.created_at).toLocaleDateString();
    lines.push(`  #${prItem.number} — ${prItem.title}`);
    lines.push(`    by ${prItem.user.login} | +${prItem.additions || '?'} -${prItem.deletions || '?'} | ${age}`);
    prItems.push({
      number: prItem.number,
      title: prItem.title,
      author: prItem.user.login,
      additions: prItem.additions,
      deletions: prItem.deletions,
      createdAt: prItem.created_at,
    });
  }

  return {
    text: lines.join('\n'),
    card: { type: 'pr-list', data: { repo, state, prs: prItems } },
  };
}

export async function executeListCommitsTool(
  runtime: GitHubReadonlyRuntime,
  repo: string,
  count: number = 10,
): Promise<GitHubReadonlyToolResult> {
  const headers = runtime.buildHeaders(DEFAULT_ACCEPT);
  const res = await runtime.githubFetch(
    buildGitHubApiUrl(runtime, `/repos/${repo}/commits?per_page=${Math.min(count, 30)}`),
    { headers },
  );

  if (!res.ok) {
    throw new Error(formatGitHubError(res.status, `commits on ${repo}`));
  }

  const commits = await res.json() as CommitListApi[];
  if (commits.length === 0) {
    return { text: `[Tool Result — list_commits]\nNo commits found on ${repo}.` };
  }

  const lines: string[] = [
    `[Tool Result — list_commits]`,
    `${commits.length} recent commit${commits.length > 1 ? 's' : ''} on ${repo}:\n`,
  ];

  const commitItems: GitHubReadonlyCommitListItem[] = [];
  for (const commit of commits) {
    const shortSha = commit.sha.slice(0, 7);
    const message = commit.commit.message.split('\n')[0];
    const author = commit.commit.author?.name || commit.author?.login || 'unknown';
    const date = commit.commit.author?.date || '';
    lines.push(`  ${shortSha} ${message}`);
    lines.push(`    by ${author} | ${new Date(date).toLocaleDateString()}`);
    commitItems.push({ sha: commit.sha, message, author, date });
  }

  return {
    text: lines.join('\n'),
    card: { type: 'commit-list', data: { repo, commits: commitItems } },
  };
}

export async function executeReadFileTool(
  runtime: GitHubReadonlyRuntime,
  repo: string,
  path: string,
  branch?: string,
  startLine?: number,
  endLine?: number,
): Promise<GitHubReadonlyToolResult> {
  if (runtime.isSensitivePath(path)) {
    return { text: runtime.formatSensitivePathToolError(path) };
  }

  const headers = runtime.buildHeaders(DEFAULT_ACCEPT);
  const res = await runtime.githubFetch(buildContentsApiUrl(runtime, repo, path, branch), { headers });
  if (!res.ok) {
    throw new Error(formatGitHubError(res.status, `${path} on ${repo}`, branch));
  }

  const data = await res.json() as RepoFileContentApi | RepoContentEntryApi[];
  if (Array.isArray(data)) {
    const entries = data
      .map((entry) => `  ${entry.type === 'dir' ? 'DIR' : 'FILE'} ${entry.name || 'unknown'}`)
      .join('\n');
    return {
      text: `[Tool Error] "${path}" is a directory, not a file. Use list_directory to browse directories, then read_file on a specific file.\n\nDirectory contents:\n${entries}`,
    };
  }

  if (data.type !== 'file' || !data.content) {
    throw new Error(`${path} is not a readable file`);
  }

  const fullContent = runtime.decodeBase64(data.content.replace(/\n/g, ''));
  const language = guessLanguageFromPath(path);
  const isRangeRead = startLine !== undefined || endLine !== undefined;

  if (isRangeRead) {
    const allLines = fullContent.split('\n');
    const totalLines = allLines.length;
    const rangeStart = startLine ?? 1;
    const rangeEnd = endLine ?? totalLines;
    const sliced = allLines.slice(rangeStart - 1, rangeEnd);

    if (sliced.length === 0) {
      return {
        text: [
          `[Tool Result — read_file]`,
          `File: ${path} on ${repo}${branch ? ` (branch: ${branch})` : ''} (${totalLines} lines total)`,
          `No content in requested range (lines ${rangeStart}-${rangeEnd}). The file has ${totalLines} lines.`,
        ].join('\n'),
      };
    }

    const safeRange = runtime.redactSensitiveText(sliced.join('\n'));
    const safeRangeLines = safeRange.text.split('\n');
    const maxLineNum = rangeStart + sliced.length - 1;
    const padWidth = String(maxLineNum).length;
    const numberedContent = safeRangeLines
      .map((line, index) => `${String(rangeStart + index).padStart(padWidth)}\t${line}`)
      .join('\n');
    const rangeDisplayLines = numberedContent.split('\n');
    const truncatedRange = truncateDisplayLines(safeRangeLines, rangeDisplayLines, rangeStart, READ_FILE_RANGE_CHAR_LIMIT);
    const truncated = truncatedRange.truncated;
    let displayContent = truncatedRange.displayLines.join('\n');
    if (truncated) {
      displayContent += `\n\n[...truncated — showing ${truncatedRange.displayLines.length} of ${sliced.length} lines in range]`;
    }
    const truncationLines = buildReadTruncationLines(
      truncatedRange.truncatedAtLine,
      truncatedRange.remainingBytes,
    );

    const lines: string[] = [
      `[Tool Result — read_file]`,
      `Lines ${rangeStart}-${Math.min(rangeEnd, totalLines)} of ${path} on ${repo}${branch ? ` (branch: ${branch})` : ''} (${totalLines} lines total)`,
      `Language: ${language}`,
      safeRange.redacted ? 'Redactions: secret-like values hidden.' : '',
      truncated ? '(truncated)\n' : '',
      ...truncationLines,
      displayContent,
    ].filter(Boolean);

    return {
      text: lines.join('\n'),
      card: {
        type: 'editor',
        data: {
          path,
          content: truncated ? displayContent : safeRangeLines.join('\n'),
          language,
          truncated,
          source: 'github',
          repo,
        },
      },
    };
  }

  const safeFull = runtime.redactSensitiveText(fullContent);
  let content = safeFull.text;
  const fullSourceLines = safeFull.text.split('\n');
  const truncatedFull = truncateDisplayLines(fullSourceLines, fullSourceLines, 1, READ_FILE_FULL_CHAR_LIMIT);
  const truncated = truncatedFull.truncated;
  if (truncated) {
    const totalLines = fullSourceLines.length;
    content = truncatedFull.displayLines.join('\n')
      + `\n\n[...truncated at ${READ_FILE_FULL_CHAR_LIMIT / 1000}K chars — file has ${totalLines} lines. Use read_file with start_line/end_line to continue from line ${truncatedFull.truncatedAtLine}, search_files to find content, or grep_file for pattern matching.]`;
  }
  const fullTruncationLines = buildReadTruncationLines(
    truncatedFull.truncatedAtLine,
    truncatedFull.remainingBytes,
  );

  const lines: string[] = [
    `[Tool Result — read_file]`,
    `File: ${path} on ${repo}${branch ? ` (branch: ${branch})` : ''}`,
    `Size: ${data.size ?? 0} bytes | Language: ${language}`,
    safeFull.redacted ? 'Redactions: secret-like values hidden.' : '',
    truncated ? '(truncated to 15K chars)\n' : '',
    ...fullTruncationLines,
    `\`\`\`${language}`,
    content,
    '```',
  ];

  return {
    text: lines.join('\n'),
    card: {
      type: 'editor',
      data: { path, content, language, truncated, source: 'github', repo },
    },
  };
}

export async function executeGrepFileTool(
  runtime: GitHubReadonlyRuntime,
  repo: string,
  path: string,
  pattern: string,
  branch?: string,
): Promise<GitHubReadonlyToolResult> {
  if (runtime.isSensitivePath(path)) {
    return { text: runtime.formatSensitivePathToolError(path) };
  }

  const headers = runtime.buildHeaders(DEFAULT_ACCEPT);
  const res = await runtime.githubFetch(buildContentsApiUrl(runtime, repo, path, branch), { headers });
  if (!res.ok) {
    throw new Error(formatGitHubError(res.status, `${path} on ${repo}`, branch));
  }

  const data = await res.json() as RepoFileContentApi | RepoContentEntryApi[];
  if (Array.isArray(data)) {
    return {
      text: `[Tool Error] "${path}" is a directory. grep_file only works on individual files. Use search_files to search across a directory.`,
    };
  }

  if (data.type !== 'file' || !data.content) {
    throw new Error(`${path} is not a readable file`);
  }

  const fullContent = runtime.decodeBase64(data.content.replace(/\n/g, ''));
  const safeContent = runtime.redactSensitiveText(fullContent);
  const allLines = safeContent.text.split('\n');

  let matcher: (line: string) => boolean;
  try {
    const regex = new RegExp(pattern, 'i');
    matcher = (line: string) => regex.test(line);
  } catch {
    const lowerPattern = pattern.toLowerCase();
    matcher = (line: string) => line.toLowerCase().includes(lowerPattern);
  }

  const matchLineNums = new Set<number>();
  for (let i = 0; i < allLines.length; i += 1) {
    if (matcher(allLines[i])) {
      matchLineNums.add(i);
    }
  }

  if (matchLineNums.size === 0) {
    return {
      text: [
        `[Tool Result — grep_file]`,
        `No matches for "${pattern}" in ${path} (${allLines.length} lines scanned).`,
      ].join('\n'),
    };
  }

  const contextLineNums = new Set<number>();
  for (const lineNum of matchLineNums) {
    if (lineNum > 0) contextLineNums.add(lineNum - 1);
    contextLineNums.add(lineNum);
    if (lineNum < allLines.length - 1) contextLineNums.add(lineNum + 1);
  }
  const sortedNums = [...contextLineNums].sort((a, b) => a - b);

  const padWidth = String(sortedNums[sortedNums.length - 1] + 1).length;
  const outputLines: string[] = [];
  const MAX_OUTPUT_MATCHES = 100;
  let matchesShown = 0;
  let prevNum = -2;
  for (const num of sortedNums) {
    if (matchLineNums.has(num)) matchesShown += 1;
    if (matchesShown > MAX_OUTPUT_MATCHES && !matchLineNums.has(num)) continue;
    if (matchesShown > MAX_OUTPUT_MATCHES) {
      outputLines.push(`\n[...truncated — showing first ${MAX_OUTPUT_MATCHES} of ${matchLineNums.size} matches]`);
      break;
    }
    if (num > prevNum + 1 && outputLines.length > 0) {
      outputLines.push('  ---');
    }
    const lineNum1 = num + 1;
    const marker = matchLineNums.has(num) ? '>' : ' ';
    outputLines.push(`${marker}${String(lineNum1).padStart(padWidth)}\t${allLines[num]}`);
    prevNum = num;
  }

  const lines: string[] = [
    `[Tool Result — grep_file]`,
    `${matchLineNums.size} match${matchLineNums.size !== 1 ? 'es' : ''} for "${pattern}" in ${path}${branch ? ` (branch: ${branch})` : ''} (${allLines.length} lines total)`,
    safeContent.redacted ? 'Redactions: secret-like values hidden.' : '',
    '',
    ...outputLines,
  ];

  const matchItems: GitHubReadonlyFileSearchMatch[] = [];
  for (const num of matchLineNums) {
    if (matchItems.length >= 50) break;
    matchItems.push({ path, line: num + 1, content: allLines[num].trim().slice(0, 200) });
  }

  return {
    text: lines.join('\n'),
    card: {
      type: 'file-search',
      data: {
        repo,
        query: pattern,
        path,
        matches: matchItems,
        totalCount: matchLineNums.size,
        truncated: matchLineNums.size > MAX_OUTPUT_MATCHES,
      },
    },
  };
}

export async function executeListDirectoryTool(
  runtime: GitHubReadonlyRuntime,
  repo: string,
  path: string = '',
  branch?: string,
): Promise<GitHubReadonlyToolResult> {
  if (path && runtime.isSensitivePath(path)) {
    return { text: runtime.formatSensitivePathToolError(path) };
  }

  const headers = runtime.buildHeaders(DEFAULT_ACCEPT);
  const apiPath = path ? encodeURIComponent(path) : '';
  const ref = branch ? `?ref=${encodeURIComponent(branch)}` : '';
  const res = await runtime.githubFetch(
    buildGitHubApiUrl(runtime, `/repos/${repo}/contents/${apiPath}${ref}`),
    { headers },
  );

  if (!res.ok) {
    throw new Error(formatGitHubError(res.status, `path "${path || '/'}" on ${repo}`, branch));
  }

  const data = await res.json() as RepoContentEntryApi[] | RepoFileContentApi;
  if (!Array.isArray(data)) {
    return { text: `[Tool Error] "${path}" is a file, not a directory. Use read_file to read its contents.` };
  }

  const normalizedEntries = data.map((entry) => ({
    name: entry.name || '',
    type: entry.type === 'dir' ? 'directory' as const : 'file' as const,
    size: entry.size,
    path: buildDirectoryEntryPath(path, entry.name || ''),
  }));
  const visibleEntries: GitHubReadonlyFileListEntry[] = [];
  let hiddenCount = 0;
  for (const entry of normalizedEntries) {
    if (runtime.isSensitivePath(entry.path)) {
      hiddenCount += 1;
      continue;
    }
    visibleEntries.push({ name: entry.name, type: entry.type, size: entry.size });
  }

  const dirs = visibleEntries.filter((entry) => entry.type === 'directory');
  const files = visibleEntries.filter((entry) => entry.type === 'file');
  const lines: string[] = [
    `[Tool Result — list_directory]`,
    `Directory: ${path || '/'} on ${repo}${branch ? ` (branch: ${branch})` : ''}`,
    `${dirs.length} directories, ${files.length} files\n`,
    hiddenCount > 0 ? `(${hiddenCount} sensitive entr${hiddenCount === 1 ? 'y' : 'ies'} hidden)\n` : '',
  ];

  for (const dir of dirs) {
    lines.push(`  DIR ${dir.name}/`);
  }
  for (const file of files) {
    const size = file.size ? ` (${file.size} bytes)` : '';
    lines.push(`  FILE ${file.name}${size}`);
  }

  return {
    text: lines.join('\n'),
    card: {
      type: 'file-list',
      data: {
        repo,
        path: path || '/',
        entries: [...dirs, ...files],
      },
    },
  };
}

async function fetchCIStatusSummary(
  runtime: GitHubReadonlyRuntime,
  repo: string,
  ref?: string,
): Promise<{ overall: GitHubReadonlyCIOverallStatus; checks: GitHubReadonlyCICheck[]; ref: string }> {
  const headers = runtime.buildHeaders(DEFAULT_ACCEPT);
  const commitRef = ref || 'HEAD';

  const checkRunsRes = await runtime.githubFetch(
    buildGitHubApiUrl(runtime, `/repos/${repo}/commits/${commitRef}/check-runs?per_page=50`),
    { headers },
  );

  let checks: GitHubReadonlyCICheck[] = [];
  let overall: GitHubReadonlyCIOverallStatus = 'no-checks';

  if (checkRunsRes.ok) {
    const data = await checkRunsRes.json() as {
      check_runs?: Array<{
        name?: string;
        status?: string;
        conclusion?: string | null;
        html_url?: string;
        details_url?: string;
      }>;
    };
    if (data.check_runs && data.check_runs.length > 0) {
      checks = data.check_runs.map((checkRun) => ({
        name: checkRun.name || 'unknown-check',
        status: (checkRun.status || 'completed') as GitHubReadonlyCICheck['status'],
        conclusion: (checkRun.conclusion ?? null) as GitHubReadonlyCICheck['conclusion'],
        detailsUrl: checkRun.html_url || checkRun.details_url,
      }));
    }
  }

  if (checks.length === 0) {
    const statusRes = await runtime.githubFetch(
      buildGitHubApiUrl(runtime, `/repos/${repo}/commits/${commitRef}/status`),
      { headers },
    );
    if (statusRes.ok) {
      const statusData = await statusRes.json() as {
        statuses?: Array<{ context?: string; state?: string; target_url?: string }>;
      };
      if (statusData.statuses && statusData.statuses.length > 0) {
        checks = statusData.statuses.map((statusItem) => ({
          name: statusItem.context || 'unknown-check',
          status: 'completed' as const,
          conclusion: statusItem.state === 'success'
            ? 'success'
            : statusItem.state === 'failure' || statusItem.state === 'error'
              ? 'failure'
              : statusItem.state === 'pending'
                ? null
                : 'neutral',
          detailsUrl: statusItem.target_url,
        }));
        for (const check of checks) {
          if (check.conclusion === null) {
            check.status = 'in_progress';
          }
        }
      }
    }
  }

  if (checks.length === 0) {
    overall = 'no-checks';
  } else if (checks.some((check) => check.status !== 'completed')) {
    overall = 'pending';
  } else if (checks.every((check) => check.conclusion === 'success' || check.conclusion === 'skipped' || check.conclusion === 'neutral')) {
    overall = 'success';
  } else if (checks.some((check) => check.conclusion === 'failure')) {
    overall = 'failure';
  } else {
    overall = 'neutral';
  }

  return { overall, checks, ref: commitRef };
}

export async function executeFetchChecksTool(
  runtime: GitHubReadonlyRuntime,
  repo: string,
  ref?: string,
): Promise<GitHubReadonlyToolResult> {
  const { overall, checks, ref: commitRef } = await fetchCIStatusSummary(runtime, repo, ref);
  const cardData: GitHubReadonlyCIStatusCardData = {
    type: 'ci-status',
    repo,
    ref: commitRef,
    checks,
    overall,
    fetchedAt: new Date().toISOString(),
  };

  const lines: string[] = [
    `[Tool Result — fetch_checks]`,
    `CI Status for ${repo}@${commitRef}: ${overall.toUpperCase()}`,
  ];

  if (checks.length === 0) {
    lines.push('No CI checks configured for this repo.');
  } else {
    for (const check of checks) {
      const icon = check.conclusion === 'success'
        ? '✓'
        : check.conclusion === 'failure'
          ? '✗'
          : check.status !== 'completed'
            ? '⏳'
            : '—';
      lines.push(`  ${icon} ${check.name}: ${check.conclusion || check.status}`);
    }
  }

  return { text: lines.join('\n'), card: { type: 'ci-status', data: cardData } };
}

export async function executeListCommitFilesTool(
  runtime: GitHubReadonlyRuntime,
  repo: string,
  ref: string,
): Promise<GitHubReadonlyToolResult> {
  const headers = runtime.buildHeaders(DEFAULT_ACCEPT);
  const res = await runtime.githubFetch(
    buildGitHubApiUrl(runtime, `/repos/${repo}/commits/${encodeURIComponent(ref)}`),
    { headers },
  );

  if (!res.ok) {
    throw new Error(formatGitHubError(res.status, `commit ${ref} on ${repo}`));
  }

  const commit = await res.json() as CommitDetailsApi;
  const files = commit.files || [];
  const lines: string[] = [
    `[Tool Result — list_commit_files]`,
    `Commit: ${commit.sha.slice(0, 7)} — ${commit.commit.message.split('\n')[0]}`,
    `Author: ${commit.commit.author?.name || commit.author?.login || 'unknown'}`,
    `Date: ${new Date(commit.commit.author?.date || '').toLocaleDateString()}`,
    `\n${files.length} file${files.length !== 1 ? 's' : ''} changed:\n`,
  ];

  let totalAdditions = 0;
  let totalDeletions = 0;
  for (const file of files) {
    totalAdditions += file.additions || 0;
    totalDeletions += file.deletions || 0;
  }

  const fileItems: GitHubReadonlyCommitFileItem[] = [];
  for (const file of files.slice(0, 50)) {
    const icon = file.status === 'added' ? '+' : file.status === 'removed' ? '-' : '~';
    lines.push(`  ${icon} ${file.filename} (+${file.additions || 0} -${file.deletions || 0})`);
    fileItems.push({
      filename: file.filename,
      status: file.status,
      additions: file.additions || 0,
      deletions: file.deletions || 0,
    });
  }

  if (files.length > 50) {
    lines.push(`  ...and ${files.length - 50} more files`);
  }

  lines.push(`\nTotal: +${totalAdditions} -${totalDeletions}`);

  const cardData: GitHubReadonlyCommitFilesCardData = {
    repo,
    ref,
    sha: commit.sha,
    message: commit.commit.message.split('\n')[0],
    author: commit.commit.author?.name || commit.author?.login || 'unknown',
    date: commit.commit.author?.date || '',
    files: fileItems,
    totalChanges: { additions: totalAdditions, deletions: totalDeletions },
  };

  return {
    text: lines.join('\n'),
    card: { type: 'commit-files', data: cardData },
  };
}

export async function executeSearchFilesTool(
  runtime: GitHubReadonlyRuntime,
  repo: string,
  query: string,
  path?: string,
  branch?: string,
): Promise<GitHubReadonlyToolResult> {
  if (path && runtime.isSensitivePath(path)) {
    return { text: runtime.formatSensitivePathToolError(path) };
  }

  const headers = runtime.buildHeaders(SEARCH_ACCEPT);
  let searchQuery = `${query} repo:${repo}`;
  if (path) searchQuery += ` path:${path}`;

  let searchUrl = buildGitHubApiUrl(runtime, `/search/code?q=${encodeURIComponent(searchQuery)}&per_page=25`);
  if (branch) searchUrl += `&ref=${encodeURIComponent(branch)}`;

  const res = await runtime.githubFetch(searchUrl, { headers });
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error('GitHub token is invalid or expired — re-authenticate in Settings.');
    }
    if (res.status === 403) {
      let detail = '';
      try {
        const errBody = await res.json() as { message?: string };
        detail = errBody.message || '';
      } catch {
        // ignore parse errors
      }

      if (detail.toLowerCase().includes('rate limit')) {
        throw new Error(`GitHub API rate limit exceeded for code search. Wait a moment and retry.\n${detail}`);
      }
      if (!headers.Authorization) {
        throw new Error('Code search requires authentication — connect your GitHub account in Settings or set a Personal Access Token.');
      }
      throw new Error(`Code search forbidden (403) — your token may lack the required scope. GitHub says: ${detail || 'no details provided'}`);
    }
    if (res.status === 422) {
      throw new Error('Invalid search query. Try a simpler pattern.');
    }
    throw new Error(`GitHub code search returned ${res.status}`);
  }

  const data = await res.json() as {
    total_count?: number;
    items?: Array<{
      path?: string;
      text_matches?: Array<{ fragment?: string }>;
    }>;
  };
  const totalCount = data.total_count || 0;

  if (totalCount === 0) {
    const hints: string[] = [];
    if (path) {
      hints.push(`Path is scoped to "${path}". Try without a path filter to search the full repo.`);
    }
    if (branch) {
      hints.push(`GitHub code search primarily indexes the default branch. Results for branch "${branch}" may be incomplete.`);
    }
    if (hints.length === 0) {
      hints.push('Try a shorter or more generic search term — partial words work well.');
    }
    hints.push('Use list_directory to browse the repo structure and find where key files live.');

    return {
      text: [
        `[Tool Result — search_files]`,
        `No files found matching "${query}"${path ? ` in ${path}` : ''}.`,
        '',
        'Suggestions:',
        ...hints.map((hint) => `- ${hint}`),
      ].join('\n'),
    };
  }

  const matches: GitHubReadonlyFileSearchMatch[] = [];
  const truncated = totalCount > 25;
  let hiddenResults = 0;
  let redactedResults = false;
  const fileContexts = new Map<string, string[]>();

  for (const item of data.items || []) {
    if (typeof item.path === 'string' && runtime.isSensitivePath(item.path)) {
      hiddenResults += 1;
      continue;
    }

    const textMatches = item.text_matches || [];
    if (textMatches.length > 0) {
      const fragments: string[] = [];
      for (const textMatch of textMatches) {
        const fragment = typeof textMatch.fragment === 'string' ? textMatch.fragment : '';
        const safeFragment = runtime.redactSensitiveText(fragment);
        redactedResults ||= safeFragment.redacted;
        const fragmentLines = safeFragment.text.split('\n');
        if (safeFragment.text.trim()) {
          fragments.push(safeFragment.text.trim());
        }
        for (let i = 0; i < fragmentLines.length && matches.length < 80; i += 1) {
          if (fragmentLines[i].toLowerCase().includes(query.toLowerCase()) && item.path) {
            matches.push({
              path: item.path,
              line: 0,
              content: fragmentLines[i].trim().slice(0, 300),
            });
          }
        }
      }
      if (item.path && fragments.length > 0) {
        fileContexts.set(item.path, fragments);
      }
    } else if (item.path) {
      matches.push({
        path: item.path,
        line: 0,
        content: '(match in file)',
      });
    }
  }

  const lines: string[] = [
    `[Tool Result — search_files]`,
    `Found ${totalCount} file${totalCount !== 1 ? 's' : ''} matching "${query}"${path ? ` in ${path}` : ''}`,
    truncated ? `(showing first 25 results)\n` : '\n',
    hiddenResults > 0 ? `(${hiddenResults} sensitive result${hiddenResults === 1 ? '' : 's'} hidden)\n` : '',
    redactedResults ? 'Redactions: secret-like values hidden.\n' : '',
  ];

  const byFile = new Map<string, GitHubReadonlyFileSearchMatch[]>();
  for (const match of matches) {
    if (!byFile.has(match.path)) byFile.set(match.path, []);
    byFile.get(match.path)?.push(match);
  }

  for (const [filePath, fileMatches] of byFile) {
    lines.push(`FILE ${filePath}`);
    const contexts = fileContexts.get(filePath);
    if (contexts && contexts.length > 0) {
      for (const context of contexts.slice(0, 2)) {
        const contextLines = context.split('\n').slice(0, 5);
        for (const line of contextLines) {
          lines.push(`    ${line.slice(0, 200)}`);
        }
        if (context.split('\n').length > 5) {
          lines.push('    ...');
        }
      }
    } else {
      for (const match of fileMatches.slice(0, 5)) {
        if (match.content && match.content !== '(match in file)') {
          lines.push(`    ${match.content}`);
        }
      }
    }
    if (fileMatches.length > 5) {
      lines.push(`    ...and ${fileMatches.length - 5} more matches`);
    }
  }

  if (byFile.size === 0 && hiddenResults > 0) {
    return {
      text: [
        `[Tool Result — search_files]`,
        `Matches for "${query}" were found only in protected secret files and were hidden.`,
      ].join('\n'),
    };
  }

  if (byFile.size > 0) {
    lines.push('');
    lines.push('Tip: Use grep_file(repo, path, pattern) to search within a specific file with line numbers and context.');
  }

  const cardData: GitHubReadonlyFileSearchCardData = {
    repo,
    query,
    path,
    matches: matches.slice(0, 50),
    totalCount,
    truncated,
  };

  return { text: lines.join('\n'), card: { type: 'file-search', data: cardData } };
}

export async function executeGitHubReadonlyTool(
  runtime: GitHubReadonlyRuntime,
  call: GitHubReadonlyToolCall,
): Promise<GitHubReadonlyToolResult> {
  switch (call.tool) {
    case 'fetch_pr':
      return executeFetchPRTool(runtime, call.args.repo, call.args.pr);
    case 'list_prs':
      return executeListPRsTool(runtime, call.args.repo, call.args.state);
    case 'list_commits':
      return executeListCommitsTool(runtime, call.args.repo, call.args.count);
    case 'read_file':
      return executeReadFileTool(runtime, call.args.repo, call.args.path, call.args.branch, call.args.start_line, call.args.end_line);
    case 'grep_file':
      return executeGrepFileTool(runtime, call.args.repo, call.args.path, call.args.pattern, call.args.branch);
    case 'list_directory':
      return executeListDirectoryTool(runtime, call.args.repo, call.args.path, call.args.branch);
    case 'list_branches':
      return executeListBranchesTool(runtime, call.args.repo, call.args.maxBranches ?? 30);
    case 'fetch_checks':
      return executeFetchChecksTool(runtime, call.args.repo, call.args.ref);
    case 'search_files':
      return executeSearchFilesTool(runtime, call.args.repo, call.args.query, call.args.path, call.args.branch);
    case 'list_commit_files':
      return executeListCommitFilesTool(runtime, call.args.repo, call.args.ref);
  }
}
