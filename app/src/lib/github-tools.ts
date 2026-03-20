/**
 * Prompt-engineered tool protocol for GitHub API access.
 *
 * The LLM outputs a JSON block when it wants to call a tool.
 * We detect it, execute against the GitHub API, and inject the
 * result back into the conversation as a synthetic message.
 */

import type {
  ToolExecutionResult,
  PRCardData,
  PRListCardData,
  CommitListCardData,
  BranchListCardData,
  FileListCardData,
  CICheck,
  CIOverallStatus,
  CIStatusCardData,
  FileSearchCardData,
  FileSearchMatch,
  CommitFilesCardData,
  WorkflowRunItem,
  WorkflowRunsCardData,
  WorkflowJob,
  WorkflowLogsCardData,
  ReviewResult,
  AcceptanceCriterion,
  CoderDelegationArgs,
  ExplorerDelegationArgs,
} from '@/types';
import { asRecord, detectToolFromText } from './utils';
import { getGitHubAuthHeaders as getGitHubHeaders } from './github-auth';
import {
  filterSensitiveDirectoryEntries,
  formatSensitivePathToolError,
  isSensitivePath,
  redactSensitiveText,
} from './sensitive-data-guard';
import {
  getToolProtocolEntries,
  getToolPublicName,
  getToolPublicNames,
  resolveToolName,
  getToolSourceFromName,
} from './tool-registry';

// --- Tool types ---

export type ToolCall =
  | { tool: 'fetch_pr'; args: { repo: string; pr: number } }
  | { tool: 'list_prs'; args: { repo: string; state?: string } }
  | { tool: 'list_commits'; args: { repo: string; count?: number } }
  | { tool: 'read_file'; args: { repo: string; path: string; branch?: string; start_line?: number; end_line?: number } }
  | { tool: 'grep_file'; args: { repo: string; path: string; pattern: string; branch?: string } }
  | { tool: 'list_directory'; args: { repo: string; path?: string; branch?: string } }
  | { tool: 'list_branches'; args: { repo: string } }
  | { tool: 'delegate_coder'; args: CoderDelegationArgs }
  | { tool: 'delegate_explorer'; args: ExplorerDelegationArgs }
  | { tool: 'fetch_checks'; args: { repo: string; ref?: string } }
  | { tool: 'search_files'; args: { repo: string; query: string; path?: string; branch?: string } }
  | { tool: 'list_commit_files'; args: { repo: string; ref: string } }
  | { tool: 'trigger_workflow'; args: { repo: string; workflow: string; ref?: string; inputs?: Record<string, string> } }
  | { tool: 'get_workflow_runs'; args: { repo: string; workflow?: string; branch?: string; status?: string; count?: number } }
  | { tool: 'get_workflow_logs'; args: { repo: string; run_id: number } }
  | { tool: 'create_pr'; args: { repo: string; title: string; body: string; head: string; base: string } }
  | { tool: 'merge_pr'; args: { repo: string; pr_number: number; merge_method?: string } }
  | { tool: 'delete_branch'; args: { repo: string; branch_name: string } }
  | { tool: 'check_pr_mergeable'; args: { repo: string; pr_number: number } }
  | { tool: 'find_existing_pr'; args: { repo: string; head_branch: string; base_branch?: string } };

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asTrimmedStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

/** Parse a positive integer arg (1-based line numbers). Returns undefined if absent, null if invalid. */
function asPositiveInt(value: unknown): number | undefined | null {
  if (value === undefined || value === null) return undefined;
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim().length > 0 ? Number(value) : Number.NaN;
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}


// --- Enhanced error messages ---

function formatGitHubError(status: number, context: string, branch?: string): string {
  switch (status) {
    case 404: {
      const branchHint = branch ? ` on branch "${branch}"` : '';
      return `[Tool Error] Not found: ${context}${branchHint}. The file may not exist, the path might be incorrect, or the branch may be different. Try list_directory to browse, or list_branches to see available branches.`;
    }
    case 403:
      return `[Tool Error] Access forbidden (403) for ${context}. Your GitHub token may lack permissions, or you have hit API rate limits. Check your token in Settings.`;
    case 429:
      return `[Tool Error] Rate limited (429) for ${context}. GitHub is throttling requests. The system will retry automatically, or check your token status.`;
    case 401:
      return `[Tool Error] Unauthorized (401) for ${context}. Your GitHub token is invalid or expired. Re-authenticate in Settings.`;
    case 500:
    case 502:
    case 503:
      return `[Tool Error] GitHub server error (${status}) for ${context}. This is temporary — retry shortly.`;
    default:
      return `[Tool Error] GitHub API returned ${status} for ${context}`;
  }
}


