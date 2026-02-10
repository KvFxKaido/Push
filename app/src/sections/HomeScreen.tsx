import { useMemo, useState } from 'react';
import {
  Box,
  GitCommit,
  GitPullRequest,
  History,
  Lock,
  LogOut,
  Search,
  Sparkles,
  Loader2,
} from 'lucide-react';
import type { Conversation, GitHubUser, RepoWithActivity } from '@/types';

interface HomeScreenProps {
  repos: RepoWithActivity[];
  loading: boolean;
  error?: string | null;
  conversations: Record<string, Conversation>;
  onSelectRepo: (repo: RepoWithActivity) => void;
  onResumeConversation: (chatId: string) => void;
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

function timeAgoFromDate(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function timeAgoFromTimestamp(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

type RepoChatMeta = {
  chatCount: number;
  lastChatAt: number;
};

export function HomeScreen({
  repos,
  loading,
  error,
  conversations,
  onSelectRepo,
  onResumeConversation,
  onDisconnect,
  onSandboxMode,
  user,
}: HomeScreenProps) {
  const [showAllRepos, setShowAllRepos] = useState(false);
  const [search, setSearch] = useState('');

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
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.full_name.toLowerCase().includes(q) ||
        (r.description && r.description.toLowerCase().includes(q)),
    );
  }, [repos, search]);

  const renderRepoButton = (repo: RepoWithActivity) => {
    const chatMeta = repoChatMeta.get(repo.full_name);
    return (
      <button
        key={repo.id}
        onClick={() => onSelectRepo(repo)}
        className="flex w-full flex-col gap-1.5 rounded-xl border border-push-edge bg-[linear-gradient(180deg,#090d14_0%,#06090f_100%)] p-3.5 text-left shadow-[0_10px_28px_rgba(0,0,0,0.38)] transition-all duration-200 hover:border-[#31425a] hover:bg-[#0d1119] active:scale-[0.99]"
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

        {repo.description && (
          <p className="line-clamp-1 text-xs text-[#788396]">
            {repo.description}
          </p>
        )}

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
          {chatMeta && (
            <span className="flex items-center gap-1 text-[#84bfff]">
              <History className="h-3 w-3" />
              {chatMeta.chatCount}
            </span>
          )}
          <span>{timeAgoFromDate(repo.pushed_at)}</span>
        </div>
      </button>
    );
  };

  return (
    <div className="flex h-dvh flex-col bg-[#000] safe-area-top safe-area-bottom">
      <header className="mx-3 mt-2 flex items-center justify-between rounded-2xl border border-[#1b2230] bg-[linear-gradient(180deg,#070a11_0%,#03050a_100%)] px-3.5 py-2.5 shadow-[0_16px_36px_rgba(0,0,0,0.52)] backdrop-blur-xl">
        <div className="flex min-w-0 items-center gap-2">
          {user && (
            <span className="truncate text-sm font-medium text-push-fg">
              {user.login}
            </span>
          )}
          <div className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
        </div>
        <button
          onClick={onDisconnect}
          className="flex items-center gap-1.5 rounded-lg border border-push-edge bg-push-surface px-2 py-1.5 text-xs text-[#788396] transition-colors duration-200 hover:border-[#31425a] hover:text-[#e2e8f0]"
        >
          <LogOut className="h-3.5 w-3.5" />
          Disconnect
        </button>
      </header>

      <div className="flex-1 overflow-y-auto overscroll-contain px-4 pb-5 pt-5">
        <div className="space-y-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-push-fg">
              Home
            </h1>
            <p className="mt-0.5 text-sm text-[#788396]">
              Resume work fast or jump into a repository.
            </p>
          </div>

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
              className="flex w-full items-start gap-3 rounded-xl border border-[#31507d] bg-[linear-gradient(180deg,#0b1423_0%,#08101d_100%)] p-3.5 text-left transition-all duration-200 hover:border-[#3f659c] hover:bg-[#0d1727] active:scale-[0.99]"
            >
              <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#163055]">
                <Sparkles className="h-4 w-4 text-[#8ad4ff]" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-[#d7ecff]">Resume latest chat</p>
                <p className="mt-0.5 truncate text-xs text-[#9ab4d4]">
                  {latestConversation.title}
                </p>
                <p className="mt-1 text-[11px] text-[#6f88aa]">
                  {latestConversationRepo.name} · {timeAgoFromTimestamp(latestConversation.lastMessageAt)}
                </p>
              </div>
            </button>
          )}

          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={onSandboxMode}
              className="flex items-center gap-2 rounded-xl border border-emerald-500/20 bg-[linear-gradient(180deg,rgba(6,14,10,0.92)_0%,rgba(4,8,6,0.95)_100%)] px-3 py-2.5 text-sm font-medium text-emerald-300 transition-all duration-200 hover:border-emerald-500/35 hover:bg-emerald-900/20"
            >
              <Box className="h-4 w-4" />
              New Sandbox
            </button>
            <button
              onClick={() => setShowAllRepos((v) => !v)}
              className="flex items-center gap-2 rounded-xl border border-push-edge bg-push-surface px-3 py-2.5 text-sm font-medium text-[#9fb0c8] transition-all duration-200 hover:border-[#31425a] hover:text-[#e2e8f0]"
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
              <div className="space-y-1.5">
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
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full rounded-xl border border-push-edge bg-push-surface py-2.5 pl-10 pr-4 text-sm text-push-fg placeholder:text-[#4f596d] outline-none transition-colors duration-200 focus:border-push-sky/50"
                />
              </div>
              {filteredRepos.length === 0 ? (
                <div className="rounded-xl border border-dashed border-push-edge px-3 py-4 text-center text-xs text-[#788396]">
                  No repos match your search.
                </div>
              ) : (
                <div className="space-y-1.5">
                  {filteredRepos.map(renderRepoButton)}
                </div>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
