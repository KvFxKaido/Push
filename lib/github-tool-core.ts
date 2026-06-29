/**
 * Shared GitHub tool core.
 *
 * This module is runtime-agnostic: callers provide fetch/auth/sensitive-data
 * primitives, and the shared core handles GitHub API orchestration plus the
 * user-facing text/card shaping for the shared GitHub tool surface.
 */

// Pure, config-free envelope-marker defanging — imported directly rather than
// threaded through the runtime port (which carries surface-specific primitives
// like the secret redactor). `sanitizeUntrustedSource` = boundary-escape +
// JSON-tool-call defang; `escapeEnvelopeBoundaries` is the boundary-escape
// alone, used for file-content tools (see the chokepoint below).
import { escapeEnvelopeBoundaries, sanitizeUntrustedSource } from './untrusted-content.js';

// GitHub tools whose `result.text` is verbatim repository file content. The
// JSON-tool-call defang would corrupt legitimate file bodies (a config/schema
// file with a `"tool":` key, MCP manifests, etc.) the agent must reason over
// faithfully — `untrusted-content.ts` documents skipping the defang on file
// reads. They still get boundary escaping (a malicious file could embed a
// `[/TOOL_RESULT]` literal to break out — that defense applies everywhere).
const FILE_CONTENT_TOOLS: ReadonlySet<string> = new Set(['read_file', 'grep_file']);

export interface GitHubCoreBranch {
  name: string;
  isDefault: boolean;
  isProtected: boolean;
  pr?: GitHubCoreBranchPR;
  /**
   * True iff a PR lookup completed (with or without a match). Distinguishes
   * "no PR exists" from "lookup not run / failed" so callers don't render a
   * false `(no PR)` marker on transient API errors or skipped enrichment.
   */
  prLookupOk?: boolean;
}

export interface GitHubCoreBranchPR {
  number: number;
  state: 'open' | 'merged' | 'closed';
  title: string;
}

export interface GitHubCorePRFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface GitHubCorePRListItem {
  number: number;
  title: string;
  author: string;
  additions?: number;
  deletions?: number;
  createdAt: string;
}

export interface GitHubCorePRListCardData {
  repo: string;
  state: string;
  prs: GitHubCorePRListItem[];
}

export interface GitHubCoreCommitListItem {
  sha: string;
  message: string;
  author: string;
  date: string;
}

export interface GitHubCoreCommitListCardData {
  repo: string;
  commits: GitHubCoreCommitListItem[];
}

export interface GitHubCoreFileListEntry {
  name: string;
  type: 'file' | 'directory';
  size?: number;
}

export interface GitHubCoreFileListCardData {
  repo?: string;
  path: string;
  entries: GitHubCoreFileListEntry[];
}

export interface GitHubCoreEditorCardData {
  path: string;
  content: string;
  language: string;
  truncated: boolean;
  source: 'github';
  repo: string;
}

export interface GitHubCoreCommitFileItem {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface GitHubCoreCommitFilesCardData {
  repo: string;
  ref: string;
  sha: string;
  message: string;
  author: string;
  date: string;
  files: GitHubCoreCommitFileItem[];
  totalChanges: { additions: number; deletions: number };
}

export interface GitHubCoreWorkflowRunItem {
  id: number;
  name: string;
  status: 'queued' | 'in_progress' | 'completed' | 'waiting' | 'requested' | 'pending';
  conclusion:
    | 'success'
    | 'failure'
    | 'cancelled'
    | 'skipped'
    | 'timed_out'
    | 'action_required'
    | 'neutral'
    | null;
  branch: string;
  event: string;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
  runNumber: number;
  actor: string;
}

export interface GitHubCoreWorkflowRunsCardData {
  repo: string;
  runs: GitHubCoreWorkflowRunItem[];
  workflow?: string;
  truncated: boolean;
}

export interface GitHubCoreWorkflowJobStep {
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion:
    | 'success'
    | 'failure'
    | 'cancelled'
    | 'skipped'
    | 'timed_out'
    | 'action_required'
    | 'neutral'
    | null;
  number: number;
}

export interface GitHubCoreWorkflowJob {
  name: string;
  status: 'queued' | 'in_progress' | 'completed' | 'waiting';
  conclusion:
    | 'success'
    | 'failure'
    | 'cancelled'
    | 'skipped'
    | 'timed_out'
    | 'action_required'
    | 'neutral'
    | null;
  steps: GitHubCoreWorkflowJobStep[];
  htmlUrl: string;
}

export interface GitHubCoreWorkflowLogsCardData {
  runId: number;
  runName: string;
  runNumber: number;
  status: string;
  conclusion: string | null;
  jobs: GitHubCoreWorkflowJob[];
  htmlUrl: string;
  repo: string;
}

export interface GitHubCorePRReviewComment {
  author: string;
  path?: string;
  line?: number;
  body: string;
}

export interface GitHubCorePRIssueComment {
  author: string;
  body: string;
  createdAt: string;
}

export interface GitHubCorePRCardData {
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
  files?: GitHubCorePRFile[];
  reviewComments?: GitHubCorePRReviewComment[];
  issueComments?: GitHubCorePRIssueComment[];
}

export interface GitHubCoreBranchListCardData {
  repo: string;
  defaultBranch: string;
  branches: GitHubCoreBranch[];
}

export interface GitHubCoreFileSearchMatch {
  path: string;
  line: number;
  content: string;
}

export interface GitHubCoreFileSearchCardData {
  repo: string;
  query: string;
  path?: string;
  matches: GitHubCoreFileSearchMatch[];
  totalCount: number;
  truncated: boolean;
}

export interface GitHubCoreCICheck {
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion:
    | 'success'
    | 'failure'
    | 'neutral'
    | 'cancelled'
    | 'skipped'
    | 'timed_out'
    | 'action_required'
    | null;
  detailsUrl?: string;
}

export type GitHubCoreCIOverallStatus = 'pending' | 'success' | 'failure' | 'neutral' | 'no-checks';

export interface GitHubCoreCIStatusCardData {
  type: 'ci-status';
  overall: GitHubCoreCIOverallStatus;
  repo: string;
  ref: string;
  fetchedAt: string;
  checks: GitHubCoreCICheck[];
}

export type GitHubCoreCard =
  | { type: 'pr'; data: GitHubCorePRCardData }
  | { type: 'pr-list'; data: GitHubCorePRListCardData }
  | { type: 'commit-list'; data: GitHubCoreCommitListCardData }
  | { type: 'branch-list'; data: GitHubCoreBranchListCardData }
  | { type: 'file-list'; data: GitHubCoreFileListCardData }
  | { type: 'ci-status'; data: GitHubCoreCIStatusCardData }
  | { type: 'editor'; data: GitHubCoreEditorCardData }
  | { type: 'file-search'; data: GitHubCoreFileSearchCardData }
  | { type: 'commit-files'; data: GitHubCoreCommitFilesCardData }
  | { type: 'workflow-runs'; data: GitHubCoreWorkflowRunsCardData }
  | { type: 'workflow-logs'; data: GitHubCoreWorkflowLogsCardData };

export interface GitHubCoreToolResult {
  text: string;
  card?: GitHubCoreCard;
  branchSwitch?: {
    name: string;
    kind: 'forked' | 'switched' | 'merged';
    from?: string;
    previous?: string;
    sha?: string;
    prNumber?: number;
    source?: string;
  };
}

export type GitHubCoreToolCall =
  | { tool: 'fetch_pr'; args: { repo: string; pr: number } }
  | { tool: 'list_prs'; args: { repo: string; state?: string } }
  | { tool: 'list_commits'; args: { repo: string; count?: number } }
  | {
      tool: 'read_file';
      args: { repo: string; path: string; branch?: string; start_line?: number; end_line?: number };
    }
  | { tool: 'grep_file'; args: { repo: string; path: string; pattern: string; branch?: string } }
  | { tool: 'list_directory'; args: { repo: string; path?: string; branch?: string } }
  | { tool: 'list_branches'; args: { repo: string; maxBranches?: number } }
  | { tool: 'fetch_checks'; args: { repo: string; ref?: string } }
  | { tool: 'search_files'; args: { repo: string; query: string; path?: string; branch?: string } }
  | { tool: 'list_commit_files'; args: { repo: string; ref: string } }
  | {
      tool: 'trigger_workflow';
      args: { repo: string; workflow: string; ref?: string; inputs?: Record<string, string> };
    }
  | {
      tool: 'get_workflow_runs';
      args: { repo: string; workflow?: string; branch?: string; status?: string; count?: number };
    }
  | { tool: 'get_workflow_logs'; args: { repo: string; run_id: number } }
  | {
      tool: 'create_pr';
      args: { repo: string; title: string; body: string; head: string; base: string };
    }
  | { tool: 'merge_pr'; args: { repo: string; pr_number: number; merge_method?: string } }
  | { tool: 'delete_branch'; args: { repo: string; branch_name: string } }
  | { tool: 'check_pr_mergeable'; args: { repo: string; pr_number: number } }
  | { tool: 'find_existing_pr'; args: { repo: string; head_branch: string; base_branch?: string } }
  | {
      tool: 'get_job_logs';
      args: {
        repo: string;
        run_id?: number;
        job_id?: number;
        failed_only?: boolean;
        tail_lines?: number;
      };
    }
  | { tool: 'list_issues'; args: { repo: string; state?: string; labels?: string; count?: number } }
  | { tool: 'get_issue'; args: { repo: string; issue_number: number } }
  | { tool: 'add_issue_comment'; args: { repo: string; issue_number: number; body: string } }
  | {
      tool: 'create_issue';
      args: { repo: string; title: string; body?: string; labels?: string[] };
    }
  | {
      tool: 'update_issue';
      args: {
        repo: string;
        issue_number: number;
        title?: string;
        body?: string;
        state?: string;
        labels?: string[];
      };
    }
  | {
      tool: 'update_pull_request';
      args: {
        repo: string;
        pr_number: number;
        title?: string;
        body?: string;
        base?: string;
        state?: string;
      };
    }
  | { tool: 'rerun_failed_jobs'; args: { repo: string; run_id: number } }
  | { tool: 'cancel_workflow_run'; args: { repo: string; run_id: number } }
  | { tool: 'list_code_scanning_alerts'; args: { repo: string; state?: string; ref?: string } }
  | { tool: 'list_dependabot_alerts'; args: { repo: string; state?: string } }
  | { tool: 'list_secret_scanning_alerts'; args: { repo: string; state?: string } };

export interface GitHubCoreRuntime {
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

// Branch-accurate code search. GitHub's /search/code API only indexes a repo's
// DEFAULT branch and its index lags recent pushes, so a `ref`/branch qualifier
// is silently ignored — searching a freshly-pushed feature branch returns stale
// main-branch hits. When a caller pins a branch we instead scan that branch's
// live git tree (Trees API → blob fetch → grep), which is current and lets us
// report honestly whether the scan was exhaustive (so "zero references" can be
// trusted). Bounds keep the blob-fetch fan-out finite.
const BRANCH_SEARCH_MAX_FILES = 400;
const BRANCH_SEARCH_RESULT_CAP = 25;
const BRANCH_SEARCH_MAX_BLOB_BYTES = 512 * 1024;
const BRANCH_SEARCH_CONCURRENCY = 8;
const BRANCH_SEARCH_MAX_LINES_PER_FILE = 5;
const BRANCH_SEARCH_BINARY_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'bmp',
  'ico',
  'webp',
  'svg',
  'avif',
  'pdf',
  'zip',
  'gz',
  'tar',
  'tgz',
  'bz2',
  '7z',
  'rar',
  'xz',
  'mp3',
  'mp4',
  'mov',
  'avi',
  'wav',
  'ogg',
  'webm',
  'flac',
  'm4a',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'jar',
  'class',
  'wasm',
  'exe',
  'dll',
  'so',
  'dylib',
  'bin',
  'o',
  'a',
]);

interface RepoBranchApi {
  name?: string;
  protected?: boolean;
  commit?: { sha?: string };
}

