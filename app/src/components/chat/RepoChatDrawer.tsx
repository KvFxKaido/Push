import { useMemo, useState } from 'react';
import {
  ArrowLeft,
  Box,
  Check,
  ChevronDown,
  ChevronRight,
  Cpu,
  FolderCog,
  FolderGit2,
  GitBranch,
  House,
  Menu,
  Pencil,
  Plus,
  Search,
  Settings,
  Trash2,
  UserRound,
  X,
  Loader2,
} from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
  currentBranch?: string;
  defaultBranch?: string;
  setCurrentBranch?: (branch: string) => void;
  availableBranches?: { name: string; isDefault: boolean; isProtected: boolean }[];
  branchesLoading?: boolean;
  branchesError?: string | null;
  onRefreshBranches?: () => void;
  onDeleteBranch?: (branch: string) => Promise<boolean>;
}

const EMPTY_CHATS: Conversation[] = [];

import { timeAgoCompact } from '@/lib/utils';

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
  currentBranch,
  defaultBranch,
  setCurrentBranch,
  availableBranches = [],
  branchesLoading = false,
  branchesError = null,
  onRefreshBranches,
  onDeleteBranch,
}: RepoChatDrawerProps) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<'history' | 'settings'>('history');
  const [expandedRepos, setExpandedRepos] = useState<Record<string, boolean>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [pendingDeleteBranch, setPendingDeleteBranch] = useState<string | null>(null);
  const [deletingBranch, setDeletingBranch] = useState<string | null>(null);

  const drawerBranchOptions = useMemo(() => {
    if (!currentBranch) return availableBranches;
    if (availableBranches.some((b) => b.name === currentBranch)) return availableBranches;
    return [
      {
        name: currentBranch,
        isDefault: currentBranch === (defaultBranch || 'main'),
        isProtected: false,
      },
      ...availableBranches,
    ];
  }, [availableBranches, currentBranch, defaultBranch]);

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

  const openChat = (chatId: string, repo?: RepoWithActivity, chatBranch?: string) => {
    if (repo && activeRepo?.id !== repo.id) {
      onSelectRepo(repo);
    }
    // Switch branch if the chat belongs to a different branch
    if (chatBranch && setCurrentBranch && chatBranch !== currentBranch) {
      setCurrentBranch(chatBranch);
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
      setBranchMenuOpen(false);
      setPendingDeleteBranch(null);
      setDeletingBranch(null);
    }
  };

  const requestDeleteBranch = async (branchName: string) => {
    if (!onDeleteBranch || deletingBranch) return;
    if (pendingDeleteBranch !== branchName) {
      setPendingDeleteBranch(branchName);
      return;
    }
    setDeletingBranch(branchName);
    try {
      const deleted = await onDeleteBranch(branchName);
      setPendingDeleteBranch(deleted ? null : branchName);
    } finally {
      setDeletingBranch((prev) => (prev === branchName ? null : prev));
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
      <div key={chat.id} className={`flex items-center gap-1.5 rounded-lg transition-all duration-200 ${isActiveChat ? 'bg-push-surface-raised' : 'hover:bg-push-surface-raised hover:translate-y-[-0.5px]'}`}>
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
              className="h-7 w-full rounded-md border border-push-edge bg-push-surface px-2 text-[12px] text-push-fg outline-none placeholder:text-push-fg-dim focus:border-push-sky/50"
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
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-push-fg-muted transition-colors hover:bg-push-surface-raised hover:text-push-fg-secondary"
              aria-label="Cancel rename"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </form>
        ) : (
          <>
            <button
              onClick={() => openChat(chat.id, repo, chat.branch)}
              className="min-w-0 flex-1 px-2.5 py-2 text-left"
            >
              <p className={`truncate text-[12px] ${isActiveChat ? 'text-push-fg' : 'text-push-fg-secondary'}`}>
                {chat.title}
              </p>
              <p className="mt-0.5 text-[10px] text-push-fg-muted">
                {messageCount} msg{messageCount !== 1 ? 's' : ''} · {timeAgoCompact(chat.lastMessageAt)}
              </p>
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                startRename(chat);
              }}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-push-fg-muted transition-colors hover:bg-push-surface-raised hover:text-push-fg-secondary"
              aria-label={`Rename ${chat.title}`}
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDeleteChat(chat.id);
              }}
              className="mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-push-fg-muted transition-colors hover:bg-push-surface-raised hover:text-red-400"
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
        className="flex h-8 w-8 items-center justify-center rounded-full border border-white/[0.06] bg-[#0a0e16]/80 text-push-fg-secondary backdrop-blur-xl transition-colors duration-200 hover:text-push-fg active:scale-95"
        aria-label="Open chats and repos"
        title="Chats and repos"
      >
        <Menu className="h-4 w-4" />
      </button>

      <Sheet open={open} onOpenChange={closeDrawer}>
      <SheetContent
        side="left"
        className="w-[86vw] rounded-r-2xl border-[#151b26] bg-push-grad-panel p-0 text-push-fg shadow-[0_16px_48px_rgba(0,0,0,0.6),0_4px_16px_rgba(0,0,0,0.3)] sm:max-w-sm [&>[data-slot=sheet-close]]:text-push-fg-secondary [&>[data-slot=sheet-close]]:hover:text-push-fg"
      >
        {/* Subtle top glow */}
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-16 bg-gradient-to-b from-white/[0.03] to-transparent rounded-tr-2xl" />
        <div className="relative h-full overflow-hidden">
          <div
            className={`absolute inset-0 flex flex-col transition-transform duration-300 ${
              panel === 'settings' ? '-translate-x-full' : 'translate-x-0'
            }`}
          >
            <SheetHeader className="border-b border-push-edge pb-3">
              <SheetTitle className="text-push-fg">History</SheetTitle>
              <SheetDescription className="text-push-fg-muted">
                Repos and chats
              </SheetDescription>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  onClick={() => {
                    onNewChat();
                    setOpen(false);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-push-edge bg-[#080b10]/95 px-2.5 py-1.5 text-xs font-medium text-push-fg-secondary spring-press transition-all duration-200 hover:border-push-edge-hover hover:bg-push-surface-raised hover:text-push-fg"
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
                    className="inline-flex items-center gap-1.5 rounded-xl border border-push-edge bg-[#080b10]/95 px-2.5 py-1.5 text-xs font-medium text-push-link spring-press transition-all duration-200 hover:border-push-edge-hover hover:bg-push-surface-raised hover:text-push-fg"
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
                    className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-500/35 bg-emerald-900/15 px-2.5 py-1.5 text-xs font-medium text-emerald-300 spring-press transition-all duration-200 hover:border-emerald-500/50 hover:text-emerald-200"
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
                    className="inline-flex items-center gap-1.5 rounded-xl border border-push-edge bg-[#080b10]/95 px-2.5 py-1.5 text-xs font-medium text-push-fg-secondary spring-press transition-all duration-200 hover:border-push-edge-hover hover:bg-push-surface-raised hover:text-push-fg"
                  >
                    <X className="h-3.5 w-3.5" />
                    Exit sandbox
                  </button>
                )}
              </div>
              <div className="relative mt-2">
                <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-push-fg-dim" />
                <input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search repos and chats"
                  className="h-8 w-full rounded-xl border border-push-edge bg-push-surface pl-8 pr-2.5 text-xs text-push-fg-secondary outline-none placeholder:text-push-fg-dim/70 focus:border-push-sky/50 transition-colors"
                />
              </div>
            </SheetHeader>

            <div className="flex-1 overflow-y-auto p-3">
              <div className="space-y-1.5 stagger-in">
                {filteredRepoRows.map(({ repo, chats }) => {
                  const isExpanded = isSearching || (expandedRepos[repo.full_name] ?? (activeRepo?.full_name === repo.full_name));
                  const isActiveRepo = activeRepo?.id === repo.id;
                  return (
                    <div key={repo.id} className="rounded-xl border border-push-edge bg-push-surface card-hover spring-press">
                      <button
                        onClick={() => toggleRepo(repo.full_name, isExpanded)}
                        className={`flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left transition-colors ${
                          isActiveRepo ? 'bg-push-surface-raised' : 'hover:bg-push-surface-raised'
                        }`}
                      >
                        <ChevronRight
                          className={`h-3.5 w-3.5 shrink-0 text-push-fg-muted transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                        />
                        <FolderGit2 className={`h-3.5 w-3.5 shrink-0 ${isActiveRepo ? 'text-push-link' : 'text-push-fg-muted'}`} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] font-medium text-push-fg">{repo.name}</p>
                          <p className="text-[11px] text-push-fg-muted">{chats.length} chat{chats.length !== 1 ? 's' : ''}</p>
                        </div>
                        {isActiveRepo && (
                          <span className="rounded-full bg-push-link/15 px-2 py-0.5 text-[10px] font-medium text-push-link">
                            active
                          </span>
                        )}
                      </button>

                      {isExpanded && (
                        <div className="space-y-1 px-2 pb-2">
                          {isActiveRepo && setCurrentBranch && (
                            <DropdownMenu
                              open={branchMenuOpen}
                              onOpenChange={(open) => {
                                setBranchMenuOpen(open);
                                if (!open) {
                                  setPendingDeleteBranch(null);
                                  setDeletingBranch(null);
                                }
                                if (open && onRefreshBranches && !branchesLoading && drawerBranchOptions.length === 0) {
                                  onRefreshBranches();
                                }
                              }}
                            >
                              <DropdownMenuTrigger className="mx-1 mb-1 flex h-8 w-[calc(100%-0.5rem)] items-center gap-1 rounded-lg border border-push-edge bg-[#080b10]/95 px-2.5 text-left text-xs text-push-fg-secondary transition-colors hover:border-push-edge-hover hover:bg-push-surface-raised">
                                <GitBranch className="h-3 w-3 text-push-fg-dim" />
                                <span className="min-w-0 flex-1 truncate">{currentBranch || defaultBranch || 'main'}</span>
                                <ChevronDown className={`h-3 w-3 text-push-fg-dim transition-transform ${branchMenuOpen ? 'rotate-180' : ''}`} />
                              </DropdownMenuTrigger>
                              <DropdownMenuContent
                                align="start"
                                sideOffset={6}
                                className="w-[230px] rounded-xl border border-push-edge bg-push-grad-card shadow-[0_18px_40px_rgba(0,0,0,0.62)]"
                              >
                                <DropdownMenuLabel className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-push-fg-dim">
                                  Switch Branch
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
                                    {onRefreshBranches && (
                                      <DropdownMenuItem
                                        onSelect={(e) => {
                                          e.preventDefault();
                                          onRefreshBranches();
                                        }}
                                        className="mx-1 rounded-lg px-3 py-2 text-xs text-push-link hover:bg-[#0d1119]"
                                      >
                                        Retry
                                      </DropdownMenuItem>
                                    )}
                                  </>
                                )}

                                {!branchesLoading && !branchesError && drawerBranchOptions.length === 0 && (
                                  <DropdownMenuItem disabled className="mx-1 rounded-lg px-3 py-2 text-xs text-push-fg-dim">
                                    No branches found
                                  </DropdownMenuItem>
                                )}

                                {!branchesLoading && !branchesError && drawerBranchOptions.map((branch) => {
                                  const isActiveBranch = branch.name === currentBranch;
                                  const canDeleteBranch = Boolean(onDeleteBranch) && !isActiveBranch && !branch.isDefault && !branch.isProtected;
                                  const isDeletePending = pendingDeleteBranch === branch.name;
                                  const isDeletingThisBranch = deletingBranch === branch.name;
                                  return (
                                    <div key={branch.name}>
                                      <DropdownMenuItem
                                        onSelect={(e) => {
                                          if (isActiveBranch) {
                                            e.preventDefault();
                                            return;
                                          }
                                          setPendingDeleteBranch(null);
                                          setCurrentBranch(branch.name);
                                        }}
                                        className={`mx-1 flex items-center gap-2 rounded-lg px-3 py-2 ${
                                          isActiveBranch ? 'bg-[#101621]' : 'hover:bg-[#0d1119]'
                                        }`}
                                      >
                                        <span className={`min-w-0 flex-1 truncate text-xs ${isActiveBranch ? 'text-push-fg' : 'text-push-fg-secondary'}`}>
                                          {branch.name}
                                        </span>
                                        {branch.isDefault && (
                                          <span className="rounded-full bg-[#0d2847] px-1.5 py-0.5 text-[10px] text-[#58a6ff]">
                                            default
                                          </span>
                                        )}
                                        {branch.isProtected && (
                                          <span className="rounded-full bg-[#2a1a1a] px-1.5 py-0.5 text-[10px] text-[#fca5a5]">
                                            protected
                                          </span>
                                        )}
                                        {isActiveBranch && <Check className="h-3.5 w-3.5 text-push-link" />}
                                      </DropdownMenuItem>
                                      {canDeleteBranch && (
                                        <DropdownMenuItem
                                          onSelect={(e) => {
                                            e.preventDefault();
                                            if (isDeletingThisBranch || deletingBranch) return;
                                            void requestDeleteBranch(branch.name);
                                          }}
                                          className={`mx-1 mb-1 flex items-center gap-2 rounded-lg px-3 py-1.5 text-[11px] ${
                                            isDeletePending
                                              ? 'bg-red-950/30 text-red-300 hover:bg-red-950/40'
                                              : 'text-push-fg-dim hover:bg-[#0d1119] hover:text-red-300'
                                          }`}
                                        >
                                          {isDeletingThisBranch ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                                          {isDeletingThisBranch
                                            ? `Deleting ${branch.name}...`
                                            : isDeletePending
                                            ? `Confirm delete ${branch.name}`
                                            : `Delete ${branch.name}`}
                                        </DropdownMenuItem>
                                      )}
                                    </div>
                                  );
                                })}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}

                          {chats.length === 0 ? (
                            <div className="rounded-lg border border-dashed border-push-edge px-2.5 py-2 text-[11px] text-push-fg-muted">
                              No chats yet
                            </div>
                          ) : (
                            (() => {
                              // Group chats by branch
                              const branchMap = new Map<string, Conversation[]>();
                              for (const chat of chats) {
                                const b = chat.branch || defaultBranch || 'main';
                                const arr = branchMap.get(b) || [];
                                arr.push(chat);
                                branchMap.set(b, arr);
                              }
                              const branchNames = Array.from(branchMap.keys());
                              const hasMultipleBranches = branchNames.length > 1;

                              if (!hasMultipleBranches) {
                                // Single branch — no sub-headers needed
                                return chats.map((chat) => renderChatRow(chat, repo));
                              }

                              // Sort branches: active branch first, then default branch, then rest alphabetically
                              const activeBranch = isActiveRepo ? currentBranch : undefined;
                              branchNames.sort((a, b) => {
                                if (a === activeBranch) return -1;
                                if (b === activeBranch) return 1;
                                const defBranch = defaultBranch || 'main';
                                if (a === defBranch) return -1;
                                if (b === defBranch) return 1;
                                return a.localeCompare(b);
                              });

                              return branchNames.map((branchName) => {
                                const branchChats = branchMap.get(branchName) || [];
                                const isActiveBranch = isActiveRepo && branchName === currentBranch;
                                return (
                                  <div key={branchName}>
                                    <button
                                      onClick={() => {
                                        if (setCurrentBranch && branchName !== currentBranch) {
                                          if (!isActiveRepo) {
                                            onSelectRepo(repo);
                                          }
                                          setCurrentBranch(branchName);
                                        }
                                      }}
                                      className="flex w-full items-center gap-1.5 px-1.5 pb-0.5 pt-2 text-left"
                                    >
                                      <GitBranch className={`h-3 w-3 shrink-0 ${isActiveBranch ? 'text-push-link' : 'text-push-fg-dim'}`} />
                                      <span className={`truncate text-[10px] font-medium ${isActiveBranch ? 'text-push-link' : 'text-push-fg-dim'}`}>
                                        {branchName}
                                      </span>
                                      <span className="text-[10px] text-push-fg-dim">
                                        ({branchChats.length})
                                      </span>
                                    </button>
                                    {branchChats.map((chat) => renderChatRow(chat, repo))}
                                  </div>
                                );
                              });
                            })()
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}

                {filteredUnscopedChats.length > 0 && (
                  <div className="rounded-xl border border-push-edge bg-push-surface">
                    <div className="px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-push-fg-muted">
                      Unscoped
                    </div>
                    <div className="space-y-1 px-2 pb-2">
                      {filteredUnscopedChats.map((chat) => renderChatRow(chat))}
                    </div>
                  </div>
                )}
                {filteredRepoRows.length === 0 && filteredUnscopedChats.length === 0 && (
                  <div className="rounded-xl border border-dashed border-push-edge bg-push-surface px-3 py-4 text-center text-[12px] text-push-fg-muted">
                    No repos or chats match your search.
                  </div>
                )}
              </div>
            </div>

            {onOpenSettings && (
              <div className="flex items-center justify-between border-t border-push-edge px-3 py-2.5">
                <div className="flex h-6 w-6 items-center justify-center rounded-lg border border-[#1e2634]/60 bg-push-grad-icon opacity-40">
                  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" className="text-push-accent">
                    <path d="M8 1L14.5 5V11L8 15L1.5 11V5L8 1Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                  </svg>
                </div>
                <button
                  onClick={() => setPanel('settings')}
                  className="inline-flex items-center gap-2 rounded-xl border border-push-edge bg-[#080b10]/95 px-3 py-1.5 text-xs font-medium text-push-fg-secondary spring-press transition-all duration-200 hover:border-push-edge-hover hover:bg-push-surface-raised hover:text-push-fg"
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
            <div className="border-b border-push-edge px-4 pb-3 pt-4">
              <button
                onClick={() => setPanel('history')}
                className="mb-3 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-push-fg-muted transition-colors hover:bg-push-surface-raised hover:text-push-fg-secondary"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Back
              </button>
              <h3 className="text-sm font-semibold text-push-fg">Settings</h3>
              <p className="mt-1 text-xs text-push-fg-muted">Pick a section and we&apos;ll slide open full settings.</p>
            </div>

            <div className="flex-1 overflow-y-auto p-3">
              <div className="space-y-2 stagger-in">
                <button
                  onClick={() => openSettingsTab('you')}
                  className="flex w-full items-center gap-2 rounded-xl border border-push-edge bg-push-surface px-3 py-2.5 text-left card-hover spring-press hover:border-push-edge-hover hover:shadow-push-card-hover"
                >
                  <UserRound className="h-4 w-4 text-push-link" />
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-push-fg">You</p>
                    <p className="text-[11px] text-push-fg-muted">GitHub, profile, identity</p>
                  </div>
                </button>

                <button
                  onClick={() => openSettingsTab('workspace')}
                  className="flex w-full items-center gap-2 rounded-xl border border-push-edge bg-push-surface px-3 py-2.5 text-left card-hover spring-press hover:border-push-edge-hover hover:shadow-push-card-hover"
                >
                  <FolderCog className="h-4 w-4 text-push-link" />
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-push-fg">Workspace</p>
                    <p className="text-[11px] text-push-fg-muted">Context mode, sandbox controls</p>
                  </div>
                </button>

                <button
                  onClick={() => openSettingsTab('ai')}
                  className="flex w-full items-center gap-2 rounded-xl border border-push-edge bg-push-surface px-3 py-2.5 text-left card-hover spring-press hover:border-push-edge-hover hover:shadow-push-card-hover"
                >
                  <Cpu className="h-4 w-4 text-push-link" />
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-push-fg">AI</p>
                    <p className="text-[11px] text-push-fg-muted">Keys, provider setup, models</p>
                  </div>
                </button>

                <div className="pt-2 text-[11px] text-push-fg-dim">
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
