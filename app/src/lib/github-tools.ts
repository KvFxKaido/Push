/**
 * GitHub tools — compatibility facade and UI-owned helpers.
 *
 * Protocol detection and TOOL_PROTOCOL live in github-tool-protocol.ts.
 * Execution/fallback dispatch lives in github-tool-executor.ts.
 * This file re-exports both and owns GitHub helpers that are UI-specific:
 * PR review, branch diff, project instructions, and PR data for the hub.
 */

import type {
  CICheck,
  CIOverallStatus,
  ReviewComment,
  ReviewResult,
  ToolExecutionResult,
} from '@/types';
import {
  resolveProjectInstructions,
  type RawProjectInstructions,
} from '@push/lib/project-instructions-source';
import { parseDiffIntoFiles } from './diff-utils';
import {
  getGitHubAuthHeaders as getGitHubHeaders,
  getGitHubAuthHeadersForToken,
} from './github-auth';
import {
  githubFetch,
  executeGitHubToolWithFallback,
  decodeGitHubBase64Utf8,
} from './github-tool-executor';

// --- Re-exports for backward compatibility ---
export type { ToolCall } from './github-tool-protocol';
export { detectToolCall, TOOL_PROTOCOL, buildGitHubToolProtocol } from './github-tool-protocol';
export {
  githubFetch,
  fetchRepoBranches,
  executeToolCall,
  executeReadOnlyGitHubToolWithToken,
  decodeGitHubBase64Utf8,
} from './github-tool-executor';
export { getGitHubHeaders };

// --- Auth injection ---

/**
 * Explicit GitHub auth for server-side callers that can't read the browser's
 * localStorage token — currently the `PrReviewJob` Durable Object, which holds
 * a short-lived installation token. Omit `auth` on the web path to use the
 * active browser token via {@link getGitHubHeaders}.
 */
export interface GitHubAuth {
  token: string;
}