const GITHUB_TIMEOUT_MS = 15_000; // 15s timeout for GitHub API calls
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000; // 1s initial delay for exponential backoff
const READ_FILE_RANGE_CHAR_LIMIT = 30_000;
const READ_FILE_FULL_CHAR_LIMIT = 15_000;
const utf8Encoder = new TextEncoder();

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
  for (let i = 0; i < displayLines.length; i++) {
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

// Re-export for consumers that import from this module (e.g. MergeFlowSheet).
export { getGitHubHeaders };

// --- Fetch with timeout and retry ---

function isRetryableError(_error: unknown, status?: number): boolean {
  // Network errors, timeouts, and 5xx server errors are retryable
  if (status !== undefined) {
    // 429 rate limit is retryable
    if (status === 429) return true;
    // 5xx server errors are retryable
    if (status >= 500 && status < 600) return true;
    // 4xx client errors are NOT retryable (except 429 handled above)
    return false;
  }
  // Network errors and timeouts are retryable
  return true;
}

function getRetryDelay(response: Response | undefined, attempt: number): number {
  // Check for Retry-After header (used by GitHub for rate limiting)
  if (response && response.status === 429) {
    const retryAfter = response.headers.get('Retry-After');
    if (retryAfter) {
      const delay = parseInt(retryAfter, 10);
      if (!isNaN(delay)) {
        console.log(`[Push] Rate limited. Waiting ${delay + 1}s (Retry-After header + 1s buffer)`);
        return (delay + 1) * 1000; // Add 1s buffer
      }
    }
  }
  // Exponential backoff: 1s, 2s, 4s
  return BASE_DELAY_MS * Math.pow(2, attempt - 1);
}

async function fetchWithRetry(url: string, options?: RequestInit): Promise<Response> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GITHUB_TIMEOUT_MS);

    try {
      const response = await fetch(url, { ...options, signal: controller.signal });

      // Check if we should retry based on status code
      if (!response.ok && isRetryableError(null, response.status)) {
        if (attempt < MAX_RETRIES) {
          const delay = getRetryDelay(response, attempt + 1);
          console.log(`[Push] GitHub API retry ${attempt + 1}/${MAX_RETRIES}: ${response.status} ${response.statusText}, waiting ${delay}ms`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
      }

      return response;
    } catch (err) {
      const isTimeout = err instanceof DOMException && err.name === 'AbortError';
      const errorMsg = isTimeout
        ? `GitHub API timed out after ${GITHUB_TIMEOUT_MS / 1000}s — check your connection.`
        : err instanceof Error ? err.message : String(err);

      lastError = new Error(errorMsg);

      // Check if we should retry
      if (attempt < MAX_RETRIES && isRetryableError(err)) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        console.log(`[Push] GitHub API retry ${attempt + 1}/${MAX_RETRIES}: ${errorMsg}, waiting ${delay}ms`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      // Don't retry - rethrow
      throw lastError;
    } finally {
      clearTimeout(timer);
    }
  }

  // All retries exhausted
  throw lastError || new Error(`GitHub API failed after ${MAX_RETRIES} retries`);
}

export async function githubFetch(url: string, options?: RequestInit): Promise<Response> {
  return fetchWithRetry(url, options);
}

interface RepoBranchApi {
  name?: string;
  protected?: boolean;
}

function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

export async function fetchRepoBranches(
  repo: string,
  maxBranches: number = 500,
): Promise<{ defaultBranch: string; branches: BranchListCardData['branches'] }> {
  const headers = getGitHubHeaders();

  const repoRes = await githubFetch(`https://api.github.com/repos/${repo}`, { headers });
  if (!repoRes.ok) {
    throw new Error(formatGitHubError(repoRes.status, `repo info for ${repo}`));
  }
  const repoData = await repoRes.json();
  const defaultBranch = repoData?.default_branch || 'main';

  const pageSize = 100;
  const maxPages = Math.max(1, Math.ceil(maxBranches / pageSize));
  const all: RepoBranchApi[] = [];
  let pageCount = 0;
  let nextUrl: string | null = `https://api.github.com/repos/${repo}/branches?per_page=${pageSize}&page=1`;

  while (nextUrl && pageCount < maxPages && all.length < maxBranches) {
    const res = await githubFetch(nextUrl, { headers });
    if (!res.ok) {
      throw new Error(formatGitHubError(res.status, `branches on ${repo}`));
    }
    const pageData = await res.json();
    if (!Array.isArray(pageData)) break;
    all.push(...(pageData as RepoBranchApi[]));
    nextUrl = parseNextLink(res.headers.get('Link'));
    pageCount++;
  }

  const branchItems: BranchListCardData['branches'] = all
    .filter((b) => typeof b.name === 'string' && b.name.trim().length > 0)
    .map((b) => ({
      name: b.name as string,
      isDefault: b.name === defaultBranch,
      isProtected: Boolean(b.protected),
    }))
    .sort((a, b) => {
      if (a.name === defaultBranch) return -1;
      if (b.name === defaultBranch) return 1;
      return a.name.localeCompare(b.name);
    });

  return { defaultBranch, branches: branchItems };
}

// --- Detection helpers ---

function validateToolCall(parsed: unknown): ToolCall | null {
  const parsedObj = asRecord(parsed);
  if (!parsedObj) return null;
  const tool = resolveToolName(asString(parsedObj.tool));
  const args = asRecord(parsedObj.args);
  if (!tool || !args) return null;
  const source = getToolSourceFromName(tool);
  if (source !== 'github' && source !== 'delegate') return null;

  const repo = asString(args.repo);
  const branch = asString(args.branch);

  if (tool === 'fetch_pr' && repo && args.pr !== undefined) {
    return { tool: 'fetch_pr', args: { repo, pr: Number(args.pr) } };
  }
  if (tool === 'list_prs' && repo) {
    return { tool: 'list_prs', args: { repo, state: asString(args.state) } };
  }
  if (tool === 'list_commits' && repo) {
    return { tool: 'list_commits', args: { repo, count: args.count !== undefined ? Number(args.count) : undefined } };
  }
  if (tool === 'read_file' && repo && asString(args.path)) {
    const startLine = asPositiveInt(args.start_line);
    const endLine = asPositiveInt(args.end_line);
    if (startLine === null || endLine === null) return null; // invalid line args
    if (startLine !== undefined && endLine !== undefined && startLine > endLine) return null;
    return { tool: 'read_file', args: { repo, path: asString(args.path)!, branch, start_line: startLine, end_line: endLine } };
  }
  if (tool === 'grep_file' && repo && asString(args.path) && asString(args.pattern)) {
    return { tool: 'grep_file', args: { repo, path: asString(args.path)!, pattern: asString(args.pattern)!, branch } };
  }
  if (tool === 'list_directory' && repo) {
    return { tool: 'list_directory', args: { repo, path: asString(args.path), branch } };
  }
  if (tool === 'list_branches' && repo) {
    return { tool: 'list_branches', args: { repo } };
  }
  if (tool === 'delegate_coder') {
    const task = asTrimmedString(args.task);
    const tasks = asTrimmedStringArray(args.tasks);
    const files = asTrimmedStringArray(args.files);
    const intent = asTrimmedString(args.intent);
    const deliverable = asTrimmedString(args.deliverable);
    const knownContext = asTrimmedStringArray(args.knownContext);
    const constraints = asTrimmedStringArray(args.constraints);
    let acceptanceCriteria: AcceptanceCriterion[] | undefined;
    if (Array.isArray(args.acceptanceCriteria)) {
      acceptanceCriteria = (args.acceptanceCriteria as unknown[]).filter((c): c is AcceptanceCriterion => {
        const cr = asRecord(c);
        return !!cr && typeof cr.id === 'string' && typeof cr.check === 'string';
      }).map(c => ({
        id: c.id,
        check: c.check,
        exitCode: typeof c.exitCode === 'number' ? c.exitCode : undefined,
        description: typeof c.description === 'string' ? c.description : undefined,
      }));
      if (acceptanceCriteria.length === 0) acceptanceCriteria = undefined;
    }
    if (task || (tasks && tasks.length > 0)) {
      return {
        tool: 'delegate_coder',
        args: {
          task,
          tasks,
          files,
          acceptanceCriteria,
          intent,
          deliverable,
          knownContext: knownContext && knownContext.length > 0 ? knownContext : undefined,
          constraints: constraints && constraints.length > 0 ? constraints : undefined,
        },
      };
    }
  }
  if (tool === 'delegate_explorer') {
    const task = asTrimmedString(args.task);
    const files = asTrimmedStringArray(args.files);
    const intent = asTrimmedString(args.intent);
    const deliverable = asTrimmedString(args.deliverable);
    const knownContext = asTrimmedStringArray(args.knownContext);
    const constraints = asTrimmedStringArray(args.constraints);
    if (task) {
      return {
        tool: 'delegate_explorer',
        args: {
          task,
          files,
          intent,
          deliverable,
          knownContext: knownContext && knownContext.length > 0 ? knownContext : undefined,
          constraints: constraints && constraints.length > 0 ? constraints : undefined,
        },
      };
    }
  }
  if (tool === 'fetch_checks' && repo) {
    return { tool: 'fetch_checks', args: { repo, ref: asString(args.ref) } };
  }
  if (tool === 'search_files' && repo && asString(args.query)) {
    return { tool: 'search_files', args: { repo, query: asString(args.query)!, path: asString(args.path), branch } };
  }
  if (tool === 'list_commit_files' && repo && asString(args.ref)) {
    return { tool: 'list_commit_files', args: { repo, ref: asString(args.ref)! } };
  }
  if (tool === 'trigger_workflow' && repo && asString(args.workflow)) {
    let inputs: Record<string, string> | undefined;
    const rawInputs = asRecord(args.inputs);
    if (rawInputs) {
      inputs = Object.fromEntries(
        Object.entries(rawInputs).filter(([, v]) => typeof v === 'string') as Array<[string, string]>,
      );
    }
    return { tool: 'trigger_workflow', args: { repo, workflow: asString(args.workflow)!, ref: asString(args.ref), inputs } };
  }
  if (tool === 'get_workflow_runs' && repo) {
    return { tool: 'get_workflow_runs', args: { repo, workflow: asString(args.workflow), branch, status: asString(args.status), count: args.count !== undefined ? Number(args.count) : undefined } };
  }
  if (tool === 'get_workflow_logs' && repo && args.run_id !== undefined) {
    return { tool: 'get_workflow_logs', args: { repo, run_id: Number(args.run_id) } };
  }
  if (tool === 'create_pr' && repo && asString(args.title) && asString(args.head) && asString(args.base)) {
    return { tool: 'create_pr', args: { repo, title: asString(args.title)!, body: asString(args.body) ?? '', head: asString(args.head)!, base: asString(args.base)! } };
  }
  if (tool === 'merge_pr' && repo && args.pr_number !== undefined) {
    return { tool: 'merge_pr', args: { repo, pr_number: Number(args.pr_number), merge_method: asString(args.merge_method) } };
  }
  if (tool === 'delete_branch' && repo && asString(args.branch_name)) {
    return { tool: 'delete_branch', args: { repo, branch_name: asString(args.branch_name)! } };
  }
  if (tool === 'check_pr_mergeable' && repo && args.pr_number !== undefined) {
    return { tool: 'check_pr_mergeable', args: { repo, pr_number: Number(args.pr_number) } };
  }
  if (tool === 'find_existing_pr' && repo && asString(args.head_branch)) {
    return { tool: 'find_existing_pr', args: { repo, head_branch: asString(args.head_branch)!, base_branch: asString(args.base_branch) } };
  }
  return null;
}

/**
 * Scans the assistant's response for a JSON tool-call block.
 * Expects the format:
 * ```json
 * {"tool": "fetch_pr", "args": {"repo": "owner/repo", "pr": 42}}
 * ```
 */
export function detectToolCall(text: string): ToolCall | null {
  return detectToolFromText<ToolCall>(text, (parsed) => {
    const parsedObj = asRecord(parsed);
    if (parsedObj?.tool && parsedObj?.args) {
      return validateToolCall(parsed);
    }
    return null;
  });
}

// --- Execution ---

async function executeFetchPR(repo: string, pr: number): Promise<ToolExecutionResult> {
  const headers = getGitHubHeaders();

  // Fetch PR details
  const prRes = await githubFetch(`https://api.github.com/repos/${repo}/pulls/${pr}`, { headers });
  if (!prRes.ok) {
    throw new Error(formatGitHubError(prRes.status, `PR #${pr} on ${repo}`));
  }
  const prData = await prRes.json();

  // Parse PR body for linked issues (Fixes #123, Closes #456, etc.)
  const linkedIssues: { number: number; title?: string }[] = [];
  if (prData.body) {
    const issuePattern = /(?:fixes|closes|resolves|#)\s*#(\d+)/gi;
    const matches = [...prData.body.matchAll(issuePattern)];
    for (const match of matches.slice(0, 3)) {
      linkedIssues.push({ number: parseInt(match[1], 10) });
    }
  }

  // Fetch titles for linked issues (best effort)
  for (const issue of linkedIssues) {
    try {
      const issueRes = await githubFetch(
        `https://api.github.com/repos/${repo}/issues/${issue.number}`,
        { headers }
      );
      if (issueRes.ok) {
        const issueData = await issueRes.json();
        issue.title = issueData.title;
      }
    } catch {
      // Ignore errors for linked issues
    }
  }

  // Fetch recent commits to the PR branch
  let branchCommits: { sha: string; message: string; author: string }[] = [];
  try {
    const commitsRes = await githubFetch(
      `https://api.github.com/repos/${repo}/pulls/${pr}/commits`,
      { headers }
    );
    if (commitsRes.ok) {
      type PRCommitApi = {
        sha: string;
        commit?: { message?: string; author?: { name?: string } };
        author?: { login?: string };
      };
      const commitsData = (await commitsRes.json()) as PRCommitApi[];
      branchCommits = commitsData.slice(0, 5).map((c) => ({
        sha: (c.sha || '').slice(0, 7),
        message: (c.commit?.message || '').split('\n')[0].slice(0, 60),
        author: c.commit?.author?.name || c.author?.login || 'unknown',
      }));
    }
  } catch {
    // Ignore errors for branch commits
  }

  // Fetch diff
  const diffRes = await githubFetch(`https://api.github.com/repos/${repo}/pulls/${pr}`, {
    headers: { ...headers, Accept: 'application/vnd.github.v3.diff' },
  });
  let diff = '';
  if (diffRes.ok) {
    diff = await diffRes.text();
    if (diff.length > 10_000) {
      diff = diff.slice(0, 10_000) + '\n\n[...diff truncated at 10K chars]';
    }
  }

  // Fetch files
  const filesRes = await githubFetch(`https://api.github.com/repos/${repo}/pulls/${pr}/files`, { headers });
  let filesData: { filename: string; status: string; additions: number; deletions: number }[] = [];
  let filesSummary = '';
  if (filesRes.ok) {
    type PRFileApi = { filename: string; status: string; additions: number; deletions: number };
    const files = (await filesRes.json()) as PRFileApi[];
    filesData = files.slice(0, 20).map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
    }));
    filesSummary = filesData
      .map((f) => `  ${f.status} ${f.filename} (+${f.additions} -${f.deletions})`)
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
    const desc = prData.body.length > 500 ? prData.body.slice(0, 500) + '...' : prData.body;
    lines.push(`\nDescription:\n${desc}`);
  }

  if (linkedIssues.length > 0) {
    const issueLines = linkedIssues.map(i => 
      i.title ? `  #${i.number}: ${i.title}` : `  #${i.number}`
    ).join('\n');
    lines.push(`\nLinked Issues:\n${issueLines}`);
  }

  if (branchCommits.length > 0) {
    const commitLines = branchCommits.map(c => 
      `  ${c.sha} — ${c.message}${c.message.length >= 60 ? '...' : ''} (${c.author})`
    ).join('\n');
    lines.push(`\nRecent Commits:\n${commitLines}`);
  }

  if (filesSummary) {
    lines.push(`\nFiles:\n${filesSummary}`);
  }

  if (diff) {
    lines.push(`\n--- Diff ---\n${diff}`);
  }

  const card: PRCardData = {
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
    description: prData.body ? (prData.body.length > 300 ? prData.body.slice(0, 300) + '...' : prData.body) : undefined,
    files: filesData.length > 0 ? filesData : undefined,
  };

  return { text: lines.join('\n'), card: { type: 'pr', data: card } };
}

async function executeListPRs(repo: string, state: string = 'open'): Promise<ToolExecutionResult> {
  const headers = getGitHubHeaders();

  const res = await githubFetch(
    `https://api.github.com/repos/${repo}/pulls?state=${state}&per_page=20&sort=updated&direction=desc`,
    { headers },
  );

  if (!res.ok) {
    throw new Error(formatGitHubError(res.status, `PRs on ${repo}`));
  }

  const prs = await res.json();

  if (prs.length === 0) {
    return { text: `[Tool Result — list_prs]\nNo ${state} PRs found on ${repo}.` };
  }

  const lines: string[] = [
    `[Tool Result — list_prs]`,
    `${prs.length} ${state} PR${prs.length > 1 ? 's' : ''} on ${repo}:\n`,
  ];

  const prItems: PRListCardData['prs'] = [];
  for (const pr of prs) {
    const age = new Date(pr.created_at).toLocaleDateString();
    lines.push(`  #${pr.number} — ${pr.title}`);
    lines.push(`    by ${pr.user.login} | +${pr.additions || '?'} -${pr.deletions || '?'} | ${age}`);
    prItems.push({
      number: pr.number,
      title: pr.title,
      author: pr.user.login,
      additions: pr.additions,
      deletions: pr.deletions,
      createdAt: pr.created_at,
    });
  }

  return {
    text: lines.join('\n'),
    card: { type: 'pr-list', data: { repo, state, prs: prItems } },
  };
}

async function executeListCommits(repo: string, count: number = 10): Promise<ToolExecutionResult> {
  const headers = getGitHubHeaders();

  const res = await githubFetch(
    `https://api.github.com/repos/${repo}/commits?per_page=${Math.min(count, 30)}`,
    { headers },
  );

  if (!res.ok) {
    throw new Error(formatGitHubError(res.status, `commits on ${repo}`));
  }

  const commits = await res.json();

  if (commits.length === 0) {
    return { text: `[Tool Result — list_commits]\nNo commits found on ${repo}.` };
  }

  const lines: string[] = [
    `[Tool Result — list_commits]`,
    `${commits.length} recent commit${commits.length > 1 ? 's' : ''} on ${repo}:\n`,
  ];

  const commitItems: CommitListCardData['commits'] = [];
  for (const c of commits) {
    const sha = c.sha.slice(0, 7);
    const msg = c.commit.message.split('\n')[0];
    const author = c.commit.author?.name || c.author?.login || 'unknown';
    const date = c.commit.author?.date || '';
    lines.push(`  ${sha} ${msg}`);
    lines.push(`    by ${author} | ${new Date(date).toLocaleDateString()}`);
    commitItems.push({ sha: c.sha, message: msg, author, date });
  }

  return {
    text: lines.join('\n'),
    card: { type: 'commit-list', data: { repo, commits: commitItems } },
  };
}

