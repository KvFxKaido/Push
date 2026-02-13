import { useState, useMemo } from 'react';
import { Search, Lock, LogOut, Loader2, GitPullRequest, GitCommit, Box } from 'lucide-react';
import type { RepoWithActivity, GitHubUser } from '@/types';
import { timeAgo } from '@/lib/utils';

interface RepoPickerProps {
  repos: RepoWithActivity[];
  loading: boolean;
  error?: string | null;
  onSelect: (repo: RepoWithActivity) => void;
  onDisconnect: () => void;
  onSandboxMode: () => void;
  user: GitHubUser | null;
}

const LANG_COLORS: Record<string, string> = {
  TypeScript: '#3178c6',
  JavaScript: '#f1e05a',
  Python: '#3572a5',
  Go: '#00add8',
  Rust: '#dea584',
  Java: '#b07219',
  Shell: '#89e051',
  HTML: '#e34c26',
  CSS: '#563d7c',
  Ruby: '#701516',
  Swift: '#f05138',
  Kotlin: '#a97bff',
  MDX: '#fcb32c',
  C: '#555555',
  'C++': '#f34b7d',
  'C#': '#178600',
};


export function RepoPicker({
  repos,
  loading,
  error,
  onSelect,
  onDisconnect,
  onSandboxMode,
  user,
}: RepoPickerProps) {
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    if (!search.trim()) return repos;
    const q = search.toLowerCase();
    return repos.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.full_name.toLowerCase().includes(q) ||
        (r.description && r.description.toLowerCase().includes(q)),
    );
  }, [repos, search]);

  return (
    <div className="flex h-dvh flex-col bg-[#000] safe-area-top">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-[#151b26] bg-push-grad-panel px-4 py-3">
        <div className="flex items-center gap-2 min-w-0">
          {user && (
            <span className="text-sm font-medium text-push-fg truncate">
              {user.login}
            </span>
          )}
          <div className="h-2 w-2 rounded-full bg-emerald-500 flex-shrink-0" />
        </div>
        <button
          onClick={onDisconnect}
          className="flex items-center gap-1.5 rounded-lg border border-push-edge bg-push-surface px-2 py-1.5 text-xs text-[#788396] transition-colors duration-200 hover:border-[#31425a] hover:text-[#e2e8f0]"
        >
          <LogOut className="h-3.5 w-3.5" />
          Disconnect
        </button>
      </header>

      {/* Title + search */}
      <div className="px-4 pt-5 pb-3 space-y-4">
        <div>
          <h1 className="text-lg font-semibold text-push-fg tracking-tight">
            Select a repository
          </h1>
          <p className="mt-0.5 text-sm text-[#788396]">
            Pick a repo to focus on. You can switch later.
          </p>
        </div>

        {error && (
          <div className="rounded-xl border border-red-500/30 bg-red-950/30 px-3 py-2">
            <p className="text-xs text-red-200">
              Couldn&apos;t load repositories from GitHub: {error}
            </p>
          </div>
        )}

        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#4f596d]" />
          <input
            type="text"
            placeholder="Search repositories…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-xl border border-push-edge bg-push-surface py-2.5 pl-10 pr-4 text-sm text-push-fg placeholder:text-[#4f596d] outline-none transition-colors duration-200 focus:border-push-sky/50"
          />
        </div>
      </div>

      {/* Repo list */}
      <div className="flex-1 overflow-y-auto overscroll-contain px-4 pb-4">
        {/* New Sandbox option */}
        <button
          onClick={onSandboxMode}
          className="mb-3 flex w-full items-center gap-3 rounded-xl border border-emerald-500/20 bg-[linear-gradient(180deg,rgba(6,14,10,0.92)_0%,rgba(4,8,6,0.95)_100%)] p-3.5 text-left transition-all duration-200 hover:border-emerald-500/35 hover:bg-emerald-900/20 active:scale-[0.99]"
        >
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/10">
            <Box className="h-4 w-4 text-emerald-400" />
          </div>
          <div>
            <span className="text-sm font-medium text-emerald-400">New Sandbox</span>
            <p className="mt-0.5 text-xs text-[#788396]">Ephemeral workspace — no repo needed</p>
          </div>
        </button>

        {loading && repos.length === 0 ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-5 w-5 animate-spin text-[#52525b]" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex items-center justify-center py-16">
            <p className="text-sm text-[#788396]">
              {search.trim() ? 'No repos match your search.' : 'No repositories found.'}
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            {filtered.map((repo) => (
              <button
                key={repo.id}
                onClick={() => onSelect(repo)}
                className="flex w-full flex-col gap-1.5 rounded-xl border border-push-edge bg-push-grad-card p-3.5 text-left shadow-[0_10px_28px_rgba(0,0,0,0.38)] transition-all duration-200 hover:border-[#31425a] hover:bg-[#0d1119] active:scale-[0.99]"
              >
                {/* Name row */}
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-push-fg truncate">
                    {repo.name}
                  </span>
                  {repo.private && (
                    <Lock className="h-3 w-3 text-[#52525b] flex-shrink-0" />
                  )}
                  {repo.activity.has_new_activity && (
                    <div className="h-1.5 w-1.5 rounded-full bg-push-accent flex-shrink-0" />
                  )}
                </div>

                {/* Description */}
                {repo.description && (
                  <p className="text-xs text-[#788396] line-clamp-1">
                    {repo.description}
                  </p>
                )}

                {/* Meta row */}
                <div className="flex items-center gap-3 text-xs text-[#5f6b80]">
                  {repo.language && (
                    <span className="flex items-center gap-1">
                      <span
                        className="inline-block h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: LANG_COLORS[repo.language] || '#8b8b8b' }}
                      />
                      {repo.language}
                    </span>
                  )}
                  {repo.activity.open_prs > 0 && (
                    <span className="flex items-center gap-1">
                      <GitPullRequest className="h-3 w-3" />
                      {repo.activity.open_prs}
                    </span>
                  )}
                  {repo.activity.recent_commits > 0 && (
                    <span className="flex items-center gap-1">
                      <GitCommit className="h-3 w-3" />
                      {repo.activity.recent_commits}
                    </span>
                  )}
                  <span>{timeAgo(repo.pushed_at)}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
