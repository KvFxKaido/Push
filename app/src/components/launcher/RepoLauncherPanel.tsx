import { useCallback, useEffect, useMemo, useState } from 'react';
import { Lock, Palette, Search, Loader2 } from 'lucide-react';
import {
  BranchWaveIcon,
  CommitPulseIcon,
  HistoryStackIcon,
  PRThreadIcon,
  PushOrbitIcon,
  SandboxCubeIcon,
} from '@/components/icons/push-custom-icons';
import { RepoAppearanceSheet } from '@/components/repo/RepoAppearanceSheet';
import { RepoAppearanceBadge } from '@/components/repo/repo-appearance';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  HUB_MATERIAL_INPUT_CLASS,
  HUB_MATERIAL_PILL_BUTTON_CLASS,
  HUB_PANEL_SUBTLE_SURFACE_CLASS,
  HUB_PANEL_SURFACE_CLASS,
  HUB_TAG_CLASS,
  HubControlGlow,
} from '@/components/chat/hub-styles';
import { fetchRepoBranches } from '@/lib/github-tools';
import { BranchCreateSheet } from '@/components/chat/BranchCreateSheet';
import type { SandboxStatus } from '@/hooks/useSandbox';
import type { RepoAppearance } from '@/lib/repo-appearance';
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

const LAUNCHER_CARD_CLASS =
  `${HUB_PANEL_SUBTLE_SURFACE_CLASS} p-3.5 transition-all duration-200 hover:border-push-edge-hover`;

const LAUNCHER_ACTION_BUTTON_CLASS =
  `${HUB_MATERIAL_PILL_BUTTON_CLASS} h-8 flex-1 justify-center px-2.5`;
const SANDBOX_SESSION_LIFETIME_MS = 30 * 60 * 1000;
const SANDBOX_SESSION_WARNING_MS = 5 * 60 * 1000;

function timeAgoWithAgo(timestamp: number): string {
  const compact = timeAgoCompact(timestamp);
  return compact === 'just now' ? compact : `${compact} ago`;
}