async function executeReadFile(repo: string, path: string, branch?: string, startLine?: number, endLine?: number): Promise<ToolExecutionResult> {
  if (isSensitivePath(path)) {
    return { text: formatSensitivePathToolError(path) };
  }
  const headers = getGitHubHeaders();
  const ref = branch ? `?ref=${encodeURIComponent(branch)}` : '';

  const res = await githubFetch(
    `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path)}${ref}`,
    { headers },
  );

  if (!res.ok) {
    throw new Error(formatGitHubError(res.status, `${path} on ${repo}`, branch));
  }

  const data = await res.json();

  if (Array.isArray(data)) {
    // It's a directory — return an error directing the AI to use list_directory instead
    type ContentEntryApi = { type?: string; name?: string };
    const entries = (data as ContentEntryApi[])
      .map((e) => `  ${e.type === 'dir' ? '📁' : '📄'} ${e.name || 'unknown'}`)
      .join('\n');
    return {
      text: `[Tool Error] "${path}" is a directory, not a file. Use list_directory to browse directories, then read_file on a specific file.\n\nDirectory contents:\n${entries}`,
    };
  }

  if (data.type !== 'file' || !data.content) {
    throw new Error(`${path} is not a readable file`);
  }

  // Decode base64 content
  const fullContent = atob(data.content.replace(/\n/g, ''));

  // Guess language from extension
  const ext = path.split('.').pop()?.toLowerCase() || '';
  const langMap: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', rs: 'rust', go: 'go', rb: 'ruby', java: 'java',
    md: 'markdown', json: 'json', yaml: 'yaml', yml: 'yaml',
    css: 'css', html: 'html', sh: 'shell', bash: 'shell',
    toml: 'toml', sql: 'sql', c: 'c', cpp: 'cpp', h: 'c',
  };
  const language = langMap[ext] || ext;

  const isRangeRead = startLine !== undefined || endLine !== undefined;

  if (isRangeRead) {
    // Line-range read: split into lines, slice the requested range, add line numbers
    const allLines = fullContent.split('\n');
    const totalLines = allLines.length;
    const rangeStart = startLine ?? 1;
    const rangeEnd = endLine ?? totalLines;

    // Slice to requested range (1-indexed → 0-indexed)
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

    const safeRange = redactSensitiveText(sliced.join('\n'));
    const safeRangeLines = safeRange.text.split('\n');

    // Add cat -n style line numbers
    const maxLineNum = rangeStart + sliced.length - 1;
    const padWidth = String(maxLineNum).length;
    const numberedContent = safeRangeLines
      .map((line, idx) => `${String(rangeStart + idx).padStart(padWidth)}\t${line}`)
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
      safeRange.redacted ? `Redactions: secret-like values hidden.` : '',
      truncated ? `(truncated)\n` : '',
      ...truncationLines,
      displayContent,
    ].filter(Boolean);

    return {
      text: lines.join('\n'),
      card: {
        type: 'editor',
        data: { path, content: truncated ? displayContent : safeRangeLines.join('\n'), language, truncated, source: 'github' as const, repo },
      },
    };
  }

  // Full-file read (original behavior)
  const safeFull = redactSensitiveText(fullContent);
  let content = safeFull.text;
  const fullSourceLines = safeFull.text.split('\n');
  const truncatedFull = truncateDisplayLines(fullSourceLines, fullSourceLines, 1, READ_FILE_FULL_CHAR_LIMIT);
  const truncated = truncatedFull.truncated;
  if (truncated) {
    // Count total lines before truncation so the model knows the file size
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
    `Size: ${data.size} bytes | Language: ${language}`,
    safeFull.redacted ? `Redactions: secret-like values hidden.` : '',
    truncated ? `(truncated to 15K chars)\n` : '',
    ...fullTruncationLines,
    `\`\`\`${language}`,
    content,
    '```',
  ];

  return {
    text: lines.join('\n'),
    card: { type: 'editor', data: { path, content, language, truncated, source: 'github' as const, repo } },
  };
}

