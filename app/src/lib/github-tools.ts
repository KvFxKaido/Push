/**
 * GitHub tools — compatibility facade and UI-owned helpers.
 *
 * Protocol detection and TOOL_PROTOCOL live in github-tool-protocol.ts.
 * Execution/fallback dispatch lives in github-tool-executor.ts.
 * This file re-exports both and owns GitHub helpers that are UI-specific:
 * PR review, branch diff, project instructions, and PR data for the hub.
 */

import type { CICheck, CIOverallStatus, ReviewResult, ToolExecutionResult } from '@/types';
import { getGitHubAuthHeaders as getGitHubHeaders } from './github-auth';
import {
  githubFetch,
  executeGitHubToolWithFallback,
  decodeGitHubBase64Utf8,
} from './github-tool-executor';

// --- Re-exports for backward compatibility ---
export type { ToolCall } from './github-tool-protocol';
export { detectToolCall, TOOL_PROTOCOL } from './github-tool-protocol';
export {
  githubFetch,
  fetchRepoBranches,
  executeToolCall,
  decodeGitHubBase64Utf8,
} from './github-tool-executor';
export { getGitHubHeaders };

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

// --- UI-owned GitHub actions ---

export async function executeCreateBranch(
  repo: string,
  branchName: string,
  fromRef?: string,
): Promise<ToolExecutionResult> {
  const headers = getGitHubHeaders();

  let sourceRef: string = fromRef || '';
  if (!sourceRef) {
    const repoRes = await githubFetch(`https://api.github.com/repos/${repo}`, { headers });
    if (!repoRes.ok) {
      throw new Error(formatGitHubError(repoRes.status, `repo info for ${repo}`));
    }
    const repoData = await repoRes.json();
    sourceRef = repoData.default_branch || 'main';
  }

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

  const createRes = await githubFetch(`https://api.github.com/repos/${repo}/git/refs`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha }),
  });

  if (createRes.status === 422) {
    throw new Error(`[Tool Error] Branch "${branchName}" already exists on ${repo}.`);
  }
  if (!createRes.ok) {
    throw new Error(
      formatGitHubError(createRes.status, `creating branch "${branchName}" on ${repo}`),
    );
  }

  return {
    branchSwitch: branchName,
    text: [
      `[Tool Result — create_branch]`,
      `Branch "${branchName}" created on ${repo} from ${sourceRef} (${sha.slice(0, 7)}).`,
    ].join('\n'),
  };
}

export async function executeCreatePR(
  repo: string,
  title: string,
  body: string,
  head: string,
  base: string,
): Promise<ToolExecutionResult> {
  return executeGitHubToolWithFallback(
    { tool: 'create_pr', args: { repo, title, body, head, base } },
    repo,
  );
}

export async function executeMergePR(
  repo: string,
  prNumber: number,
  mergeMethod?: string,
): Promise<ToolExecutionResult> {
  return executeGitHubToolWithFallback(
    { tool: 'merge_pr', args: { repo, pr_number: prNumber, merge_method: mergeMethod } },
    repo,
  );
}

export async function executeDeleteBranch(
  repo: string,
  branchName: string,
): Promise<ToolExecutionResult> {
  return executeGitHubToolWithFallback(
    { tool: 'delete_branch', args: { repo, branch_name: branchName } },
    repo,
  );
}

export async function executeCheckPRMergeable(
  repo: string,
  prNumber: number,
): Promise<ToolExecutionResult> {
  return executeGitHubToolWithFallback(
    { tool: 'check_pr_mergeable', args: { repo, pr_number: prNumber } },
    repo,
  );
}

