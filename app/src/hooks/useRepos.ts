import { useState, useCallback } from 'react';
import type { RepoWithActivity, RepoSummary, RepoActivity } from '@/types';

const GITHUB_TOKEN = import.meta.env.VITE_GITHUB_TOKEN || '';
const OAUTH_STORAGE_KEY = 'github_access_token';
const SYNC_STORAGE_KEY = 'repo_last_sync';
const PUSHED_STORAGE_KEY = 'repo_last_pushed';

function getAuthHeaders(): Record<string, string> {
  const oauthToken = localStorage.getItem(OAUTH_STORAGE_KEY) || '';
  const authToken = oauthToken || GITHUB_TOKEN;
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
    return JSON.parse(localStorage.getItem(PUSHED_STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function storePushedAt(repos: RepoSummary[]) {
  const map: Record<string, string> = {};
  for (const repo of repos) {
    map[repo.full_name] = repo.pushed_at;
  }
  localStorage.setItem(PUSHED_STORAGE_KEY, JSON.stringify(map));
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

export function useRepos() {
  const [repos, setRepos] = useState<RepoWithActivity[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSyncTime, setLastSyncTime] = useState<string | null>(() =>
    localStorage.getItem(SYNC_STORAGE_KEY),
  );
  const [userInfo, setUserInfo] = useState<{ login: string; avatar_url: string } | null>(null);

  const sync = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const headers = getAuthHeaders();

      if (!headers['Authorization']) {
        // No token — use mock data
        await new Promise((r) => setTimeout(r, 800));
        const now = new Date().toISOString();
        setRepos(MOCK_REPOS.map((r) => ({
          ...r,
          activity: { ...r.activity, last_synced: now },
        })));
        setLastSyncTime(now);
        localStorage.setItem(SYNC_STORAGE_KEY, now);
        setUserInfo({ login: 'demo-user', avatar_url: '' });
        return;
      }

      // Fetch authenticated user
      const userRes = await fetch('https://api.github.com/user', { headers });
      if (!userRes.ok) throw new Error('Failed to fetch user');
      const userData = await userRes.json();
      setUserInfo({ login: userData.login, avatar_url: userData.avatar_url });

      // Fetch repos sorted by recent push
      const reposRes = await fetch(
        'https://api.github.com/user/repos?sort=pushed&direction=desc&per_page=30',
        { headers },
      );
      if (!reposRes.ok) throw new Error('Failed to fetch repos');
      const reposData = await reposRes.json();

      const previousPushed = getStoredPushedAt();

      const summaries: RepoSummary[] = reposData.map((r: any) => ({
        id: r.id,
        name: r.name,
        full_name: r.full_name,
        owner: r.owner.login,
        private: r.private,
        description: r.description,
        open_issues_count: r.open_issues_count,
        pushed_at: r.pushed_at,
        default_branch: r.default_branch,
        language: r.language,
        avatar_url: r.owner.avatar_url,
      }));

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
      localStorage.setItem(SYNC_STORAGE_KEY, now);
    } catch (err) {
      console.log('GitHub API failed, using mock data for demo');
      const now = new Date().toISOString();
      setRepos(MOCK_REPOS.map((r) => ({
        ...r,
        activity: { ...r.activity, last_synced: now },
      })));
      setLastSyncTime(now);
      localStorage.setItem(SYNC_STORAGE_KEY, now);
      setUserInfo({ login: 'demo-user', avatar_url: '' });
    } finally {
      setLoading(false);
    }
  }, []);

  return { repos, loading, error, sync, lastSyncTime, userInfo };
}