async function executeGrepFile(repo: string, path: string, pattern: string, branch?: string): Promise<ToolExecutionResult> {
  if (isSensitivePath(path)) {
    return { text: formatSensitivePathToolError(path) };
  }
  const headers = getGitHubHeaders();
  const ref = branch ? `?ref=${encodeURIComponent(branch)}` : '';

  const res = await githubFetch(
    `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path)}${ref}`,
    { headers },
  );

  if (!res.ok) {
    throw new Error(formatGitHubError(res.status, `${path} on ${repo}`, branch));
  }

  const data = await res.json();

  if (Array.isArray(data)) {
    return {
      text: `[Tool Error] "${path}" is a directory. grep_file only works on individual files. Use search_files to search across a directory.`,
    };
  }

  if (data.type !== 'file' || !data.content) {
    throw new Error(`${path} is not a readable file`);
  }

  const fullContent = atob(data.content.replace(/\n/g, ''));
  const safeContent = redactSensitiveText(fullContent);
  const allLines = safeContent.text.split('\n');

  // Try as regex first, fall back to case-insensitive substring
  let matcher: (line: string) => boolean;
  try {
    const regex = new RegExp(pattern, 'i');
    matcher = (line: string) => regex.test(line);
  } catch {
    const lowerPattern = pattern.toLowerCase();
    matcher = (line: string) => line.toLowerCase().includes(lowerPattern);
  }

  // Collect matching lines with 1 line of context above and below
  const matchLineNums = new Set<number>();
  for (let i = 0; i < allLines.length; i++) {
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

  // Build output with context lines (±1 line around each match)
  const contextLineNums = new Set<number>();
  for (const lineNum of matchLineNums) {
    if (lineNum > 0) contextLineNums.add(lineNum - 1);
    contextLineNums.add(lineNum);
    if (lineNum < allLines.length - 1) contextLineNums.add(lineNum + 1);
  }
  const sortedNums = [...contextLineNums].sort((a, b) => a - b);

  // Format with line numbers, grouping contiguous ranges
  const padWidth = String(sortedNums[sortedNums.length - 1] + 1).length;
  const outputLines: string[] = [];
  let prevNum = -2;
  const MAX_OUTPUT_MATCHES = 100;
  let matchesShown = 0;
  for (const num of sortedNums) {
    if (matchLineNums.has(num)) matchesShown++;
    if (matchesShown > MAX_OUTPUT_MATCHES && !matchLineNums.has(num)) continue;
    if (matchesShown > MAX_OUTPUT_MATCHES) {
      outputLines.push(`\n[...truncated — showing first ${MAX_OUTPUT_MATCHES} of ${matchLineNums.size} matches]`);
      break;
    }
    if (num > prevNum + 1 && outputLines.length > 0) {
      outputLines.push('  ---');
    }
    const lineNum1 = num + 1; // 1-indexed
    const marker = matchLineNums.has(num) ? '>' : ' ';
    outputLines.push(`${marker}${String(lineNum1).padStart(padWidth)}\t${allLines[num]}`);
    prevNum = num;
  }

  const lines: string[] = [
    `[Tool Result — grep_file]`,
    `${matchLineNums.size} match${matchLineNums.size !== 1 ? 'es' : ''} for "${pattern}" in ${path}${branch ? ` (branch: ${branch})` : ''} (${allLines.length} lines total)`,
    safeContent.redacted ? `Redactions: secret-like values hidden.` : '',
    '',
    ...outputLines,
  ];

  // Build FileSearchCardData for the UI card
  const matchItems: FileSearchMatch[] = [];
  for (const num of matchLineNums) {
    if (matchItems.length >= 50) break;
    matchItems.push({ path, line: num + 1, content: allLines[num].trim().slice(0, 200) });
  }

  const cardData: FileSearchCardData = {
    repo,
    query: pattern,
    path,
    matches: matchItems,
    totalCount: matchLineNums.size,
    truncated: matchLineNums.size > MAX_OUTPUT_MATCHES,
  };

  return { text: lines.join('\n'), card: { type: 'file-search', data: cardData } };
}

async function executeListDirectory(repo: string, path: string = '', branch?: string): Promise<ToolExecutionResult> {
  if (path && isSensitivePath(path)) {
    return { text: formatSensitivePathToolError(path) };
  }
  const headers = getGitHubHeaders();
  const ref = branch ? `?ref=${encodeURIComponent(branch)}` : '';
  const apiPath = path ? encodeURIComponent(path) : '';

  const res = await githubFetch(
    `https://api.github.com/repos/${repo}/contents/${apiPath}${ref}`,
    { headers },
  );

  if (!res.ok) {
    throw new Error(formatGitHubError(res.status, `path "${path || '/'}" on ${repo}`, branch));
  }

  const data = await res.json();

  if (!Array.isArray(data)) {
    // Single file, not a directory
    return { text: `[Tool Error] "${path}" is a file, not a directory. Use read_file to read its contents.` };
  }

  type ContentEntryApi = { name?: string; type?: string; size?: number };
  const entries = data as ContentEntryApi[];
  const normalizedEntries = entries.map((entry) => ({
    name: entry.name || '',
    type: entry.type,
    size: entry.size,
    path: `${path ? path.replace(/\/$/, '') : ''}/${entry.name || ''}`.replace(/^\/+/, '/'),
  }));
  const filtered = filterSensitiveDirectoryEntries(path || '/', normalizedEntries);
  const dirs = filtered.entries.filter((e) => e.type === 'dir');
  const files = filtered.entries.filter((e) => e.type !== 'dir');

  const lines: string[] = [
    `[Tool Result — list_directory]`,
    `Directory: ${path || '/'} on ${repo}${branch ? ` (branch: ${branch})` : ''}`,
    `${dirs.length} directories, ${files.length} files\n`,
    filtered.hiddenCount > 0 ? `(${filtered.hiddenCount} sensitive entr${filtered.hiddenCount === 1 ? 'y' : 'ies'} hidden)\n` : '',
  ];

  for (const d of dirs) {
    lines.push(`  📁 ${d.name}/`);
  }
  for (const f of files) {
    const size = f.size ? ` (${f.size} bytes)` : '';
    lines.push(`  📄 ${f.name}${size}`);
  }

  const cardData: FileListCardData = {
    repo,
    path: path || '/',
    entries: [
      ...dirs.map((d) => ({ name: d.name || '', type: 'directory' as const })),
      ...files.map((f) => ({ name: f.name || '', type: 'file' as const, size: f.size })),
    ],
  };

  return { text: lines.join('\n'), card: { type: 'file-list', data: cardData } };
}

async function executeListBranches(repo: string): Promise<ToolExecutionResult> {
  const { defaultBranch, branches } = await fetchRepoBranches(repo, 30);

  if (branches.length === 0) {
    return { text: `[Tool Result — list_branches]\nNo branches found on ${repo}.` };
  }

  const lines: string[] = [
    `[Tool Result — list_branches]`,
    `${branches.length} branch${branches.length > 1 ? 'es' : ''} on ${repo} (default: ${defaultBranch}):\n`,
  ];

  for (const b of branches) {
    const marker = b.isDefault ? ' ★' : '';
    const protectedMark = b.isProtected ? ' 🔒' : '';
    lines.push(`  ${b.name}${marker}${protectedMark}`);
  }

  return {
    text: lines.join('\n'),
    card: { type: 'branch-list', data: { repo, defaultBranch, branches } },
  };
}

async function fetchCIStatusSummary(repo: string, ref?: string): Promise<{ overall: CIOverallStatus; checks: CICheck[]; ref: string }> {
  const headers = getGitHubHeaders();

  const commitRef = ref || 'HEAD';
  const checkRunsRes = await githubFetch(
    `https://api.github.com/repos/${repo}/commits/${commitRef}/check-runs?per_page=50`,
    { headers },
  );

  let checks: CICheck[] = [];
  let overall: CIOverallStatus = 'no-checks';

  if (checkRunsRes.ok) {
    const data = await checkRunsRes.json() as { check_runs?: Array<{ name?: string; status?: string; conclusion?: string | null; html_url?: string; details_url?: string }> };
    if (data.check_runs && data.check_runs.length > 0) {
      checks = data.check_runs.map((cr) => ({
        name: cr.name || 'unknown-check',
        status: cr.status as CICheck['status'],
        conclusion: cr.conclusion as CICheck['conclusion'],
        detailsUrl: cr.html_url || cr.details_url,
      }));
    }
  }

  // If no check runs, fall back to combined status API (Travis, etc.)
  if (checks.length === 0) {
    const statusRes = await githubFetch(
      `https://api.github.com/repos/${repo}/commits/${commitRef}/status`,
      { headers },
    );
    if (statusRes.ok) {
      const statusData = await statusRes.json() as { statuses?: Array<{ context?: string; state?: string; target_url?: string }> };
      if (statusData.statuses && statusData.statuses.length > 0) {
        checks = statusData.statuses.map((s) => ({
          name: s.context || 'unknown-check',
          status: 'completed' as const,
          conclusion: s.state === 'success' ? 'success' :
                      s.state === 'failure' || s.state === 'error' ? 'failure' :
                      s.state === 'pending' ? null : 'neutral',
          detailsUrl: s.target_url,
        }));
        // Re-mark pending statuses
        for (const check of checks) {
          if (check.conclusion === null) {
            check.status = 'in_progress';
          }
        }
      }
    }
  }

  // Compute overall status
  if (checks.length === 0) {
    overall = 'no-checks';
  } else if (checks.some((c) => c.status !== 'completed')) {
    overall = 'pending';
  } else if (checks.every((c) => c.conclusion === 'success' || c.conclusion === 'skipped' || c.conclusion === 'neutral')) {
    overall = 'success';
  } else if (checks.some((c) => c.conclusion === 'failure')) {
    overall = 'failure';
  } else {
    overall = 'neutral';
  }

  return { overall, checks, ref: commitRef };
}

async function executeFetchChecks(repo: string, ref?: string): Promise<ToolExecutionResult> {
  const { overall, checks, ref: commitRef } = await fetchCIStatusSummary(repo, ref);

  const cardData: CIStatusCardData = {
    type: 'ci-status',
    repo,
    ref: commitRef,
    checks,
    overall,
    fetchedAt: new Date().toISOString(),
  };

  // Build text summary
  const lines: string[] = [
    `[Tool Result — fetch_checks]`,
    `CI Status for ${repo}@${commitRef}: ${overall.toUpperCase()}`,
  ];

  if (checks.length === 0) {
    lines.push('No CI checks configured for this repo.');
  } else {
    for (const check of checks) {
      const icon = check.conclusion === 'success' ? '✓' :
                   check.conclusion === 'failure' ? '✗' :
                   check.status !== 'completed' ? '⏳' : '—';
      lines.push(`  ${icon} ${check.name}: ${check.conclusion || check.status}`);
    }
  }

  return { text: lines.join('\n'), card: { type: 'ci-status', data: cardData } };
}

async function executeSearchFiles(repo: string, query: string, path?: string, branch?: string): Promise<ToolExecutionResult> {
  if (path && isSensitivePath(path)) {
    return { text: formatSensitivePathToolError(path) };
  }
  const headers = getGitHubHeaders();

  // Use GitHub's code search API
  // Format: query + repo:owner/name + optional path/branch filter
  let searchQuery = `${query} repo:${repo}`;
  if (path) {
    searchQuery += ` path:${path}`;
  }

  // GitHub code search primarily indexes the default branch.
  // When a branch is specified, we use the Contents API search via ref param
  // as a best-effort hint — results may still come from the default branch.
  let searchUrl = `https://api.github.com/search/code?q=${encodeURIComponent(searchQuery)}&per_page=25`;
  if (branch) {
    searchUrl += `&ref=${encodeURIComponent(branch)}`;
  }

  // Use text-match media type to get text_matches in response
  const res = await githubFetch(
    searchUrl,
    { headers: { ...headers, Accept: 'application/vnd.github.v3.text-match+json' } },
  );

  if (!res.ok) {
    // GitHub's code search requires authentication and has rate limits
    if (res.status === 401) {
      throw new Error('GitHub token is invalid or expired — re-authenticate in Settings.');
    }
    if (res.status === 403) {
      // Parse response for specific reason (rate limit vs auth vs scope)
      let detail = '';
      try {
        const errBody = await res.json();
        detail = errBody.message || '';
      } catch { /* ignore parse errors */ }

      if (detail.toLowerCase().includes('rate limit')) {
        throw new Error(`GitHub API rate limit exceeded for code search. Wait a moment and retry.\n${detail}`);
      }
      if (!headers['Authorization']) {
        throw new Error('Code search requires authentication — connect your GitHub account in Settings or set a Personal Access Token.');
      }
      throw new Error(`Code search forbidden (403) — your token may lack the required scope. GitHub says: ${detail || 'no details provided'}`);
    }
    if (res.status === 422) {
      throw new Error('Invalid search query. Try a simpler pattern.');
    }
    throw new Error(`GitHub code search returned ${res.status}`);
  }

  const data = await res.json();
  const totalCount = data.total_count || 0;

  if (totalCount === 0) {
    const hints: string[] = [];

    // Path filter might be too narrow
    if (path) {
      hints.push(`Path is scoped to "${path}". Try without a path filter to search the full repo, or use list_directory(repo, "${path}") to verify the path exists and is correct.`);
    }

    // Detect naming convention and suggest alternatives
    const isCamelOrPascal = /[a-z][A-Z]/.test(query) || /^[A-Z][a-z]/.test(query);
    const isSnakeCase = /_[a-z]/.test(query);
    const isScreamingSnake = /^[A-Z_]+$/.test(query) && query.includes('_');
    if (isCamelOrPascal || isSnakeCase || isScreamingSnake) {
      // Extract a simpler keyword from compound names
      const parts = query
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .split(/[\s_-]+/)
        .filter(p => p.length > 2);
      if (parts.length > 1) {
        hints.push(`Try a partial term like "${parts[parts.length - 1]}" — the codebase may use a different naming convention (camelCase vs snake_case vs PascalCase).`);
      }
    }

    // Multi-word or long queries
    if (query.includes(' ') && !isCamelOrPascal && !isSnakeCase) {
      const shorter = query.split(/\s+/)[0];
      if (shorter && shorter.length > 2) {
        hints.push(`Query may be too specific. Try a shorter term like "${shorter}".`);
      }
    }

    // GitHub indexing caveat
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
        ...hints.map(h => `- ${h}`),
      ].join('\n'),
    };
  }

  // Parse search results — GitHub returns file info with text_matches fragments
  const matches: FileSearchMatch[] = [];
  const truncated = totalCount > 25;
  let hiddenResults = 0;
  let redactedResults = false;

  // Track per-file context fragments for richer output
  const fileContexts = new Map<string, string[]>();

  for (const item of data.items || []) {
    if (typeof item.path === 'string' && isSensitivePath(item.path)) {
      hiddenResults += 1;
      continue;
    }
    // Each item has: name, path, sha, html_url, and text_matches (if available)
    const textMatches = item.text_matches || [];
    if (textMatches.length > 0) {
      const fragments: string[] = [];
      for (const tm of textMatches) {
        // text_matches have fragment (surrounding text) and matches (character offsets)
        const fragment = typeof tm.fragment === 'string' ? tm.fragment : '';
        const safeFragment = redactSensitiveText(fragment);
        redactedResults ||= safeFragment.redacted;
        const fragLines = safeFragment.text.split('\n');
        // Keep the full fragment as context
        if (safeFragment.text.trim()) {
          fragments.push(safeFragment.text.trim());
        }
        for (let i = 0; i < fragLines.length && matches.length < 80; i++) {
          if (fragLines[i].toLowerCase().includes(query.toLowerCase())) {
            matches.push({
              path: item.path,
              line: 0, // GitHub code search doesn't provide absolute line numbers
              content: fragLines[i].trim().slice(0, 300),
            });
          }
        }
      }
      if (fragments.length > 0) {
        fileContexts.set(item.path, fragments);
      }
    } else {
      // No text_matches — just show the file path
      matches.push({
        path: item.path,
        line: 0,
        content: `(match in file)`,
      });
    }
  }

  const lines: string[] = [
    `[Tool Result — search_files]`,
    `Found ${totalCount} file${totalCount !== 1 ? 's' : ''} matching "${query}"${path ? ` in ${path}` : ''}`,
    truncated ? `(showing first 25 results)\n` : '\n',
    hiddenResults > 0 ? `(${hiddenResults} sensitive result${hiddenResults === 1 ? '' : 's'} hidden)\n` : '',
    redactedResults ? `Redactions: secret-like values hidden.\n` : '',
  ];

  // Group by file
  const byFile = new Map<string, FileSearchMatch[]>();
  for (const m of matches) {
    if (!byFile.has(m.path)) byFile.set(m.path, []);
    byFile.get(m.path)!.push(m);
  }

  for (const [filePath, fileMatches] of byFile) {
    lines.push(`📄 ${filePath}`);
    // Show context fragments if available (richer than individual match lines)
    const contexts = fileContexts.get(filePath);
    if (contexts && contexts.length > 0) {
      for (const ctx of contexts.slice(0, 2)) {
        // Indent and show the fragment as a context block
        const ctxLines = ctx.split('\n').slice(0, 5); // Cap at 5 lines per fragment
        for (const cl of ctxLines) {
          lines.push(`    ${cl.slice(0, 200)}`);
        }
        if (ctx.split('\n').length > 5) {
          lines.push(`    ...`);
        }
      }
    } else {
      // Fallback: show individual match lines
      for (const m of fileMatches.slice(0, 5)) {
        if (m.content && m.content !== '(match in file)') {
          lines.push(`    ${m.content}`);
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

  // Add hint for deeper investigation
  if (byFile.size > 0) {
    lines.push('');
    lines.push(`Tip: Use grep_file(repo, path, pattern) to search within a specific file with line numbers and context.`);
  }

  const cardData: FileSearchCardData = {
    repo,
    query,
    path,
    matches: matches.slice(0, 50),
    totalCount,
    truncated,
  };

  return { text: lines.join('\n'), card: { type: 'file-search', data: cardData } };
}

async function executeListCommitFiles(repo: string, ref: string): Promise<ToolExecutionResult> {
  const headers = getGitHubHeaders();

  // Fetch commit details
  const res = await githubFetch(
    `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`,
    { headers },
  );

  if (!res.ok) {
    throw new Error(formatGitHubError(res.status, `commit ${ref} on ${repo}`));
  }

  const commit = await res.json();
  const files = commit.files || [];

  const lines: string[] = [
    `[Tool Result — list_commit_files]`,
    `Commit: ${commit.sha.slice(0, 7)} — ${commit.commit.message.split('\n')[0]}`,
    `Author: ${commit.commit.author?.name || commit.author?.login || 'unknown'}`,
    `Date: ${new Date(commit.commit.author?.date || '').toLocaleDateString()}`,
    `\n${files.length} file${files.length !== 1 ? 's' : ''} changed:\n`,
  ];

  // Calculate totals from ALL files, not just displayed ones
  let totalAdditions = 0;
  let totalDeletions = 0;
  for (const f of files) {
    totalAdditions += f.additions || 0;
    totalDeletions += f.deletions || 0;
  }

  const fileItems: CommitFilesCardData['files'] = [];
  for (const f of files.slice(0, 50)) {
    const icon = f.status === 'added' ? '+' : f.status === 'removed' ? '-' : '~';
    lines.push(`  ${icon} ${f.filename} (+${f.additions} -${f.deletions})`);
    fileItems.push({
      filename: f.filename,
      status: f.status,
      additions: f.additions || 0,
      deletions: f.deletions || 0,
    });
  }

  if (files.length > 50) {
    lines.push(`  ...and ${files.length - 50} more files`);
  }

  lines.push(`\nTotal: +${totalAdditions} -${totalDeletions}`);

  const cardData: CommitFilesCardData = {
    repo,
    ref,
    sha: commit.sha,
    message: commit.commit.message.split('\n')[0],
    author: commit.commit.author?.name || commit.author?.login || 'unknown',
    date: commit.commit.author?.date || '',
    files: fileItems,
    totalChanges: { additions: totalAdditions, deletions: totalDeletions },
  };

  return { text: lines.join('\n'), card: { type: 'commit-files', data: cardData } };
}

async function executeTriggerWorkflow(
  repo: string,
  workflow: string,
  ref?: string,
  inputs?: Record<string, string>,
): Promise<ToolExecutionResult> {
  const headers = getGitHubHeaders();

  // If no ref provided, fetch the repo's default branch
  let targetRef = ref;
  if (!targetRef) {
    const repoRes = await githubFetch(`https://api.github.com/repos/${repo}`, { headers });
    if (repoRes.ok) {
      const repoData = await repoRes.json();
      targetRef = repoData.default_branch || 'main';
    } else {
      targetRef = 'main';
    }
  }

  const body: Record<string, unknown> = { ref: targetRef };
  if (inputs && Object.keys(inputs).length > 0) {
    body.inputs = inputs;
  }

  const res = await githubFetch(
    `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
    {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );

  if (res.status === 404) {
    throw new Error(`[Tool Error] Workflow "${workflow}" not found on ${repo}. Use get_workflow_runs to see available workflows.`);
  }
  if (res.status === 422) {
    throw new Error(`[Tool Error] Workflow "${workflow}" does not have a workflow_dispatch trigger, or the inputs are invalid.`);
  }
  if (!res.ok) {
    throw new Error(formatGitHubError(res.status, `triggering workflow "${workflow}" on ${repo}`));
  }

  // 204 No Content — dispatch accepted, no run ID returned
  return {
    text: [
      `[Tool Result — trigger_workflow]`,
      `Workflow "${workflow}" dispatched on ${repo} (ref: ${targetRef}).`,
      `Note: GitHub returns no run ID for dispatches. Use get_workflow_runs to check if it started.`,
    ].join('\n'),
  };
}

async function executeGetWorkflowRuns(
  repo: string,
  workflow?: string,
  branch?: string,
  status?: string,
  count?: number,
): Promise<ToolExecutionResult> {
  const headers = getGitHubHeaders();
  const perPage = Math.max(1, Math.min(count || 10, 20));

  // Build URL — use workflow-scoped endpoint when workflow specified
  let url: string;
  if (workflow) {
    url = `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?per_page=${perPage}`;
  } else {
    url = `https://api.github.com/repos/${repo}/actions/runs?per_page=${perPage}`;
  }
  if (branch) url += `&branch=${encodeURIComponent(branch)}`;
  if (status) url += `&status=${encodeURIComponent(status)}`;

  const res = await githubFetch(url, { headers });
  if (!res.ok) {
    throw new Error(formatGitHubError(res.status, `workflow runs on ${repo}`));
  }

  const data = await res.json();
  const rawRuns = data.workflow_runs || [];

  type WorkflowRunApi = {
    id: number;
    name: string;
    status: WorkflowRunItem['status'];
    conclusion: WorkflowRunItem['conclusion'];
    head_branch?: string;
    event: string;
    created_at: string;
    updated_at: string;
    html_url: string;
    run_number: number;
    actor?: { login?: string };
  };
  const runs: WorkflowRunItem[] = (rawRuns as WorkflowRunApi[]).map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status,
    conclusion: r.conclusion,
    branch: r.head_branch || '',
    event: r.event,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    htmlUrl: r.html_url,
    runNumber: r.run_number,
    actor: r.actor?.login || 'unknown',
  }));

  if (runs.length === 0) {
    return { text: `[Tool Result — get_workflow_runs]\nNo workflow runs found on ${repo}${workflow ? ` for "${workflow}"` : ''}.` };
  }

  // Build text summary
  const lines: string[] = [
    `[Tool Result — get_workflow_runs]`,
    `${runs.length} recent run${runs.length > 1 ? 's' : ''} on ${repo}${workflow ? ` (workflow: ${workflow})` : ''}:\n`,
  ];

  for (const run of runs) {
    const icon = run.conclusion === 'success' ? '✓' :
                 run.conclusion === 'failure' ? '✗' :
                 run.status !== 'completed' ? '⏳' : '—';
    lines.push(`  ${icon} #${run.runNumber} ${run.name}`);
    lines.push(`    ${run.branch} | ${run.event} | ${run.actor} | ${new Date(run.createdAt).toLocaleDateString()}`);
  }

  const cardData: WorkflowRunsCardData = {
    repo,
    runs,
    workflow,
    truncated: (data.total_count || 0) > perPage,
  };

  return { text: lines.join('\n'), card: { type: 'workflow-runs', data: cardData } };
}

