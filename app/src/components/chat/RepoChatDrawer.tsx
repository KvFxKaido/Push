import { useMemo, useState } from 'react';
import {
  ArrowLeft,
  Box,
  Check,
  ChevronRight,
  Cpu,
  FolderCog,
  FolderGit2,
  House,
  Menu,
  Pencil,
  Plus,
  Search,
  Settings,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import type { ActiveRepo, Conversation, RepoWithActivity } from '@/types';

interface RepoChatDrawerProps {
  repos: RepoWithActivity[];
  activeRepo: ActiveRepo | null;
  conversations: Record<string, Conversation>;
  activeChatId: string;
  onSelectRepo: (repo: RepoWithActivity) => void;
  onSwitchChat: (id: string) => void;
  onNewChat: () => void;
  onDeleteChat: (id: string) => void;
  onRenameChat: (id: string, title: string) => void;
  onOpenSettings?: (tab: 'you' | 'workspace' | 'ai') => void;
  onBrowseRepos?: () => void;
  onSandboxMode?: () => void;
  isSandboxMode?: boolean;
  onExitSandboxMode?: () => void;
}

const EMPTY_CHATS: Conversation[] = [];

function timeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

export function RepoChatDrawer({
  repos,
  activeRepo,
  conversations,
  activeChatId,
  onSelectRepo,
  onSwitchChat,
  onNewChat,
  onDeleteChat,
  onRenameChat,
  onOpenSettings,
  onBrowseRepos,
  onSandboxMode,
  isSandboxMode = false,
  onExitSandboxMode,
}: RepoChatDrawerProps) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<'history' | 'settings'>('history');
  const [expandedRepos, setExpandedRepos] = useState<Record<string, boolean>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');

  const chatsByRepo = useMemo(() => {
    const grouped = new Map<string, Conversation[]>();
    for (const conv of Object.values(conversations)) {
      const key = conv.repoFullName || '__unscoped__';
      const arr = grouped.get(key) || [];
      arr.push(conv);
      grouped.set(key, arr);
    }
    for (const [, list] of grouped) {
      list.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    }
    return grouped;
  }, [conversations]);

  const repoRows = useMemo(
    () => repos.map((repo) => ({ repo, chats: chatsByRepo.get(repo.full_name) || [] })),
    [repos, chatsByRepo],
  );

  const unscopedChats = chatsByRepo.get('__unscoped__') ?? EMPTY_CHATS;
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const isSearching = normalizedQuery.length > 0;

  const filteredRepoRows = useMemo(() => {
    if (!isSearching) return repoRows;
    return repoRows
      .map(({ repo, chats }) => {
        const repoMatches = `${repo.name} ${repo.full_name}`.toLowerCase().includes(normalizedQuery);
        const matchingChats = chats.filter((chat) => chat.title.toLowerCase().includes(normalizedQuery));
        if (!repoMatches && matchingChats.length === 0) return null;
        return { repo, chats: repoMatches ? chats : matchingChats };
      })
      .filter((row): row is { repo: RepoWithActivity; chats: Conversation[] } => Boolean(row));
  }, [isSearching, normalizedQuery, repoRows]);

  const filteredUnscopedChats = useMemo(() => {
    if (!isSearching) return unscopedChats;
    return unscopedChats.filter((chat) => chat.title.toLowerCase().includes(normalizedQuery));
  }, [isSearching, normalizedQuery, unscopedChats]);

  const toggleRepo = (repoFullName: string, fallbackOpen: boolean) => {
    if (isSearching) return;
    setExpandedRepos((prev) => ({ ...prev, [repoFullName]: !(prev[repoFullName] ?? fallbackOpen) }));
  };

  const openChat = (chatId: string, repo?: RepoWithActivity) => {
    if (repo && activeRepo?.id !== repo.id) {
      onSelectRepo(repo);
    }
    onSwitchChat(chatId);
    setOpen(false);
    setEditingChatId(null);
    setEditingTitle('');
  };

  const startRename = (chat: Conversation) => {
    setEditingChatId(chat.id);
    setEditingTitle(chat.title);
  };

  const cancelRename = () => {
    setEditingChatId(null);
    setEditingTitle('');
  };

  const commitRename = () => {
    if (!editingChatId) return;
    const trimmed = editingTitle.trim();
    if (!trimmed) {
      cancelRename();
      return;
    }
    onRenameChat(editingChatId, trimmed);
    cancelRename();
  };

  const closeDrawer = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setPanel('history');
      setSearchQuery('');
      cancelRename();
    }
  };

  const openSettingsTab = (tab: 'you' | 'workspace' | 'ai') => {
    if (!onOpenSettings) return;
    setOpen(false);
    setPanel('history');
    onOpenSettings(tab);
  };

  const renderChatRow = (chat: Conversation, repo?: RepoWithActivity) => {
    const isActiveChat = chat.id === activeChatId;
    const isEditing = editingChatId === chat.id;
    const messageCount = chat.messages.filter((m) => !m.isToolResult).length;

    return (
      <div key={chat.id} className={`flex items-center gap-1.5 rounded-lg ${isActiveChat ? 'bg-[#121a29]' : 'hover:bg-[#0d1119]'}`}>
        {isEditing ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              e.stopPropagation();
              commitRename();
            }}
            className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5"
          >
            <input
              value={editingTitle}
              autoFocus
              maxLength={80}
              onChange={(e) => setEditingTitle(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  cancelRename();
                }
              }}
              className="h-7 w-full rounded-md border border-[#2a3447] bg-[#05070b] px-2 text-[12px] text-[#f5f7ff] outline-none placeholder:text-[#5f6b80] focus:border-[#3d5579]"
              placeholder="Chat name"
              aria-label="Rename chat"
            />
            <button
              type="submit"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-emerald-300 transition-colors hover:bg-[#173523] hover:text-emerald-200"
              aria-label="Save chat name"
            >
              <Check className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                cancelRename();
              }}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[#8b96aa] transition-colors hover:bg-[#1a1f2b] hover:text-[#d7deeb]"
              aria-label="Cancel rename"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </form>
        ) : (
          <>
            <button
              onClick={() => openChat(chat.id, repo)}
              className="min-w-0 flex-1 px-2.5 py-2 text-left"
            >
              <p className={`truncate text-[12px] ${isActiveChat ? 'text-[#f5f7ff]' : 'text-[#c5cfde]'}`}>
                {chat.title}
              </p>
              <p className="mt-0.5 text-[10px] text-[#8b96aa]">
                {messageCount} msg{messageCount !== 1 ? 's' : ''} · {timeAgo(chat.lastMessageAt)}
              </p>
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                startRename(chat);
              }}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[#8b96aa] transition-colors hover:bg-[#1a1f2b] hover:text-[#d7deeb]"
              aria-label={`Rename ${chat.title}`}
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDeleteChat(chat.id);
              }}
              className="mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[#8b96aa] transition-colors hover:bg-[#1a1f2b] hover:text-red-400"
              aria-label={`Delete ${chat.title}`}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </div>
    );
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-[#b4becf] transition-colors duration-200 hover:text-[#f5f7ff] active:scale-95"
        aria-label="Open chats and repos"
        title="Chats and repos"
      >
        <Menu className="h-4 w-4" />
      </button>

      <Sheet open={open} onOpenChange={closeDrawer}>
      <SheetContent
        side="left"
        className="w-[86vw] border-[#151b26] bg-[linear-gradient(180deg,#05070b_0%,#020306_100%)] p-0 text-[#f5f7ff] sm:max-w-sm [&>[data-slot=sheet-close]]:text-[#b4becf] [&>[data-slot=sheet-close]]:hover:text-[#f5f7ff]"
      >
        <div className="relative h-full overflow-hidden">
          <div
            className={`absolute inset-0 flex flex-col transition-transform duration-300 ${
              panel === 'settings' ? '-translate-x-full' : 'translate-x-0'
            }`}
          >
            <SheetHeader className="border-b border-[#1f2531] pb-3">
              <SheetTitle className="text-[#f5f7ff]">History</SheetTitle>
              <SheetDescription className="text-[#8b96aa]">
                Repos and chats
              </SheetDescription>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  onClick={() => {
                    onNewChat();
                    setOpen(false);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[#2a3447] bg-[#070a10] px-2.5 py-1.5 text-xs font-medium text-[#b4becf] transition-colors hover:border-[#31425a] hover:text-[#f0f4ff]"
                >
                  <Plus className="h-3.5 w-3.5" />
                  New chat
                </button>
                {onBrowseRepos && (
                  <button
                    onClick={() => {
                      onBrowseRepos();
                      setOpen(false);
                    }}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-[#2a3447] bg-[#070a10] px-2.5 py-1.5 text-xs font-medium text-[#8ad4ff] transition-colors hover:border-[#31425a] hover:text-[#c4e9ff]"
                  >
                    <House className="h-3.5 w-3.5" />
                    Home
                  </button>
                )}
                {!isSandboxMode && onSandboxMode && (
                  <button
                    onClick={() => {
                      onSandboxMode();
                      setOpen(false);
                    }}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/35 bg-emerald-900/15 px-2.5 py-1.5 text-xs font-medium text-emerald-300 transition-colors hover:border-emerald-500/50 hover:text-emerald-200"
                  >
                    <Box className="h-3.5 w-3.5" />
                    Sandbox
                  </button>
                )}
                {isSandboxMode && onExitSandboxMode && (
                  <button
                    onClick={() => {
                      onExitSandboxMode();
                      setOpen(false);
                    }}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-[#2a3447] bg-[#070a10] px-2.5 py-1.5 text-xs font-medium text-[#b4becf] transition-colors hover:border-[#31425a] hover:text-[#f0f4ff]"
                  >
                    <X className="h-3.5 w-3.5" />
                    Exit sandbox
                  </button>
                )}
              </div>
              <div className="relative mt-2">
                <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-[#5f6b80]" />
                <input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search repos and chats"
                  className="h-8 w-full rounded-lg border border-[#242d3d] bg-[#05070b] pl-8 pr-2.5 text-xs text-[#d7deeb] outline-none placeholder:text-[#5f6b80] focus:border-[#3d5579]"
                />
              </div>
            </SheetHeader>

            <div className="flex-1 overflow-y-auto p-3">
              <div className="space-y-1.5">
                {filteredRepoRows.map(({ repo, chats }) => {
                  const isExpanded = isSearching || (expandedRepos[repo.full_name] ?? (activeRepo?.full_name === repo.full_name));
                  const isActiveRepo = activeRepo?.id === repo.id;
                  return (
                    <div key={repo.id} className="rounded-xl border border-[#1f2531] bg-[#070a10]">
                      <button
                        onClick={() => toggleRepo(repo.full_name, isExpanded)}
                        className={`flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left transition-colors ${
                          isActiveRepo ? 'bg-[#101621]' : 'hover:bg-[#0d1119]'
                        }`}
                      >
                        <ChevronRight
                          className={`h-3.5 w-3.5 shrink-0 text-[#8b96aa] transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                        />
                        <FolderGit2 className={`h-3.5 w-3.5 shrink-0 ${isActiveRepo ? 'text-[#8ad4ff]' : 'text-[#8b96aa]'}`} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] font-medium text-[#f5f7ff]">{repo.name}</p>
                          <p className="text-[11px] text-[#8b96aa]">{chats.length} chat{chats.length !== 1 ? 's' : ''}</p>
                        </div>
                        {isActiveRepo && (
                          <span className="rounded-full bg-[#5cb7ff]/15 px-2 py-0.5 text-[10px] font-medium text-[#8ad4ff]">
                            active
                          </span>
                        )}
                      </button>

                      {isExpanded && (
                        <div className="space-y-1 px-2 pb-2">
                          {chats.length === 0 ? (
                            <div className="rounded-lg border border-dashed border-[#2a3447] px-2.5 py-2 text-[11px] text-[#8b96aa]">
                              No chats yet
                            </div>
                          ) : (
                            chats.map((chat) => renderChatRow(chat, repo))
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}

                {filteredUnscopedChats.length > 0 && (
                  <div className="rounded-xl border border-[#1f2531] bg-[#070a10]">
                    <div className="px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-[#8b96aa]">
                      Unscoped
                    </div>
                    <div className="space-y-1 px-2 pb-2">
                      {filteredUnscopedChats.map((chat) => renderChatRow(chat))}
                    </div>
                  </div>
                )}
                {filteredRepoRows.length === 0 && filteredUnscopedChats.length === 0 && (
                  <div className="rounded-xl border border-dashed border-[#2a3447] bg-[#070a10] px-3 py-4 text-center text-[12px] text-[#8b96aa]">
                    No repos or chats match your search.
                  </div>
                )}
              </div>
            </div>

            {onOpenSettings && (
              <div className="border-t border-[#1f2531] px-3 py-2.5">
                <button
                  onClick={() => setPanel('settings')}
                  className="inline-flex items-center gap-2 rounded-lg border border-[#2a3447] bg-[#070a10] px-3 py-1.5 text-xs font-medium text-[#c5cfde] transition-colors hover:border-[#31425a] hover:text-[#f0f4ff]"
                >
                  <Settings className="h-3.5 w-3.5" />
                  Settings
                </button>
              </div>
            )}
          </div>

          <div
            className={`absolute inset-0 flex flex-col transition-transform duration-300 ${
              panel === 'settings' ? 'translate-x-0' : 'translate-x-full'
            }`}
          >
            <div className="border-b border-[#1f2531] px-4 pb-3 pt-4">
              <button
                onClick={() => setPanel('history')}
                className="mb-3 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-[#8b96aa] transition-colors hover:bg-[#0d1119] hover:text-[#d7deeb]"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Back
              </button>
              <h3 className="text-sm font-semibold text-[#f5f7ff]">Settings</h3>
              <p className="mt-1 text-xs text-[#8b96aa]">Pick a section and we&apos;ll slide open full settings.</p>
            </div>

            <div className="flex-1 overflow-y-auto p-3">
              <div className="space-y-2">
                <button
                  onClick={() => openSettingsTab('you')}
                  className="flex w-full items-center gap-2 rounded-xl border border-[#1f2531] bg-[#070a10] px-3 py-2.5 text-left transition-colors hover:border-[#31425a] hover:bg-[#0d1119]"
                >
                  <UserRound className="h-4 w-4 text-[#8ad4ff]" />
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-[#f5f7ff]">You</p>
                    <p className="text-[11px] text-[#8b96aa]">GitHub, profile, identity</p>
                  </div>
                </button>

                <button
                  onClick={() => openSettingsTab('workspace')}
                  className="flex w-full items-center gap-2 rounded-xl border border-[#1f2531] bg-[#070a10] px-3 py-2.5 text-left transition-colors hover:border-[#31425a] hover:bg-[#0d1119]"
                >
                  <FolderCog className="h-4 w-4 text-[#8ad4ff]" />
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-[#f5f7ff]">Workspace</p>
                    <p className="text-[11px] text-[#8b96aa]">Context mode, sandbox controls</p>
                  </div>
                </button>

                <button
                  onClick={() => openSettingsTab('ai')}
                  className="flex w-full items-center gap-2 rounded-xl border border-[#1f2531] bg-[#070a10] px-3 py-2.5 text-left transition-colors hover:border-[#31425a] hover:bg-[#0d1119]"
                >
                  <Cpu className="h-4 w-4 text-[#8ad4ff]" />
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-[#f5f7ff]">AI</p>
                    <p className="text-[11px] text-[#8b96aa]">Keys, provider setup, models</p>
                  </div>
                </button>

                <div className="pt-2 text-[11px] text-[#667188]">
                  Backend and model switching now live in the bottom tray for faster access.
                </div>
              </div>
            </div>
          </div>
        </div>
      </SheetContent>
      </Sheet>
    </>
  );
}
