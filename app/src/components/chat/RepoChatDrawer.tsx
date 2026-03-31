import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Menu,
  Palette,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
  Loader2,
} from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { BranchWaveIcon, HistoryStackIcon, PushMarkIcon } from '@/components/icons/push-custom-icons';
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
  HUB_MATERIAL_PILL_BUTTON_CLASS,
  HubControlGlow,
} from '@/components/chat/hub-styles';
import type { RepoAppearance } from '@/lib/repo-appearance';
import type { ActiveRepo, Conversation, RepoWithActivity } from '@/types';

interface RepoChatDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repos: RepoWithActivity[];
  activeRepo: ActiveRepo | null;
  conversations: Record<string, Conversation>;
  activeChatId: string;
  resolveRepoAppearance: (repoFullName?: string | null) => RepoAppearance;
  setRepoAppearance: (repoFullName: string, appearance: RepoAppearance) => void;
  clearRepoAppearance: (repoFullName: string) => void;
  onSelectRepo: (repo: RepoWithActivity, branch?: string) => void;
  onSwitchChat: (id: string) => void;
  onNewChat: () => void;
  onDeleteChat: (id: string) => void;
  onRenameChat: (id: string, title: string) => void;
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

const DRAWER_CONTROL_SURFACE_CLASS =
  'relative overflow-hidden rounded-full border border-push-edge-subtle bg-push-grad-input shadow-[0_12px_34px_rgba(0,0,0,0.5),0_3px_10px_rgba(0,0,0,0.28)] backdrop-blur-xl';
const DRAWER_CONTROL_INTERACTIVE_CLASS =
  'transition-all duration-200 hover:border-push-edge-hover hover:text-push-fg hover:brightness-110';
const DRAWER_SECTION_SURFACE_CLASS =
  'border-b border-push-edge/70 pb-2 last:border-b-0';