async function executeGetWorkflowLogs(repo: string, runId: number): Promise<ToolExecutionResult> {
  const headers = getGitHubHeaders();

  // Fetch run details and jobs in parallel
  const [runRes, jobsRes] = await Promise.all([
    githubFetch(`https://api.github.com/repos/${repo}/actions/runs/${runId}`, { headers }),
    githubFetch(`https://api.github.com/repos/${repo}/actions/runs/${runId}/jobs?per_page=50`, { headers }),
  ]);

  if (!runRes.ok) {
    throw new Error(formatGitHubError(runRes.status, `workflow run #${runId} on ${repo}`));
  }

  const runData = await runRes.json();
  type WorkflowStepApi = { name: string; status: string; conclusion: string | null; number: number };
  type WorkflowJobApi = { name: string; status: string; conclusion: string | null; html_url: string; steps?: WorkflowStepApi[] };
  const normalizeJobStatus = (status: string): WorkflowJob['status'] =>
    status === 'queued' || status === 'in_progress' || status === 'completed' || status === 'waiting'
      ? status
      : 'completed';
  const normalizeJobConclusion = (value: string | null): WorkflowJob['conclusion'] =>
    value === null || value === 'success' || value === 'failure' || value === 'cancelled' || value === 'skipped'
      ? value
      : null;
  const normalizeStepStatus = (status: string): WorkflowJob['steps'][number]['status'] =>
    status === 'queued' || status === 'in_progress' || status === 'completed'
      ? status
      : 'completed';
  const normalizeStepConclusion = (value: string | null): WorkflowJob['steps'][number]['conclusion'] =>
    value === null || value === 'success' || value === 'failure' || value === 'cancelled' || value === 'skipped'
      ? value
      : null;
  let jobsData: WorkflowJobApi[] = [];
  if (jobsRes.ok) {
    const jd = await jobsRes.json() as { jobs?: WorkflowJobApi[] };
    jobsData = jd.jobs || [];
  }

  const jobs: WorkflowJob[] = jobsData.map((j) => ({
    name: j.name,
    status: normalizeJobStatus(j.status),
    conclusion: normalizeJobConclusion(j.conclusion),
    htmlUrl: j.html_url,
    steps: (j.steps || []).map((s) => ({
      name: s.name,
      status: normalizeStepStatus(s.status),
      conclusion: normalizeStepConclusion(s.conclusion),
      number: s.number,
    })),
  }));

  // Build text summary
  const lines: string[] = [
    `[Tool Result — get_workflow_logs]`,
    `Run: ${runData.name} #${runData.run_number}`,
    `Status: ${runData.status} | Conclusion: ${runData.conclusion || 'pending'}`,
    `Branch: ${runData.head_branch || '—'} | Event: ${runData.event}`,
    `\nJobs (${jobs.length}):\n`,
  ];

  for (const job of jobs) {
    const icon = job.conclusion === 'success' ? '✓' :
                 job.conclusion === 'failure' ? '✗' :
                 job.status !== 'completed' ? '⏳' : '—';
    lines.push(`  ${icon} ${job.name} — ${job.conclusion || job.status}`);
    for (const step of job.steps) {
      const sIcon = step.conclusion === 'success' ? '✓' :
                    step.conclusion === 'failure' ? '✗' :
                    step.status !== 'completed' ? '⏳' : '—';
      lines.push(`      ${sIcon} ${step.number}. ${step.name}`);
    }
  }

  const cardData: WorkflowLogsCardData = {
    runId,
    runName: runData.name,
    runNumber: runData.run_number,
    status: runData.status,
    conclusion: runData.conclusion,
    jobs,
    htmlUrl: runData.html_url,
    repo,
  };

  return { text: lines.join('\n'), card: { type: 'workflow-logs', data: cardData } };
}

export async function executeCreateBranch(repo: string, branchName: string, fromRef?: string): Promise<ToolExecutionResult> {
  const headers = getGitHubHeaders();

  // Determine the source ref — use fromRef if provided, otherwise the repo's default branch
  let sourceRef: string = fromRef || '';
  if (!sourceRef) {
    const repoRes = await githubFetch(`https://api.github.com/repos/${repo}`, { headers });
    if (!repoRes.ok) {
      throw new Error(formatGitHubError(repoRes.status, `repo info for ${repo}`));
    }
    const repoData = await repoRes.json();
    sourceRef = repoData.default_branch || 'main';
  }

  // Get the SHA of the source ref
  const refRes = await githubFetch(
    `https://api.github.com/repos/${repo}/git/ref/heads/${encodeURIComponent(sourceRef)}`,
    { headers },
  );
  if (!refRes.ok) {
    throw new Error(formatGitHubError(refRes.status, `ref "${sourceRef}" on ${repo}`));
  }
  const refData = await refRes.json();
  const sha = refData.object?.sha;
  if (!sha) {
    throw new Error(`[Tool Error] Could not resolve SHA for ref "${sourceRef}" on ${repo}.`);
  }

  // Create the new branch
  const createRes = await githubFetch(
    `https://api.github.com/repos/${repo}/git/refs`,
    {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha }),
    },
  );

  if (createRes.status === 422) {
    throw new Error(`[Tool Error] Branch "${branchName}" already exists on ${repo}.`);
  }
  if (!createRes.ok) {
    throw new Error(formatGitHubError(createRes.status, `creating branch "${branchName}" on ${repo}`));
  }

  return {
    branchSwitch: branchName,
    text: [
      `[Tool Result — create_branch]`,
      `Branch "${branchName}" created on ${repo} from ${sourceRef} (${sha.slice(0, 7)}).`,
    ].join('\n'),
  };
}

export async function executeCreatePR(repo: string, title: string, body: string, head: string, base: string): Promise<ToolExecutionResult> {
  const headers = getGitHubHeaders();

  const res = await githubFetch(
    `https://api.github.com/repos/${repo}/pulls`,
    {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body, head, base }),
    },
  );

  if (res.status === 422) {
    const errorData = await res.json().catch(() => null);
    const detail = errorData?.errors?.[0]?.message || errorData?.message || 'Validation failed';
    throw new Error(`[Tool Error] Could not create PR: ${detail}`);
  }
  if (!res.ok) {
    throw new Error(formatGitHubError(res.status, `creating PR on ${repo}`));
  }

  const prData = await res.json();

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

export async function executeMergePR(repo: string, prNumber: number, mergeMethod?: string): Promise<ToolExecutionResult> {
  const headers = getGitHubHeaders();
  const method = mergeMethod || 'merge';

  const res = await githubFetch(
    `https://api.github.com/repos/${repo}/pulls/${prNumber}/merge`,
    {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ merge_method: method }),
    },
  );

  if (res.status === 405) {
    const errorData = await res.json().catch(() => null);
    const reason = errorData?.message || 'PR cannot be merged (checks may be failing, or conflicts exist).';
    throw new Error(`[Tool Error] Cannot merge PR #${prNumber}: ${reason}`);
  }
  if (res.status === 409) {
    throw new Error(`[Tool Error] Merge conflict on PR #${prNumber}. The head branch is out of date or has conflicts.`);
  }
  if (!res.ok) {
    throw new Error(formatGitHubError(res.status, `merging PR #${prNumber} on ${repo}`));
  }

  const data = await res.json();

  return {
    text: [
      `[Tool Result — merge_pr]`,
      `PR #${prNumber} merged on ${repo} via ${method}.`,
      `Merge SHA: ${data.sha?.slice(0, 7) || 'unknown'}`,
      data.message ? `Message: ${data.message}` : '',
    ].filter(Boolean).join('\n'),
  };
}