interface CommitPullApi {
  number: number;
  state: 'open' | 'closed';
  title: string;
  merged_at: string | null;
  head?: { ref?: string };
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

interface GitTreeEntryApi {
  path?: string;
  type?: string;
  sha?: string;
  size?: number;
}

interface GitTreeApi {
  tree?: GitTreeEntryApi[];
  truncated?: boolean;
}

interface GitBlobApi {
  content?: string;
  encoding?: string;
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

interface WorkflowRunApi {
  id: number;
  name: string;
  status?: string;
  conclusion?: string | null;
  head_branch?: string;
  event: string;
  created_at: string;
  updated_at: string;
  html_url: string;
  run_number: number;
  actor?: { login?: string };
}

interface WorkflowRunDetailsApi {
  name: string;
  run_number: number;
  status: string;
  conclusion: string | null;
  head_branch?: string;
  event: string;
  html_url: string;
}

interface WorkflowStepApi {
  name: string;
  status: string;
  conclusion: string | null;
  number: number;
}

interface WorkflowJobApi {
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  steps?: WorkflowStepApi[];
}

interface PullRequestMergeabilityApi {
  title: string;
  state: string;
  mergeable: boolean | null;
  mergeable_state?: string | null;
  head?: { ref?: string; sha?: string };
  base?: { ref?: string };
}

interface WorkflowJobSummaryApi {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
}

type IssueLabelApi = string | { name?: string };

interface IssueListItemApi {
  number: number;
  title: string;
  state: string;
  user?: { login?: string };
  labels?: IssueLabelApi[];
  comments?: number;
  /** Present iff this "issue" is actually a pull request (the /issues list mixes both). */
  pull_request?: unknown;
  created_at: string;
  html_url: string;
}

interface IssueDetailApi extends IssueListItemApi {
  body?: string | null;
}

interface IssueCommentApi {
  user?: { login?: string };
  body?: string;
  created_at: string;
}

interface CodeScanningAlertApi {
  number: number;
  state: string;
  html_url: string;
  rule?: { id?: string; severity?: string; description?: string };
  tool?: { name?: string };
  most_recent_instance?: { ref?: string; location?: { path?: string; start_line?: number } };
}

interface DependabotAlertApi {
  number: number;
  state: string;
  html_url: string;
  dependency?: { package?: { name?: string }; manifest_path?: string };
  security_advisory?: { severity?: string; summary?: string };
  security_vulnerability?: { severity?: string };
}

interface SecretScanningAlertApi {
  number: number;
  state: string;
  html_url: string;
  secret_type_display_name?: string;
  secret_type?: string;
  resolution?: string | null;
  created_at: string;
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

function buildGitHubApiUrl(runtime: GitHubCoreRuntime, path: string): string {
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
  runtime: GitHubCoreRuntime,
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

function getRepoOwner(repo: string): string {
  return repo.split('/')[0] || '';
}

function normalizeWorkflowRunStatus(
  status: string | undefined,
): GitHubCoreWorkflowRunItem['status'] {
  return status === 'queued' ||
    status === 'in_progress' ||
    status === 'completed' ||
    status === 'waiting' ||
    status === 'requested' ||
    status === 'pending'
    ? status
    : 'completed';
}

function normalizeWorkflowConclusion(
  value: string | null | undefined,
): GitHubCoreWorkflowRunItem['conclusion'] {
  return value === null ||
    value === undefined ||
    value === 'success' ||
    value === 'failure' ||
    value === 'cancelled' ||
    value === 'skipped' ||
    value === 'timed_out' ||
    value === 'action_required' ||
    value === 'neutral'
    ? (value ?? null)
    : null;
}

function normalizeWorkflowJobStatus(status: string): GitHubCoreWorkflowJob['status'] {
  return status === 'queued' ||
    status === 'in_progress' ||
    status === 'completed' ||
    status === 'waiting'
    ? status
    : 'completed';
}

function normalizeWorkflowStepStatus(status: string): GitHubCoreWorkflowJobStep['status'] {
  return status === 'queued' || status === 'in_progress' || status === 'completed'
    ? status
    : 'completed';
}

async function fetchRepoDefaultBranch(runtime: GitHubCoreRuntime, repo: string): Promise<string> {
  const headers = runtime.buildHeaders(DEFAULT_ACCEPT);
  const repoRes = await runtime.githubFetch(buildGitHubApiUrl(runtime, `/repos/${repo}`), {
    headers,
  });
  if (!repoRes.ok) {
    throw new Error(formatGitHubError(repoRes.status, `repo info for ${repo}`));
  }
  const repoData = (await repoRes.json()) as { default_branch?: string };
  return repoData.default_branch || 'main';
}

export function normalizeGitHubRepoName(repo: string): string {
  return repo
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .toLowerCase();
}

export async function fetchRepoBranchesData(
  runtime: GitHubCoreRuntime,
  repo: string,
  maxBranches: number = 500,
): Promise<GitHubCoreBranchListCardData> {
  const headers = runtime.buildHeaders(DEFAULT_ACCEPT);
  const defaultBranch = await fetchRepoDefaultBranch(runtime, repo);

  const pageSize = 100;
  const maxPages = Math.max(1, Math.ceil(maxBranches / pageSize));
  const all: RepoBranchApi[] = [];
  let pageCount = 0;
  let nextUrl: string | null = buildGitHubApiUrl(
    runtime,
    `/repos/${repo}/branches?per_page=${pageSize}&page=1`,
  );

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

  const rawBranches = all.filter(
    (branch) => typeof branch.name === 'string' && branch.name.trim().length > 0,
  );

  const enrichmentInput = new Map<string, string>();
  if (rawBranches.length <= PR_ENRICHMENT_BRANCH_LIMIT) {
    for (const branch of rawBranches) {
      const name = branch.name as string;
      if (name === defaultBranch) continue;
      const sha = branch.commit?.sha;
      if (typeof sha === 'string' && sha.length > 0) enrichmentInput.set(name, sha);
    }
  }

  const enrichment = await enrichBranchesWithPRs(runtime, repo, enrichmentInput);

  const branches: GitHubCoreBranch[] = rawBranches
    .map((branch) => {
      const name = branch.name as string;
      const enriched: GitHubCoreBranch = {
        name,
        isDefault: name === defaultBranch,
        isProtected: Boolean(branch.protected),
      };
      const pr = enrichment.found.get(name);
      if (pr) enriched.pr = pr;
      if (enrichment.lookupOk.has(name)) enriched.prLookupOk = true;
      return enriched;
    })
    .sort((a, b) => {
      if (a.name === defaultBranch) return -1;
      if (b.name === defaultBranch) return 1;
      return a.name.localeCompare(b.name);
    });

  return { repo, defaultBranch, branches };
}

const PR_ENRICHMENT_BRANCH_LIMIT = 50;
const PR_ENRICHMENT_CONCURRENCY = 6;

interface BranchPREnrichment {
  found: Map<string, GitHubCoreBranchPR>;
  lookupOk: Set<string>;
}

async function enrichBranchesWithPRs(
  runtime: GitHubCoreRuntime,
  repo: string,
  branchToSha: Map<string, string>,
): Promise<BranchPREnrichment> {
  const found = new Map<string, GitHubCoreBranchPR>();
  const lookupOk = new Set<string>();
  if (branchToSha.size === 0) return { found, lookupOk };

  const headers = runtime.buildHeaders(DEFAULT_ACCEPT);

  // Dedupe by SHA: multiple branches at the same tip share one /pulls call.
  const shaToBranches = new Map<string, string[]>();
  for (const [branch, sha] of branchToSha.entries()) {
    const list = shaToBranches.get(sha);
    if (list) list.push(branch);
    else shaToBranches.set(sha, [branch]);
  }

  const shas = Array.from(shaToBranches.keys());
  for (let i = 0; i < shas.length; i += PR_ENRICHMENT_CONCURRENCY) {
    const chunk = shas.slice(i, i + PR_ENRICHMENT_CONCURRENCY);
    const results = await Promise.allSettled(
      chunk.map(async (sha) => {
        const res = await runtime.githubFetch(
          buildGitHubApiUrl(runtime, `/repos/${repo}/commits/${sha}/pulls?per_page=100`),
          { headers },
        );
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as CommitPullApi[];
        return Array.isArray(data) ? data : [];
      }),
    );

    chunk.forEach((sha, idx) => {
      const result = results[idx];
      const branchesForSha = shaToBranches.get(sha) || [];
      if (result.status !== 'fulfilled') return;
      for (const branchName of branchesForSha) {
        lookupOk.add(branchName);
        const matched = result.value.filter((pr) => pr.head?.ref === branchName);
        if (matched.length === 0) continue;
        const pr = matched.reduce<CommitPullApi | null>(
          (best, current) => (best === null || current.number > best.number ? current : best),
          null,
        );
        if (!pr) continue;
        const state: GitHubCoreBranchPR['state'] = pr.merged_at
          ? 'merged'
          : pr.state === 'open'
            ? 'open'
            : 'closed';
        found.set(branchName, { number: pr.number, state, title: pr.title });
      }
    });
  }

  return { found, lookupOk };
}

function formatBranchPRMark(branch: GitHubCoreBranch): string {
  if (branch.isDefault) return '';
  if (branch.pr) return ` (PR #${branch.pr.number} ${branch.pr.state})`;
  if (branch.prLookupOk) return ' (no PR)';
  return '';
}

export async function executeListBranchesTool(
  runtime: GitHubCoreRuntime,
  repo: string,
  maxBranches: number = 30,
): Promise<GitHubCoreToolResult> {
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
    const prMark = formatBranchPRMark(branch);
    lines.push(`  ${branch.name}${marker}${protectedMark}${prMark}`);
  }

  return {
    text: lines.join('\n'),
    card: { type: 'branch-list', data: cardData },
  };
}

export async function executeFetchPRTool(
  runtime: GitHubCoreRuntime,
  repo: string,
  pr: number,
): Promise<GitHubCoreToolResult> {
  const headers = runtime.buildHeaders(DEFAULT_ACCEPT);

  const prRes = await runtime.githubFetch(
    buildGitHubApiUrl(runtime, `/repos/${repo}/pulls/${pr}`),
    { headers },
  );
  if (!prRes.ok) {
    throw new Error(formatGitHubError(prRes.status, `PR #${pr} on ${repo}`));
  }
  const prData = (await prRes.json()) as {
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
      const issueRes = await runtime.githubFetch(
        buildGitHubApiUrl(runtime, `/repos/${repo}/issues/${issue.number}`),
        { headers },
      );
      if (issueRes.ok) {
        const issueData = (await issueRes.json()) as { title?: string };
        issue.title = issueData.title;
      }
    } catch {
      // Best-effort enrichment only.
    }
  }

  // All remaining enrichments (commits, diff, files, inline review comments,
  // top-level conversation comments) depend only on prData, so fetch them in
  // parallel with Promise.allSettled and merge whatever succeeds. Each branch
  // returns a stable fallback so one failing endpoint cannot mask the others.
  const commitsPromise = (async (): Promise<
    Array<{ sha: string; message: string; author: string }>
  > => {
    const commitsRes = await runtime.githubFetch(
      buildGitHubApiUrl(runtime, `/repos/${repo}/pulls/${pr}/commits`),
      { headers },
    );
    if (!commitsRes.ok) return [];
    const commitsData = (await commitsRes.json()) as Array<{
      sha: string;
      commit?: { message?: string; author?: { name?: string } };
      author?: { login?: string };
    }>;
    return commitsData.slice(0, 5).map((commit) => ({
      sha: (commit.sha || '').slice(0, 7),
      message: (commit.commit?.message || '').split('\n')[0].slice(0, 60),
      author: commit.commit?.author?.name || commit.author?.login || 'unknown',
    }));
  })();

  const diffPromise = (async (): Promise<string> => {
    const diffRes = await runtime.githubFetch(
      buildGitHubApiUrl(runtime, `/repos/${repo}/pulls/${pr}`),
      { headers: runtime.buildHeaders(DIFF_ACCEPT) },
    );
    if (!diffRes.ok) return '';
    const text = await diffRes.text();
    if (text.length > 10_000) {
      return `${text.slice(0, 10_000)}\n\n[...diff truncated at 10K chars]`;
    }
    return text;
  })();

  const filesPromise = (async (): Promise<{ data: GitHubCorePRFile[]; summary: string }> => {
    const filesRes = await runtime.githubFetch(
      buildGitHubApiUrl(runtime, `/repos/${repo}/pulls/${pr}/files`),
      { headers },
    );
    if (!filesRes.ok) return { data: [], summary: '' };
    const files = (await filesRes.json()) as GitHubCorePRFile[];
    const data = files.slice(0, 20).map((file) => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
    }));
    let summary = data
      .map((file) => `  ${file.status} ${file.filename} (+${file.additions} -${file.deletions})`)
      .join('\n');
    if (files.length > 20) {
      summary += `\n  ...and ${files.length - 20} more files`;
    }
    return { data, summary };
  })();