/** Headers for a request: explicit token when provided, else the browser token. */
function resolveHeaders(auth?: GitHubAuth): Record<string, string> {
  return auth ? getGitHubAuthHeadersForToken(auth.token) : getGitHubHeaders();
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
    // 'switched' (not 'forked'): github-side branch creation is typically
    // PR-side branching that doesn't intend a branch_forked transcript moment.
    // The user is creating a branch on GitHub for some other purpose, not
    // forking their current chat. Slice 2 may revisit if runtime usage proves
    // this wrong.
    branchSwitch: {
      name: branchName,
      kind: 'switched',
      from: sourceRef,
      sha,
      source: 'github_create_branch',
    },
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

export interface MergedPRForBranch {
  number: number;
  title: string;
  url: string;
  mergedAt: string;
  /** The branch this PR merged INTO. Captured so the merge-detected banner can
   *  prove the PR targeted the default branch before claiming "merged into
   *  <default>" and migrating the chat there — a branch whose PR merged into a
   *  non-default base (stacked PR, release branch) must not be mislabeled. */
  baseBranch: string;
  /** The head commit SHA that was merged. Captured so a reused branch name can
   *  be told apart from the genuinely-merged branch: if the live branch tip no
   *  longer matches this SHA, the active branch has advanced past the merge and
   *  the banner's "was merged" claim is stale. */
  headSha: string;
}

const mergedPRForBranchCache = new Map<string, MergedPRForBranch>();

function mergedPRCacheKey(repo: string, headBranch: string): string {
  return `${repo}\0${headBranch}`;
}

function evictMergedPRForBranchCache(repo: string, headBranch: string): void {
  mergedPRForBranchCache.delete(mergedPRCacheKey(repo, headBranch));
}

/**
 * Find the merged PR for a branch and return structured data for UI use.
 * Returns null when no token is configured, no merged PR exists, or the API call fails.
 */
export async function findMergedPRForBranch(
  repo: string,
  headBranch: string,
): Promise<MergedPRForBranch | null> {
  const headers = getGitHubHeaders();
  const owner = repo.split('/')[0];
  if (!owner || !headers.Authorization) return null;

  const cacheKey = mergedPRCacheKey(repo, headBranch);
  const cached = mergedPRForBranchCache.get(cacheKey);
  if (cached) return cached;

  try {
    const res = await githubFetch(
      `https://api.github.com/repos/${repo}/pulls?state=closed&head=${encodeURIComponent(`${owner}:${headBranch}`)}`,
      { headers },
    );
    if (!res.ok) return null;

    const prs = await res.json();
    if (!Array.isArray(prs) || prs.length === 0) return null;

    const merged = prs
      .filter((pr) => typeof pr?.merged_at === 'string' && pr.merged_at)
      .sort((a, b) => String(b.merged_at).localeCompare(String(a.merged_at)))[0];
    if (!merged) return null;

    const result = {
      number: merged.number as number,
      title: typeof merged.title === 'string' ? merged.title : '',
      url: typeof merged.html_url === 'string' ? merged.html_url : '',
      mergedAt: merged.merged_at as string,
      baseBranch: typeof merged.base?.ref === 'string' ? merged.base.ref : '',
      headSha: typeof merged.head?.sha === 'string' ? merged.head.sha : '',
    };
    // Positive-only cache: a merged PR stays merged, but caching misses would
    // suppress the return-after-merge banner until reload in the flow this serves.
    mergedPRForBranchCache.set(cacheKey, result);
    return result;
  } catch {
    return null;
  }
}

/** Live state of a branch's remote tip relative to a known merged head SHA.
 *  - `absent`: the branch no longer exists remotely — the normal post-merge
 *    state (PR merged and branch deleted); the merge claim is genuine.
 *  - `matches`: the branch still exists and points at the merged SHA; genuine.
 *  - `diverged`: the branch exists but its tip moved past the merged SHA — a
 *    reused/advanced name with new unmerged work; the merge claim is stale.
 *  - `unknown`: could not verify (no token, rate limit, transport error). */
type BranchTipState = 'absent' | 'matches' | 'diverged' | 'unknown';

async function branchTipState(
  repo: string,
  branch: string,
  mergedHeadSha: string,
): Promise<BranchTipState> {
  const headers = getGitHubHeaders();
  if (!headers.Authorization) return 'unknown';
  try {
    const res = await githubFetch(
      `https://api.github.com/repos/${repo}/branches/${encodeURIComponent(branch)}`,
      { headers },
    );
    if (res.status === 404) return 'absent';
    if (!res.ok) return 'unknown';
    const data = (await res.json()) as { commit?: { sha?: string } };
    const tip = typeof data.commit?.sha === 'string' ? data.commit.sha : '';
    if (!tip || !mergedHeadSha) return 'unknown';
    return tip === mergedHeadSha ? 'matches' : 'diverged';
  } catch {
    return 'unknown';
  }
}

/**
 * Out-of-band merge detection with an identity check: returns the merged PR
 * ONLY when it is safe to offer migrating the chat onto the default branch.
 *
 * The banner makes a provenance claim ("<branch> was merged"), so branch-name
 * matching is not enough — a name reused after an earlier PR merged + the
 * branch was deleted would otherwise resurface that stale merge. We verify the
 * live branch tip against the merged head SHA (`branchTipState`): show only
 * when the branch is gone (normal post-merge) or still points at the merged
 * commit. On a confirmed divergence we also evict the positive cache so a
 * later genuine merge re-checks fresh instead of being shadowed by the stale
 * entry. A secondary guard suppresses when an open PR is now in flight.
 */
export async function detectStrandedMergedPR(
  repo: string,
  branch: string,
): Promise<MergedPRForBranch | null> {
  const merged = await findMergedPRForBranch(repo, branch);
  if (!merged) return null;

  const tip = await branchTipState(repo, branch, merged.headSha);
  if (tip === 'diverged') {
    // The active branch advanced past the merge: the merge claim is stale and
    // the cached positive must not keep shadowing future fresh detection.
    evictMergedPRForBranchCache(repo, branch);
    return null;
  }
  if (tip === 'unknown') return null; // Cannot verify → make no unverified claim.

  // tip is 'absent' (branch gone) or 'matches' (still at the merged commit).
  // When the branch still exists, a fresh open PR means active in-flight work,
  // not a stranded post-merge chat — suppress. (Branch gone ⇒ no open PR.)
  if (tip === 'matches' && (await findOpenPRForBranch(repo, branch))) return null;

  return merged;
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
  let overall: CIOverallStatus;

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
  auth?: GitHubAuth,
  /**
   * The unified diff that was reviewed. When provided, a 422 (bad inline
   * anchor) triggers a pinpoint salvage: anchors that land on a real RIGHT-side
   * hunk line are kept inline and only the unanchorable findings fold into the
   * body — instead of dropping ALL inline comments. Omit it to keep the blunt
   * all-or-nothing fallback.
   */
  diff?: string,
): Promise<number> {
  const headers = resolveHeaders(auth);

  const withLine = reviewResult.comments.filter((c) => typeof c.line === 'number');
  const noLine = reviewResult.comments.filter((c) => typeof c.line !== 'number');

  const toInline = (c: ReviewComment) => ({
    path: c.file,
    line: c.line,
    side: 'RIGHT' as const,
    body: `**${c.severity.toUpperCase()}**: ${c.comment}`,
  });

  /** Render `bulletComments` as a "Findings" section under the summary. */
  function buildBody(bulletComments: ReviewComment[]): string {
    let b = reviewResult.summary;
    if (bulletComments.length > 0) {
      b += '\n\n---\n\n**Findings:**\n';
      for (const c of bulletComments) {
        const loc = typeof c.line === 'number' ? ` L${c.line}` : '';
        b += `\n- **${c.file}${loc}** (${c.severity}): ${c.comment}`;
      }
    }
    b += `\n\n---\n*Review by Push · ${reviewResult.model}*`;
    return b;
  }

  const postReview = async (comments: ReturnType<typeof toInline>[], bodyText: string) =>
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
      // Don't retry: POSTing a review is non-idempotent, so a retry after a
      // timeout (where GitHub may have already created the review) would
      // duplicate the advisory review. A failed post surfaces as an error the
      // caller can handle instead. (A 422 creates nothing, so our own
      // application-level fallbacks below are safe — they can't duplicate.)
      { retry: false },
    );

  // Optimistic first attempt: send every anchored finding inline and let GitHub
  // adjudicate. We don't pre-filter against our own diff parse — that risks
  // demoting an anchor GitHub would have accepted.
  let res = await postReview(withLine.map(toInline), buildBody(noLine));
  let inlinePosted = withLine.length;

  // GitHub 422 means one or more inline anchors are invalid (hallucinated
  // file/line or a line outside a diff hunk).
  if (res.status === 422 && withLine.length > 0) {
    // Pinpoint salvage: keep the anchors that fall on a real RIGHT-side hunk
    // line, fold the rest into the body. Only worth a retry when we can
    // actually identify a strict, non-empty subset to keep.
    if (diff) {
      const anchorable = collectAnchorableLines(diff);
      const valid = withLine.filter((c) => anchorable.get(c.file)?.has(c.line as number));
      const invalid = withLine.filter((c) => !anchorable.get(c.file)?.has(c.line as number));
      if (valid.length > 0 && valid.length < withLine.length) {
        res = await postReview(valid.map(toInline), buildBody([...noLine, ...invalid]));
        inlinePosted = res.ok ? valid.length : 0;
      }
    }

    // Last resort — no diff to salvage with, nothing salvageable, or the
    // salvage retry itself 422'd: fold every finding into the body and post
    // with zero inline anchors.
    if (res.status === 422) {
      res = await postReview([], buildBody(reviewResult.comments));
      inlinePosted = 0;
    }
  }

  if (!res.ok) {
    throw new Error(formatGitHubError(res.status, `posting review to PR #${prNumber}`));
  }

  // Count of inline comments actually anchored on the PR (0 when all folded into
  // the body). Callers that ignore the return value are unaffected.
  return inlinePosted;
}