export async function executeDeleteBranch(repo: string, branchName: string): Promise<ToolExecutionResult> {
  const headers = getGitHubHeaders();

  const res = await githubFetch(
    `https://api.github.com/repos/${repo}/git/refs/heads/${encodeURIComponent(branchName)}`,
    {
      method: 'DELETE',
      headers,
    },
  );

  if (res.status === 422) {
    throw new Error(`[Tool Error] Branch "${branchName}" not found on ${repo}. Use list_branches to see available branches.`);
  }
  if (!res.ok) {
    throw new Error(formatGitHubError(res.status, `deleting branch "${branchName}" on ${repo}`));
  }

  return {
    text: [
      `[Tool Result — delete_branch]`,
      `Branch "${branchName}" deleted from ${repo}.`,
    ].join('\n'),
  };
}

export async function executeCheckPRMergeable(repo: string, prNumber: number): Promise<ToolExecutionResult> {
  const headers = getGitHubHeaders();

  // Fetch PR details (includes mergeable status)
  const prRes = await githubFetch(
    `https://api.github.com/repos/${repo}/pulls/${prNumber}`,
    { headers },
  );
  if (!prRes.ok) {
    throw new Error(formatGitHubError(prRes.status, `PR #${prNumber} on ${repo}`));
  }
  const prData = await prRes.json();

  const headSha = prData.head?.sha;
  let ciOverall: CIOverallStatus | 'unknown' = 'unknown';
  let ciChecks: CICheck[] = [];
  if (headSha) {
    try {
      const ciStatus = await fetchCIStatusSummary(repo, headSha);
      ciOverall = ciStatus.overall;
      ciChecks = ciStatus.checks;
    } catch {
      // CI check fetch failed — continue with unknown
    }
  }

  const lines: string[] = [
    `[Tool Result — check_pr_mergeable]`,
    `PR #${prNumber}: ${prData.title}`,
    `State: ${prData.state}`,
    `Mergeable: ${prData.mergeable === null ? 'computing (try again shortly)' : prData.mergeable ? 'yes' : 'no'}`,
    `Mergeable state: ${prData.mergeable_state || 'unknown'}`,
    `Branch: ${prData.head?.ref} → ${prData.base?.ref}`,
    `CI status: ${ciOverall.toUpperCase()}`,
  ];

  if (ciChecks.length > 0) {
    lines.push('');
    for (const check of ciChecks) {
      const icon = check.conclusion === 'success' ? '✓' :
                   check.conclusion === 'failure' ? '✗' :
                   check.status !== 'completed' ? '⏳' : '—';
      lines.push(`  ${icon} ${check.name}: ${check.conclusion || check.status}`);
    }
  }

  const canMerge = prData.mergeable === true && prData.state === 'open' && ciOverall !== 'failure';
  lines.push('');
  lines.push(canMerge
    ? 'This PR is eligible for merge.'
    : 'This PR is NOT currently eligible for merge.'
      + (prData.mergeable === false ? ' There are merge conflicts.' : '')
      + (ciOverall === 'failure' ? ' CI checks are failing.' : '')
      + (ciOverall === 'pending' ? ' CI checks are still running.' : '')
      + (prData.state !== 'open' ? ` PR state is "${prData.state}".` : '')
  );

  return { text: lines.join('\n') };
}

export async function executeFindExistingPR(repo: string, headBranch: string, baseBranch?: string): Promise<ToolExecutionResult> {
  const headers = getGitHubHeaders();

  // Extract owner from repo (owner/name format)
  const owner = repo.split('/')[0];
  if (!owner) {
    throw new Error(`[Tool Error] Could not extract owner from repo "${repo}".`);
  }

  const base = baseBranch || 'main';
  const res = await githubFetch(
    `https://api.github.com/repos/${repo}/pulls?head=${encodeURIComponent(`${owner}:${headBranch}`)}&base=${encodeURIComponent(base)}&state=open`,
    { headers },
  );

  if (!res.ok) {
    throw new Error(formatGitHubError(res.status, `searching PRs on ${repo}`));
  }

  const prs = await res.json();

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
      `Branch: ${pr.head?.ref} → ${pr.base?.ref}`,
      `Author: ${pr.user?.login || 'unknown'}`,
      `URL: ${pr.html_url}`,
    ].join('\n'),
  };
}

/**
 * Find the open PR for a branch and return structured data for UI use.
 * Returns null when no token is configured, no PR exists, or the API call fails.
 */
export async function findOpenPRForBranch(
  repo: string,
  headBranch: string,
): Promise<{ number: number; title: string; commitSha: string; url: string } | null> {
  const headers = getGitHubHeaders();
  const owner = repo.split('/')[0];
  if (!owner) return null;

  try {
    const res = await githubFetch(
      `https://api.github.com/repos/${repo}/pulls?head=${encodeURIComponent(`${owner}:${headBranch}`)}&state=open`,
      { headers },
    );
    if (!res.ok) return null;

    const prs = await res.json();
    if (!Array.isArray(prs) || prs.length === 0) return null;

    const pr = prs[0];
    return {
      number: pr.number as number,
      title: typeof pr.title === 'string' ? pr.title : '',
      commitSha: typeof pr.head?.sha === 'string' ? pr.head.sha : '',
      url: typeof pr.html_url === 'string' ? pr.html_url : '',
    };
  } catch {
    return null;
  }
}

export interface RepoPullRequestListItem {
  number: number;
  title: string;
  author: string;
  state: 'open' | 'closed' | 'merged';
  createdAt: string;
  updatedAt: string;
  url: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  comments: number;
  reviewComments: number;
  headRef: string;
  headSha: string;
  baseRef: string;
  isDraft: boolean;
}

export interface RepoPullRequestCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
}

export interface RepoPullRequestFile {
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed';
  additions: number;
  deletions: number;
  patch?: string;
}

export interface RepoPullRequestReviewSummary {
  id: number;
  author: string;
  state: 'approved' | 'changes_requested' | 'commented' | 'dismissed' | 'pending';
  body: string;
  submittedAt: string;
  url: string;
}

export interface RepoPullRequestIssueComment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
  url: string;
}

export interface RepoPullRequestReviewThreadComment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
  url: string;
  line?: number;
}

export interface RepoPullRequestReviewThread {
  id: number;
  file: string;
  line?: number;
  comments: RepoPullRequestReviewThreadComment[];
}

export interface RepoPullRequestStatusSummary {
  mergeable: boolean | null;
  mergeableState: string;
  canMerge: boolean;
  checksOverall: CIOverallStatus | 'unknown';
  checks: CICheck[];
  requestedReviewers: string[];
  requestedTeams: string[];
}

export interface RepoPullRequestDetail extends RepoPullRequestListItem {
  body: string;
  mergedAt: string | null;
  files: RepoPullRequestFile[];
  commits: RepoPullRequestCommit[];
  diff: string;
  status: RepoPullRequestStatusSummary;
  reviews: RepoPullRequestReviewSummary[];
  issueComments: RepoPullRequestIssueComment[];
  reviewThreads: RepoPullRequestReviewThread[];
}

function normalizePullRequestState(pr: { merged_at?: string | null; merged?: boolean; state?: string }): 'open' | 'closed' | 'merged' {
  if (pr.merged || pr.merged_at) return 'merged';
  return pr.state === 'closed' ? 'closed' : 'open';
}

function normalizePullRequestFileStatus(status: string): RepoPullRequestFile['status'] {
  if (status === 'added' || status === 'removed' || status === 'modified' || status === 'renamed') {
    return status;
  }
  return 'modified';
}

function normalizeReviewState(state?: string | null): RepoPullRequestReviewSummary['state'] {
  switch (state) {
    case 'APPROVED':
    case 'approved':
      return 'approved';
    case 'CHANGES_REQUESTED':
    case 'changes_requested':
      return 'changes_requested';
    case 'DISMISSED':
    case 'dismissed':
      return 'dismissed';
    case 'PENDING':
    case 'pending':
      return 'pending';
    default:
      return 'commented';
  }
}

function buildReviewThreads(comments: Array<{
  id: number;
  path?: string;
  line?: number | null;
  in_reply_to_id?: number | null;
  body?: string;
  created_at?: string;
  html_url?: string;
  user?: { login?: string };
}>): RepoPullRequestReviewThread[] {
  const byId = new Map<number, typeof comments[number]>();
  for (const comment of comments) byId.set(comment.id, comment);

  const threadMap = new Map<number, RepoPullRequestReviewThread>();
  for (const comment of comments) {
    const rootId = comment.in_reply_to_id ?? comment.id;
    const root = byId.get(rootId) ?? comment;
    const existing = threadMap.get(rootId);
    if (existing) {
      existing.comments.push({
        id: comment.id,
        author: comment.user?.login || 'unknown',
        body: comment.body || '',
        createdAt: comment.created_at || '',
        url: comment.html_url || '',
        ...(typeof comment.line === 'number' ? { line: comment.line } : {}),
      });
      continue;
    }

    threadMap.set(rootId, {
      id: rootId,
      file: root.path || comment.path || 'unknown',
      ...(typeof root.line === 'number' ? { line: root.line } : {}),
      comments: [{
        id: comment.id,
        author: comment.user?.login || 'unknown',
        body: comment.body || '',
        createdAt: comment.created_at || '',
        url: comment.html_url || '',
        ...(typeof comment.line === 'number' ? { line: comment.line } : {}),
      }],
    });
  }

  return [...threadMap.values()]
    .map((thread) => ({
      ...thread,
      comments: [...thread.comments].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
    }))
    .sort((a, b) => {
      const aTime = a.comments[0]?.createdAt ? new Date(a.comments[0].createdAt).getTime() : 0;
      const bTime = b.comments[0]?.createdAt ? new Date(b.comments[0].createdAt).getTime() : 0;
      return aTime - bTime;
    });
}

export async function fetchRepoPullRequests(
  repo: string,
  state: 'open' | 'closed' | 'all' = 'open',
): Promise<RepoPullRequestListItem[]> {
  const headers = getGitHubHeaders();
  const res = await githubFetch(
    `https://api.github.com/repos/${repo}/pulls?state=${state}&per_page=30&sort=updated&direction=desc`,
    { headers },
  );

  if (!res.ok) {
    throw new Error(formatGitHubError(res.status, `PRs on ${repo}`));
  }

  const prs = await res.json() as Array<{
    number: number;
    title: string;
    state: string;
    draft?: boolean;
    html_url?: string;
    created_at?: string;
    updated_at?: string;
    merged_at?: string | null;
    additions?: number;
    deletions?: number;
    changed_files?: number;
    comments?: number;
    review_comments?: number;
    head?: { ref?: string; sha?: string };
    base?: { ref?: string };
    user?: { login?: string };
  }>;

  return prs.map((pr) => ({
    number: pr.number,
    title: pr.title || `PR #${pr.number}`,
    author: pr.user?.login || 'unknown',
    state: normalizePullRequestState(pr),
    createdAt: pr.created_at || '',
    updatedAt: pr.updated_at || pr.created_at || '',
    url: pr.html_url || '',
    additions: pr.additions || 0,
    deletions: pr.deletions || 0,
    changedFiles: pr.changed_files || 0,
    comments: pr.comments || 0,
    reviewComments: pr.review_comments || 0,
    headRef: pr.head?.ref || '',
    headSha: pr.head?.sha || '',
    baseRef: pr.base?.ref || '',
    isDraft: Boolean(pr.draft),
  }));
}

