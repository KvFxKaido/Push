import { useState, useCallback } from 'react';
import type { RepoWithActivity, RepoSummary, RepoActivity } from '@/types';
import { safeStorageGet, safeStorageSet } from '@/lib/safe-storage';

const GITHUB_TOKEN = import.meta.env.VITE_GITHUB_TOKEN || '';
const OAUTH_STORAGE_KEY = 'github_access_token';
const APP_TOKEN_STORAGE_KEY = 'github_app_token';
const APP_INSTALLATION_ID_KEY = 'github_app_installation_id';
const SYNC_STORAGE_KEY = 'repo_last_sync';
const PUSHED_STORAGE_KEY = 'repo_last_pushed';

function getAuthHeaders(): Record<string, string> {
  const oauthToken = safeStorageGet(OAUTH_STORAGE_KEY) || '';
  const appToken = safeStorageGet(APP_TOKEN_STORAGE_KEY) || '';
  const authToken = appToken || oauthToken || GITHUB_TOKEN;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
  };
  if (authToken) {
    headers['Authorization'] = `token ${authToken}`;
  }
  return headers;
}

function getStoredPushedAt(): Record<string, string> {
  try {
    const raw = safeStorageGet(PUSHED_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};

    const map: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') {
        map[key] = value;
      }
    }
    return map;
  } catch {
    return {};
  }
}

function storePushedAt(repos: RepoSummary[]) {
  const map: Record<string, string> = {};
  for (const repo of repos) {
    map[repo.full_name] = repo.pushed_at;
  }
  safeStorageSet(PUSHED_STORAGE_KEY, JSON.stringify(map));
}

// Mock repos for demo mode
const MOCK_REPOS: RepoWithActivity[] = [
  {
    id: 1,
    name: 'diff',
    full_name: 'ishaw/diff',
    owner: 'ishaw',
    private: true,
    description: 'Mobile GitHub command center PWA',
    open_issues_count: 3,
    pushed_at: new Date(Date.now() - 1000 * 60 * 12).toISOString(),
    default_branch: 'main',
    language: 'TypeScript',
    avatar_url: '',
    activity: { open_prs: 2, recent_commits: 5, has_new_activity: true, last_synced: null },
  },
  {
    id: 2,
    name: 'dotfiles',
    full_name: 'ishaw/dotfiles',
    owner: 'ishaw',
    private: false,
    description: 'Personal dev environment configuration',
    open_issues_count: 0,
    pushed_at: new Date(Date.now() - 1000 * 60 * 60 * 3).toISOString(),
    default_branch: 'main',
    language: 'Shell',
    avatar_url: '',
    activity: { open_prs: 0, recent_commits: 1, has_new_activity: false, last_synced: null },
  },
  {
    id: 3,
    name: 'api-gateway',
    full_name: 'ishaw/api-gateway',
    owner: 'ishaw',
    private: true,
    description: 'Edge proxy and rate limiter',
    open_issues_count: 7,
    pushed_at: new Date(Date.now() - 1000 * 60 * 60 * 26).toISOString(),
    default_branch: 'main',
    language: 'Go',
    avatar_url: '',
    activity: { open_prs: 1, recent_commits: 0, has_new_activity: true, last_synced: null },
  },
  {
    id: 4,
    name: 'blog',
    full_name: 'ishaw/blog',
    owner: 'ishaw',
    private: false,
    description: null,
    open_issues_count: 0,
    pushed_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 5).toISOString(),
    default_branch: 'main',
    language: 'MDX',
    avatar_url: '',
    activity: { open_prs: 0, recent_commits: 0, has_new_activity: false, last_synced: null },
  },
];

async function fetchPRCount(fullName: string, headers: Record<string, string>): Promise<number> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${fullName}/pulls?state=open&per_page=1`,
      { headers },
    );
    if (!res.ok) return 0;
    // GitHub returns total count in the Link header, but for simplicity use a small fetch
    const data = await res.json();
    // Check link header for last page to get total count
    const link = res.headers.get('Link') || '';
    const match = link.match(/page=(\d+)>; rel="last"/);
    if (match) return parseInt(match[1], 10);
    return Array.isArray(data) ? data.length : 0;
  } catch {
    return 0;
  }
}

async function fetchRecentCommitCount(
  fullName: string,
  headers: Record<string, string>,
): Promise<number> {
  try {
    const since = new Date(Date.now() - 1000 * 60 * 60 * 24 * 7).toISOString();
    const res = await fetch(
      `https://api.github.com/repos/${fullName}/commits?since=${since}&per_page=100`,
      { headers },
    );
    if (!res.ok) return 0;
    const data = await res.json();
    return Array.isArray(data) ? data.length : 0;
  } catch {
    return 0;
  }
}

