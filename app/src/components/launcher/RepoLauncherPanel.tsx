import { useCallback, useMemo, useState } from 'react';
import {
  GitBranch,
  GitCommit,
  GitPullRequest,
  History,
  Lock,
  Search,
  Loader2,
} from 'lucide-react';
import { PushOrbitIcon, SandboxCubeIcon } from '@/components/icons/push-custom-icons';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { fetchRepoBranches } from '@/lib/github-tools';
import { BranchCreateSheet } from '@/components/chat/BranchCreateSheet';
import { timeAgo, timeAgoCompact } from '@/lib/utils';
import type { ActiveRepo, Conversation, RepoWithActivity } from '@/types';

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

type RepoChatMeta = {
  chatCount: number;
  lastChatAt: number;
};

type RepoBranchOption = {
  name: string;
  isDefault: boolean;
  isProtected: boolean;
};

function timeAgoWithAgo(timestamp: number): string {
  const compact = timeAgoCompact(timestamp);
  return compact === 'just now' ? compact : `${compact} ago`;
}

interface RepoLauncherPanelProps {
  repos: RepoWithActivity[];
  loading: boolean;
  error?: string | null;
  conversations: Record<string, Conversation>;
  activeRepo: ActiveRepo | null;
  onSelectRepo: (repo: RepoWithActivity, branch?: string) => void;
  onResumeConversation: (chatId: string) => void;
  onSandboxMode?: () => void;
}