function formatRemainingDuration(ms: number): string {
  if (ms <= 0) return '0:00';
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export interface LauncherSandboxSession {
  status: SandboxStatus;
  createdAt: number | null;
}

interface RepoLauncherPanelProps {
  repos: RepoWithActivity[];
  loading: boolean;
  error?: string | null;
  conversations: Record<string, Conversation>;
  activeRepo: ActiveRepo | null;
  resolveRepoAppearance: (repoFullName?: string | null) => RepoAppearance;
  setRepoAppearance: (repoFullName: string, appearance: RepoAppearance) => void;
  clearRepoAppearance: (repoFullName: string) => void;
  onSelectRepo: (repo: RepoWithActivity, branch?: string) => void;
  onResumeConversation: (chatId: string) => void;
  sandboxSession?: LauncherSandboxSession | null;
  onResumeSandbox?: () => void;
  onSandboxMode?: () => void;
}

export function RepoLauncherPanel({
  repos,
  loading,
  error,
  conversations,
  activeRepo,
  resolveRepoAppearance,
  setRepoAppearance,
  clearRepoAppearance,
  onSelectRepo,
  onResumeConversation,
  sandboxSession,
  onResumeSandbox,
  onSandboxMode,
}: RepoLauncherPanelProps) {
  const [showAllRepos, setShowAllRepos] = useState(false);
  const [search, setSearch] = useState('');
  const [openRepoBranchMenu, setOpenRepoBranchMenu] = useState<string | null>(null);
  const [repoBranchesByRepo, setRepoBranchesByRepo] = useState<Record<string, RepoBranchOption[]>>({});
  const [repoBranchLoadingByRepo, setRepoBranchLoadingByRepo] = useState<Record<string, boolean>>({});
  const [repoBranchErrorByRepo, setRepoBranchErrorByRepo] = useState<Record<string, string | null>>({});
  const [branchCreateRepo, setBranchCreateRepo] = useState<RepoWithActivity | null>(null);
  const [sandboxRemainingMs, setSandboxRemainingMs] = useState<number | null>(null);
  const [appearanceRepo, setAppearanceRepoState] = useState<RepoWithActivity | null>(null);

  useEffect(() => {
    if (!sandboxSession?.createdAt || sandboxSession.status !== 'ready') {
      setSandboxRemainingMs(null);
      return;
    }

    const tick = () => {
      const remaining = SANDBOX_SESSION_LIFETIME_MS - (Date.now() - sandboxSession.createdAt);
      setSandboxRemainingMs(remaining);
    };

    tick();
    const intervalId = window.setInterval(tick, 1000);
    return () => window.clearInterval(intervalId);
  }, [sandboxSession?.createdAt, sandboxSession?.status]);

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

  const latestRepoConversation = useMemo(() => {
    const availableRepos = new Set(repos.map((repo) => repo.full_name));
    let latest: Conversation | null = null;
    for (const conv of Object.values(conversations)) {
      if (!conv.repoFullName || !availableRepos.has(conv.repoFullName)) continue;
      if (!latest || conv.lastMessageAt > latest.lastMessageAt) {
        latest = conv;
      }
    }
    return latest;
  }, [conversations, repos]);

  const latestRepoConversationRepo = useMemo(() => {
    if (!latestRepoConversation?.repoFullName) return null;
    return repos.find((repo) => repo.full_name === latestRepoConversation.repoFullName) ?? null;
  }, [latestRepoConversation, repos]);

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

  const sandboxResumeMeta = useMemo(() => {
    if (!sandboxSession || sandboxSession.status === 'idle') return null;
    if (sandboxSession.status === 'ready') {
      const isWarning = sandboxRemainingMs !== null && sandboxRemainingMs <= SANDBOX_SESSION_WARNING_MS;
      return {
        detail: sandboxRemainingMs !== null
          ? `Sandbox session active - ${formatRemainingDuration(Math.max(sandboxRemainingMs, 0))} left`
          : 'Sandbox session active',
        detailClass: isWarning ? 'text-amber-300' : 'text-emerald-300',
      };
    }
    if (sandboxSession.status === 'creating') {
      return {
        detail: 'Workspace is starting',
        detailClass: 'text-push-fg-secondary',
      };
    }
    if (sandboxSession.status === 'reconnecting') {
      return {
        detail: 'Reconnecting to your workspace',
        detailClass: 'text-push-fg-secondary',
      };
    }
    return {
      detail: 'Workspace needs attention before you continue',
      detailClass: 'text-red-300',
    };
  }, [sandboxRemainingMs, sandboxSession]);

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
        className={LAUNCHER_CARD_CLASS}
      >
        <div className="relative">
          <button
            onClick={() => onSelectRepo(repo)}
            className="flex w-full flex-col gap-1.5 pr-10 text-left"
          >
            <div className="flex items-center gap-2">
              <RepoAppearanceBadge
                appearance={resolveRepoAppearance(repo.full_name)}
                className="h-6 w-6 shrink-0 rounded-md"
                iconClassName="h-3.5 w-3.5"
              />
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
              <span className={`${HUB_TAG_CLASS} w-fit gap-1 text-push-xs text-[#9db8df]`}>
                <BranchWaveIcon className="h-3 w-3" />
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
              {chatMeta && (
                <span className={`${HUB_TAG_CLASS} gap-1 text-[#84bfff]`}>
                  <HistoryStackIcon className="h-3 w-3" />
                  {chatMeta.chatCount}
                </span>
              )}
              <span>{timeAgo(repo.pushed_at)}</span>
            </div>
          </button>

          <button
            type="button"
            onClick={() => setAppearanceRepoState(repo)}
            className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} absolute right-0 top-0 h-8 w-8 justify-center px-0 text-push-fg-secondary`}
            aria-label={`Customize ${repo.name}`}
            title="Customize repo"
          >
            <HubControlGlow />
            <Palette className="relative z-10 h-3.5 w-3.5" />
          </button>
        </div>

        <div className="mt-2 flex items-center gap-2">
          <button
            onClick={() => setBranchCreateRepo(repo)}
            className={LAUNCHER_ACTION_BUTTON_CLASS}
          >
            <HubControlGlow />
            <BranchWaveIcon className="relative z-10 h-3.5 w-3.5 text-push-fg-dim" />
            <span className="relative z-10">Create branch</span>
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
              <button className={`${LAUNCHER_ACTION_BUTTON_CLASS} justify-between text-[#9db8df]`}>
                <HubControlGlow />
                <span className="relative z-10 inline-flex min-w-0 items-center gap-1">
                  <BranchWaveIcon className="h-3 w-3 text-push-fg-dim" />
                  <span className="truncate">Open on branch</span>
                </span>
                <span className="relative z-10 truncate text-push-xs text-[#788396]">{repo.default_branch}</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              sideOffset={8}
              className={`w-[240px] ${HUB_PANEL_SURFACE_CLASS}`}
            >
              <DropdownMenuLabel className="px-3 py-1.5 text-push-2xs font-medium uppercase tracking-wider text-push-fg-dim">
                {repo.name} Branches
              </DropdownMenuLabel>
              <DropdownMenuSeparator className="bg-push-edge" />

              {branchesLoading && (
                <DropdownMenuItem disabled className="mx-1 flex items-center gap-2 rounded-full px-3 py-2 text-xs text-push-fg-dim">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Loading branches...
                </DropdownMenuItem>
              )}

              {!branchesLoading && branchesError && (
                <>
                  <DropdownMenuItem disabled className="mx-1 rounded-full px-3 py-2 text-xs text-red-400">
                    Failed to load branches
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={(event) => {
                      event.preventDefault();
                      void loadBranchesForRepo(repo.full_name, true);
                    }}
                    className="mx-1 rounded-full px-3 py-2 text-xs text-push-link focus:bg-white/[0.04]"
                  >
                    Retry
                  </DropdownMenuItem>
                </>
              )}

              {!branchesLoading && !branchesError && branchOptions.length === 0 && (
                <DropdownMenuItem disabled className="mx-1 rounded-full px-3 py-2 text-xs text-push-fg-dim">
                  No branches found
                </DropdownMenuItem>
              )}

              {!branchesLoading && !branchesError && branchOptions.map((branch) => (
                <DropdownMenuItem
                  key={branch.name}
                  onSelect={() => onSelectRepo(repo, branch.name)}
                  className="mx-1 flex items-center gap-2 rounded-full px-3 py-2 focus:bg-white/[0.04]"
                >
                  <span className="min-w-0 flex-1 truncate text-xs text-push-fg-secondary">
                    {branch.name}
                  </span>
                  {branch.isDefault && (
                    <span className={`${HUB_TAG_CLASS} text-[#58a6ff]`}>
                      default
                    </span>
                  )}
                  {branch.isProtected && (
                    <span className={`${HUB_TAG_CLASS} text-[#fca5a5]`}>
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
    resolveRepoAppearance,
  ]);

  return (
    <>
      <div className="space-y-4">
        {error && (
          <div className={`${HUB_PANEL_SUBTLE_SURFACE_CLASS} border-red-500/20 bg-red-500/5 px-3 py-2`}>
            <p className="text-xs text-red-200">
              Couldn&apos;t load repositories from GitHub: {error}
            </p>
          </div>
        )}

        {sandboxResumeMeta && onResumeSandbox && (
          <button
            onClick={onResumeSandbox}
            className={`${HUB_PANEL_SURFACE_CLASS} flex w-full items-start gap-3 p-3.5 text-left transition-all duration-200 hover:border-push-edge-hover`}
          >
            <SandboxCubeIcon className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-push-fg">Resume sandbox</p>
              <p className={`mt-0.5 truncate text-xs ${sandboxResumeMeta.detailClass}`}>
                {sandboxResumeMeta.detail}
              </p>
            </div>
          </button>
        )}

        {latestRepoConversation && latestRepoConversationRepo && (
          <button
            onClick={() => onResumeConversation(latestRepoConversation.id)}
            className={`${HUB_PANEL_SURFACE_CLASS} flex w-full items-start gap-3 p-3.5 text-left transition-all duration-200 hover:border-push-edge-hover`}
          >
            <PushOrbitIcon className="mt-0.5 h-4 w-4 shrink-0 text-[#8ad4ff]" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-push-fg">Resume latest repo chat</p>
              <p className="mt-0.5 truncate text-xs text-push-fg-secondary">
                {latestRepoConversation.title}
              </p>
              <p className="mt-1 flex items-center gap-1 text-push-xs text-push-fg-dim">
                <span>{latestRepoConversationRepo.name}</span>
                {latestRepoConversation.branch && (
                  <>
                    <span className="text-push-fg-dim/60">/</span>
                    <BranchWaveIcon className="h-2.5 w-2.5 shrink-0" />
                    <span className="max-w-[120px] truncate">{latestRepoConversation.branch}</span>
                  </>
                )}
                <span className="text-push-fg-dim/60">·</span>
                <span>{timeAgoWithAgo(latestRepoConversation.lastMessageAt)}</span>
              </p>
            </div>
          </button>
        )}

        <div className={`grid gap-2 ${onSandboxMode ? 'grid-cols-2' : 'grid-cols-1'}`}>
          {onSandboxMode && (
            <button
              onClick={onSandboxMode}
              className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} h-11 gap-2 px-3 text-sm font-medium text-emerald-300`}
            >
              <HubControlGlow />
              <SandboxCubeIcon className="relative z-10 h-4 w-4" />
              <span className="relative z-10">New Sandbox</span>
            </button>
          )}
          <button
            onClick={() => setShowAllRepos((value) => !value)}
            className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} h-11 gap-2 px-3 text-sm font-medium text-[#9fb0c8]`}
          >
            <HubControlGlow />
            <Search className="relative z-10 h-4 w-4" />
            <span className="relative z-10">{showAllRepos ? 'Hide All Repos' : 'Browse All Repos'}</span>
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
            <div className={`${HUB_PANEL_SUBTLE_SURFACE_CLASS} border-dashed px-3 py-4 text-center text-xs text-[#788396]`}>
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
                className={`${HUB_MATERIAL_INPUT_CLASS} w-full py-2.5 pl-10 pr-4 text-sm`}
              />
            </div>
            {filteredRepos.length === 0 ? (
              <div className={`${HUB_PANEL_SUBTLE_SURFACE_CLASS} border-dashed px-3 py-4 text-center text-xs text-[#788396]`}>
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

      {appearanceRepo && (
        <RepoAppearanceSheet
          open={Boolean(appearanceRepo)}
          onOpenChange={(open) => {
            if (!open) setAppearanceRepoState(null);
          }}
          repoName={appearanceRepo.name}
          appearance={resolveRepoAppearance(appearanceRepo.full_name)}
          onSave={(appearance) => setRepoAppearance(appearanceRepo.full_name, appearance)}
          onReset={() => clearRepoAppearance(appearanceRepo.full_name)}
        />
      )}
    </>
  );
}