export function RepoChatDrawer({
  open,
  onOpenChange,
  repos,
  activeRepo,
  conversations,
  activeChatId,
  resolveRepoAppearance,
  setRepoAppearance,
  clearRepoAppearance,
  onSelectRepo,
  onSwitchChat,
  onNewChat,
  onDeleteChat,
  onRenameChat,
  currentBranch,
  defaultBranch,
  setCurrentBranch,
  availableBranches = [],
  branchesLoading = false,
  branchesError = null,
  onRefreshBranches,
  onDeleteBranch,
}: RepoChatDrawerProps) {
  const [expandedRepos, setExpandedRepos] = useState<Record<string, boolean>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [pendingDeleteBranch, setPendingDeleteBranch] = useState<string | null>(null);
  const [deletingBranch, setDeletingBranch] = useState<string | null>(null);
  const [appearanceRepo, setAppearanceRepoState] = useState<RepoWithActivity | null>(null);

  useEffect(() => {
    if (open) return;
    setSearchQuery('');
    setEditingChatId(null);
    setEditingTitle('');
    setBranchMenuOpen(false);
    setPendingDeleteBranch(null);
    setDeletingBranch(null);
    setAppearanceRepoState(null);
  }, [open]);

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

  const allUnscopedChats = chatsByRepo.get('__unscoped__') ?? EMPTY_CHATS;
  const chatModeChats = useMemo(() => allUnscopedChats.filter((c) => c.mode === 'chat'), [allUnscopedChats]);
  const unscopedChats = useMemo(() => allUnscopedChats.filter((c) => c.mode !== 'chat'), [allUnscopedChats]);
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

  const filteredChatModeChats = useMemo(() => {
    if (!isSearching) return chatModeChats;
    return chatModeChats.filter((chat) => chat.title.toLowerCase().includes(normalizedQuery));
  }, [isSearching, normalizedQuery, chatModeChats]);

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
    onOpenChange(false);
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

  const renderChatRow = (chat: Conversation, repo?: RepoWithActivity) => {
    const isActiveChat = chat.id === activeChatId;
    const isEditing = editingChatId === chat.id;
    const messageCount = chat.messages.filter((m) => !m.isToolResult).length;

    return (
      <div
        key={chat.id}
        className={`flex items-center gap-1 rounded-xl border border-transparent transition-colors duration-200 ${
          isActiveChat ? 'border-push-edge-subtle bg-push-surface-raised/80' : 'hover:bg-push-surface-hover/60'
        }`}
      >
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
              className="h-7 w-full rounded-md border border-push-edge bg-push-surface px-2 text-push-sm text-push-fg outline-none placeholder:text-push-fg-dim focus:border-push-sky/50"
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
              <p className={`truncate text-push-sm ${isActiveChat ? 'text-push-fg' : 'text-push-fg-secondary'}`}>
                {chat.title}
              </p>
              <p className="mt-0.5 text-push-2xs text-push-fg-muted">
                {messageCount} msg{messageCount !== 1 ? 's' : ''} · {timeAgoCompact(chat.lastMessageAt)}
              </p>
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                startRename(chat);
              }}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-push-fg-muted transition-colors hover:bg-push-surface-hover hover:text-push-fg-secondary"
              aria-label={`Rename ${chat.title}`}
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDeleteChat(chat.id);
              }}
              className="mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-push-fg-muted transition-colors hover:bg-push-surface-hover hover:text-red-400"
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
        onClick={() => onOpenChange(true)}
        className="inline-flex h-8 items-center justify-center rounded-full px-1.5 text-push-fg-secondary transition-all duration-200 hover:bg-white/[0.04] hover:text-push-fg active:scale-95"
        aria-label="Open chats and repos"
        title="Chats and repos"
      >
        <Menu className="h-3 w-3" />
      </button>

      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="left"
          overlayClassName="bg-transparent"
          className="w-[86vw] rounded-r-2xl border-[#151b26] bg-push-grad-panel p-0 text-push-fg shadow-[0_16px_48px_rgba(0,0,0,0.6),0_4px_16px_rgba(0,0,0,0.3)] sm:max-w-sm [&>[data-slot=sheet-close]]:text-push-fg-secondary [&>[data-slot=sheet-close]]:hover:text-push-fg"
        >
          {/* Subtle top glow */}
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-16 rounded-tr-2xl bg-gradient-to-b from-white/[0.03] to-transparent" />
          <div className="relative h-full overflow-hidden">
            <div className="absolute inset-0 flex flex-col">
            <SheetHeader className="border-b border-push-edge pb-3">
              <SheetTitle className="flex items-center gap-2 text-push-fg">
                <HistoryStackIcon className="h-4 w-4 text-push-fg-dim" />
                <span>Chats</span>
              </SheetTitle>
              <SheetDescription className="text-push-fg-muted">
                Repos and chats
              </SheetDescription>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  onClick={() => {
                    onNewChat();
                    onOpenChange(false);
                  }}
                  className={`inline-flex h-9 items-center gap-1.5 px-3 text-xs font-medium text-push-fg-secondary ${DRAWER_CONTROL_SURFACE_CLASS} ${DRAWER_CONTROL_INTERACTIVE_CLASS}`}
                >
                  <div className="pointer-events-none absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/[0.05] to-transparent" />
                  <Plus className="relative z-10 h-3.5 w-3.5" />
                  <span className="relative z-10">New chat</span>
                </button>
              </div>
              <div className="relative mt-2">
                <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-push-fg-dim" />
                <input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search repos and chats"
                  className="h-9 w-full rounded-full border border-push-edge-subtle bg-push-grad-input pl-8 pr-3 text-xs text-push-fg-secondary shadow-[0_12px_34px_rgba(0,0,0,0.5),0_3px_10px_rgba(0,0,0,0.28)] backdrop-blur-xl outline-none placeholder:text-push-fg-dim/70 transition-all focus:border-push-sky/50"
                />
              </div>
            </SheetHeader>

            <div className="flex-1 overflow-y-auto p-3">
              <div className="space-y-3 stagger-in">
                {filteredRepoRows.map(({ repo, chats }) => {
                  const isExpanded = isSearching || (expandedRepos[repo.full_name] ?? (activeRepo?.full_name === repo.full_name));
                  const isActiveRepo = activeRepo?.id === repo.id;
                  return (
                    <div key={repo.id} className={DRAWER_SECTION_SURFACE_CLASS}>
                      <div className="relative">
                        <button
                          onClick={() => toggleRepo(repo.full_name, isExpanded)}
                          className={`flex w-full items-center gap-2 rounded-xl px-1 py-2.5 pr-10 text-left transition-colors ${
                            isActiveRepo ? 'bg-push-surface-raised/55' : 'hover:bg-push-surface-hover/40'
                          }`}
                        >
                          <ChevronRight
                            className={`h-3.5 w-3.5 shrink-0 text-push-fg-muted transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                          />
                          <RepoAppearanceBadge
                            appearance={resolveRepoAppearance(repo.full_name)}
                            className="h-6 w-6 shrink-0 rounded-md"
                            iconClassName="h-3.5 w-3.5"
                          />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-push-base font-medium text-push-fg">{repo.name}</p>
                            <p className="text-push-xs text-push-fg-muted">{chats.length} chat{chats.length !== 1 ? 's' : ''}</p>
                          </div>
                          {isActiveRepo && (
                            <span className="text-push-2xs font-medium text-push-link">
                              active
                            </span>
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => setAppearanceRepoState(repo)}
                          className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} absolute right-0 top-1/2 h-8 w-8 -translate-y-1/2 justify-center px-0 text-push-fg-secondary`}
                          aria-label={`Customize ${repo.name}`}
                          title="Customize repo"
                        >
                          <HubControlGlow />
                          <Palette className="relative z-10 h-3.5 w-3.5" />
                        </button>
                      </div>

                      {isExpanded && (
                        <div className="space-y-1 px-0 pb-0">
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
                              <DropdownMenuTrigger className={`mb-2 flex h-9 w-full items-center gap-1.5 px-3 text-left text-xs text-push-fg-secondary ${DRAWER_CONTROL_SURFACE_CLASS} ${DRAWER_CONTROL_INTERACTIVE_CLASS}`}>
                                <BranchWaveIcon className="h-3 w-3 text-push-fg-dim" />
                                <span className="min-w-0 flex-1 truncate">{currentBranch || defaultBranch || 'main'}</span>
                                <ChevronDown className={`h-3 w-3 text-push-fg-dim transition-transform ${branchMenuOpen ? 'rotate-180' : ''}`} />
                              </DropdownMenuTrigger>
                              <DropdownMenuContent
                                align="start"
                                sideOffset={6}
                                className="w-[230px] rounded-xl border border-push-edge bg-push-grad-card shadow-[0_18px_40px_rgba(0,0,0,0.62)]"
                              >
                                <DropdownMenuLabel className="px-3 py-1.5 text-push-2xs font-medium uppercase tracking-wider text-push-fg-dim">
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
                                        className="mx-1 rounded-lg px-3 py-2 text-xs text-push-link hover:bg-push-surface-hover"
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
                                          isActiveBranch ? 'bg-[#101621]' : 'hover:bg-push-surface-hover'
                                        }`}
                                      >
                                        <span className={`min-w-0 flex-1 truncate text-xs ${isActiveBranch ? 'text-push-fg' : 'text-push-fg-secondary'}`}>
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
                                        {isActiveBranch && <Check className="h-3.5 w-3.5 text-push-link" />}
                                      </DropdownMenuItem>
                                      {canDeleteBranch && (
                                        <DropdownMenuItem
                                          onSelect={(e) => {
                                            e.preventDefault();
                                            if (isDeletingThisBranch || deletingBranch) return;
                                            void requestDeleteBranch(branch.name);
                                          }}
                                          className={`mx-1 mb-1 flex items-center gap-2 rounded-lg px-3 py-1.5 text-push-xs ${
                                            isDeletePending
                                              ? 'bg-red-950/30 text-red-300 hover:bg-red-950/40'
                                              : 'text-push-fg-dim hover:bg-push-surface-hover hover:text-red-300'
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
                            <div className="rounded-xl border border-push-edge/70 bg-push-surface/20 px-3 py-2.5 text-push-xs text-push-fg-muted">
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
                                      <BranchWaveIcon className={`h-3 w-3 shrink-0 ${isActiveBranch ? 'text-push-link' : 'text-push-fg-dim'}`} />
                                      <span className={`truncate text-push-2xs font-medium ${isActiveBranch ? 'text-push-link' : 'text-push-fg-dim'}`}>
                                        {branchName}
                                      </span>
                                      <span className="text-push-2xs text-push-fg-dim">
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

                {filteredChatModeChats.length > 0 && (
                  <div className={DRAWER_SECTION_SURFACE_CLASS}>
                    <div className="px-1 py-2.5 text-push-xs font-medium uppercase tracking-wide text-[#c4b5fd]">
                      Chats
                    </div>
                    <div className="space-y-1 px-0 pb-0">
                      {filteredChatModeChats.map((chat) => renderChatRow(chat))}
                    </div>
                  </div>
                )}
                {filteredUnscopedChats.length > 0 && (
                  <div className={DRAWER_SECTION_SURFACE_CLASS}>
                    <div className="px-1 py-2.5 text-push-xs font-medium uppercase tracking-wide text-push-fg-muted">
                      Unscoped
                    </div>
                    <div className="space-y-1 px-0 pb-0">
                      {filteredUnscopedChats.map((chat) => renderChatRow(chat))}
                    </div>
                  </div>
                )}
                {filteredRepoRows.length === 0 && filteredUnscopedChats.length === 0 && filteredChatModeChats.length === 0 && (
                  <div className="rounded-xl border border-dashed border-push-edge/70 bg-push-surface/15 px-3 py-4 text-center text-push-sm text-push-fg-muted">
                    No repos or chats match your search.
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2 border-t border-push-edge bg-[linear-gradient(180deg,rgba(7,10,15,0.92)_0%,rgba(3,5,9,0.98)_100%)] px-3 py-3">
              <PushMarkIcon className="h-[13px] w-[13px] shrink-0 text-push-accent" />
              <div className="min-w-0">
                <p className="text-push-xs font-medium text-push-fg-secondary">Push</p>
                <p className="truncate text-push-2xs text-push-fg-dim">Your coding notebook</p>
              </div>
            </div>
          </div>
        </div>
        </SheetContent>
      </Sheet>

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
