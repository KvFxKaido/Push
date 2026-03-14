import { useState, useMemo } from 'react';
import { Search, Lock, LogOut, Loader2 } from 'lucide-react';
import { CommitPulseIcon, PRThreadIcon, WorkspaceSparkIcon } from '@/components/icons/push-custom-icons';
import {
  HUB_MATERIAL_INPUT_CLASS,
  HUB_MATERIAL_PILL_BUTTON_CLASS,
  HUB_PANEL_SUBTLE_SURFACE_CLASS,
  HUB_PANEL_SURFACE_CLASS,
  HUB_TAG_CLASS,
  HubControlGlow,
} from '@/components/chat/hub-styles';
import type { RepoWithActivity, GitHubUser } from '@/types';
import { timeAgo } from '@/lib/utils';

interface RepoPickerProps {
  repos: RepoWithActivity[];
  loading: boolean;
  error?: string | null;
  onSelect: (repo: RepoWithActivity) => void;
  onDisconnect: () => void;
  onStartWorkspace: () => void;
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

const PICKER_CARD_CLASS =
  `${HUB_PANEL_SUBTLE_SURFACE_CLASS} p-3.5 transition-all duration-200 hover:border-push-edge-hover active:scale-[0.995]`;

const PICKER_ACTION_BUTTON_CLASS =
  `${HUB_MATERIAL_PILL_BUTTON_CLASS} h-9 gap-1.5 px-3 text-push-fg-secondary`;

export function RepoPicker({
  repos,
  loading,
  error,
  onSelect,
  onDisconnect,
  onStartWorkspace,
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
    <div className="flex h-dvh flex-col bg-push-grad-panel text-push-fg safe-area-top">
      {/* Header */}
      <header className="px-4 pb-3 pt-4">
        <div className={`${HUB_PANEL_SURFACE_CLASS} flex items-center justify-between gap-3 px-4 py-3`}>
          <div className="min-w-0">
            <p className="text-push-2xs font-medium uppercase tracking-[0.16em] text-push-fg-dim">
              Connected GitHub
            </p>
            <div className="mt-1 flex min-w-0 items-center gap-2">
              {user && (
                <span className="truncate text-sm font-medium text-push-fg">
                  {user.login}
                </span>
              )}
              <span className="h-2 w-2 flex-shrink-0 rounded-full bg-emerald-400" />
            </div>
          </div>
          <button
            onClick={onDisconnect}
            className={PICKER_ACTION_BUTTON_CLASS}
          >
            <HubControlGlow />
            <LogOut className="relative z-10 h-3.5 w-3.5" />
            <span className="relative z-10">Disconnect</span>
          </button>
        </div>
      </header>

      {/* Title + search */}
      <div className="space-y-4 px-4 pb-3 pt-2">
        <div>
          <h1 className="text-lg font-semibold text-push-fg tracking-tight">
            Select a repository
          </h1>
          <p className="mt-0.5 text-sm text-push-fg-secondary">
            Pick a repo to focus on. You can switch later.
          </p>
        </div>

        {error && (
          <div className="rounded-[18px] border border-red-500/20 bg-[linear-gradient(180deg,rgba(70,23,23,0.18)_0%,rgba(31,11,11,0.34)_100%)] px-3.5 py-3">
            <p className="text-xs text-red-200">
              Couldn&apos;t load repositories from GitHub: {error}
            </p>
          </div>
        )}

        <div className="relative">
          <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-push-fg-dim" />
          <input
            type="text"
            placeholder="Search repositories…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={`${HUB_MATERIAL_INPUT_CLASS} h-11 w-full rounded-[18px] py-2.5 pl-10 pr-4 text-sm`}
          />
        </div>
      </div>

      {/* Repo list */}
      <div className="flex-1 overflow-y-auto overscroll-contain px-4 pb-4">
        {/* New Workspace option */}
        <button
          onClick={onStartWorkspace}
          className={`${HUB_PANEL_SURFACE_CLASS} mb-3 flex w-full items-start gap-3 p-3.5 text-left transition-all duration-200 hover:border-emerald-500/30 active:scale-[0.995]`}
        >
          <WorkspaceSparkIcon className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" />
          <div className="min-w-0">
            <span className="text-sm font-medium text-emerald-300">New Workspace</span>
            <p className="mt-0.5 text-xs text-push-fg-secondary">Ephemeral workspace with no repo needed.</p>
          </div>
        </button>

        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium text-[#cfd8e8]">
            {search.trim() ? 'Matching repos' : 'Repositories'}
          </h2>
          <span className="text-xs text-[#657289]">{filtered.length}</span>
        </div>

        {loading && repos.length === 0 ? (
          <div className={`${HUB_PANEL_SUBTLE_SURFACE_CLASS} flex items-center justify-center py-14`}>
            <Loader2 className="h-5 w-5 animate-spin text-push-fg-dim" />
          </div>
        ) : filtered.length === 0 ? (
          <div className={`${HUB_PANEL_SUBTLE_SURFACE_CLASS} border-dashed px-3 py-6 text-center`}>
            <p className="text-sm text-push-fg-secondary">
              {search.trim() ? 'No repos match your search.' : 'No repositories found.'}
            </p>
          </div>
        ) : (
          <div className="space-y-1.5 stagger-in">
            {filtered.map((repo) => (
              <button
                key={repo.id}
                onClick={() => onSelect(repo)}
                className={`${PICKER_CARD_CLASS} flex w-full flex-col gap-1.5 text-left`}
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
                  <p className="line-clamp-1 text-xs text-push-fg-secondary">
                    {repo.description}
                  </p>
                )}

                {/* Meta row */}
                <div className="flex items-center gap-3 text-xs text-push-fg-dim">
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
                    <span className={`${HUB_TAG_CLASS} gap-1 text-[#58a6ff]`}>
                      <PRThreadIcon className="h-3 w-3" />
                      {repo.activity.open_prs}
                    </span>
                  )}
                  {repo.activity.recent_commits > 0 && (
                    <span className="flex items-center gap-1">
                      <CommitPulseIcon className="h-3 w-3" />
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