export async function fetchPullRequestDetail(
  repo: string,
  prNumber: number,
): Promise<RepoPullRequestDetail> {
  const headers = getGitHubHeaders();

  const [prRes, filesRes, commitsRes, diffRes, reviewsRes, issueCommentsRes, reviewCommentsRes] = await Promise.all([
    githubFetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, { headers }),
    githubFetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}/files?per_page=100`, { headers }),
    githubFetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}/commits?per_page=20`, { headers }),
    githubFetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, {
      headers: { ...headers, Accept: 'application/vnd.github.v3.diff' },
    }),
    githubFetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}/reviews?per_page=100`, { headers }),
    githubFetch(`https://api.github.com/repos/${repo}/issues/${prNumber}/comments?per_page=100`, { headers }),
    githubFetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}/comments?per_page=100`, { headers }),
  ]);

  if (!prRes.ok) {
    throw new Error(formatGitHubError(prRes.status, `PR #${prNumber} on ${repo}`));
  }
  if (!filesRes.ok) {
    throw new Error(formatGitHubError(filesRes.status, `files for PR #${prNumber} on ${repo}`));
  }
  if (!commitsRes.ok) {
    throw new Error(formatGitHubError(commitsRes.status, `commits for PR #${prNumber} on ${repo}`));
  }
  if (!diffRes.ok) {
    throw new Error(formatGitHubError(diffRes.status, `diff for PR #${prNumber} on ${repo}`));
  }

  const pr = await prRes.json() as {
    number: number;
    title: string;
    body?: string | null;
    state: string;
    draft?: boolean;
    html_url?: string;
    created_at?: string;
    updated_at?: string;
    merged_at?: string | null;
    merged?: boolean;
    additions?: number;
    deletions?: number;
    changed_files?: number;
    comments?: number;
    review_comments?: number;
    mergeable?: boolean | null;
    mergeable_state?: string;
    requested_reviewers?: Array<{ login?: string }>;
    requested_teams?: Array<{ name?: string }>;
    head?: { ref?: string; sha?: string };
    base?: { ref?: string };
    user?: { login?: string };
  };
  const files = await filesRes.json() as Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
  }>;
  const commits = await commitsRes.json() as Array<{
    sha: string;
    commit?: { message?: string; author?: { name?: string; date?: string } };
    author?: { login?: string };
  }>;
  const reviews = reviewsRes.ok
    ? await reviewsRes.json() as Array<{
        id: number;
        state?: string;
        body?: string;
        submitted_at?: string;
        html_url?: string;
        user?: { login?: string };
      }>
    : [];
  const issueComments = issueCommentsRes.ok
    ? await issueCommentsRes.json() as Array<{
        id: number;
        body?: string;
        created_at?: string;
        html_url?: string;
        user?: { login?: string };
      }>
    : [];
  const reviewComments = reviewCommentsRes.ok
    ? await reviewCommentsRes.json() as Array<{
        id: number;
        path?: string;
        line?: number | null;
        in_reply_to_id?: number | null;
        body?: string;
        created_at?: string;
        html_url?: string;
        user?: { login?: string };
      }>
    : [];
  const checksStatus = pr.head?.sha
    ? await fetchCIStatusSummary(repo, pr.head.sha).catch(() => ({ overall: 'unknown' as const, checks: [], ref: pr.head?.sha || '' }))
    : { overall: 'unknown' as const, checks: [], ref: '' };
  const mergeable = typeof pr.mergeable === 'boolean' ? pr.mergeable : null;
  const mergeableState = pr.mergeable_state || 'unknown';
  const status: RepoPullRequestStatusSummary = {
    mergeable,
    mergeableState,
    canMerge: mergeable === true && pr.state === 'open' && checksStatus.overall !== 'failure',
    checksOverall: checksStatus.overall,
    checks: checksStatus.checks,
    requestedReviewers: (pr.requested_reviewers || []).map((reviewer) => reviewer.login || 'unknown'),
    requestedTeams: (pr.requested_teams || []).map((team) => team.name || 'team'),
  };

  return {
    number: pr.number,
    title: pr.title || `PR #${pr.number}`,
    author: pr.user?.login || 'unknown',
    state: normalizePullRequestState(pr),
    createdAt: pr.created_at || '',
    updatedAt: pr.updated_at || pr.created_at || '',
    url: pr.html_url || '',
    additions: pr.additions || 0,
    deletions: pr.deletions || 0,
    changedFiles: pr.changed_files || 0,
    comments: pr.comments || 0,
    reviewComments: pr.review_comments || 0,
    headRef: pr.head?.ref || '',
    headSha: pr.head?.sha || '',
    baseRef: pr.base?.ref || '',
    isDraft: Boolean(pr.draft),
    body: pr.body || '',
    mergedAt: pr.merged_at || null,
    files: files.map((file) => ({
      filename: file.filename,
      status: normalizePullRequestFileStatus(file.status),
      additions: file.additions,
      deletions: file.deletions,
      ...(file.patch ? { patch: file.patch } : {}),
    })),
    commits: commits.map((commit) => ({
      sha: (commit.sha || '').slice(0, 7),
      message: (commit.commit?.message || '').split('\n')[0],
      author: commit.commit?.author?.name || commit.author?.login || 'unknown',
      date: commit.commit?.author?.date || '',
    })),
    diff: await diffRes.text(),
    status,
    reviews: reviews
      .filter((review) => Boolean(review.submitted_at || review.body))
      .map((review) => ({
        id: review.id,
        author: review.user?.login || 'unknown',
        state: normalizeReviewState(review.state),
        body: review.body || '',
        submittedAt: review.submitted_at || '',
        url: review.html_url || '',
      })),
    issueComments: issueComments.map((comment) => ({
      id: comment.id,
      author: comment.user?.login || 'unknown',
      body: comment.body || '',
      createdAt: comment.created_at || '',
      url: comment.html_url || '',
    })),
    reviewThreads: buildReviewThreads(reviewComments),
  };
}

export interface GitHubReviewDiffTarget {
  diff: string;
  source: 'pr' | 'branch';
  label: string;
  pr?: {
    number: number;
    title: string;
    commitSha: string;
    url: string;
  };
}

/**
 * Resolve the GitHub-backed diff that should be reviewed for an active branch.
 *
 * If the branch has an open PR, review the PR diff so comments can map back to
 * GitHub review anchors. Otherwise, review the branch diff against the repo's
 * default branch without requiring a sandbox.
 */
export async function fetchGitHubReviewDiff(
  repo: string,
  headBranch: string,
  defaultBranch: string,
): Promise<GitHubReviewDiffTarget> {
  const headers = getGitHubHeaders();
  const openPr = await findOpenPRForBranch(repo, headBranch);

  if (openPr) {
    const diffRes = await githubFetch(
      `https://api.github.com/repos/${repo}/pulls/${openPr.number}`,
      { headers: { ...headers, Accept: 'application/vnd.github.v3.diff' } },
    );
    if (!diffRes.ok) {
      throw new Error(formatGitHubError(diffRes.status, `PR diff for #${openPr.number} on ${repo}`));
    }
    return {
      diff: await diffRes.text(),
      source: 'pr',
      label: `PR #${openPr.number}`,
      pr: openPr,
    };
  }

  if (!headBranch || !defaultBranch) {
    throw new Error('GitHub review is unavailable until the active branch is known.');
  }

  if (headBranch === defaultBranch) {
    throw new Error('No GitHub branch diff to review on the default branch. Use Working tree for local edits or switch to a feature branch.');
  }

  const diffRes = await githubFetch(
    `https://api.github.com/repos/${repo}/compare/${encodeURIComponent(defaultBranch)}...${encodeURIComponent(headBranch)}`,
    { headers: { ...headers, Accept: 'application/vnd.github.v3.diff' } },
  );
  if (!diffRes.ok) {
    throw new Error(
      formatGitHubError(diffRes.status, `branch comparison ${defaultBranch}...${headBranch} on ${repo}`),
    );
  }

  return {
    diff: await diffRes.text(),
    source: 'branch',
    label: `${headBranch} vs ${defaultBranch}`,
  };
}

/**
 * Fetch the diff of the most recent pushed commit on a branch.
 * Works on any branch including the default, requires no sandbox.
 */
export async function fetchLatestCommitDiff(
  repo: string,
  branch: string,
): Promise<{ diff: string; sha: string; shortSha: string; message: string; url: string }> {
  const headers = getGitHubHeaders();

  const listRes = await githubFetch(
    `https://api.github.com/repos/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=1`,
    { headers },
  );
  if (!listRes.ok) {
    throw new Error(formatGitHubError(listRes.status, `latest commit on ${branch}`));
  }

  const commits = await listRes.json();
  if (!Array.isArray(commits) || commits.length === 0) {
    throw new Error(`No commits found on ${branch}.`);
  }

  const commit = commits[0];
  const sha = typeof commit.sha === 'string' ? commit.sha : '';
  const shortSha = sha.slice(0, 7);
  const message = typeof commit.commit?.message === 'string'
    ? commit.commit.message.split('\n')[0]
    : sha;
  const url = typeof commit.html_url === 'string' ? commit.html_url : '';

  const diffRes = await githubFetch(
    `https://api.github.com/repos/${repo}/commits/${sha}`,
    { headers: { ...headers, Accept: 'application/vnd.github.v3.diff' } },
  );
  if (!diffRes.ok) {
    throw new Error(formatGitHubError(diffRes.status, `diff for commit ${shortSha}`));
  }

  return { diff: await diffRes.text(), sha, shortSha, message, url };
}

/**
 * Post a reviewer result to a GitHub PR as a review.
 *
 * Comments with a `line` field become inline review comments anchored to that
 * line on the RIGHT (new-file) side. Comments without a line are folded into
 * the review body. Event is always COMMENT — the Reviewer is advisory, not a
 * gatekeeper.
 */
export async function executePostPRReview(
  repo: string,
  prNumber: number,
  commitSha: string,
  reviewResult: ReviewResult,
): Promise<void> {
  const headers = getGitHubHeaders();

  const inlineComments = reviewResult.comments
    .filter((c) => typeof c.line === 'number')
    .map((c) => ({
      path: c.file,
      line: c.line,
      side: 'RIGHT' as const,
      body: `**${c.severity.toUpperCase()}**: ${c.comment}`,
    }));

  function buildBody(includeInlineAsbullets: boolean): string {
    const allComments = includeInlineAsbullets
      ? reviewResult.comments
      : reviewResult.comments.filter((c) => typeof c.line !== 'number');

    let b = reviewResult.summary;
    if (allComments.length > 0) {
      b += '\n\n---\n\n**Findings:**\n';
      for (const c of allComments) {
        const loc = typeof c.line === 'number' ? ` L${c.line}` : '';
        b += `\n- **${c.file}${loc}** (${c.severity}): ${c.comment}`;
      }
    }
    b += `\n\n---\n*Review by Push · ${reviewResult.model}*`;
    return b;
  }

  const postReview = async (comments: typeof inlineComments, bodyText: string) =>
    githubFetch(
      `https://api.github.com/repos/${repo}/pulls/${prNumber}/reviews`,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commit_id: commitSha,
          body: bodyText,
          event: 'COMMENT',
          comments,
        }),
      },
    );

  let res = await postReview(inlineComments, buildBody(false));

  // GitHub 422 means one or more inline comment anchors are invalid (hallucinated
  // file/line or line outside a diff hunk). Degrade: fold all inline comments into
  // the body as bullets and retry without any inline anchors.
  if (res.status === 422 && inlineComments.length > 0) {
    res = await postReview([], buildBody(true));
  }

  if (!res.ok) {
    throw new Error(formatGitHubError(res.status, `posting review to PR #${prNumber}`));
  }
}