  // Inline review comments (left on specific lines during a PR review).
  // Fetch newest-first so that when a PR has more than 20 inline comments we
  // surface the most recent reviewer feedback, then reverse the slice so the
  // displayed order stays chronological (oldest -> newest).
  const reviewCommentsPromise = (async (): Promise<GitHubCorePRReviewComment[]> => {
    const reviewCommentsRes = await runtime.githubFetch(
      buildGitHubApiUrl(runtime, `/repos/${repo}/pulls/${pr}/comments?per_page=20&direction=desc`),
      { headers },
    );
    if (!reviewCommentsRes.ok) return [];
    const raw = (await reviewCommentsRes.json()) as Array<{
      user?: { login?: string };
      path?: string;
      line?: number | null;
      original_line?: number | null;
      body?: string;
    }>;
    return raw
      .slice(0, 20)
      .map((comment) => ({
        author: comment.user?.login || 'unknown',
        path: comment.path,
        line: comment.line ?? comment.original_line ?? undefined,
        body: truncateCommentBody(comment.body || ''),
      }))
      .reverse();
  })();

  // Top-level PR conversation comments (use the issues endpoint per GitHub API).
  // The /issues/{num}/comments endpoint does not support a direction parameter,
  // so this returns the oldest comments first; per_page is matched to the slice
  // limit to avoid over-fetching.
  const issueCommentsPromise = (async (): Promise<GitHubCorePRIssueComment[]> => {
    const issueCommentsRes = await runtime.githubFetch(
      buildGitHubApiUrl(runtime, `/repos/${repo}/issues/${pr}/comments?per_page=10`),
      { headers },
    );
    if (!issueCommentsRes.ok) return [];
    const raw = (await issueCommentsRes.json()) as Array<{
      user?: { login?: string };
      body?: string;
      created_at?: string;
    }>;
    return raw.slice(0, 10).map((comment) => ({
      author: comment.user?.login || 'unknown',
      body: truncateCommentBody(comment.body || ''),
      createdAt: comment.created_at || '',
    }));
  })();

  const [commitsResult, diffResult, filesResult, reviewCommentsResult, issueCommentsResult] =
    await Promise.allSettled([
      commitsPromise,
      diffPromise,
      filesPromise,
      reviewCommentsPromise,
      issueCommentsPromise,
    ]);

  const branchCommits = commitsResult.status === 'fulfilled' ? commitsResult.value : [];
  const diff = diffResult.status === 'fulfilled' ? diffResult.value : '';
  const filesData = filesResult.status === 'fulfilled' ? filesResult.value.data : [];
  const filesSummary = filesResult.status === 'fulfilled' ? filesResult.value.summary : '';
  const reviewComments =
    reviewCommentsResult.status === 'fulfilled' ? reviewCommentsResult.value : [];
  const issueComments = issueCommentsResult.status === 'fulfilled' ? issueCommentsResult.value : [];

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
      `\nLinked Issues:\n${linkedIssues.map((issue) => (issue.title ? `  #${issue.number}: ${issue.title}` : `  #${issue.number}`)).join('\n')}`,
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

  if (issueComments.length > 0) {
    const formatted = issueComments
      .map((comment) => `  @${comment.author}: ${comment.body}`)
      .join('\n');
    lines.push(`\nConversation (${issueComments.length}):\n${formatted}`);
  }

  if (reviewComments.length > 0) {
    const formatted = reviewComments
      .map((comment) => {
        const location =
          comment.path && comment.line
            ? `${comment.path}:${comment.line}`
            : comment.path || '(general)';
        return `  @${comment.author} on ${location}: ${comment.body}`;
      })
      .join('\n');
    lines.push(`\nInline Review Comments (${reviewComments.length}):\n${formatted}`);
  }

  if (diff) {
    lines.push(`\n--- Diff ---\n${diff}`);
  }

  const card: GitHubCorePRCardData = {
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
    description: prData.body
      ? prData.body.length > 300
        ? `${prData.body.slice(0, 300)}...`
        : prData.body
      : undefined,
    files: filesData.length > 0 ? filesData : undefined,
    reviewComments: reviewComments.length > 0 ? reviewComments : undefined,
    issueComments: issueComments.length > 0 ? issueComments : undefined,
  };

  return { text: lines.join('\n'), card: { type: 'pr', data: card } };
}

function truncateCommentBody(body: string): string {
  // Comment sections render `  @author: ${body}` one per line, so collapse any
  // internal newlines (and surrounding whitespace) to a single space before
  // truncating to keep the layout stable.
  const normalized = body
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]*\n+[ \t]*/g, ' ')
    .trim();
  if (normalized.length <= 300) return normalized;
  return `${normalized.slice(0, 300)}...`;
}

