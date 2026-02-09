import { useState, useMemo } from 'react';
import { Search, Lock, LogOut, Loader2, GitPullRequest, GitCommit } from 'lucide-react';
import type { RepoWithActivity, GitHubUser } from '@/types';

interface RepoPickerProps {
  repos: RepoWithActivity[];
  loading: boolean;
  error?: string | null;
  onSelect: (repo: RepoWithActivity) => void;
  onDisconnect: () => void;
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

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export function RepoPicker({
  repos,
  loading,
  error,
  onSelect,
  onDisconnect,
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
      <header className="flex items-center justify-between px-4 py-3 border-b border-[#1a1a1a]">
        <div className="flex items-center gap-2 min-w-0">
          {user && (
            <span className="text-sm font-medium text-[#fafafa] truncate">
              {user.login}
            </span>
          )}
          <div className="h-2 w-2 rounded-full bg-emerald-500 flex-shrink-0" />
        </div>
        <button
          onClick={onDisconnect}
          className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-[#52525b] transition-colors duration-200 hover:text-[#a1a1aa] hover:bg-[#0d0d0d]"
        >
          <LogOut className="h-3.5 w-3.5" />
          Disconnect
        </button>
      </header>

      {/* Title + search */}
      <div className="px-4 pt-5 pb-3 space-y-4">
        <div>
          <h1 className="text-lg font-semibold text-[#fafafa] tracking-tight">
            Select a repository
          </h1>
          <p className="text-sm text-[#52525b] mt-0.5">
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
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[#3f3f46]" />
          <input
            type="text"
            placeholder="Search repositories…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-xl border border-[#1a1a1a] bg-[#0d0d0d] pl-10 pr-4 py-2.5 text-sm text-[#fafafa] placeholder:text-[#3f3f46] outline-none transition-colors duration-200 focus:border-[#0070f3]/50"
          />
        </div>
      </div>

      {/* Repo list */}
      <div className="flex-1 overflow-y-auto overscroll-contain px-4 pb-4">
        {loading && repos.length === 0 ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-5 w-5 animate-spin text-[#52525b]" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex items-center justify-center py-16">
            <p className="text-sm text-[#52525b]">
              {search.trim() ? 'No repos match your search.' : 'No repositories found.'}
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            {filtered.map((repo) => (
              <button
                key={repo.id}
                onClick={() => onSelect(repo)}
                className="flex w-full flex-col gap-1.5 rounded-xl border border-[#1a1a1a] bg-[#0d0d0d] p-3.5 text-left transition-all duration-200 hover:border-[#27272a] hover:bg-[#141416] active:scale-[0.99]"
              >
                {/* Name row */}
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-[#fafafa] truncate">
                    {repo.name}
                  </span>
                  {repo.private && (
                    <Lock className="h-3 w-3 text-[#52525b] flex-shrink-0" />
                  )}
                  {repo.activity.has_new_activity && (
                    <div className="h-1.5 w-1.5 rounded-full bg-[#0070f3] flex-shrink-0" />
                  )}
                </div>

                {/* Description */}
                {repo.description && (
                  <p className="text-xs text-[#52525b] line-clamp-1">
                    {repo.description}
                  </p>
                )}

                {/* Meta row */}
                <div className="flex items-center gap-3 text-xs text-[#3f3f46]">
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