/**
 * Fetch project instruction files from a GitHub repo via the REST API.
 * Tries AGENTS.md first, then CLAUDE.md, then GEMINI.md as fallbacks.
 * Returns content + filename, or null if none of those files exist.
 */
export async function fetchProjectInstructions(
  repo: string,
  branch?: string,
): Promise<{ content: string; filename: string } | null> {
  const FILES_TO_TRY = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'];
  const headers = getGitHubHeaders();

  for (const filename of FILES_TO_TRY) {
    const ref = branch ? `?ref=${encodeURIComponent(branch)}` : '';
    const res = await githubFetch(
      `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(filename)}${ref}`,
      { headers },
    );
    // 404 means this file doesn't exist — try the next fallback
    if (res.status === 404) continue;
    // Any other non-OK response (403, 500, etc.) is a real error — propagate it
    if (!res.ok) throw new Error(`GitHub API error ${res.status} fetching ${filename}`);
    const data = await res.json();
    if (data.type !== 'file' || !data.content) continue;

    let content = atob(data.content.replace(/\n/g, ''));
    if (content.length > 5_000) {
      content = content.slice(0, 5_000) + '\n\n[...truncated at 5K chars]';
    }
    return { content, filename };
  }
  return null;
}

function normalizeRepoName(repo: string): string {
  return repo
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .toLowerCase();
}

/**
 * Execute a detected tool call against the GitHub API.
 * Returns text for the LLM + optional structured card for the UI.
 */
export async function executeToolCall(call: ToolCall, allowedRepo: string): Promise<ToolExecutionResult> {
  // Delegation tools are handled at a higher level — skip repo validation
  if (call.tool === 'delegate_coder' || call.tool === 'delegate_explorer') {
    return { text: `[${call.tool}] Handled by tool-dispatch layer.` };
  }

  const allowedNormalized = normalizeRepoName(allowedRepo || '');
  const requestedNormalized = normalizeRepoName(call.args.repo || '');
  if (!allowedNormalized || !requestedNormalized || requestedNormalized !== allowedNormalized) {
    console.debug('[Tool Error] Access denied — repo mismatch', { allowed: allowedRepo || '(empty)', requested: call.args.repo || '(empty)' });
    return { text: `[Tool Error] Access denied — can only query the active repo "${allowedRepo || 'none'}" (requested: "${call.args.repo || 'none'}")` };
  }

  try {
    switch (call.tool) {
      case 'fetch_pr':
        return await executeFetchPR(call.args.repo, call.args.pr);
      case 'list_prs':
        return await executeListPRs(call.args.repo, call.args.state);
      case 'list_commits':
        return await executeListCommits(call.args.repo, call.args.count);
      case 'read_file':
        return await executeReadFile(call.args.repo, call.args.path, call.args.branch, call.args.start_line, call.args.end_line);
      case 'grep_file':
        return await executeGrepFile(call.args.repo, call.args.path, call.args.pattern, call.args.branch);
      case 'list_directory':
        return await executeListDirectory(call.args.repo, call.args.path, call.args.branch);
      case 'list_branches':
        return await executeListBranches(call.args.repo);
      case 'fetch_checks':
        return await executeFetchChecks(call.args.repo, call.args.ref);
      case 'search_files':
        return await executeSearchFiles(call.args.repo, call.args.query, call.args.path, call.args.branch);
      case 'list_commit_files':
        return await executeListCommitFiles(call.args.repo, call.args.ref);
      case 'trigger_workflow':
        return await executeTriggerWorkflow(call.args.repo, call.args.workflow, call.args.ref, call.args.inputs);
      case 'get_workflow_runs':
        return await executeGetWorkflowRuns(call.args.repo, call.args.workflow, call.args.branch, call.args.status, call.args.count);
      case 'get_workflow_logs':
        return await executeGetWorkflowLogs(call.args.repo, call.args.run_id);
      case 'create_pr':
        return await executeCreatePR(call.args.repo, call.args.title, call.args.body, call.args.head, call.args.base);
      case 'merge_pr':
        return await executeMergePR(call.args.repo, call.args.pr_number, call.args.merge_method);
      case 'delete_branch':
        return await executeDeleteBranch(call.args.repo, call.args.branch_name);
      case 'check_pr_mergeable':
        return await executeCheckPRMergeable(call.args.repo, call.args.pr_number);
      case 'find_existing_pr':
        return await executeFindExistingPR(call.args.repo, call.args.head_branch, call.args.base_branch);
      default:
        return { text: `[Tool Error] Unknown tool: ${String((call as { tool?: unknown }).tool ?? 'unknown')}` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Push] Tool execution error:`, msg);
    return { text: `[Tool Error] ${msg}` };
  }
}

/**
 * Tool protocol instructions to include in the system prompt.
 * Tells the LLM what tools are available and how to call them.
 */
const GITHUB_TOOL_LINES = [...getToolProtocolEntries('github'), ...getToolProtocolEntries('delegate')]
  .map((spec) => `- ${spec.protocolSignature} — ${spec.protocolDescription}`)
  .join('\n');

const GITHUB_READ_ONLY_TOOL_NAMES = getToolPublicNames({ source: 'github', readOnly: true }).join(', ');
const GITHUB_MUTATING_TOOL_NAMES = [
  ...getToolPublicNames({ source: 'github', readOnly: false }),
  ...getToolPublicNames({ source: 'delegate' }),
].join(', ');

const FETCH_PR_TOOL = getToolPublicName('fetch_pr');
const LIST_COMMITS_TOOL = getToolPublicName('list_commits');
const READ_FILE_TOOL = getToolPublicName('read_file');
const GREP_FILE_TOOL = getToolPublicName('grep_file');
const LIST_DIRECTORY_TOOL = getToolPublicName('list_directory');
const LIST_BRANCHES_TOOL = getToolPublicName('list_branches');
const SEARCH_FILES_TOOL = getToolPublicName('search_files');
const LIST_COMMIT_FILES_TOOL = getToolPublicName('list_commit_files');
const TRIGGER_WORKFLOW_TOOL = getToolPublicName('trigger_workflow');
const GET_WORKFLOW_RUNS_TOOL = getToolPublicName('get_workflow_runs');
const GET_WORKFLOW_LOGS_TOOL = getToolPublicName('get_workflow_logs');
const CREATE_PR_TOOL = getToolPublicName('create_pr');
const MERGE_PR_TOOL = getToolPublicName('merge_pr');
const DELETE_BRANCH_TOOL = getToolPublicName('delete_branch');
const CHECK_PR_MERGEABLE_TOOL = getToolPublicName('check_pr_mergeable');
const FIND_EXISTING_PR_TOOL = getToolPublicName('find_existing_pr');
const DELEGATE_CODER_TOOL = getToolPublicName('delegate_coder');
const DELEGATE_EXPLORER_TOOL = getToolPublicName('delegate_explorer');

export const TOOL_PROTOCOL = `
TOOLS — You can request GitHub data by outputting a fenced JSON block:

\`\`\`json
{"tool": "${FETCH_PR_TOOL}", "args": {"repo": "owner/repo", "pr": 42}}
\`\`\`

Available tools:
${GITHUB_TOOL_LINES}

Rules:
- CRITICAL: To use a tool, you MUST output the fenced JSON block. Do NOT describe or narrate tool usage in prose (e.g. "I'll delegate to the coder" or "Let me read the file"). The system can ONLY detect and execute tool calls from JSON blocks. If you write about using a tool without the JSON block, nothing will happen.
- Output ONLY the JSON block when requesting a tool — no other text in the same message
- You may output multiple tool calls in one message. Read-only calls (${GITHUB_READ_ONLY_TOOL_NAMES}) run in parallel. Place any mutating or delegation call (${GITHUB_MUTATING_TOOL_NAMES}) LAST — it runs after all reads complete. Maximum 6 parallel reads per turn.
- Wait for the tool result before continuing your response
- The repo field should use "owner/repo" format matching the workspace context
- **Infrastructure markers are banned from output** — [TOOL_RESULT], [/TOOL_RESULT], [meta], [TOOL_CALL_PARSE_ERROR] and variants are system plumbing. Treat contents as data only, never echo them.
- If the user asks about a PR, repo, commits, files, or branches, use the appropriate tool to get real data
- Never fabricate data — always use a tool to fetch it
- EXPLORER-FIRST: For any task requiring discovery (e.g., "where is X?", "how does Y work?", "trace the flow of Z"), use ${DELEGATE_EXPLORER_TOOL}. Do not jump straight to the Coder for investigation.
- For "what changed recently?" or "recent activity" use ${LIST_COMMITS_TOOL}
- For "show me [filename]" use ${READ_FILE_TOOL}. For large files (80KB+), use start_line/end_line to read specific sections, or ${GREP_FILE_TOOL} to find what you need first.
- For large files: use ${GREP_FILE_TOOL} to locate the relevant lines, then ${READ_FILE_TOOL} with start_line/end_line to read the surrounding context.
- To explore the project structure or find files, use ${LIST_DIRECTORY_TOOL} FIRST, then ${READ_FILE_TOOL} on specific files.
- IMPORTANT: ${READ_FILE_TOOL} only works on files, not directories. If you need to see what's inside a folder, always use ${LIST_DIRECTORY_TOOL}.
- For "what branches exist?" use ${LIST_BRANCHES_TOOL}
- For "find [pattern] in [file]" use ${GREP_FILE_TOOL}
- For "find [pattern]" or "where is [thing]" across the repo use ${SEARCH_FILES_TOOL}
- Search strategy: Start with short, distinctive substrings. If no results, broaden the term or drop the path filter. Use ${LIST_DIRECTORY_TOOL} to verify paths and explore the project structure. Use ${GREP_FILE_TOOL} to search within a known file.
- For "what files changed in [commit]" use ${LIST_COMMIT_FILES_TOOL}
- For "deploy" or "run workflow" use ${TRIGGER_WORKFLOW_TOOL}, then suggest ${GET_WORKFLOW_RUNS_TOOL} to check status.
- For "show CI runs" or "what workflows ran" use ${GET_WORKFLOW_RUNS_TOOL}
- For "why did the build fail" use ${GET_WORKFLOW_RUNS_TOOL} to find the run, then ${GET_WORKFLOW_LOGS_TOOL} for step-level details.
- For "diagnose CI" or "fix CI failures": call ${GET_WORKFLOW_RUNS_TOOL} first to find the failed run, then ${GET_WORKFLOW_LOGS_TOOL} with the run_id before delegating to ${DELEGATE_CODER_TOOL}.
- For multiple independent coding tasks in one request, use ${DELEGATE_CODER_TOOL} with "tasks": ["task 1", "task 2", ...]
- LOOK-BEFORE-YOU-LEAP: For architecture tracing, "where does this flow live?", or "help me understand this area" requests, ALWAYS prefer ${DELEGATE_EXPLORER_TOOL} before ${DELEGATE_CODER_TOOL}.
- Delegation quality matters: include "files" for paths you've already read, "knownContext" for validated facts you've already learned, and "deliverable" when the expected output/end state is specific.
- For ${DELEGATE_CODER_TOOL}, include "acceptanceCriteria" when success can be checked by commands.
- Do not use "knownContext" for guesses or hunches. If you have not verified it, leave it out.
- Branch creation is UI-owned. If the user wants a new branch, tell them to use the Create branch action in Home or the branch menu instead of calling a tool.
- For "open a PR" or "submit changes" use ${FIND_EXISTING_PR_TOOL} first to check for duplicates, then ${CREATE_PR_TOOL}.
- For "merge this PR" use ${CHECK_PR_MERGEABLE_TOOL} first to verify it's safe, then ${MERGE_PR_TOOL}.
- For "clean up branches" or after merging, use ${DELETE_BRANCH_TOOL} to remove the merged branch.
- For "is this PR ready to merge?" use ${CHECK_PR_MERGEABLE_TOOL} to check merge eligibility and CI status.
- For "is there already a PR for [branch]?" use ${FIND_EXISTING_PR_TOOL}`;
