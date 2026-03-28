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

export type GitHubReadonlyCard =
  | { type: 'pr'; data: GitHubReadonlyPRCardData }
  | { type: 'branch-list'; data: GitHubReadonlyBranchListCardData }
  | { type: 'file-search'; data: GitHubReadonlyFileSearchCardData };

export interface GitHubReadonlyToolResult {
  text: string;
  card?: GitHubReadonlyCard;
}

export type GitHubReadonlyToolCall =
  | { tool: 'fetch_pr'; args: { repo: string; pr: number } }
  | { tool: 'list_branches'; args: { repo: string; maxBranches?: number } }
  | { tool: 'search_files'; args: { repo: string; query: string; path?: string; branch?: string } };

export interface GitHubReadonlyRuntime {
  githubFetch(url: string, options?: RequestInit): Promise<Response>;
  buildHeaders(accept?: string): Record<string, string>;
  buildApiUrl(path: string): string;
  isSensitivePath(path: string): boolean;
  redactSensitiveText(text: string): { text: string; redacted: boolean };
  formatSensitivePathToolError(path: string): string;
}

const DEFAULT_ACCEPT = 'application/vnd.github.v3+json';
const SEARCH_ACCEPT = 'application/vnd.github.v3.text-match+json';
const DIFF_ACCEPT = 'application/vnd.github.v3.diff';

interface RepoBranchApi {
  name?: string;
  protected?: boolean;
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
    case 'list_branches':
      return executeListBranchesTool(runtime, call.args.repo, call.args.maxBranches ?? 30);
    case 'search_files':
      return executeSearchFilesTool(runtime, call.args.repo, call.args.query, call.args.path, call.args.branch);
  }
}