export async function executeListPRsTool(
  runtime: GitHubCoreRuntime,
  repo: string,
  state: string = 'open',
): Promise<GitHubCoreToolResult> {
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

  const prs = (await res.json()) as PullRequestListApi[];
  if (prs.length === 0) {
    return { text: `[Tool Result — list_prs]\nNo ${state} PRs found on ${repo}.` };
  }

  const lines: string[] = [
    `[Tool Result — list_prs]`,
    `${prs.length} ${state} PR${prs.length > 1 ? 's' : ''} on ${repo}:\n`,
  ];

  const prItems: GitHubCorePRListItem[] = [];
  for (const prItem of prs) {
    const age = new Date(prItem.created_at).toLocaleDateString();
    lines.push(`  #${prItem.number} — ${prItem.title}`);
    lines.push(
      `    by ${prItem.user.login} | +${prItem.additions || '?'} -${prItem.deletions || '?'} | ${age}`,
    );
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
  runtime: GitHubCoreRuntime,
  repo: string,
  count: number = 10,
): Promise<GitHubCoreToolResult> {
  const headers = runtime.buildHeaders(DEFAULT_ACCEPT);
  const res = await runtime.githubFetch(
    buildGitHubApiUrl(runtime, `/repos/${repo}/commits?per_page=${Math.min(count, 30)}`),
    { headers },
  );

  if (!res.ok) {
    throw new Error(formatGitHubError(res.status, `commits on ${repo}`));
  }

  const commits = (await res.json()) as CommitListApi[];
  if (commits.length === 0) {
    return { text: `[Tool Result — list_commits]\nNo commits found on ${repo}.` };
  }

  const lines: string[] = [
    `[Tool Result — list_commits]`,
    `${commits.length} recent commit${commits.length > 1 ? 's' : ''} on ${repo}:\n`,
  ];

  const commitItems: GitHubCoreCommitListItem[] = [];
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
  runtime: GitHubCoreRuntime,
  repo: string,
  path: string,
  branch?: string,
  startLine?: number,
  endLine?: number,
): Promise<GitHubCoreToolResult> {
  if (runtime.isSensitivePath(path)) {
    return { text: runtime.formatSensitivePathToolError(path) };
  }

  const headers = runtime.buildHeaders(DEFAULT_ACCEPT);
  const res = await runtime.githubFetch(buildContentsApiUrl(runtime, repo, path, branch), {
    headers,
  });
  if (!res.ok) {
    throw new Error(formatGitHubError(res.status, `${path} on ${repo}`, branch));
  }

  const data = (await res.json()) as RepoFileContentApi | RepoContentEntryApi[];
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
    const truncatedRange = truncateDisplayLines(
      safeRangeLines,
      rangeDisplayLines,
      rangeStart,
      READ_FILE_RANGE_CHAR_LIMIT,
    );
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
  const truncatedFull = truncateDisplayLines(
    fullSourceLines,
    fullSourceLines,
    1,
    READ_FILE_FULL_CHAR_LIMIT,
  );
  const truncated = truncatedFull.truncated;
  if (truncated) {
    const totalLines = fullSourceLines.length;
    content =
      truncatedFull.displayLines.join('\n') +
      `\n\n[...truncated at ${READ_FILE_FULL_CHAR_LIMIT / 1000}K chars — file has ${totalLines} lines. Use read_file with start_line/end_line to continue from line ${truncatedFull.truncatedAtLine}, search_files to find content, or grep_file for pattern matching.]`;
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
  runtime: GitHubCoreRuntime,
  repo: string,
  path: string,
  pattern: string,
  branch?: string,
): Promise<GitHubCoreToolResult> {
  if (runtime.isSensitivePath(path)) {
    return { text: runtime.formatSensitivePathToolError(path) };
  }

  const headers = runtime.buildHeaders(DEFAULT_ACCEPT);
  const res = await runtime.githubFetch(buildContentsApiUrl(runtime, repo, path, branch), {
    headers,
  });
  if (!res.ok) {
    throw new Error(formatGitHubError(res.status, `${path} on ${repo}`, branch));
  }

  const data = (await res.json()) as RepoFileContentApi | RepoContentEntryApi[];
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
      outputLines.push(
        `\n[...truncated — showing first ${MAX_OUTPUT_MATCHES} of ${matchLineNums.size} matches]`,
      );
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

  const matchItems: GitHubCoreFileSearchMatch[] = [];
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
  runtime: GitHubCoreRuntime,
  repo: string,
  path: string = '',
  branch?: string,
): Promise<GitHubCoreToolResult> {
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

  const data = (await res.json()) as RepoContentEntryApi[] | RepoFileContentApi;
  if (!Array.isArray(data)) {
    return {
      text: `[Tool Error] "${path}" is a file, not a directory. Use read_file to read its contents.`,
    };
  }

  const normalizedEntries = data.map((entry) => ({
    name: entry.name || '',
    type: entry.type === 'dir' ? ('directory' as const) : ('file' as const),
    size: entry.size,
    path: buildDirectoryEntryPath(path, entry.name || ''),
  }));
  const visibleEntries: GitHubCoreFileListEntry[] = [];
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
    hiddenCount > 0
      ? `(${hiddenCount} sensitive entr${hiddenCount === 1 ? 'y' : 'ies'} hidden)\n`
      : '',
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
  runtime: GitHubCoreRuntime,
  repo: string,
  ref?: string,
): Promise<{ overall: GitHubCoreCIOverallStatus; checks: GitHubCoreCICheck[]; ref: string }> {
  const headers = runtime.buildHeaders(DEFAULT_ACCEPT);
  const commitRef = ref || 'HEAD';

  const checkRunsRes = await runtime.githubFetch(
    buildGitHubApiUrl(runtime, `/repos/${repo}/commits/${commitRef}/check-runs?per_page=50`),
    { headers },
  );

  let checks: GitHubCoreCICheck[] = [];
  let overall: GitHubCoreCIOverallStatus = 'no-checks';

  if (checkRunsRes.ok) {
    const data = (await checkRunsRes.json()) as {
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
        status: (checkRun.status || 'completed') as GitHubCoreCICheck['status'],
        conclusion: (checkRun.conclusion ?? null) as GitHubCoreCICheck['conclusion'],
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
      const statusData = (await statusRes.json()) as {
        statuses?: Array<{ context?: string; state?: string; target_url?: string }>;
      };
      if (statusData.statuses && statusData.statuses.length > 0) {
        checks = statusData.statuses.map((statusItem) => ({
          name: statusItem.context || 'unknown-check',
          status: 'completed' as const,
          conclusion:
            statusItem.state === 'success'
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
  } else if (
    checks.every(
      (check) =>
        check.conclusion === 'success' ||
        check.conclusion === 'skipped' ||
        check.conclusion === 'neutral',
    )
  ) {
    overall = 'success';
  } else if (checks.some((check) => check.conclusion === 'failure')) {
    overall = 'failure';
  } else {
    overall = 'neutral';
  }

  return { overall, checks, ref: commitRef };
}

export async function executeFetchChecksTool(
  runtime: GitHubCoreRuntime,
  repo: string,
  ref?: string,
): Promise<GitHubCoreToolResult> {
  const { overall, checks, ref: commitRef } = await fetchCIStatusSummary(runtime, repo, ref);
  const cardData: GitHubCoreCIStatusCardData = {
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
      const icon =
        check.conclusion === 'success'
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
  runtime: GitHubCoreRuntime,
  repo: string,
  ref: string,
): Promise<GitHubCoreToolResult> {
  const headers = runtime.buildHeaders(DEFAULT_ACCEPT);
  const res = await runtime.githubFetch(
    buildGitHubApiUrl(runtime, `/repos/${repo}/commits/${encodeURIComponent(ref)}`),
    { headers },
  );

  if (!res.ok) {
    throw new Error(formatGitHubError(res.status, `commit ${ref} on ${repo}`));
  }

  const commit = (await res.json()) as CommitDetailsApi;
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

  const fileItems: GitHubCoreCommitFileItem[] = [];
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

  const cardData: GitHubCoreCommitFilesCardData = {
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

export async function executeTriggerWorkflowTool(
  runtime: GitHubCoreRuntime,
  repo: string,
  workflow: string,
  ref?: string,
  inputs?: Record<string, string>,
): Promise<GitHubCoreToolResult> {
  const headers = runtime.buildHeaders(DEFAULT_ACCEPT);
  let targetRef = ref;

  if (!targetRef) {
    try {
      targetRef = await fetchRepoDefaultBranch(runtime, repo);
    } catch {
      targetRef = 'main';
    }
  }

  const body: Record<string, unknown> = { ref: targetRef };
  if (inputs && Object.keys(inputs).length > 0) {
    body.inputs = inputs;
  }

  const res = await runtime.githubFetch(
    buildGitHubApiUrl(
      runtime,
      `/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
    ),
    {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );

  if (res.status === 404) {
    throw new Error(
      `Workflow "${workflow}" not found on ${repo}. Use get_workflow_runs to see available workflows.`,
    );
  }
  if (res.status === 422) {
    throw new Error(
      `Workflow "${workflow}" does not have a workflow_dispatch trigger, or the inputs are invalid.`,
    );
  }
  if (!res.ok) {
    throw new Error(formatGitHubError(res.status, `triggering workflow "${workflow}" on ${repo}`));
  }

  return {
    text: [
      `[Tool Result — trigger_workflow]`,
      `Workflow "${workflow}" dispatched on ${repo} (ref: ${targetRef}).`,
      'Note: GitHub returns no run ID for dispatches. Use get_workflow_runs to check if it started.',
    ].join('\n'),
  };
}

export async function executeGetWorkflowRunsTool(
  runtime: GitHubCoreRuntime,
  repo: string,
  workflow?: string,
  branch?: string,
  status?: string,
  count?: number,
): Promise<GitHubCoreToolResult> {
  const headers = runtime.buildHeaders(DEFAULT_ACCEPT);
  const perPage = Math.max(1, Math.min(count || 10, 20));

  let url = workflow
    ? buildGitHubApiUrl(
        runtime,
        `/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?per_page=${perPage}`,
      )
    : buildGitHubApiUrl(runtime, `/repos/${repo}/actions/runs?per_page=${perPage}`);
  if (branch) url += `&branch=${encodeURIComponent(branch)}`;
  if (status) url += `&status=${encodeURIComponent(status)}`;

  const res = await runtime.githubFetch(url, { headers });
  if (!res.ok) {
    throw new Error(formatGitHubError(res.status, `workflow runs on ${repo}`));
  }

  const data = (await res.json()) as { total_count?: number; workflow_runs?: WorkflowRunApi[] };
  const runs: GitHubCoreWorkflowRunItem[] = (data.workflow_runs || []).map((run) => ({
    id: run.id,
    name: run.name,
    status: normalizeWorkflowRunStatus(run.status),
    conclusion: normalizeWorkflowConclusion(run.conclusion),
    branch: run.head_branch || '',
    event: run.event,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    htmlUrl: run.html_url,
    runNumber: run.run_number,
    actor: run.actor?.login || 'unknown',
  }));

  if (runs.length === 0) {
    return {
      text: `[Tool Result — get_workflow_runs]\nNo workflow runs found on ${repo}${workflow ? ` for "${workflow}"` : ''}.`,
    };
  }

  const lines: string[] = [
    `[Tool Result — get_workflow_runs]`,
    `${runs.length} recent run${runs.length > 1 ? 's' : ''} on ${repo}${workflow ? ` (workflow: ${workflow})` : ''}:\n`,
  ];

  for (const run of runs) {
    const icon =
      run.conclusion === 'success'
        ? '✓'
        : run.conclusion === 'failure'
          ? '✗'
          : run.status !== 'completed'
            ? '⏳'
            : '—';
    lines.push(`  ${icon} #${run.runNumber} ${run.name}`);
    lines.push(
      `    ${run.branch} | ${run.event} | ${run.actor} | ${new Date(run.createdAt).toLocaleDateString()}`,
    );
  }

  return {
    text: lines.join('\n'),
    card: {
      type: 'workflow-runs',
      data: {
        repo,
        runs,
        workflow,
        truncated: (data.total_count || 0) > perPage,
      },
    },
  };
}

export async function executeGetWorkflowLogsTool(
  runtime: GitHubCoreRuntime,
  repo: string,
  runId: number,
): Promise<GitHubCoreToolResult> {
  const headers = runtime.buildHeaders(DEFAULT_ACCEPT);

  const [runRes, jobsRes] = await Promise.all([
    runtime.githubFetch(buildGitHubApiUrl(runtime, `/repos/${repo}/actions/runs/${runId}`), {
      headers,
    }),
    runtime.githubFetch(
      buildGitHubApiUrl(runtime, `/repos/${repo}/actions/runs/${runId}/jobs?per_page=50`),
      { headers },
    ),
  ]);

  if (!runRes.ok) {
    throw new Error(formatGitHubError(runRes.status, `workflow run #${runId} on ${repo}`));
  }

  const runData = (await runRes.json()) as WorkflowRunDetailsApi;
  let jobsData: WorkflowJobApi[] = [];
  if (jobsRes.ok) {
    const parsed = (await jobsRes.json()) as { jobs?: WorkflowJobApi[] };
    jobsData = parsed.jobs || [];
  }

  const jobs: GitHubCoreWorkflowJob[] = jobsData.map((job) => ({
    name: job.name,
    status: normalizeWorkflowJobStatus(job.status),
    conclusion: normalizeWorkflowConclusion(job.conclusion),
    htmlUrl: job.html_url,
    steps: (job.steps || []).map((step) => ({
      name: step.name,
      status: normalizeWorkflowStepStatus(step.status),
      conclusion: normalizeWorkflowConclusion(step.conclusion),
      number: step.number,
    })),
  }));

  const lines: string[] = [
    `[Tool Result — get_workflow_logs]`,
    `Run: ${runData.name} #${runData.run_number}`,
    `Status: ${runData.status} | Conclusion: ${runData.conclusion || 'pending'}`,
    `Branch: ${runData.head_branch || '—'} | Event: ${runData.event}`,
    `\nJobs (${jobs.length}):\n`,
  ];

  for (const job of jobs) {
    const icon =
      job.conclusion === 'success'
        ? '✓'
        : job.conclusion === 'failure'
          ? '✗'
          : job.status !== 'completed'
            ? '⏳'
            : '—';
    lines.push(`  ${icon} ${job.name} — ${job.conclusion || job.status}`);
    for (const step of job.steps) {
      const stepIcon =
        step.conclusion === 'success'
          ? '✓'
          : step.conclusion === 'failure'
            ? '✗'
            : step.status !== 'completed'
              ? '⏳'
              : '—';
      lines.push(`      ${stepIcon} ${step.number}. ${step.name}`);
    }
  }

  return {
    text: lines.join('\n'),
    card: {
      type: 'workflow-logs',
      data: {
        runId,
        runName: runData.name,
        runNumber: runData.run_number,
        status: runData.status,
        conclusion: runData.conclusion,
        jobs,
        htmlUrl: runData.html_url,
        repo,
      },
    },
  };
}

export async function executeCreatePRTool(
  runtime: GitHubCoreRuntime,
  repo: string,
  title: string,
  body: string,
  head: string,
  base: string,
): Promise<GitHubCoreToolResult> {
  const headers = runtime.buildHeaders(DEFAULT_ACCEPT);
  const res = await runtime.githubFetch(buildGitHubApiUrl(runtime, `/repos/${repo}/pulls`), {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body, head, base }),
  });

  if (res.status === 422) {
    const errorData = (await res.json().catch(() => null)) as {
      errors?: Array<{ message?: string }>;
      message?: string;
    } | null;
    const detail = errorData?.errors?.[0]?.message || errorData?.message || 'Validation failed';
    throw new Error(`Could not create PR: ${detail}`);
  }
  if (!res.ok) {
    throw new Error(formatGitHubError(res.status, `creating PR on ${repo}`));
  }

  const prData = (await res.json()) as { number: number; title: string; html_url: string };
  return {
    text: [
      `[Tool Result — create_pr]`,
      `PR #${prData.number} created on ${repo}.`,
      `Title: ${prData.title}`,
      `Branch: ${head} → ${base}`,
      `URL: ${prData.html_url}`,
    ].join('\n'),
  };
}

export async function executeMergePRTool(
  runtime: GitHubCoreRuntime,
  repo: string,
  prNumber: number,
  mergeMethod?: string,
): Promise<GitHubCoreToolResult> {
  const headers = runtime.buildHeaders(DEFAULT_ACCEPT);
  const method = mergeMethod || 'merge';
  let branchSwitch: GitHubCoreToolResult['branchSwitch'];

  try {
    const prRes = await runtime.githubFetch(
      buildGitHubApiUrl(runtime, `/repos/${repo}/pulls/${prNumber}`),
      { headers },
    );
    if (prRes.ok) {
      const prData = (await prRes.json()) as {
        head?: { ref?: string };
        base?: { ref?: string };
      };
      const baseBranch = prData.base?.ref?.trim();
      if (baseBranch) {
        const headBranch = prData.head?.ref?.trim();
        branchSwitch = {
          name: baseBranch,
          kind: 'merged',
          ...(headBranch ? { from: headBranch } : {}),
          prNumber,
          source: 'merge_pr',
        };
      }
    }
  } catch {
    // Best-effort metadata fetch: merging should not fail just because the
    // branch-switch hint could not be enriched.
  }

  const res = await runtime.githubFetch(
    buildGitHubApiUrl(runtime, `/repos/${repo}/pulls/${prNumber}/merge`),
    {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ merge_method: method }),
    },
  );

  if (res.status === 405) {
    const errorData = (await res.json().catch(() => null)) as { message?: string } | null;
    const reason =
      errorData?.message || 'PR cannot be merged (checks may be failing, or conflicts exist).';
    throw new Error(`Cannot merge PR #${prNumber}: ${reason}`);
  }
  if (res.status === 409) {
    throw new Error(
      `Merge conflict on PR #${prNumber}. The head branch is out of date or has conflicts.`,
    );
  }
  if (!res.ok) {
    throw new Error(formatGitHubError(res.status, `merging PR #${prNumber} on ${repo}`));
  }

  const data = (await res.json()) as { sha?: string; message?: string };
  return {
    text: [
      `[Tool Result — merge_pr]`,
      `PR #${prNumber} merged on ${repo} via ${method}.`,
      `Merge SHA: ${data.sha?.slice(0, 7) || 'unknown'}`,
      data.message ? `Message: ${data.message}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    ...(branchSwitch ? { branchSwitch } : {}),
  };
}

export async function executeDeleteBranchTool(
  runtime: GitHubCoreRuntime,
  repo: string,
  branchName: string,
): Promise<GitHubCoreToolResult> {
  const headers = runtime.buildHeaders(DEFAULT_ACCEPT);
  const res = await runtime.githubFetch(
    buildGitHubApiUrl(runtime, `/repos/${repo}/git/refs/heads/${encodeURIComponent(branchName)}`),
    {
      method: 'DELETE',
      headers,
    },
  );

  if (res.status === 422) {
    throw new Error(
      `Branch "${branchName}" not found on ${repo}. Use list_branches to see available branches.`,
    );
  }
  if (!res.ok) {
    throw new Error(formatGitHubError(res.status, `deleting branch "${branchName}" on ${repo}`));
  }

  return {
    text: [`[Tool Result — delete_branch]`, `Branch "${branchName}" deleted from ${repo}.`].join(
      '\n',
    ),
  };
}

export async function executeCheckPRMergeableTool(
  runtime: GitHubCoreRuntime,
  repo: string,
  prNumber: number,
): Promise<GitHubCoreToolResult> {
  const headers = runtime.buildHeaders(DEFAULT_ACCEPT);
  const prRes = await runtime.githubFetch(
    buildGitHubApiUrl(runtime, `/repos/${repo}/pulls/${prNumber}`),
    { headers },
  );
  if (!prRes.ok) {
    throw new Error(formatGitHubError(prRes.status, `PR #${prNumber} on ${repo}`));
  }

  const prData = (await prRes.json()) as PullRequestMergeabilityApi;
  const headSha = prData.head?.sha;
  let ciOverall: GitHubCoreCIOverallStatus | 'unknown' = 'unknown';
  let ciChecks: GitHubCoreCICheck[] = [];
  if (headSha) {
    try {
      const ciStatus = await fetchCIStatusSummary(runtime, repo, headSha);
      ciOverall = ciStatus.overall;
      ciChecks = ciStatus.checks;
    } catch {
      // Best-effort CI context only.
    }
  }

  const lines: string[] = [
    `[Tool Result — check_pr_mergeable]`,
    `PR #${prNumber}: ${prData.title}`,
    `State: ${prData.state}`,
    `Mergeable: ${prData.mergeable === null ? 'computing (try again shortly)' : prData.mergeable ? 'yes' : 'no'}`,
    `Mergeable state: ${prData.mergeable_state || 'unknown'}`,
    `Branch: ${prData.head?.ref || ''} → ${prData.base?.ref || ''}`,
    `CI status: ${ciOverall.toUpperCase()}`,
  ];

  if (ciChecks.length > 0) {
    lines.push('');
    for (const check of ciChecks) {
      const icon =
        check.conclusion === 'success'
          ? '✓'
          : check.conclusion === 'failure'
            ? '✗'
            : check.status !== 'completed'
              ? '⏳'
              : '—';
      lines.push(`  ${icon} ${check.name}: ${check.conclusion || check.status}`);
    }
  }

  const canMerge = prData.mergeable === true && prData.state === 'open' && ciOverall !== 'failure';
  lines.push('');
  lines.push(
    canMerge
      ? 'This PR is eligible for merge.'
      : 'This PR is NOT currently eligible for merge.' +
          (prData.mergeable === false ? ' There are merge conflicts.' : '') +
          (ciOverall === 'failure' ? ' CI checks are failing.' : '') +
          (ciOverall === 'pending' ? ' CI checks are still running.' : '') +
          (prData.state !== 'open' ? ` PR state is "${prData.state}".` : ''),
  );

  return { text: lines.join('\n') };
}

export async function executeFindExistingPRTool(
  runtime: GitHubCoreRuntime,
  repo: string,
  headBranch: string,
  baseBranch?: string,
): Promise<GitHubCoreToolResult> {
  const headers = runtime.buildHeaders(DEFAULT_ACCEPT);
  const owner = getRepoOwner(repo);
  if (!owner) {
    throw new Error(`Could not extract owner from repo "${repo}".`);
  }

  const base = baseBranch || 'main';
  const res = await runtime.githubFetch(
    buildGitHubApiUrl(
      runtime,
      `/repos/${repo}/pulls?head=${encodeURIComponent(`${owner}:${headBranch}`)}&base=${encodeURIComponent(base)}&state=open`,
    ),
    { headers },
  );

  if (!res.ok) {
    throw new Error(formatGitHubError(res.status, `searching PRs on ${repo}`));
  }

  const prs = (await res.json()) as Array<{
    number: number;
    title: string;
    html_url: string;
    head?: { ref?: string };
    base?: { ref?: string };
    user?: { login?: string };
  }>;
  if (!Array.isArray(prs) || prs.length === 0) {
    return {
      text: [
        `[Tool Result — find_existing_pr]`,
        `No existing open PR found for ${headBranch} → ${base} on ${repo}.`,
      ].join('\n'),
    };
  }

  const pr = prs[0];
  return {
    text: [
      `[Tool Result — find_existing_pr]`,
      `Found existing PR #${pr.number} on ${repo}.`,
      `Title: ${pr.title}`,
      `Branch: ${pr.head?.ref || ''} → ${pr.base?.ref || ''}`,
      `Author: ${pr.user?.login || 'unknown'}`,
      `URL: ${pr.html_url}`,
    ].join('\n'),
  };
}

/**
 * Build a case-insensitive LITERAL substring line matcher. repo_search is
 * advertised as code/text search, not regex — compiling the query as a regex
 * would silently change its meaning (`$schema`, `obj[key]`, `foo?` are valid
 * regexes that match something other than the literal text), which would let a
 * present reference be reported as an exhaustive zero-match. Literal matching
 * keeps the exhaustiveness guarantee honest and the two search paths aligned.
 */
function buildSearchLineMatcher(query: string): (line: string) => boolean {
  const needle = query.toLowerCase();
  return (line: string) => line.toLowerCase().includes(needle);
}

/**
 * Branch-accurate repo search: walk the branch's live git tree and grep blob
 * contents, instead of GitHub's default-branch-only code-search index. This is
 * the path used whenever a caller pins a branch (notably the reviewer, which
 * always reviews a feature branch). Bounded by BRANCH_SEARCH_MAX_FILES; reports
 * explicitly whether the scan was exhaustive so callers can trust a zero-match
 * result instead of mistaking a stale/partial scan for "no references".
 */
async function executeBranchTreeSearch(
  runtime: GitHubCoreRuntime,
  repo: string,
  query: string,
  branch: string,
  path?: string,
): Promise<GitHubCoreToolResult> {
  const headers = runtime.buildHeaders(DEFAULT_ACCEPT);
  const treeRes = await runtime.githubFetch(
    buildGitHubApiUrl(
      runtime,
      `/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    ),
    { headers },
  );
  if (!treeRes.ok) {
    throw new Error(formatGitHubError(treeRes.status, `branch tree for ${repo}`, branch));
  }

  const treeData = (await treeRes.json()) as GitTreeApi;
  const treeTruncated = treeData.truncated === true;
  const normalizedPath = path ? path.replace(/^\/+|\/+$/g, '') : '';

  let hiddenResults = 0;
  let oversizedSkipped = 0;
  const candidates: Array<{ path: string; sha: string }> = [];
  for (const entry of treeData.tree || []) {
    if (entry.type !== 'blob' || typeof entry.path !== 'string' || typeof entry.sha !== 'string') {
      continue;
    }
    if (normalizedPath && !entry.path.startsWith(normalizedPath)) continue;
    if (runtime.isSensitivePath(entry.path)) {
      hiddenResults += 1;
      continue;
    }
    const ext = entry.path.split('.').pop()?.toLowerCase() || '';
    if (BRANCH_SEARCH_BINARY_EXTENSIONS.has(ext)) continue;
    if (typeof entry.size === 'number' && entry.size > BRANCH_SEARCH_MAX_BLOB_BYTES) {
      // A non-binary file too large to fetch is content we did NOT scan — it
      // must defeat the exhaustiveness claim, or a reference hiding in a large
      // file would be reported as "zero references".
      oversizedSkipped += 1;
      continue;
    }
    candidates.push({ path: entry.path, sha: entry.sha });
  }

  const capHit = candidates.length > BRANCH_SEARCH_MAX_FILES;
  const scanLimit = Math.min(candidates.length, BRANCH_SEARCH_MAX_FILES);
  const matcher = buildSearchLineMatcher(query);

  const fileMatches = new Map<string, GitHubCoreFileSearchMatch[]>();
  let redactedResults = false;
  let scannedCount = 0;
  let fetchFailures = 0;
  let resultCapHit = false;
  let nextIndex = 0;

  // Bounded-concurrency blob fetch. JS is single-threaded between awaits, so the
  // `nextIndex` claim and the shared counters mutate safely without a lock.
  const worker = async (): Promise<void> => {
    while (!resultCapHit) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= scanLimit) return;
      const cand = candidates[i];

      let blobRes: Response;
      try {
        blobRes = await runtime.githubFetch(
          buildGitHubApiUrl(runtime, `/repos/${repo}/git/blobs/${cand.sha}`),
          { headers },
        );
      } catch {
        fetchFailures += 1;
        continue;
      }
      scannedCount += 1;
      if (!blobRes.ok) {
        fetchFailures += 1;
        continue;
      }

      const blob = (await blobRes.json()) as GitBlobApi;
      if (blob.encoding !== 'base64' || typeof blob.content !== 'string') continue;
      let decoded: string;
      try {
        decoded = runtime.decodeBase64(blob.content.replace(/\n/g, ''));
      } catch {
        continue;
      }
      if (decoded.includes('\u0000')) continue; // binary blob with a text extension

      const safe = runtime.redactSensitiveText(decoded);
      redactedResults ||= safe.redacted;
      const lines = safe.text.split('\n');
      const lineMatches: GitHubCoreFileSearchMatch[] = [];
      for (let ln = 0; ln < lines.length; ln += 1) {
        if (matcher(lines[ln])) {
          lineMatches.push({
            path: cand.path,
            line: ln + 1,
            content: lines[ln].trim().slice(0, 300),
          });
          if (lineMatches.length >= BRANCH_SEARCH_MAX_LINES_PER_FILE) break;
        }
      }
      if (lineMatches.length > 0) {
        fileMatches.set(cand.path, lineMatches);
        if (fileMatches.size >= BRANCH_SEARCH_RESULT_CAP) resultCapHit = true;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(BRANCH_SEARCH_CONCURRENCY, scanLimit)) }, () =>
      worker(),
    ),
  );

  const exhaustive =
    !treeTruncated && !capHit && !resultCapHit && fetchFailures === 0 && oversizedSkipped === 0;
  // Shared lib also runs on the CLI, where stdout is reserved for user output —
  // structured logs go to stderr. Paired event names: completed ↔ partial.
  console.error(
    JSON.stringify({
      level: 'info',
      event: exhaustive ? 'branch_search_completed' : 'branch_search_partial',
      repo,
      branch,
      candidates: candidates.length,
      scanned: scannedCount,
      matchedFiles: fileMatches.size,
      exhaustive,
      treeTruncated,
      capHit,
      resultCapHit,
      oversizedSkipped,
      fetchFailures,
    }),
  );

  const oversizedKiB = Math.floor(BRANCH_SEARCH_MAX_BLOB_BYTES / 1024);
  const incompleteReasons: string[] = [];
  if (treeTruncated) {
    incompleteReasons.push('the branch file tree was too large for GitHub to return in full');
  }
  if (capHit) {
    incompleteReasons.push(
      `scanned the first ${scannedCount} of ${candidates.length} candidate files (cap ${BRANCH_SEARCH_MAX_FILES}) — add a path filter to cover the rest`,
    );
  }
  if (resultCapHit) {
    incompleteReasons.push(
      `stopped after the first ${BRANCH_SEARCH_RESULT_CAP} matching files — more matches may exist`,
    );
  }
  if (oversizedSkipped > 0) {
    incompleteReasons.push(
      `${oversizedSkipped} file(s) larger than ${oversizedKiB} KiB were not scanned`,
    );
  }
  if (fetchFailures > 0) {
    incompleteReasons.push(`${fetchFailures} file(s) could not be fetched`);
  }

  const scopeLabel = `branch "${branch}"${normalizedPath ? ` under ${normalizedPath}` : ''}`;
  const lines: string[] = [`[Tool Result — search_files]`];

  if (fileMatches.size === 0) {
    lines.push(`No matches for "${query}" on ${scopeLabel}.`);
    lines.push('');
    if (exhaustive) {
      lines.push(
        `Scanned all ${scannedCount} text file(s) on this branch — this result is exhaustive (zero references).`,
      );
    } else {
      lines.push('This search was NOT exhaustive — do not conclude zero references:');
      for (const reason of incompleteReasons) lines.push(`- ${reason}`);
    }
    if (hiddenResults > 0) {
      lines.push(`(${hiddenResults} sensitive path${hiddenResults === 1 ? '' : 's'} skipped)`);
    }
    return {
      text: lines.join('\n'),
      card: {
        type: 'file-search',
        data: {
          repo,
          query,
          path: normalizedPath || undefined,
          matches: [],
          totalCount: 0,
          truncated: !exhaustive,
        },
      },
    };
  }

  lines.push(
    `Found matches in ${fileMatches.size}${resultCapHit ? '+' : ''} file(s) for "${query}" on ${scopeLabel}.`,
  );
  if (!exhaustive && incompleteReasons.length > 0) {
    lines.push(`(search not exhaustive: ${incompleteReasons.join('; ')})`);
  }
  if (redactedResults) lines.push('Redactions: secret-like values hidden.');
  if (hiddenResults > 0) {
    lines.push(`(${hiddenResults} sensitive path${hiddenResults === 1 ? '' : 's'} skipped)`);
  }
  lines.push('');

  const flatMatches: GitHubCoreFileSearchMatch[] = [];
  for (const [filePath, matchesForFile] of fileMatches) {
    lines.push(`FILE ${filePath}`);
    for (const match of matchesForFile) {
      lines.push(`    ${match.line}: ${match.content}`);
      flatMatches.push(match);
    }
  }

  return {
    text: lines.join('\n'),
    card: {
      type: 'file-search',
      data: {
        repo,
        query,
        path: normalizedPath || undefined,
        matches: flatMatches,
        totalCount: fileMatches.size,
        truncated: resultCapHit || !exhaustive,
      },
    },
  };
}

export async function executeSearchFilesTool(
  runtime: GitHubCoreRuntime,
  repo: string,
  query: string,
  path?: string,
  branch?: string,
): Promise<GitHubCoreToolResult> {
  if (path && runtime.isSensitivePath(path)) {
    return { text: runtime.formatSensitivePathToolError(path) };
  }

  // A pinned branch can't be served by GitHub's default-branch-only code-search
  // index; scan the branch's live tree instead so results reflect the code
  // actually under review (this is the reviewer's path).
  if (branch) {
    return executeBranchTreeSearch(runtime, repo, query, branch, path);
  }

  const headers = runtime.buildHeaders(SEARCH_ACCEPT);
  const searchQuery = `${query} repo:${repo}${path ? ` path:${path}` : ''}`;

  const searchUrl = buildGitHubApiUrl(
    runtime,
    `/search/code?q=${encodeURIComponent(searchQuery)}&per_page=25`,
  );

  const res = await runtime.githubFetch(searchUrl, { headers });
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error('GitHub token is invalid or expired — re-authenticate in Settings.');
    }
    if (res.status === 403) {
      let detail = '';
      try {
        const errBody = (await res.json()) as { message?: string };
        detail = errBody.message || '';
      } catch {
        // ignore parse errors
      }

      if (detail.toLowerCase().includes('rate limit')) {
        throw new Error(
          `GitHub API rate limit exceeded for code search. Wait a moment and retry.\n${detail}`,
        );
      }
      if (!headers.Authorization) {
        throw new Error(
          'Code search requires authentication — connect your GitHub account in Settings or set a Personal Access Token.',
        );
      }
      throw new Error(
        `Code search forbidden (403) — your token may lack the required scope. GitHub says: ${detail || 'no details provided'}`,
      );
    }
    if (res.status === 422) {
      throw new Error('Invalid search query. Try a simpler pattern.');
    }
    throw new Error(`GitHub code search returned ${res.status}`);
  }

  const data = (await res.json()) as {
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
    // This path runs only without a pinned branch (code search indexes the
    // default branch). Branch-scoped searches route to executeBranchTreeSearch
    // above, which reports its own exhaustiveness caveats.
    hints.push(
      'This searches the default branch only. Pass a branch to scan a specific branch end-to-end.',
    );
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

  const matches: GitHubCoreFileSearchMatch[] = [];
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
    hiddenResults > 0
      ? `(${hiddenResults} sensitive result${hiddenResults === 1 ? '' : 's'} hidden)\n`
      : '',
    redactedResults ? 'Redactions: secret-like values hidden.\n' : '',
  ];

  const byFile = new Map<string, GitHubCoreFileSearchMatch[]>();
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
    lines.push(
      'Tip: Use grep_file(repo, path, pattern) to search within a specific file with line numbers and context.',
    );
  }

  const cardData: GitHubCoreFileSearchCardData = {
    repo,
    query,
    path,
    matches: matches.slice(0, 50),
    totalCount,
    truncated,
  };

  return { text: lines.join('\n'), card: { type: 'file-search', data: cardData } };
}

// ---------------------------------------------------------------------------
// CI job logs (real log text, not just step status)
// ---------------------------------------------------------------------------

const JOB_LOG_DEFAULT_TAIL = 200;
const JOB_LOG_MAX_TAIL = 1000;
const JOB_LOG_MAX_JOBS = 5;
const JOB_LOG_CHAR_LIMIT = 50_000;
/** Cap the jobs-list pagination walk (per_page=100, so 5 pages = 500 jobs). */
const JOB_LIST_MAX_PAGES = 5;
/** Job conclusions that count as "failed" for `failed_only`. */
const FAILED_JOB_CONCLUSIONS: ReadonlySet<string> = new Set([
  'failure',
  'timed_out',
  'action_required',
]);

function tailLines(text: string, max: number): { text: string; truncated: boolean } {
  // A terminal newline yields a trailing '' segment from split('\n'); don't
  // count it as a line, or tail_lines:3 on "a\nb\nc\n" would drop a real line
  // and falsely mark the result truncated. Strip one trailing newline first.
  const normalized = text.endsWith('\n') ? text.slice(0, -1) : text;
  const lines = normalized.split('\n');
  if (lines.length <= max) return { text, truncated: false };
  return { text: lines.slice(lines.length - max).join('\n'), truncated: true };
}

async function fetchJobLogText(
  runtime: GitHubCoreRuntime,
  repo: string,
  jobId: number,
): Promise<string | null> {
  // GitHub 302-redirects this endpoint to a short-lived blob URL; the platform
  // fetch follows the redirect (and strips Authorization cross-origin per the
  // Fetch spec), so we just read the final body. 404 = logs expired/absent.
  const res = await runtime.githubFetch(
    buildGitHubApiUrl(runtime, `/repos/${repo}/actions/jobs/${jobId}/logs`),
    { headers: runtime.buildHeaders(DEFAULT_ACCEPT) },
  );
  if (!res.ok) return null;
  return res.text();
}

export async function executeGetJobLogsTool(
  runtime: GitHubCoreRuntime,
  repo: string,
  runId?: number,
  jobId?: number,
  failedOnly: boolean = true,
  tail?: number,
): Promise<GitHubCoreToolResult> {
  const headers = runtime.buildHeaders(DEFAULT_ACCEPT);
  const tailN = Math.max(1, Math.min(tail || JOB_LOG_DEFAULT_TAIL, JOB_LOG_MAX_TAIL));

  // Single job by id — the targeted "why did THIS job fail" path.
  if (typeof jobId === 'number') {
    const metaRes = await runtime.githubFetch(
      buildGitHubApiUrl(runtime, `/repos/${repo}/actions/jobs/${jobId}`),
      { headers },
    );
    if (!metaRes.ok) {
      throw new Error(formatGitHubError(metaRes.status, `job #${jobId} on ${repo}`));
    }
    const meta = (await metaRes.json()) as WorkflowJobSummaryApi;
    const raw = await fetchJobLogText(runtime, repo, jobId);
    if (raw === null) {
      return {
        text: `[Tool Result — get_job_logs]\nNo logs available for job #${jobId} on ${repo} (logs may have expired or the job has not produced output yet).`,
      };
    }
    const tailed = tailLines(raw.slice(-JOB_LOG_CHAR_LIMIT * 2), tailN);
    const safe = runtime.redactSensitiveText(tailed.text.slice(-JOB_LOG_CHAR_LIMIT));
    return {
      text: [
        `[Tool Result — get_job_logs]`,
        `Job: ${meta.name || `#${jobId}`} — ${meta.conclusion || meta.status || 'unknown'}`,
        tailed.truncated ? `(showing last ${tailN} lines)` : '',
        safe.redacted ? 'Redactions: secret-like values hidden.' : '',
        '',
        '```',
        safe.text,
        '```',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }

  if (typeof runId !== 'number') {
    throw new Error(
      'get_job_logs requires either run_id (a workflow run) or job_id (a single job).',
    );
  }

  // Paginate the jobs list: a large matrix run can exceed one page, and a
  // failure on a later page would otherwise be invisible (false "No failed
  // jobs"). Walk Link pages up to a sane cap before filtering.
  const allJobs: WorkflowJobSummaryApi[] = [];
  let jobsPage = 0;
  let jobsUrl: string | null = buildGitHubApiUrl(
    runtime,
    `/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`,
  );
  while (jobsUrl && jobsPage < JOB_LIST_MAX_PAGES) {
    const jobsRes = await runtime.githubFetch(jobsUrl, { headers });
    if (!jobsRes.ok) {
      throw new Error(formatGitHubError(jobsRes.status, `jobs for run #${runId} on ${repo}`));
    }
    const jobsData = (await jobsRes.json()) as { jobs?: WorkflowJobSummaryApi[] };
    if (jobsData.jobs) allJobs.push(...jobsData.jobs);
    jobsUrl = parseNextLink(jobsRes.headers.get('Link'));
    jobsPage += 1;
  }
  const candidates = failedOnly
    ? allJobs.filter((job) => FAILED_JOB_CONCLUSIONS.has(job.conclusion || ''))
    : allJobs;

  if (candidates.length === 0) {
    return {
      text: `[Tool Result — get_job_logs]\n${failedOnly ? 'No failed jobs' : 'No jobs'} found for run #${runId} on ${repo}.${failedOnly && allJobs.length > 0 ? ' Pass failed_only: false to see all jobs.' : ''}`,
    };
  }

  const selected = candidates.slice(0, JOB_LOG_MAX_JOBS);
  const blocks: string[] = [
    `[Tool Result — get_job_logs]`,
    `Run #${runId} on ${repo} — ${selected.length} job${selected.length > 1 ? 's' : ''}${failedOnly ? ' (failed only)' : ''}, last ${tailN} lines each:`,
  ];
  let anyRedacted = false;
  for (const job of selected) {
    blocks.push('', `── ${job.name} (${job.conclusion || job.status}) ──`);
    const raw = await fetchJobLogText(runtime, repo, job.id);
    if (raw === null) {
      blocks.push('(logs unavailable — may have expired)');
      continue;
    }
    const tailed = tailLines(raw.slice(-JOB_LOG_CHAR_LIMIT * 2), tailN);
    const safe = runtime.redactSensitiveText(tailed.text.slice(-JOB_LOG_CHAR_LIMIT));
    anyRedacted ||= safe.redacted;
    blocks.push('```', safe.text, '```');
  }
  if (candidates.length > JOB_LOG_MAX_JOBS) {
    blocks.push(
      '',
      `(${candidates.length - JOB_LOG_MAX_JOBS} more job(s) not shown — pass job_id to target one.)`,
    );
  }
  if (anyRedacted) blocks.push('', 'Redactions: secret-like values hidden.');
  return { text: blocks.join('\n') };
}

// ---------------------------------------------------------------------------
// Issues (read + write). The /issues list and item endpoints also serve PRs;
// list filters PRs out, get/comment/update operate on both (a PR IS an issue
// API-side, which is exactly why add_issue_comment works on PRs too).
// ---------------------------------------------------------------------------

const ISSUE_BODY_CHAR_LIMIT = 8000;
const ISSUE_COMMENT_CHAR_LIMIT = 2000;
/** Cap the issues-list pagination walk (per_page=100, so 10 pages = 1000 items). */
const LIST_ISSUES_MAX_PAGES = 10;

function labelNames(labels: IssueLabelApi[] | undefined): string[] {
  return (labels || [])
    .map((label) => (typeof label === 'string' ? label : label?.name))
    .filter((name): name is string => Boolean(name));
}

export async function executeListIssuesTool(
  runtime: GitHubCoreRuntime,
  repo: string,
  state: string = 'open',
  labels?: string,
  count?: number,
): Promise<GitHubCoreToolResult> {
  const headers = runtime.buildHeaders(DEFAULT_ACCEPT);
  const limit = Math.max(1, Math.min(count || 20, 50));
  // The /issues endpoint mixes issues and PRs and we filter PRs out client-side,
  // so a PR-heavy page could hide real issues. Walk Link pages (per_page=100)
  // until we've collected `limit` non-PR issues or run out of pages — stops
  // after the first page on a normal repo, only paginates when PRs crowd it out.
  const collected: IssueListItemApi[] = [];
  let issuesPage = 0;
  let nextUrl: string | null = (() => {
    const base = buildGitHubApiUrl(
      runtime,
      `/repos/${repo}/issues?state=${encodeURIComponent(state)}&per_page=100`,
    );
    return labels ? `${base}&labels=${encodeURIComponent(labels)}` : base;
  })();

  while (nextUrl && issuesPage < LIST_ISSUES_MAX_PAGES && collected.length < limit) {
    const res = await runtime.githubFetch(nextUrl, { headers });
    if (!res.ok) {
      throw new Error(formatGitHubError(res.status, `issues on ${repo}`));
    }
    const pageData = await res.json();
    if (!Array.isArray(pageData)) break;
    for (const issue of pageData as IssueListItemApi[]) {
      if (!issue.pull_request) collected.push(issue);
    }
    nextUrl = parseNextLink(res.headers.get('Link'));
    issuesPage += 1;
  }
  const issues = collected.slice(0, limit);

  if (issues.length === 0) {
    return {
      text: `[Tool Result — list_issues]\nNo ${state} issues found on ${repo}${labels ? ` with labels "${labels}"` : ''}.`,
    };
  }

  const lines: string[] = [
    `[Tool Result — list_issues]`,
    `${issues.length} ${state} issue${issues.length > 1 ? 's' : ''} on ${repo}:`,
    '',
  ];
  for (const issue of issues) {
    const names = labelNames(issue.labels);
    lines.push(`  #${issue.number} ${issue.title}`);
    lines.push(
      `    by ${issue.user?.login || 'unknown'} | ${issue.comments ?? 0} comment(s)${names.length ? ` | labels: ${names.join(', ')}` : ''}`,
    );
  }
  return { text: lines.join('\n') };
}

export async function executeGetIssueTool(
  runtime: GitHubCoreRuntime,
  repo: string,
  issueNumber: number,
): Promise<GitHubCoreToolResult> {
  const headers = runtime.buildHeaders(DEFAULT_ACCEPT);
  const [issueRes, commentsRes] = await Promise.all([
    runtime.githubFetch(buildGitHubApiUrl(runtime, `/repos/${repo}/issues/${issueNumber}`), {
      headers,
    }),
    runtime.githubFetch(
      buildGitHubApiUrl(runtime, `/repos/${repo}/issues/${issueNumber}/comments?per_page=10`),
      { headers },
    ),
  ]);

  if (!issueRes.ok) {
    throw new Error(formatGitHubError(issueRes.status, `issue #${issueNumber} on ${repo}`));
  }
  const issue = (await issueRes.json()) as IssueDetailApi;
  const comments = commentsRes.ok ? ((await commentsRes.json()) as IssueCommentApi[]) : [];
  const names = labelNames(issue.labels);
  const kind = issue.pull_request ? 'PR' : 'Issue';

  const body = (issue.body || '').trim();
  const lines: string[] = [
    `[Tool Result — get_issue]`,
    `${kind} #${issue.number}: ${issue.title}`,
    `State: ${issue.state} | by ${issue.user?.login || 'unknown'}${names.length ? ` | labels: ${names.join(', ')}` : ''}`,
    `URL: ${issue.html_url}`,
    '',
    body ? body.slice(0, ISSUE_BODY_CHAR_LIMIT) : '(no description)',
  ];
  if (body.length > ISSUE_BODY_CHAR_LIMIT) lines.push('… (body truncated)');

  if (comments.length) {
    const total = issue.comments ?? comments.length;
    lines.push(
      '',
      `Comments (${comments.length}${total > comments.length ? ` of ${total}` : ''}):`,
    );
    for (const comment of comments) {
      const text = (comment.body || '').trim();
      lines.push(
        '',
        `— ${comment.user?.login || 'unknown'}:`,
        text.slice(0, ISSUE_COMMENT_CHAR_LIMIT) +
          (text.length > ISSUE_COMMENT_CHAR_LIMIT ? ' …' : ''),
      );
    }
  }
  return { text: lines.join('\n') };
}

export async function executeAddIssueCommentTool(
  runtime: GitHubCoreRuntime,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<GitHubCoreToolResult> {
  const headers = runtime.buildHeaders(DEFAULT_ACCEPT);
  const res = await runtime.githubFetch(
    buildGitHubApiUrl(runtime, `/repos/${repo}/issues/${issueNumber}/comments`),
    {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    },
  );
  if (res.status === 404) {
    throw new Error(`Issue/PR #${issueNumber} not found on ${repo}.`);
  }
  if (!res.ok) {
    throw new Error(formatGitHubError(res.status, `commenting on #${issueNumber} on ${repo}`));
  }
  const data = (await res.json()) as { html_url?: string };
  return {
    text: [
      `[Tool Result — add_issue_comment]`,
      `Comment posted on #${issueNumber} on ${repo}.`,
      data.html_url ? `URL: ${data.html_url}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

export async function executeCreateIssueTool(
  runtime: GitHubCoreRuntime,
  repo: string,
  title: string,
  body?: string,
  labels?: string[],
): Promise<GitHubCoreToolResult> {
  const headers = runtime.buildHeaders(DEFAULT_ACCEPT);
  const payload: Record<string, unknown> = { title };
  if (body) payload.body = body;
  if (labels && labels.length) payload.labels = labels;

  const res = await runtime.githubFetch(buildGitHubApiUrl(runtime, `/repos/${repo}/issues`), {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.status === 410) {
    throw new Error(`Issues are disabled on ${repo}.`);
  }
  if (!res.ok) {
    throw new Error(formatGitHubError(res.status, `creating issue on ${repo}`));
  }
  const data = (await res.json()) as { number?: number; html_url?: string };
  return {
    text: [
      `[Tool Result — create_issue]`,
      `Issue #${data.number} created on ${repo}.`,
      `Title: ${title}`,
      data.html_url ? `URL: ${data.html_url}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

export async function executeUpdateIssueTool(
  runtime: GitHubCoreRuntime,
  repo: string,
  issueNumber: number,
  title?: string,
  body?: string,
  state?: string,
  labels?: string[],
): Promise<GitHubCoreToolResult> {
  const headers = runtime.buildHeaders(DEFAULT_ACCEPT);
  const payload: Record<string, unknown> = {};
  if (title !== undefined) payload.title = title;
  if (body !== undefined) payload.body = body;
  if (state !== undefined) payload.state = state;
  if (labels !== undefined) payload.labels = labels;
  if (Object.keys(payload).length === 0) {
    throw new Error(
      'update_issue requires at least one field to change (title, body, state, or labels).',
    );
  }

  const res = await runtime.githubFetch(
    buildGitHubApiUrl(runtime, `/repos/${repo}/issues/${issueNumber}`),
    {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
  if (res.status === 404) {
    throw new Error(`Issue #${issueNumber} not found on ${repo}.`);
  }
  if (!res.ok) {
    throw new Error(formatGitHubError(res.status, `updating issue #${issueNumber} on ${repo}`));
  }
  const data = (await res.json()) as { state?: string; html_url?: string };
  return {
    text: [
      `[Tool Result — update_issue]`,
      `Issue #${issueNumber} updated on ${repo}.`,
      `State: ${data.state || 'unchanged'}`,
      data.html_url ? `URL: ${data.html_url}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

export async function executeUpdatePullRequestTool(
  runtime: GitHubCoreRuntime,
  repo: string,
  prNumber: number,
  title?: string,
  body?: string,
  base?: string,
  state?: string,
): Promise<GitHubCoreToolResult> {
  const headers = runtime.buildHeaders(DEFAULT_ACCEPT);
  const payload: Record<string, unknown> = {};
  if (title !== undefined) payload.title = title;
  if (body !== undefined) payload.body = body;
  if (base !== undefined) payload.base = base;
  if (state !== undefined) payload.state = state;
  if (Object.keys(payload).length === 0) {
    throw new Error(
      'update_pull_request requires at least one field to change (title, body, base, or state).',
    );
  }

  const res = await runtime.githubFetch(
    buildGitHubApiUrl(runtime, `/repos/${repo}/pulls/${prNumber}`),
    {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
  if (res.status === 404) {
    throw new Error(`PR #${prNumber} not found on ${repo}.`);
  }
  if (res.status === 422) {
    const errorData = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(
      `Could not update PR #${prNumber}: ${errorData?.message || 'validation failed (check the base branch exists)'}`,
    );
  }
  if (!res.ok) {
    throw new Error(formatGitHubError(res.status, `updating PR #${prNumber} on ${repo}`));
  }
  const data = (await res.json()) as { state?: string; html_url?: string };
  return {
    text: [
      `[Tool Result — update_pull_request]`,
      `PR #${prNumber} updated on ${repo}.`,
      `State: ${data.state || 'unchanged'}`,
      data.html_url ? `URL: ${data.html_url}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

// ---------------------------------------------------------------------------
// CI control — re-run failed jobs / cancel a run
// ---------------------------------------------------------------------------

export async function executeRerunFailedJobsTool(
  runtime: GitHubCoreRuntime,
  repo: string,
  runId: number,
): Promise<GitHubCoreToolResult> {
  const headers = runtime.buildHeaders(DEFAULT_ACCEPT);
  const res = await runtime.githubFetch(
    buildGitHubApiUrl(runtime, `/repos/${repo}/actions/runs/${runId}/rerun-failed-jobs`),
    { method: 'POST', headers },
  );
  if (res.status === 403) {
    throw new Error(
      `Cannot re-run jobs for run #${runId} on ${repo} (token lacks actions:write, or the run is not re-runnable).`,
    );
  }
  if (!res.ok) {
    throw new Error(
      formatGitHubError(res.status, `re-running failed jobs for run #${runId} on ${repo}`),
    );
  }
  return {
    text: [
      `[Tool Result — rerun_failed_jobs]`,
      `Re-run of failed jobs requested for run #${runId} on ${repo}.`,
      `Watch progress with get_workflow_runs or fetch_checks.`,
    ].join('\n'),
  };
}

export async function executeCancelWorkflowRunTool(
  runtime: GitHubCoreRuntime,
  repo: string,
  runId: number,
): Promise<GitHubCoreToolResult> {
  const headers = runtime.buildHeaders(DEFAULT_ACCEPT);
  const res = await runtime.githubFetch(
    buildGitHubApiUrl(runtime, `/repos/${repo}/actions/runs/${runId}/cancel`),
    { method: 'POST', headers },
  );
  if (res.status === 409) {
    throw new Error(
      `Run #${runId} on ${repo} cannot be cancelled (it has already completed or is not in a cancellable state).`,
    );
  }
  if (!res.ok) {
    throw new Error(formatGitHubError(res.status, `cancelling run #${runId} on ${repo}`));
  }
  return {
    text: [
      `[Tool Result — cancel_workflow_run]`,
      `Cancellation requested for run #${runId} on ${repo}.`,
    ].join('\n'),
  };
}

// ---------------------------------------------------------------------------
// Security alerts (read-only). 404 = the feature isn't enabled on the repo or
// the token lacks the security_events scope — reported as a soft message, not
// an error, so the agent can move on. Secret-scanning deliberately surfaces
// only alert metadata (type/state/location), never the raw `secret` value.
// ---------------------------------------------------------------------------

function formatSecurityFeatureDisabled(tool: string, repo: string, feature: string): string {
  return `[Tool Result — ${tool}]\n${feature} is not enabled on ${repo}, or the token lacks the security_events scope. No alerts accessible.`;
}

export async function executeListCodeScanningAlertsTool(
  runtime: GitHubCoreRuntime,
  repo: string,
  state: string = 'open',
  ref?: string,
): Promise<GitHubCoreToolResult> {
  const headers = runtime.buildHeaders(DEFAULT_ACCEPT);
  let url = buildGitHubApiUrl(
    runtime,
    `/repos/${repo}/code-scanning/alerts?state=${encodeURIComponent(state)}&per_page=30`,
  );
  if (ref) url += `&ref=${encodeURIComponent(ref)}`;

  const res = await runtime.githubFetch(url, { headers });
  if (res.status === 404) {
    return {
      text: formatSecurityFeatureDisabled('list_code_scanning_alerts', repo, 'Code scanning'),
    };
  }
  if (!res.ok) {
    throw new Error(formatGitHubError(res.status, `code scanning alerts on ${repo}`));
  }
  const data = (await res.json()) as CodeScanningAlertApi[];
  const alerts = Array.isArray(data) ? data : [];
  if (alerts.length === 0) {
    return {
      text: `[Tool Result — list_code_scanning_alerts]\nNo ${state} code scanning alerts on ${repo}.`,
    };
  }
  const lines: string[] = [
    `[Tool Result — list_code_scanning_alerts]`,
    `${alerts.length} ${state} code scanning alert${alerts.length > 1 ? 's' : ''} on ${repo}:`,
    '',
  ];
  for (const alert of alerts) {
    const loc = alert.most_recent_instance?.location;
    lines.push(
      `  #${alert.number} [${alert.rule?.severity || 'unknown'}] ${alert.rule?.description || alert.rule?.id || 'rule'}`,
    );
    lines.push(
      `    ${alert.tool?.name || 'tool'}${loc?.path ? ` | ${loc.path}${loc.start_line ? `:${loc.start_line}` : ''}` : ''} | ${alert.html_url}`,
    );
  }
  return { text: lines.join('\n') };
}

export async function executeListDependabotAlertsTool(
  runtime: GitHubCoreRuntime,
  repo: string,
  state: string = 'open',
): Promise<GitHubCoreToolResult> {
  const headers = runtime.buildHeaders(DEFAULT_ACCEPT);
  const url = buildGitHubApiUrl(
    runtime,
    `/repos/${repo}/dependabot/alerts?state=${encodeURIComponent(state)}&per_page=30`,
  );
  const res = await runtime.githubFetch(url, { headers });
  if (res.status === 404) {
    return {
      text: formatSecurityFeatureDisabled('list_dependabot_alerts', repo, 'Dependabot alerts'),
    };
  }
  if (!res.ok) {
    throw new Error(formatGitHubError(res.status, `dependabot alerts on ${repo}`));
  }
  const data = (await res.json()) as DependabotAlertApi[];
  const alerts = Array.isArray(data) ? data : [];
  if (alerts.length === 0) {
    return {
      text: `[Tool Result — list_dependabot_alerts]\nNo ${state} Dependabot alerts on ${repo}.`,
    };
  }
  const lines: string[] = [
    `[Tool Result — list_dependabot_alerts]`,
    `${alerts.length} ${state} Dependabot alert${alerts.length > 1 ? 's' : ''} on ${repo}:`,
    '',
  ];
  for (const alert of alerts) {
    const severity =
      alert.security_advisory?.severity || alert.security_vulnerability?.severity || 'unknown';
    lines.push(`  #${alert.number} [${severity}] ${alert.dependency?.package?.name || 'package'}`);
    lines.push(
      `    ${alert.security_advisory?.summary || 'vulnerability'}${alert.dependency?.manifest_path ? ` | ${alert.dependency.manifest_path}` : ''} | ${alert.html_url}`,
    );
  }
  return { text: lines.join('\n') };
}

export async function executeListSecretScanningAlertsTool(
  runtime: GitHubCoreRuntime,
  repo: string,
  state: string = 'open',
): Promise<GitHubCoreToolResult> {
  const headers = runtime.buildHeaders(DEFAULT_ACCEPT);
  const url = buildGitHubApiUrl(
    runtime,
    `/repos/${repo}/secret-scanning/alerts?state=${encodeURIComponent(state)}&per_page=30`,
  );
  const res = await runtime.githubFetch(url, { headers });
  if (res.status === 404) {
    return {
      text: formatSecurityFeatureDisabled('list_secret_scanning_alerts', repo, 'Secret scanning'),
    };
  }
  if (!res.ok) {
    throw new Error(formatGitHubError(res.status, `secret scanning alerts on ${repo}`));
  }
  const data = (await res.json()) as SecretScanningAlertApi[];
  const alerts = Array.isArray(data) ? data : [];
  if (alerts.length === 0) {
    return {
      text: `[Tool Result — list_secret_scanning_alerts]\nNo ${state} secret scanning alerts on ${repo}.`,
    };
  }
  // Surface alert metadata only — never the raw `secret` value the API returns.
  const lines: string[] = [
    `[Tool Result — list_secret_scanning_alerts]`,
    `${alerts.length} ${state} secret scanning alert${alerts.length > 1 ? 's' : ''} on ${repo} (secret values withheld):`,
    '',
  ];
  for (const alert of alerts) {
    lines.push(
      `  #${alert.number} ${alert.secret_type_display_name || alert.secret_type || 'secret'} — ${alert.state}${alert.resolution ? ` (${alert.resolution})` : ''}`,
    );
    lines.push(`    ${alert.html_url}`);
  }
  return { text: lines.join('\n') };
}

async function dispatchGitHubCoreToolCall(
  runtime: GitHubCoreRuntime,
  call: GitHubCoreToolCall,
): Promise<GitHubCoreToolResult> {
  switch (call.tool) {
    case 'fetch_pr':
      return executeFetchPRTool(runtime, call.args.repo, call.args.pr);
    case 'list_prs':
      return executeListPRsTool(runtime, call.args.repo, call.args.state);
    case 'list_commits':
      return executeListCommitsTool(runtime, call.args.repo, call.args.count);
    case 'read_file':
      return executeReadFileTool(
        runtime,
        call.args.repo,
        call.args.path,
        call.args.branch,
        call.args.start_line,
        call.args.end_line,
      );
    case 'grep_file':
      return executeGrepFileTool(
        runtime,
        call.args.repo,
        call.args.path,
        call.args.pattern,
        call.args.branch,
      );
    case 'list_directory':
      return executeListDirectoryTool(runtime, call.args.repo, call.args.path, call.args.branch);
    case 'list_branches':
      return executeListBranchesTool(runtime, call.args.repo, call.args.maxBranches ?? 30);
    case 'fetch_checks':
      return executeFetchChecksTool(runtime, call.args.repo, call.args.ref);
    case 'search_files':
      return executeSearchFilesTool(
        runtime,
        call.args.repo,
        call.args.query,
        call.args.path,
        call.args.branch,
      );
    case 'list_commit_files':
      return executeListCommitFilesTool(runtime, call.args.repo, call.args.ref);
    case 'trigger_workflow':
      return executeTriggerWorkflowTool(
        runtime,
        call.args.repo,
        call.args.workflow,
        call.args.ref,
        call.args.inputs,
      );
    case 'get_workflow_runs':
      return executeGetWorkflowRunsTool(
        runtime,
        call.args.repo,
        call.args.workflow,
        call.args.branch,
        call.args.status,
        call.args.count,
      );
    case 'get_workflow_logs':
      return executeGetWorkflowLogsTool(runtime, call.args.repo, call.args.run_id);
    case 'create_pr':
      return executeCreatePRTool(
        runtime,
        call.args.repo,
        call.args.title,
        call.args.body,
        call.args.head,
        call.args.base,
      );
    case 'merge_pr':
      return executeMergePRTool(
        runtime,
        call.args.repo,
        call.args.pr_number,
        call.args.merge_method,
      );
    case 'delete_branch':
      return executeDeleteBranchTool(runtime, call.args.repo, call.args.branch_name);
    case 'check_pr_mergeable':
      return executeCheckPRMergeableTool(runtime, call.args.repo, call.args.pr_number);
    case 'find_existing_pr':
      return executeFindExistingPRTool(
        runtime,
        call.args.repo,
        call.args.head_branch,
        call.args.base_branch,
      );
    case 'get_job_logs':
      return executeGetJobLogsTool(
        runtime,
        call.args.repo,
        call.args.run_id,
        call.args.job_id,
        call.args.failed_only ?? true,
        call.args.tail_lines,
      );
    case 'list_issues':
      return executeListIssuesTool(
        runtime,
        call.args.repo,
        call.args.state,
        call.args.labels,
        call.args.count,
      );
    case 'get_issue':
      return executeGetIssueTool(runtime, call.args.repo, call.args.issue_number);
    case 'add_issue_comment':
      return executeAddIssueCommentTool(
        runtime,
        call.args.repo,
        call.args.issue_number,
        call.args.body,
      );
    case 'create_issue':
      return executeCreateIssueTool(
        runtime,
        call.args.repo,
        call.args.title,
        call.args.body,
        call.args.labels,
      );
    case 'update_issue':
      return executeUpdateIssueTool(
        runtime,
        call.args.repo,
        call.args.issue_number,
        call.args.title,
        call.args.body,
        call.args.state,
        call.args.labels,
      );
    case 'update_pull_request':
      return executeUpdatePullRequestTool(
        runtime,
        call.args.repo,
        call.args.pr_number,
        call.args.title,
        call.args.body,
        call.args.base,
        call.args.state,
      );
    case 'rerun_failed_jobs':
      return executeRerunFailedJobsTool(runtime, call.args.repo, call.args.run_id);
    case 'cancel_workflow_run':
      return executeCancelWorkflowRunTool(runtime, call.args.repo, call.args.run_id);
    case 'list_code_scanning_alerts':
      return executeListCodeScanningAlertsTool(
        runtime,
        call.args.repo,
        call.args.state,
        call.args.ref,
      );
    case 'list_dependabot_alerts':
      return executeListDependabotAlertsTool(runtime, call.args.repo, call.args.state);
    case 'list_secret_scanning_alerts':
      return executeListSecretScanningAlertsTool(runtime, call.args.repo, call.args.state);
  }
}

/**
 * Recursively redact secret-like text in every string value of a card payload,
 * preserving structure. Cards copy raw GitHub fields (PR titles/bodies/comments,
 * commit messages) into structured metadata that the web surface renders and
 * stores, so redacting only the result text would still leak a card-borne
 * secret. A generic walk covers every card type — current and future — without
 * a per-type redaction list that could drift. `redactSensitiveText` only
 * rewrites secret-shaped substrings, so non-secret strings (URLs, SHAs, names)
 * pass through untouched.
 */
function redactCardDeep(
  value: unknown,
  redact: (text: string) => { text: string; redacted: boolean },
): { value: unknown; redacted: boolean } {
  if (typeof value === 'string') {
    const { text, redacted } = redact(value);
    return { value: text, redacted };
  }
  if (Array.isArray(value)) {
    let any = false;
    const out = value.map((entry) => {
      const r = redactCardDeep(entry, redact);
      any ||= r.redacted;
      return r.value;
    });
    return { value: any ? out : value, redacted: any };
  }
  if (value && typeof value === 'object') {
    let any = false;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const r = redactCardDeep(entry, redact);
      any ||= r.redacted;
      out[key] = r.value;
    }
    return { value: any ? out : value, redacted: any };
  }
  return { value, redacted: false };
}

export async function executeGitHubCoreTool(
  runtime: GitHubCoreRuntime,
  call: GitHubCoreToolCall,
): Promise<GitHubCoreToolResult> {
  const result = await dispatchGitHubCoreToolCall(runtime, call);
  // Defense-in-depth secret redaction at the single dispatch chokepoint. All
  // GitHub-API text — PR/issue bodies, comments, titles, commit messages,
  // branch names — is attacker-controlled and may carry a pasted secret. Most
  // tools don't redact it themselves (only file-content and CI-log tools do),
  // and only the MCP surface wraps results in a blanket redactor; the web
  // Worker/local and CLI return this verbatim. Redacting here covers every
  // surface uniformly (behavior in code, not per-surface), and both the result
  // text AND the structured card (which the web renders/stores). Idempotent for
  // the tools that already redact internally — re-running finds nothing new.
  const { text: redactedText } = runtime.redactSensitiveText(result.text);
  // Envelope-integrity sanitization (#1080) at the same chokepoint, AFTER
  // redaction — mirroring the MCP path (which already does redact → sanitize).
  // Attacker-controlled GitHub text can carry [TOOL_RESULT]/[meta]/[CODER_STATE]
  // markers or a fenced JSON tool-call shape to break out of the agent's result
  // envelope; sanitizing here means the web Worker/local and CLI inherit the
  // guard too, not just MCP. Idempotent, and it only neutralizes the dangerous
  // infrastructure markers — the tools' own `[Tool Result — …]` headers survive.
  //
  // Text-only (not the card): the card is structured data the web renders
  // (React-escaped) and stores, never fed into the model's envelope text stream,
  // so envelope markers there can't break out. The card still gets secret
  // REDACTION below (a leakage concern, which is different).
  //
  // File-content tools (read_file/grep_file) get boundary escaping only, NOT the
  // JSON-tool-call defang: their text is verbatim repository content, and
  // defanging would silently rewrite a legitimate `"tool":` key in a config or
  // schema file — leaving the agent reasoning over source that no longer matches
  // GitHub while the editor card still holds the original. The envelope-breakout
  // markers are still escaped (a malicious file can carry a `[/TOOL_RESULT]`
  // literal), which is the part that matters for #1080.
  const text = FILE_CONTENT_TOOLS.has(call.tool)
    ? escapeEnvelopeBoundaries(redactedText)
    : sanitizeUntrustedSource(redactedText);
  const textChanged = text !== result.text;
  if (!result.card) {
    return textChanged ? { ...result, text } : result;
  }
  const card = redactCardDeep(result.card, runtime.redactSensitiveText);
  if (!textChanged && !card.redacted) return result;
  return { ...result, text, card: card.value as GitHubCoreCard };
}
