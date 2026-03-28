import type { Env } from './worker-middleware';
import {
  validateOrigin,
  getClientIp,
  readBodyText,
  wlog,
} from './worker-middleware';
import { REQUEST_ID_HEADER, getOrCreateRequestId } from '../lib/request-id';
import {
  formatSensitivePathToolError,
  isSensitivePath,
  redactSensitiveText,
} from '../lib/sensitive-data-guard';
import type {
  BranchListCardData,
  FileSearchCardData,
  FileSearchMatch,
  PRCardData,
  ToolExecutionResult,
} from '../types';

const GITHUB_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

type GitHubToolPayload =
  | { tool: 'fetch_pr'; args: { repo: string; pr: number }; allowedRepo: string }
  | { tool: 'list_branches'; args: { repo: string; maxBranches?: number }; allowedRepo: string }
  | { tool: 'search_files'; args: { repo: string; query: string; path?: string; branch?: string }; allowedRepo: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asPositiveNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function normalizeRepoName(repo: string): string {
  return repo
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .toLowerCase();
}

function getGitHubHeaders(request: Request, accept: string = 'application/vnd.github.v3+json'): Record<string, string> {
  const authorization = request.headers.get('Authorization');
  const headers: Record<string, string> = { Accept: accept };
  if (authorization) {
    headers.Authorization = authorization;
  }
  return headers;
}

function isRetryableError(_error: unknown, status?: number): boolean {
  if (status !== undefined) {
    if (status === 429) return true;
    if (status >= 500 && status < 600) return true;
    return false;
  }
  return true;
}

function getRetryDelay(response: Response | undefined, attempt: number): number {
  if (response && response.status === 429) {
    const retryAfter = response.headers.get('Retry-After');
    if (retryAfter) {
      const delay = parseInt(retryAfter, 10);
      if (!Number.isNaN(delay)) return (delay + 1) * 1000;
    }
  }
  return BASE_DELAY_MS * Math.pow(2, attempt - 1);
}

async function githubFetch(url: string, options?: RequestInit): Promise<Response> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), GITHUB_TIMEOUT_MS);

    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (!response.ok && isRetryableError(null, response.status) && attempt < MAX_RETRIES) {
        const delay = getRetryDelay(response, attempt + 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      return response;
    } catch (error) {
      const isTimeout = error instanceof DOMException && error.name === 'AbortError';
      lastError = new Error(
        isTimeout
          ? `GitHub API timed out after ${GITHUB_TIMEOUT_MS / 1000}s`
          : error instanceof Error ? error.message : String(error),
      );

      if (attempt < MAX_RETRIES && isRetryableError(error)) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw lastError;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw lastError || new Error(`GitHub API failed after ${MAX_RETRIES} retries`);
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

async function fetchRepoBranches(
  request: Request,
  repo: string,
  maxBranches: number = 500,
): Promise<{ defaultBranch: string; branches: BranchListCardData['branches'] }> {
  const headers = getGitHubHeaders(request);

  const repoRes = await githubFetch(`https://api.github.com/repos/${repo}`, { headers });
  if (!repoRes.ok) {
    throw new Error(formatGitHubError(repoRes.status, `repo info for ${repo}`));
  }
  const repoData = await repoRes.json() as { default_branch?: string };
  const defaultBranch = repoData.default_branch || 'main';

  const pageSize = 100;
  const maxPages = Math.max(1, Math.ceil(maxBranches / pageSize));
  const all: Array<{ name?: string; protected?: boolean }> = [];
  let pageCount = 0;
  let nextUrl: string | null = `https://api.github.com/repos/${repo}/branches?per_page=${pageSize}&page=1`;

  while (nextUrl && pageCount < maxPages && all.length < maxBranches) {
    const res = await githubFetch(nextUrl, { headers });
    if (!res.ok) {
      throw new Error(formatGitHubError(res.status, `branches on ${repo}`));
    }
    const pageData = await res.json();
    if (!Array.isArray(pageData)) break;
    all.push(...pageData as Array<{ name?: string; protected?: boolean }>);
    nextUrl = parseNextLink(res.headers.get('Link'));
    pageCount += 1;
  }

  const branches: BranchListCardData['branches'] = all
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

  return { defaultBranch, branches };
}

async function executeListBranches(
  request: Request,
  repo: string,
  maxBranches: number = 30,
): Promise<ToolExecutionResult> {
  const { defaultBranch, branches } = await fetchRepoBranches(request, repo, maxBranches);

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
    card: { type: 'branch-list', data: { repo, defaultBranch, branches } },
  };
}

async function executeFetchPR(request: Request, repo: string, pr: number): Promise<ToolExecutionResult> {
  const headers = getGitHubHeaders(request);

  const prRes = await githubFetch(`https://api.github.com/repos/${repo}/pulls/${pr}`, { headers });
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

  const linkedIssues: { number: number; title?: string }[] = [];
  if (prData.body) {
    const issuePattern = /(?:fixes|closes|resolves|#)\s*#(\d+)/gi;
    const matches = [...prData.body.matchAll(issuePattern)];
    for (const match of matches.slice(0, 3)) {
      linkedIssues.push({ number: parseInt(match[1], 10) });
    }
  }

  for (const issue of linkedIssues) {
    try {
      const issueRes = await githubFetch(`https://api.github.com/repos/${repo}/issues/${issue.number}`, { headers });
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
    const commitsRes = await githubFetch(`https://api.github.com/repos/${repo}/pulls/${pr}/commits`, { headers });
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

  const diffRes = await githubFetch(`https://api.github.com/repos/${repo}/pulls/${pr}`, {
    headers: getGitHubHeaders(request, 'application/vnd.github.v3.diff'),
  });
  let diff = '';
  if (diffRes.ok) {
    diff = await diffRes.text();
    if (diff.length > 10_000) {
      diff = `${diff.slice(0, 10_000)}\n\n[...diff truncated at 10K chars]`;
    }
  }

  const filesRes = await githubFetch(`https://api.github.com/repos/${repo}/pulls/${pr}/files`, { headers });
  let filesData: Array<{ filename: string; status: string; additions: number; deletions: number }> = [];
  let filesSummary = '';
  if (filesRes.ok) {
    const files = await filesRes.json() as Array<{
      filename: string;
      status: string;
      additions: number;
      deletions: number;
    }>;
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
    description: prData.body ? (prData.body.length > 300 ? `${prData.body.slice(0, 300)}...` : prData.body) : undefined,
    files: filesData.length > 0 ? filesData : undefined,
  };

  return { text: lines.join('\n'), card: { type: 'pr', data: card } };
}

async function executeSearchFiles(
  request: Request,
  repo: string,
  query: string,
  path?: string,
  branch?: string,
): Promise<ToolExecutionResult> {
  if (path && isSensitivePath(path)) {
    return { text: formatSensitivePathToolError(path) };
  }

  const headers = getGitHubHeaders(request, 'application/vnd.github.v3.text-match+json');
  let searchQuery = `${query} repo:${repo}`;
  if (path) searchQuery += ` path:${path}`;

  let searchUrl = `https://api.github.com/search/code?q=${encodeURIComponent(searchQuery)}&per_page=25`;
  if (branch) searchUrl += `&ref=${encodeURIComponent(branch)}`;

  const res = await githubFetch(searchUrl, { headers });
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

  const matches: FileSearchMatch[] = [];
  const truncated = totalCount > 25;
  let hiddenResults = 0;
  let redactedResults = false;
  const fileContexts = new Map<string, string[]>();

  for (const item of data.items || []) {
    if (typeof item.path === 'string' && isSensitivePath(item.path)) {
      hiddenResults += 1;
      continue;
    }

    const textMatches = item.text_matches || [];
    if (textMatches.length > 0) {
      const fragments: string[] = [];
      for (const textMatch of textMatches) {
        const fragment = typeof textMatch.fragment === 'string' ? textMatch.fragment : '';
        const safeFragment = redactSensitiveText(fragment);
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

  const byFile = new Map<string, FileSearchMatch[]>();
  for (const match of matches) {
    if (!byFile.has(match.path)) byFile.set(match.path, []);
    byFile.get(match.path)?.push(match);
  }

  for (const [filePath, fileMatches] of byFile) {
    lines.push(`📄 ${filePath}`);
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

function parseToolPayload(value: unknown): GitHubToolPayload | null {
  const payload = asRecord(value);
  const tool = asString(payload?.tool);
  const args = asRecord(payload?.args);
  const allowedRepo = asString(payload?.allowedRepo);
  if (!tool || !args || !allowedRepo) return null;

  const repo = asString(args.repo);
  if (!repo) return null;

  if (tool === 'fetch_pr') {
    const pr = asPositiveNumber(args.pr);
    return pr ? { tool, args: { repo, pr }, allowedRepo } : null;
  }
  if (tool === 'list_branches') {
    const maxBranches = asPositiveNumber(args.maxBranches);
    return { tool, args: { repo, maxBranches }, allowedRepo };
  }
  if (tool === 'search_files') {
    const query = asString(args.query);
    if (!query) return null;
    return {
      tool,
      args: {
        repo,
        query,
        path: asString(args.path),
        branch: asString(args.branch),
      },
      allowedRepo,
    };
  }

  return null;
}

export async function handleGitHubTools(request: Request, env: Env): Promise<Response> {
  const requestId = getOrCreateRequestId(request.headers.get(REQUEST_ID_HEADER), 'github-tools');
  const requestUrl = new URL(request.url);
  const originCheck = validateOrigin(request, requestUrl, env);
  if (!originCheck.ok) {
    return Response.json({ error: originCheck.error }, { status: 403 });
  }

  const { success: rateLimitOk } = await env.RATE_LIMITER.limit({ key: getClientIp(request) });
  if (!rateLimitOk) {
    wlog('warn', 'rate_limited', { requestId, path: 'api/github/tools', ip: getClientIp(request) });
    return Response.json({ error: 'Rate limit exceeded. Try again later.' }, {
      status: 429,
      headers: { 'Retry-After': '60' },
    });
  }

  const bodyResult = await readBodyText(request, 64 * 1024);
  if ('error' in bodyResult) {
    return Response.json({ error: bodyResult.error }, { status: bodyResult.status });
  }

  let parsed: GitHubToolPayload | null = null;
  try {
    parsed = parseToolPayload(JSON.parse(bodyResult.text));
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!parsed) {
    return Response.json({ error: 'Invalid GitHub tool payload' }, { status: 400 });
  }

  const allowedNormalized = normalizeRepoName(parsed.allowedRepo);
  const requestedNormalized = normalizeRepoName(parsed.args.repo);
  if (!allowedNormalized || !requestedNormalized || allowedNormalized !== requestedNormalized) {
    return Response.json({
      error: `Access denied — can only query the active repo "${parsed.allowedRepo}"`,
    }, { status: 403 });
  }

  try {
    let result: ToolExecutionResult;
    switch (parsed.tool) {
      case 'fetch_pr':
        result = await executeFetchPR(request, parsed.args.repo, parsed.args.pr);
        break;
      case 'list_branches':
        result = await executeListBranches(request, parsed.args.repo, parsed.args.maxBranches ?? 30);
        break;
      case 'search_files':
        result = await executeSearchFiles(
          request,
          parsed.args.repo,
          parsed.args.query,
          parsed.args.path,
          parsed.args.branch,
        );
        break;
      default:
        return Response.json({ error: `Unsupported GitHub tool: ${(parsed as { tool?: string }).tool || 'unknown'}` }, { status: 400 });
    }

    return Response.json({ result }, {
      headers: { [REQUEST_ID_HEADER]: requestId },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    wlog('error', 'github_tool_error', { requestId, tool: parsed.tool, message });
    return Response.json({ error: message }, {
      status: 502,
      headers: { [REQUEST_ID_HEADER]: requestId },
    });
  }
}