export async function executeFindExistingPR(
  repo: string,
  headBranch: string,
  baseBranch?: string,
): Promise<ToolExecutionResult> {
  return executeGitHubToolWithFallback(
    { tool: 'find_existing_pr', args: { repo, head_branch: headBranch, base_branch: baseBranch } },
    repo,
  );
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

// --- PR list and detail types ---

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

// --- PR data helpers ---

function normalizePullRequestState(pr: {
  merged_at?: string | null;
  merged?: boolean;
  state?: string;
}): 'open' | 'closed' | 'merged' {
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

function buildReviewThreads(
  comments: Array<{
    id: number;
    path?: string;
    line?: number | null;
    in_reply_to_id?: number | null;
    body?: string;
    created_at?: string;
    html_url?: string;
    user?: { login?: string };
  }>,
): RepoPullRequestReviewThread[] {
  const byId = new Map<number, (typeof comments)[number]>();
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
      comments: [
        {
          id: comment.id,
          author: comment.user?.login || 'unknown',
          body: comment.body || '',
          createdAt: comment.created_at || '',
          url: comment.html_url || '',
          ...(typeof comment.line === 'number' ? { line: comment.line } : {}),
        },
      ],
    });
  }

  return [...threadMap.values()]
    .map((thread) => ({
      ...thread,
      comments: [...thread.comments].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      ),
    }))
    .sort((a, b) => {
      const aTime = a.comments[0]?.createdAt ? new Date(a.comments[0].createdAt).getTime() : 0;
      const bTime = b.comments[0]?.createdAt ? new Date(b.comments[0].createdAt).getTime() : 0;
      return aTime - bTime;
    });
}