/**
 * Map each file in a unified diff to the set of new-file ("RIGHT" side) line
 * numbers that can carry an inline review comment — i.e. added (`+`) and
 * context lines inside a hunk. Deleted lines live on the LEFT side and
 * pre-hunk header lines (`diff --git`, `index`, `---`, `+++`) are excluded.
 * Mirrors the new-file line counting in `annotateDiffWithLineNumbers`.
 */
function collectAnchorableLines(diff: string): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  for (const file of parseDiffIntoFiles(diff)) {
    const lines = new Set<number>();
    let newLine = 0;
    let inHunk = false;
    for (const raw of file.hunks.split('\n')) {
      if (raw.startsWith('@@')) {
        // @@ -old_start[,old_count] +new_start[,new_count] @@
        const m = raw.match(/\+(\d+)/);
        if (m) newLine = parseInt(m[1], 10) - 1;
        inHunk = true;
      } else if (!inHunk) {
        // File header lines before the first hunk (including `+++`/`---`).
        continue;
      } else if (raw.startsWith('+')) {
        newLine++;
        lines.add(newLine);
      } else if (raw.startsWith('-') || raw.startsWith('\\')) {
        // Removed line (LEFT side) or "\ No newline" marker — not anchorable.
      } else {
        // Context line — advances the new-file counter and is anchorable.
        newLine++;
        lines.add(newLine);
      }
    }
    map.set(file.path, lines);
  }
  return map;
}