export function RepoLauncherPanel({
  repos,
  loading,
  error,
  conversations,
  activeRepo,
  onSelectRepo,
  onResumeConversation,
  onSandboxMode,
}: RepoLauncherPanelProps) {
  const [showAllRepos, setShowAllRepos] = useState(false);
  const [search, setSearch] = useState('');
  const [openRepoBranchMenu, setOpenRepoBranchMenu] = useState<string | null>(null);
  const [repoBranchesByRepo, setRepoBranchesByRepo] = useState<Record<string, RepoBranchOption[]>>({});
  const [repoBranchLoadingByRepo, setRepoBranchLoadingByRepo] = useState<Record<string, boolean>>({});
  const [repoBranchErrorByRepo, setRepoBranchErrorByRepo] = useState<Record<string, string | null>>({});
  const [branchCreateRepo, setBranchCreateRepo] = useState<RepoWithActivity | null>(null);

  const loadBranchesForRepo = useCallback(async (repoFullName: string, force: boolean = false) => {
    if (!force && (repoBranchLoadingByRepo[repoFullName] || repoBranchesByRepo[repoFullName]?.length)) {
      return;
    }
    setRepoBranchLoadingByRepo((prev) => ({ ...prev, [repoFullName]: true }));
    setRepoBranchErrorByRepo((prev) => ({ ...prev, [repoFullName]: null }));
    try {
      const { branches } = await fetchRepoBranches(repoFullName, 300);
      setRepoBranchesByRepo((prev) => ({ ...prev, [repoFullName]: branches }));
    } catch (err) {
      setRepoBranchesByRepo((prev) => ({ ...prev, [repoFullName]: [] }));
      setRepoBranchErrorByRepo((prev) => ({
        ...prev,
        [repoFullName]: err instanceof Error ? err.message : 'Failed to load branches',
      }));
    } finally {
      setRepoBranchLoadingByRepo((prev) => ({ ...prev, [repoFullName]: false }));
    }
  }, [repoBranchLoadingByRepo, repoBranchesByRepo]);

  const repoChatMeta = useMemo(() => {
    const meta = new Map<string, RepoChatMeta>();
    for (const conv of Object.values(conversations)) {
      if (!conv.repoFullName) continue;
      const prev = meta.get(conv.repoFullName);
      if (!prev) {
        meta.set(conv.repoFullName, { chatCount: 1, lastChatAt: conv.lastMessageAt });
      } else {
        meta.set(conv.repoFullName, {
          chatCount: prev.chatCount + 1,
          lastChatAt: Math.max(prev.lastChatAt, conv.lastMessageAt),
        });
      }
    }
    return meta;
  }, [conversations]);

  const latestConversation = useMemo(() => {
    let latest: Conversation | null = null;
    for (const conv of Object.values(conversations)) {
      if (!conv.repoFullName) continue;
      if (!latest || conv.lastMessageAt > latest.lastMessageAt) {
        latest = conv;
      }
    }
    return latest;
  }, [conversations]);

  const latestConversationRepo = useMemo(() => {
    if (!latestConversation?.repoFullName) return null;
    return repos.find((repo) => repo.full_name === latestConversation.repoFullName) ?? null;
  }, [latestConversation, repos]);

  const recentRepos = useMemo(() => {
    return [...repos]
      .sort((a, b) => {
        const aChatAt = repoChatMeta.get(a.full_name)?.lastChatAt ?? 0;
        const bChatAt = repoChatMeta.get(b.full_name)?.lastChatAt ?? 0;
        if (aChatAt !== bChatAt) return bChatAt - aChatAt;
        return new Date(b.pushed_at).getTime() - new Date(a.pushed_at).getTime();
      })
      .slice(0, 6);
  }, [repos, repoChatMeta]);

  const filteredRepos = useMemo(() => {
    if (!search.trim()) return repos;
    const q = search.toLowerCase();
    return repos.filter(
      (repo) =>
        repo.name.toLowerCase().includes(q) ||
        repo.full_name.toLowerCase().includes(q) ||
        (repo.description && repo.description.toLowerCase().includes(q)),
    );
  }, [repos, search]);

  const branchCreateActiveRepo = useMemo<ActiveRepo | null>(() => {
    if (!branchCreateRepo) return null;
    const currentBranch =
      activeRepo?.full_name === branchCreateRepo.full_name
        ? activeRepo.current_branch || activeRepo.default_branch
        : branchCreateRepo.default_branch;
    return {
      id: branchCreateRepo.id,
      name: branchCreateRepo.name,
      full_name: branchCreateRepo.full_name,
      owner: branchCreateRepo.owner,
      default_branch: branchCreateRepo.default_branch,
      current_branch: currentBranch,
      private: branchCreateRepo.private,
    };
  }, [activeRepo, branchCreateRepo]);

  const renderRepoButton = useCallback((repo: RepoWithActivity) => {
    const chatMeta = repoChatMeta.get(repo.full_name);
    const isActiveRepo = activeRepo?.full_name === repo.full_name;
    const activeBranch = isActiveRepo ? activeRepo?.current_branch : undefined;
    const branchOptions = (() => {
      const loaded = repoBranchesByRepo[repo.full_name] || [];
      if (loaded.some((branch) => branch.name === repo.default_branch)) return loaded;
      return [
        {
          name: repo.default_branch,
          isDefault: true,
          isProtected: false,
        },
        ...loaded,
      ];
    })();
    const isBranchMenuOpen = openRepoBranchMenu === repo.full_name;
    const branchesLoading = Boolean(repoBranchLoadingByRepo[repo.full_name]);
    const branchesError = repoBranchErrorByRepo[repo.full_name] || null;

    return (
      <div
        key={repo.id}
        className="rounded-xl border border-push-edge bg-push-grad-card p-3.5 shadow-push-card card-hover spring-press hover:border-push-edge-hover hover:shadow-push-card-hover"
      >
        <button
          onClick={() => onSelectRepo(repo)}
          className="flex w-full flex-col gap-1.5 text-left"
        >
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-push-fg">
              {repo.name}
            </span>
            {repo.private && (
              <Lock className="h-3 w-3 shrink-0 text-[#52525b]" />
            )}
            {repo.activity.has_new_activity && (
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-push-accent" />
            )}
          </div>

          {activeBranch && activeBranch !== repo.default_branch && (
            <span className="inline-flex w-fit items-center gap-1 rounded-md bg-[#1a1f2e] px-1.5 py-0.5 text-push-xs text-[#9db8df]">
              <GitBranch className="h-3 w-3" />
              <span className="max-w-[160px] truncate">{activeBranch}</span>
            </span>
          )}

          {repo.description && (
            <p className="line-clamp-1 text-xs text-[#788396]">
              {repo.description}
            </p>
          )}

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
              <span className="inline-flex items-center gap-1 rounded-full bg-[#0d2847] px-1.5 py-0.5 text-[#58a6ff]">
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
            {chatMeta && (
              <span className="flex items-center gap-1 text-[#84bfff]">
                <History className="h-3 w-3" />
                {chatMeta.chatCount}
              </span>
            )}
            <span>{timeAgo(repo.pushed_at)}</span>
          </div>
        </button>

        <div className="mt-2 flex items-center gap-2">
          <button
            onClick={() => setBranchCreateRepo(repo)}
            className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border border-push-edge-subtle bg-push-grad-input px-2.5 text-xs text-push-fg-secondary shadow-[0_8px_20px_rgba(0,0,0,0.42),0_2px_6px_rgba(0,0,0,0.22)] backdrop-blur-xl transition-all duration-200 hover:border-push-edge-hover hover:text-push-fg hover:brightness-110"
          >
            <GitBranch className="h-3.5 w-3.5 text-push-fg-dim" />
            Create branch
          </button>

          <DropdownMenu
            open={isBranchMenuOpen}
            onOpenChange={(open) => {
              setOpenRepoBranchMenu(open ? repo.full_name : null);
              if (open) {
                void loadBranchesForRepo(repo.full_name);
              }
            }}
          >
            <DropdownMenuTrigger asChild>
              <button className="flex h-8 flex-1 items-center justify-between rounded-lg border border-push-edge-subtle bg-push-grad-input px-2.5 text-xs text-[#9db8df] shadow-[0_8px_20px_rgba(0,0,0,0.42),0_2px_6px_rgba(0,0,0,0.22)] backdrop-blur-xl transition-all duration-200 hover:border-push-edge-hover hover:brightness-110">
                <span className="inline-flex min-w-0 items-center gap-1">
                  <GitBranch className="h-3 w-3 text-push-fg-dim" />
                  <span className="truncate">Open on branch</span>
                </span>
                <span className="truncate text-push-xs text-[#788396]">{repo.default_branch}</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              sideOffset={8}
              className="w-[240px] rounded-xl border border-push-edge bg-push-grad-card shadow-[0_18px_40px_rgba(0,0,0,0.62)]"
            >
              <DropdownMenuLabel className="px-3 py-1.5 text-push-2xs font-medium uppercase tracking-wider text-push-fg-dim">
                {repo.name} Branches
              </DropdownMenuLabel>
              <DropdownMenuSeparator className="bg-push-edge" />

              {branchesLoading && (
                <DropdownMenuItem disabled className="mx-1 flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-push-fg-dim">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Loading branches...
                </DropdownMenuItem>
              )}

              {!branchesLoading && branchesError && (
                <>
                  <DropdownMenuItem disabled className="mx-1 rounded-lg px-3 py-2 text-xs text-red-400">
                    Failed to load branches
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={(event) => {
                      event.preventDefault();
                      void loadBranchesForRepo(repo.full_name, true);
                    }}
                    className="mx-1 rounded-lg px-3 py-2 text-xs text-push-link hover:bg-push-surface-hover"
                  >
                    Retry
                  </DropdownMenuItem>
                </>
              )}

              {!branchesLoading && !branchesError && branchOptions.length === 0 && (
                <DropdownMenuItem disabled className="mx-1 rounded-lg px-3 py-2 text-xs text-push-fg-dim">
                  No branches found
                </DropdownMenuItem>
              )}

              {!branchesLoading && !branchesError && branchOptions.map((branch) => (
                <DropdownMenuItem
                  key={branch.name}
                  onSelect={() => onSelectRepo(repo, branch.name)}
                  className="mx-1 flex items-center gap-2 rounded-lg px-3 py-2 hover:bg-push-surface-hover"
                >
                  <span className="min-w-0 flex-1 truncate text-xs text-push-fg-secondary">
                    {branch.name}
                  </span>
                  {branch.isDefault && (
                    <span className="rounded-full bg-[#0d2847] px-1.5 py-0.5 text-push-2xs text-[#58a6ff]">
                      default
                    </span>
                  )}
                  {branch.isProtected && (
                    <span className="rounded-full bg-[#2a1a1a] px-1.5 py-0.5 text-push-2xs text-[#fca5a5]">
                      protected
                    </span>
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    );
  }, [
    activeRepo,
    loadBranchesForRepo,
    onSelectRepo,
    openRepoBranchMenu,
    repoBranchErrorByRepo,
    repoBranchLoadingByRepo,
    repoBranchesByRepo,
    repoChatMeta,
  ]);

  return (
    <>
      <div className="space-y-4">
        {error && (
          <div className="rounded-xl border border-red-500/30 bg-red-950/30 px-3 py-2">
            <p className="text-xs text-red-200">
              Couldn&apos;t load repositories from GitHub: {error}
            </p>
          </div>
        )}

        {latestConversation && latestConversationRepo && (
          <button
            onClick={() => onResumeConversation(latestConversation.id)}
            className="flex w-full items-start gap-3 rounded-xl border border-[#31507d] bg-[linear-gradient(180deg,#0b1423_0%,#08101d_100%)] p-3.5 text-left shadow-push-card card-hover spring-press hover:border-[#3f659c] hover:shadow-push-card-hover"
          >
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#163055]">
              <PushOrbitIcon className="h-4 w-4 text-[#8ad4ff]" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium text-[#d7ecff]">Resume latest chat</p>
              <p className="mt-0.5 truncate text-xs text-[#9ab4d4]">
                {latestConversation.title}
              </p>
              <p className="mt-1 flex items-center gap-1 text-push-xs text-[#6f88aa]">
                <span>{latestConversationRepo.name}</span>
                {latestConversation.branch && (
                  <>
                    <span className="text-[#4a6080]">/</span>
                    <GitBranch className="h-2.5 w-2.5 shrink-0" />
                    <span className="max-w-[120px] truncate">{latestConversation.branch}</span>
                  </>
                )}
                <span className="text-[#4a6080]">·</span>
                <span>{timeAgoWithAgo(latestConversation.lastMessageAt)}</span>
              </p>
            </div>
          </button>
        )}

        <div className={`grid gap-2 ${onSandboxMode ? 'grid-cols-2' : 'grid-cols-1'}`}>
          {onSandboxMode && (
            <button
              onClick={onSandboxMode}
              className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-[linear-gradient(180deg,rgba(9,25,18,0.95)_0%,rgba(4,10,7,0.98)_100%)] px-3 py-2.5 text-sm font-medium text-emerald-300 shadow-[0_10px_24px_rgba(0,0,0,0.42),0_2px_8px_rgba(0,0,0,0.2)] spring-press transition-all duration-200 hover:border-emerald-500/45 hover:brightness-110"
            >
              <SandboxCubeIcon className="h-4 w-4" />
              New Sandbox
            </button>
          )}
          <button
            onClick={() => setShowAllRepos((value) => !value)}
            className="flex items-center gap-2 rounded-xl border border-push-edge-subtle bg-push-grad-input px-3 py-2.5 text-sm font-medium text-[#9fb0c8] shadow-[0_10px_24px_rgba(0,0,0,0.42),0_2px_8px_rgba(0,0,0,0.2)] backdrop-blur-xl spring-press transition-all duration-200 hover:border-push-edge-hover hover:text-[#e2e8f0] hover:brightness-110"
          >
            <Search className="h-4 w-4" />
            {showAllRepos ? 'Hide All Repos' : 'Browse All Repos'}
          </button>
        </div>

        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-[#cfd8e8]">Recent repos</h2>
            <span className="text-xs text-[#657289]">{recentRepos.length}</span>
          </div>
          {loading && repos.length === 0 ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-[#52525b]" />
            </div>
          ) : recentRepos.length === 0 ? (
            <div className="rounded-xl border border-dashed border-push-edge px-3 py-4 text-center text-xs text-[#788396]">
              No repositories yet.
            </div>
          ) : (
            <div className="space-y-1.5 stagger-in">
              {recentRepos.map(renderRepoButton)}
            </div>
          )}
        </section>

        {showAllRepos && (
          <section className="space-y-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#4f596d]" />
              <input
                type="text"
                placeholder="Search repositories..."
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="w-full rounded-xl border border-push-edge-subtle bg-push-grad-input py-2.5 pl-10 pr-4 text-sm text-push-fg placeholder:text-[#4f596d] shadow-[0_10px_24px_rgba(0,0,0,0.35),0_2px_6px_rgba(0,0,0,0.2)] backdrop-blur-xl outline-none transition-all duration-200 focus:border-push-sky/50"
              />
            </div>
            {filteredRepos.length === 0 ? (
              <div className="rounded-xl border border-dashed border-push-edge px-3 py-4 text-center text-xs text-[#788396]">
                No repos match your search.
              </div>
            ) : (
              <div className="space-y-1.5 stagger-in">
                {filteredRepos.map(renderRepoButton)}
              </div>
            )}
          </section>
        )}
      </div>

      {branchCreateActiveRepo && (
        <BranchCreateSheet
          open={Boolean(branchCreateActiveRepo)}
          onOpenChange={(open) => {
            if (!open) setBranchCreateRepo(null);
          }}
          activeRepo={branchCreateActiveRepo}
          setCurrentBranch={(branch) => {
            if (!branchCreateRepo) return;
            onSelectRepo(branchCreateRepo, branch);
          }}
        />
      )}
    </>
  );
}