async function fetchCIStatusSummary(
  repo: string,
  ref?: string,
): Promise<{ overall: CIOverallStatus; checks: CICheck[]; ref: string }> {
  const headers = getGitHubHeaders();

  const commitRef = ref || 'HEAD';
  const checkRunsRes = await githubFetch(
    `https://api.github.com/repos/${repo}/commits/${commitRef}/check-runs?per_page=50`,
    { headers },
  );

  let checks: CICheck[] = [];
  let overall: CIOverallStatus = 'no-checks';

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
      checks = data.check_runs.map((cr) => ({
        name: cr.name || 'unknown-check',
        status: cr.status as CICheck['status'],
        conclusion: cr.conclusion as CICheck['conclusion'],
        detailsUrl: cr.html_url || cr.details_url,
      }));
    }
  }

  if (checks.length === 0) {
    const statusRes = await githubFetch(
      `https://api.github.com/repos/${repo}/commits/${commitRef}/status`,
      { headers },
    );
    if (statusRes.ok) {
      const statusData = (await statusRes.json()) as {
        statuses?: Array<{ context?: string; state?: string; target_url?: string }>;
      };
      if (statusData.statuses && statusData.statuses.length > 0) {
        checks = statusData.statuses.map((s) => ({
          name: s.context || 'unknown-check',
          status: 'completed' as const,
          conclusion:
            s.state === 'success'
              ? 'success'
              : s.state === 'failure' || s.state === 'error'
                ? 'failure'
                : s.state === 'pending'
                  ? null
                  : 'neutral',
          detailsUrl: s.target_url,
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
  } else if (checks.some((c) => c.status !== 'completed')) {
    overall = 'pending';
  } else if (
    checks.every(
      (c) => c.conclusion === 'success' || c.conclusion === 'skipped' || c.conclusion === 'neutral',
    )
  ) {
    overall = 'success';
  } else if (checks.some((c) => c.conclusion === 'failure')) {
    overall = 'failure';
  } else {
    overall = 'neutral';
  }

  return { overall, checks, ref: commitRef };
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

  const prs = (await res.json()) as Array<{
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

  const [prRes, filesRes, commitsRes, diffRes, reviewsRes, issueCommentsRes, reviewCommentsRes] =
    await Promise.all([
      githubFetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, { headers }),
      githubFetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}/files?per_page=100`, {
        headers,
      }),
      githubFetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}/commits?per_page=20`, {
        headers,
      }),
      githubFetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, {
        headers: { ...headers, Accept: 'application/vnd.github.v3.diff' },
      }),
      githubFetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}/reviews?per_page=100`, {
        headers,
      }),
      githubFetch(`https://api.github.com/repos/${repo}/issues/${prNumber}/comments?per_page=100`, {
        headers,
      }),
      githubFetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}/comments?per_page=100`, {
        headers,
      }),
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

  const pr = (await prRes.json()) as {
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
  const files = (await filesRes.json()) as Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
  }>;
  const commits = (await commitsRes.json()) as Array<{
    sha: string;
    commit?: { message?: string; author?: { name?: string; date?: string } };
    author?: { login?: string };
  }>;
  const reviews = reviewsRes.ok
    ? ((await reviewsRes.json()) as Array<{
        id: number;
        state?: string;
        body?: string;
        submitted_at?: string;
        html_url?: string;
        user?: { login?: string };
      }>)
    : [];
  const issueComments = issueCommentsRes.ok
    ? ((await issueCommentsRes.json()) as Array<{
        id: number;
        body?: string;
        created_at?: string;
        html_url?: string;
        user?: { login?: string };
      }>)
    : [];
  const reviewComments = reviewCommentsRes.ok
    ? ((await reviewCommentsRes.json()) as Array<{
        id: number;
        path?: string;
        line?: number | null;
        in_reply_to_id?: number | null;
        body?: string;
        created_at?: string;
        html_url?: string;
        user?: { login?: string };
      }>)
    : [];
  const checksStatus = pr.head?.sha
    ? await fetchCIStatusSummary(repo, pr.head.sha).catch(() => ({
        overall: 'unknown' as const,
        checks: [],
        ref: pr.head?.sha || '',
      }))
    : { overall: 'unknown' as const, checks: [], ref: '' };
  const mergeable = typeof pr.mergeable === 'boolean' ? pr.mergeable : null;
  const mergeableState = pr.mergeable_state || 'unknown';
  const status: RepoPullRequestStatusSummary = {
    mergeable,
    mergeableState,
    canMerge: mergeable === true && pr.state === 'open' && checksStatus.overall !== 'failure',
    checksOverall: checksStatus.overall,
    checks: checksStatus.checks,
    requestedReviewers: (pr.requested_reviewers || []).map(
      (reviewer) => reviewer.login || 'unknown',
    ),
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
      throw new Error(
        formatGitHubError(diffRes.status, `PR diff for #${openPr.number} on ${repo}`),
      );
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
    throw new Error(
      'No GitHub branch diff to review on the default branch. Use Working tree for local edits or switch to a feature branch.',
    );
  }

  const diffRes = await githubFetch(
    `https://api.github.com/repos/${repo}/compare/${encodeURIComponent(defaultBranch)}...${encodeURIComponent(headBranch)}`,
    { headers: { ...headers, Accept: 'application/vnd.github.v3.diff' } },
  );
  if (!diffRes.ok) {
    throw new Error(
      formatGitHubError(
        diffRes.status,
        `branch comparison ${defaultBranch}...${headBranch} on ${repo}`,
      ),
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
  const message =
    typeof commit.commit?.message === 'string' ? commit.commit.message.split('\n')[0] : sha;
  const url = typeof commit.html_url === 'string' ? commit.html_url : '';

  const diffRes = await githubFetch(`https://api.github.com/repos/${repo}/commits/${sha}`, {
    headers: { ...headers, Accept: 'application/vnd.github.v3.diff' },
  });
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
    githubFetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}/reviews`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commit_id: commitSha,
        body: bodyText,
        event: 'COMMENT',
        comments,
      }),
    });

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
    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`GitHub API error ${res.status} fetching ${filename}`);
    const data = await res.json();
    if (data.type !== 'file' || !data.content) continue;

    let content = decodeGitHubBase64Utf8(data.content);
    if (content.length > 5_000) {
      content = content.slice(0, 5_000) + '\n\n[...truncated at 5K chars]';
    }
    return { content, filename };
  }
  return null;
}