function parseNextPage(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

async function fetchAllUserRepos(headers: Record<string, string>): Promise<unknown[]> {
  const all: unknown[] = [];
  let url: string | null = 'https://api.github.com/user/repos?sort=pushed&direction=desc&per_page=100&page=1';
  let pages = 0;
  const MAX_PAGES = 10;

  while (url && pages < MAX_PAGES) {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error('Failed to fetch repos');
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error('Unexpected repos response from GitHub');
    all.push(...data);
    url = parseNextPage(res.headers.get('Link'));
    pages++;
  }

  return all;
}

async function fetchAllInstallationRepos(headers: Record<string, string>): Promise<unknown[]> {
  const all: unknown[] = [];
  let url: string | null = 'https://api.github.com/installation/repositories?per_page=100&page=1';
  let pages = 0;
  const MAX_PAGES = 10;

  while (url && pages < MAX_PAGES) {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error('Failed to fetch installation repositories');
    const payload = await res.json() as { repositories?: unknown[] };
    all.push(...(payload.repositories ?? []));
    url = parseNextPage(res.headers.get('Link'));
    pages++;
  }

  return all;
}

export function useRepos() {
  const [repos, setRepos] = useState<RepoWithActivity[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSyncTime, setLastSyncTime] = useState<string | null>(() =>
    safeStorageGet(SYNC_STORAGE_KEY),
  );
  const [userInfo, setUserInfo] = useState<{ login: string; avatar_url: string } | null>(null);

  const sync = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const headers = getAuthHeaders();
      const appToken = safeStorageGet(APP_TOKEN_STORAGE_KEY) || '';
      const hasInstallationId = Boolean(safeStorageGet(APP_INSTALLATION_ID_KEY));
      const isGitHubAppAuth = Boolean(appToken && hasInstallationId);

      if (!headers['Authorization']) {
        // No token — use mock data
        await new Promise((r) => setTimeout(r, 800));
        const now = new Date().toISOString();
        setRepos(MOCK_REPOS.map((r) => ({
          ...r,
          activity: { ...r.activity, last_synced: now },
        })));
        setLastSyncTime(now);
        safeStorageSet(SYNC_STORAGE_KEY, now);
        setUserInfo({ login: 'demo-user', avatar_url: '' });
        return;
      }

      let reposData: unknown;
      if (isGitHubAppAuth) {
        // Installation tokens are repo-scoped and cannot call /user.
        reposData = await fetchAllInstallationRepos(headers);
        setUserInfo(null);
      } else {
        // OAuth/PAT path has user context.
        const userRes = await fetch('https://api.github.com/user', { headers });
        if (!userRes.ok) throw new Error('Failed to fetch user');
        const userData = await userRes.json();
        setUserInfo({ login: userData.login, avatar_url: userData.avatar_url });

        reposData = await fetchAllUserRepos(headers);
      }

      const previousPushed = getStoredPushedAt();

      type RepoApi = {
        id: number;
        name: string;
        full_name: string;
        owner: { login: string; avatar_url: string };
        private: boolean;
        description?: string | null;
        open_issues_count: number;
        pushed_at: string;
        default_branch: string;
        language?: string | null;
      };
      const summaries: RepoSummary[] = (reposData as RepoApi[]).map((r) => ({
        id: r.id,
        name: r.name,
        full_name: r.full_name,
        owner: r.owner.login,
        private: r.private,
        description: r.description ?? null,
        open_issues_count: r.open_issues_count,
        pushed_at: r.pushed_at,
        default_branch: r.default_branch,
        language: r.language ?? null,
        avatar_url: r.owner.avatar_url,
      })).sort((a, b) => b.pushed_at.localeCompare(a.pushed_at));

      // Fetch activity for top 10 repos (rate limit friendly)
      const top = summaries.slice(0, 10);
      const activityResults = await Promise.all(
        top.map(async (repo) => {
          const [prs, commits] = await Promise.all([
            fetchPRCount(repo.full_name, headers),
            fetchRecentCommitCount(repo.full_name, headers),
          ]);
          return { fullName: repo.full_name, prs, commits };
        }),
      );

      const activityMap = new Map(
        activityResults.map((a) => [a.fullName, a]),
      );

      const now = new Date().toISOString();

      const reposWithActivity: RepoWithActivity[] = summaries.map((repo) => {
        const act = activityMap.get(repo.full_name);
        const prevPushed = previousPushed[repo.full_name];
        const hasNew = prevPushed ? repo.pushed_at > prevPushed : false;

        const activity: RepoActivity = {
          open_prs: act?.prs ?? 0,
          recent_commits: act?.commits ?? 0,
          has_new_activity: hasNew,
          last_synced: now,
        };

        return { ...repo, activity };
      });

      storePushedAt(summaries);
      setRepos(reposWithActivity);
      setLastSyncTime(now);
      safeStorageSet(SYNC_STORAGE_KEY, now);
    } catch (err) {
      const hasAnyToken = Boolean(
        safeStorageGet(OAUTH_STORAGE_KEY) ||
        safeStorageGet(APP_TOKEN_STORAGE_KEY) ||
        GITHUB_TOKEN
      );
      if (hasAnyToken) {
        const msg = err instanceof Error ? err.message : 'Failed to fetch repositories from GitHub';
        setError(msg);
        setRepos([]);
        return;
      }
      console.log('GitHub API failed, using mock data for demo');
      const now = new Date().toISOString();
      setRepos(MOCK_REPOS.map((r) => ({
        ...r,
        activity: { ...r.activity, last_synced: now },
      })));
      setLastSyncTime(now);
      safeStorageSet(SYNC_STORAGE_KEY, now);
      setUserInfo({ login: 'demo-user', avatar_url: '' });
    } finally {
      setLoading(false);
    }
  }, []);

  return { repos, loading, error, sync, lastSyncTime, userInfo };
}