/**
 * Fetch project instruction files from a GitHub repo via the REST API.
 * Tries PUSH.md first (Push-specific override), then AGENTS.md, CLAUDE.md,
 * and GEMINI.md as fallbacks. Returns content + filename, or null if none
 * of those files exist. Matches the CLI loader in `cli/workspace-context.ts`.
 */
export async function fetchProjectInstructions(
  repo: string,
  branch?: string,
): Promise<RawProjectInstructions | null> {
  const headers = getGitHubHeaders();
  // Candidate order lives in the shared resolver so this (Phase A) can't drift
  // from the sandbox re-read (Phase B) or the CLI. Returns raw content — the
  // injection site (`formatProjectInstructionsBlock` in useProjectInstructions)
  // caps and escapes, so the old bespoke `.slice(0, 5_000)` (a tighter,
  // un-escaped pre-cut that disagreed with Phase B's 8K injection budget) is
  // gone. GitHub only inlines `content` for files under ~1 MB, so an oversized
  // file resolves to `null` here rather than streaming a huge blob.
  return resolveProjectInstructions(async (filename) => {
    const ref = branch ? `?ref=${encodeURIComponent(branch)}` : '';
    const res = await githubFetch(
      `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(filename)}${ref}`,
      { headers },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub API error ${res.status} fetching ${filename}`);
    const data = await res.json();
    if (data.type !== 'file' || !data.content) return null;
    return decodeGitHubBase64Utf8(data.content);
  });
}

/**
 * Fetch repo-root `REVIEW.md` (Reviewer guidance) from GitHub via the REST API.
 * Returns the file contents, or null when the repo has no REVIEW.md (so the
 * Reviewer falls back to its built-in guidance). Pass `branch` to read from a
 * specific ref — the in-app reviewer reads from the base branch.
 */
export async function fetchReviewGuidance(
  repo: string,
  branch?: string,
  auth?: GitHubAuth,
): Promise<string | null> {
  const ref = branch ? `?ref=${encodeURIComponent(branch)}` : '';
  const res = await githubFetch(`https://api.github.com/repos/${repo}/contents/REVIEW.md${ref}`, {
    headers: resolveHeaders(auth),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub API error ${res.status} fetching REVIEW.md`);
  const data = await res.json();
  if (data.type !== 'file' || !data.content) return null;
  return decodeGitHubBase64Utf8(data.content);
}

/**
 * Fetch a single committed repo file from GitHub via the REST contents API.
 * Token-injectable for server-side callers that need raw trusted base-ref
 * content, not model-facing read_file envelopes.
 */
export async function fetchRepoFileContent(
  repo: string,
  path: string,
  branch?: string,
  auth?: GitHubAuth,
): Promise<string | null> {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const ref = branch ? `?ref=${encodeURIComponent(branch)}` : '';
  const res = await githubFetch(
    `https://api.github.com/repos/${repo}/contents/${encodedPath}${ref}`,
    {
      headers: resolveHeaders(auth),
    },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub API error ${res.status} fetching ${path}`);
  const data = await res.json();
  if (data.type !== 'file' || !data.content) return null;
  return decodeGitHubBase64Utf8(data.content);
}

/**
 * Fetch the unified diff for a specific PR by number. Token-injectable so the
 * webhook DO can fetch a PR diff with its installation token. Distinct from
 * {@link fetchGitHubReviewDiff}, which resolves the PR from a branch name for
 * the in-app reviewer.
 */
export async function fetchPullRequestDiff(
  repo: string,
  prNumber: number,
  auth?: GitHubAuth,
): Promise<string> {
  const res = await githubFetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, {
    headers: { ...resolveHeaders(auth), Accept: 'application/vnd.github.v3.diff' },
  });
  if (!res.ok) throw new Error(formatGitHubError(res.status, `PR #${prNumber} diff on ${repo}`));
  return res.text();
}

/**
 * Fetch the current head commit SHA of a PR. Used to pin a posted review to the
 * commit that was actually reviewed (the head can advance between a webhook
 * delivery and the review running). Returns null when the field is absent.
 */
export async function fetchPullRequestHeadSha(
  repo: string,
  prNumber: number,
  auth?: GitHubAuth,
): Promise<string | null> {
  const res = await githubFetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, {
    headers: resolveHeaders(auth),
  });
  if (!res.ok) throw new Error(formatGitHubError(res.status, `PR #${prNumber} head on ${repo}`));
  const data = (await res.json()) as { head?: { sha?: string } };
  return data.head?.sha ?? null;
}

/** Head/base refs + fork status for a PR — everything the PrReviewJob DO needs to
 * start a manual (re-run) review for an existing PR. */
export interface PullRequestRefs {
  headSha: string;
  headRef: string;
  baseRef: string;
  isCrossFork: boolean;
  /** PR state; `'open'` is the only reviewable state (mirrors the webhook gate). */
  state: string;
  draft: boolean;
}

/**
 * Fetch a PR's head SHA, head/base refs, and fork status in one call. Used by
 * the manual re-run trigger to construct a `PrReviewStartInput` for a PR that
 * didn't arrive via a webhook delivery. Throws when required fields are missing.
 */
export async function fetchPullRequestRefs(
  repo: string,
  prNumber: number,
  auth?: GitHubAuth,
): Promise<PullRequestRefs> {
  const res = await githubFetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, {
    headers: resolveHeaders(auth),
  });
  if (!res.ok) throw new Error(formatGitHubError(res.status, `PR #${prNumber} on ${repo}`));
  const data = (await res.json()) as {
    state?: string;
    draft?: boolean;
    head?: { sha?: string; ref?: string; repo?: { full_name?: string } };
    base?: { ref?: string };
  };
  const headSha = data.head?.sha;
  const headRef = data.head?.ref;
  const baseRef = data.base?.ref;
  if (!headSha || !headRef || !baseRef) {
    throw new Error(`PR #${prNumber} on ${repo} is missing head/base refs`);
  }
  // owner/repo names are case-insensitive on GitHub; compare case-folded so a
  // client casing difference doesn't misclassify a same-repo PR as a fork.
  const headRepo = data.head?.repo?.full_name ?? '';
  return {
    headSha,
    headRef,
    baseRef,
    isCrossFork: headRepo.toLowerCase() !== repo.toLowerCase(),
    state: data.state ?? 'unknown',
    draft: Boolean(data.draft),
  };
}

export type ReviewCheckConclusion = 'success' | 'failure' | 'neutral';

/**
 * The single check-run name the reviewer creates and updates in place. Shared
 * across create/patch so a delivery's `in_progress` run becomes its terminal
 * status rather than spawning a second check.
 */
export const REVIEW_CHECK_NAME = 'Push review';

/**
 * Which comment endpoint a reaction targets. Top-level PR conversation comments
 * (`issue_comment`) and inline diff-line review comments
 * (`pull_request_review_comment`) live at different reaction URLs.
 */
export type CommentReactionKind = 'issue' | 'review';

/**
 * Add a reaction to a PR comment. Best-effort acknowledgement — e.g. the 👀 the
 * autonomous reviewer leaves when it's @-mentioned to confirm the request
 * landed. Returns false (never throws) so a failed reaction can't break the
 * trigger path. `kind` selects the endpoint: `issue` for conversation comments,
 * `review` for inline diff-line comments.
 */
export async function addCommentReaction(
  repo: string,
  kind: CommentReactionKind,
  commentId: number,
  content: '+1' | '-1' | 'laugh' | 'confused' | 'heart' | 'hooray' | 'rocket' | 'eyes',
  auth?: GitHubAuth,
): Promise<boolean> {
  const path = kind === 'review' ? 'pulls/comments' : 'issues/comments';
  try {
    const res = await githubFetch(
      `https://api.github.com/repos/${repo}/${path}/${commentId}/reactions`,
      {
        method: 'POST',
        headers: { ...resolveHeaders(auth), 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      },
      { retry: false },
    );
    // 201 = reaction created, 200 = the same reaction already existed; either way
    // the reaction is present.
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Post a plain conversation comment on a PR. Best-effort like
 * {@link addCommentReaction} — returns false rather than throwing — because its
 * caller is the comment-trigger failure path, where a notice that can't post
 * must degrade to the structured log, not break the webhook ack. PRs are issues
 * for commenting purposes, so this rides the issues endpoint.
 */
export async function postPullRequestComment(
  repo: string,
  prNumber: number,
  body: string,
  auth?: GitHubAuth,
): Promise<boolean> {
  try {
    const res = await githubFetch(
      `https://api.github.com/repos/${repo}/issues/${prNumber}/comments`,
      {
        method: 'POST',
        headers: { ...resolveHeaders(auth), 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      },
      { retry: false },
    );
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Start an `in_progress` "Push review" check-run on the head commit and return
 * its id, so a later {@link finalizeReviewCheckRun} can update the same run in
 * place. Gives every reviewed PR a visible "Reviewing…" status while the model
 * runs, instead of silence until (or unless) a review posts.
 */
export async function createInProgressReviewCheckRun(
  repo: string,
  headSha: string,
  output: { title: string; summary: string },
  auth?: GitHubAuth,
): Promise<number> {
  const res = await githubFetch(
    `https://api.github.com/repos/${repo}/check-runs`,
    {
      method: 'POST',
      headers: { ...resolveHeaders(auth), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: REVIEW_CHECK_NAME,
        head_sha: headSha,
        status: 'in_progress',
        output: { title: output.title, summary: output.summary },
      }),
    },
    { retry: false },
  );
  if (!res.ok)
    throw new Error(formatGitHubError(res.status, `start check run on ${repo}@${headSha}`));
  const data = (await res.json()) as { id: number };
  return data.id;
}

/** One check run on a commit, as the reviewer needs to see it (§9a). */
export interface CheckRunForSha {
  id: number;
  name: string;
  /** GitHub's status vocabulary, passed through (including Actions-only waiting states). */
  status: string;
  /** null while the run has not completed. */
  conclusion: string | null;
  /** Owning GitHub App id — `null` for checks not created by an App. */
  appId: number | null;
  detailsUrl?: string;
}

/** GitHub's cap for this endpoint; also our page size. */
const CHECK_RUNS_PER_PAGE = 100;
/** Backstop so a pathological SHA can't spin the reviewer through unbounded pages. */
const CHECK_RUNS_MAX_PAGES = 10;

/**
 * All check runs GitHub has for a commit — the reviewer's verification source
 * (decision doc §9a). Paginated: a truncated first page would silently drop a
 * FAILING check and turn a `fail` verdict into a `pass`, which is the one error
 * this whole path exists to avoid.
 *
 * Returns `null` (never throws) when the API can't be read, so the caller can
 * record `blocked` — "we could not see CI" — instead of a fabricated verdict.
 */
export async function fetchCheckRunsForSha(
  repo: string,
  sha: string,
  auth?: GitHubAuth,
): Promise<CheckRunForSha[] | null> {
  const runs: CheckRunForSha[] = [];
  const seenIds = new Set<number>();
  let expectedTotal: number | null = null;
  try {
    for (let page = 1; page <= CHECK_RUNS_MAX_PAGES; page += 1) {
      const res = await githubFetch(
        `https://api.github.com/repos/${repo}/commits/${sha}/check-runs?per_page=${CHECK_RUNS_PER_PAGE}&page=${page}`,
        { headers: resolveHeaders(auth) },
      );
      if (!res.ok) return null;
      const data = (await res.json()) as {
        total_count?: number;
        check_runs?: Array<{
          id?: number;
          name?: string;
          status?: string;
          conclusion?: string | null;
          html_url?: string;
          details_url?: string;
          app?: { id?: number } | null;
        }>;
      };
      // A malformed 200 is not evidence that the commit has no CI. Fail closed
      // instead of turning an unreadable response into `unavailable`.
      if (
        !Array.isArray(data.check_runs) ||
        typeof data.total_count !== 'number' ||
        !Number.isInteger(data.total_count) ||
        data.total_count < 0
      ) {
        return null;
      }
      if (expectedTotal === null) expectedTotal = data.total_count;
      // The collection changed under pagination. Continuing could duplicate one
      // run and omit another (including the only failure), so do not aggregate it.
      if (data.total_count !== expectedTotal) return null;
      const batch = data.check_runs;
      for (const run of batch) {
        // Required verdict fields must be structurally trustworthy. Dropping or
        // defaulting one could hide the only failing/pending check and fabricate a
        // pass. A duplicate id means pagination shifted while we were reading it.
        if (
          typeof run.id !== 'number' ||
          seenIds.has(run.id) ||
          typeof run.status !== 'string' ||
          (run.conclusion !== null && typeof run.conclusion !== 'string')
        ) {
          return null;
        }
        seenIds.add(run.id);
        runs.push({
          id: run.id,
          name: run.name || 'unknown-check',
          status: run.status,
          conclusion: run.conclusion,
          appId: typeof run.app?.id === 'number' ? run.app.id : null,
          detailsUrl: run.html_url || run.details_url,
        });
      }
      if (batch.length < CHECK_RUNS_PER_PAGE) {
        return runs.length < expectedTotal ? null : runs;
      }
      // GitHub caps this endpoint at the 1000 most recent check suites. A full
      // final page may therefore be truncated with a failure beyond our view;
      // never turn that incomplete set into a green aggregate.
      if (page === CHECK_RUNS_MAX_PAGES) return null;
    }
  } catch {
    // githubFetch can still reject after its bounded retry budget, and JSON
    // parsing can fail. The verification caller maps null to a blocked verdict.
    return null;
  }
  return null;
}

/** Patch an existing check-run to a terminal `completed` state in place. */
export async function finalizeReviewCheckRun(
  repo: string,
  checkRunId: number,
  conclusion: ReviewCheckConclusion,
  output: { title: string; summary: string },
  auth?: GitHubAuth,
): Promise<void> {
  const res = await githubFetch(
    `https://api.github.com/repos/${repo}/check-runs/${checkRunId}`,
    {
      method: 'PATCH',
      headers: { ...resolveHeaders(auth), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'completed',
        conclusion,
        output: { title: output.title, summary: output.summary },
      }),
    },
    { retry: false },
  );
  if (!res.ok)
    throw new Error(formatGitHubError(res.status, `patch check run ${checkRunId} on ${repo}`));
}

/**
 * Create a GitHub Checks API run reflecting an automated review's verdict, on the
 * reviewed commit. Used for the terminal-direct path (no prior in-progress run to
 * patch): `failure` when the review found a blocking finding, else `success`.
 * Requires the `checks: write` permission. Non-idempotent POST (not retried).
 * Throws on failure so the caller can log without aborting the posted review.
 */
export async function createReviewCheckRun(
  repo: string,
  headSha: string,
  conclusion: ReviewCheckConclusion,
  output: { title: string; summary: string },
  auth?: GitHubAuth,
): Promise<void> {
  const res = await githubFetch(
    `https://api.github.com/repos/${repo}/check-runs`,
    {
      method: 'POST',
      headers: { ...resolveHeaders(auth), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: REVIEW_CHECK_NAME,
        head_sha: headSha,
        status: 'completed',
        conclusion,
        output: { title: output.title, summary: output.summary },
      }),
    },
    { retry: false },
  );
  if (!res.ok) throw new Error(formatGitHubError(res.status, `check run on ${repo}@${headSha}`));
}
