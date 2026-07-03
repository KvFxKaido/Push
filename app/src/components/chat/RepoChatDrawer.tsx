import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Menu,
  Palette,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { HistoryStackIcon, PushMarkIcon } from '@/components/icons/push-custom-icons';
import { RepoAppearanceSheet } from '@/components/repo/RepoAppearanceSheet';
import { RepoAppearanceBadge } from '@/components/repo/repo-appearance';
import {
  GLASS_ACTIVE_CLASS,
  GLASS_FILL_FAINT,
  GLASS_GHOST_BUTTON_CLASS,
  GLASS_SURFACE,
  GLASS_SURFACE_HOVER,
  HUB_GLASS_HAIRLINE,
  HUB_GLASS_PANEL_CLASS,
} from '@/components/chat/hub-styles';
import { CliSessionRow } from '@/components/chat/drawer-cli-row';
import { chatDrawerRepoTag } from '@/components/chat/repo-chat-drawer-utils';
import type { RepoAppearance } from '@/lib/repo-appearance';
import type { ActiveRepo, Conversation, DaemonCliSession, RepoWithActivity } from '@/types';

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
  /** Resume the chat the user tapped. The handler is responsible for
   * migrating the workspace session (repo / mode) to match the
   * chat — switching activeChatId in isolation gets reverted by the
   * workspace's belong-to-workspace auto-effects. */
  onResumeChat: (id: string) => void;
  onNewChat: () => void;
  onDeleteChat: (id: string) => void;
  onRenameChat: (id: string, title: string) => void;
  /**
   * Sessions discovered on the paired daemon via `list_sessions` that
   * weren't started from this device. Optional — callers without a
   * daemon connection never pass it. When present, the drawer leads
   * with a "Connected" section (Claude Code-style: green indicator,
   * alongside the cloud chats) rendering these rows read-only: no
   * resume-into-mobile flow, no rename/delete affordances. The
   * `cliSessionsLabel` tags the section header with the transport
   * provenance — `'local-pc'` or `'relay'` (Remote).
   */
  cliSessions?: DaemonCliSession[];
  cliSessionsLabel?: 'local-pc' | 'relay';
  /**
   * Tap-to-resume for Connected rows. When present, rows render as
   * buttons and a tap hands the session to this callback (the caller
   * owns the grant_session_attach round-trip + navigation — see
   * RelayChatScreen / the workspace routes). The drawer intentionally
   * does NOT close itself on tap: the caller's navigation unmounts it
   * on success, and on failure the drawer staying open is the honest
   * signal that nothing happened. Absent: rows stay read-only.
   */
  onResumeCliSession?: (session: DaemonCliSession) => void;
  /**
   * Daemon-mode-only footer actions (Local PC / Remote). Repo mode has no
   * equivalent — leaving a repo chat happens by picking another item in
   * this same drawer, so the affordance would be redundant there. Daemon
   * sessions are singular (one pairing, no repo list to switch between),
   * so Leave/Unpair/Customize need an explicit home; this keeps them out
   * of the header row so it can match repo mode's icon set.
   */
  daemonActions?: {
    daemonLabel: string;
    onLeave: () => void;
    onUnpair: () => void;
    unpairIcon: LucideIcon;
    onCustomizeAppearance: () => void;
  };
}

const EMPTY_CHATS: Conversation[] = [];
const EMPTY_CLI_SESSIONS: DaemonCliSession[] = [];

// The cross-repo Recents lane leads the drawer with recency rather than
// branch — branch is mutable session state now (repo-scoped chats), not a
// drawer-organizing axis. Capped so it stays a "what was I just in" surface,
// not a second full chat list; the repo cards below carry the long tail.
const RECENTS_LIMIT = 6;

import { timeAgoCompact } from '@/lib/utils';

const DRAWER_CONTROL_SURFACE_CLASS = `relative overflow-hidden rounded-full border ${GLASS_SURFACE} shadow-[0_8px_24px_rgba(0,0,0,0.35)] backdrop-blur-xl`;
const DRAWER_CONTROL_INTERACTIVE_CLASS = `transition-all duration-200 ${GLASS_SURFACE_HOVER} hover:text-push-fg`;
// Repo groups read as soft glass cards floating on the panel rather than slabs
// split by hard rules — this kills the "large empty slab" feeling and lets the
// active repo glow stand out from its quiet neighbors. The base carries layout
// + the border *width* only; the resting (GLASS_SURFACE) and active
// (GLASS_ACTIVE_CLASS) states each own their border + bg so the two never
// collide on CSS order. The active tint is the shared accent token, so it can't
// drift from the active tab cell in the Workspace hub.
const DRAWER_SECTION_SURFACE_CLASS =
  'rounded-2xl border px-1.5 py-1 transition-colors duration-200';
const DRAWER_SECTION_RESTING_CLASS = `${GLASS_SURFACE} ${GLASS_SURFACE_HOVER}`;

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
  onResumeChat,
  onNewChat,
  onDeleteChat,
  onRenameChat,
  cliSessions = EMPTY_CLI_SESSIONS,
  cliSessionsLabel,
  onResumeCliSession,
  daemonActions,
}: RepoChatDrawerProps) {
  const [expandedRepos, setExpandedRepos] = useState<Record<string, boolean>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [appearanceRepo, setAppearanceRepoState] = useState<RepoWithActivity | null>(null);

  useEffect(() => {
    if (open) return;
    const id = setTimeout(() => {
      setSearchQuery('');
      setEditingChatId(null);
      setEditingTitle('');
      setAppearanceRepoState(null);
    }, 0);
    return () => clearTimeout(id);
  }, [open]);

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

  // repoFullName → short repo name, so cross-repo Recents rows can carry a
  // repo tag (the disambiguator that replaces the dropped branch stamp; chat
  // titles duplicate hard, e.g. "What changed recently in Push?" ×4).
  const repoNameByFullName = useMemo(() => {
    const map = new Map<string, string>();
    for (const repo of repos) map.set(repo.full_name, repo.name);
    return map;
  }, [repos]);

  const repoTagForChat = useCallback(
    (chat: Conversation): string => chatDrawerRepoTag(chat, repoNameByFullName),
    [repoNameByFullName],
  );

  const recentChats = useMemo(
    () =>
      Object.values(conversations)
        .slice()
        .sort((a, b) => b.lastMessageAt - a.lastMessageAt)
        .slice(0, RECENTS_LIMIT),
    [conversations],
  );

  const allUnscopedChats = chatsByRepo.get('__unscoped__') ?? EMPTY_CHATS;
  const chatModeChats = useMemo(
    () => allUnscopedChats.filter((c) => c.mode === 'chat'),
    [allUnscopedChats],
  );
  // Daemon-backed chats (local-pc / relay) get their own labeled sections.
  // Before splitting these out, they fell into "Unscoped" beside scratch
  // chats — confusing when they have a stable provenance (a paired daemon)
  // and the user is in one of those modes.
  const localPcChats = useMemo(
    () => allUnscopedChats.filter((c) => c.mode === 'local-pc'),
    [allUnscopedChats],
  );
  const relayChats = useMemo(
    () => allUnscopedChats.filter((c) => c.mode === 'relay'),
    [allUnscopedChats],
  );
  const unscopedChats = useMemo(
    () =>
      allUnscopedChats.filter(
        (c) => c.mode !== 'chat' && c.mode !== 'local-pc' && c.mode !== 'relay',
      ),
    [allUnscopedChats],
  );
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const isSearching = normalizedQuery.length > 0;

  const filteredRepoRows = useMemo(() => {
    if (!isSearching) return repoRows;
    return repoRows
      .map(({ repo, chats }) => {
        const repoMatches = `${repo.name} ${repo.full_name}`
          .toLowerCase()
          .includes(normalizedQuery);
        const matchingChats = chats.filter((chat) =>
          chat.title.toLowerCase().includes(normalizedQuery),
        );
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

  const filteredLocalPcChats = useMemo(() => {
    if (!isSearching) return localPcChats;
    return localPcChats.filter((chat) => chat.title.toLowerCase().includes(normalizedQuery));
  }, [isSearching, normalizedQuery, localPcChats]);

  const filteredRelayChats = useMemo(() => {
    if (!isSearching) return relayChats;
    return relayChats.filter((chat) => chat.title.toLowerCase().includes(normalizedQuery));
  }, [isSearching, normalizedQuery, relayChats]);

  const filteredCliSessions = useMemo(() => {
    if (!isSearching) return cliSessions;
    return cliSessions.filter((s) => {
      const haystack = `${s.sessionName} ${s.lastUserMessage} ${s.sessionId}`.toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [isSearching, normalizedQuery, cliSessions]);
  const cliSectionTitle =
    cliSessionsLabel === 'local-pc' ? 'Connected · Local PC' : 'Connected · Remote';

  const toggleRepo = (repoFullName: string, fallbackOpen: boolean) => {
    if (isSearching) return;
    setExpandedRepos((prev) => ({
      ...prev,
      [repoFullName]: !(prev[repoFullName] ?? fallbackOpen),
    }));
  };

  const openChat = (chatId: string) => {
    onResumeChat(chatId);
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

  // `showRepoTag` swaps the message-count subtitle for a repo tag — used by the
  // cross-repo Recents lane, where "which repo" matters more than the count and
  // the rows aren't already nested under a repo card. `keyPrefix` keeps React
  // keys distinct when the same chat appears in both Recents and its repo card.
  // `actions: false` makes the row open-only (Recents): rename/delete live on
  // the canonical repo-card copy, which also avoids both copies of a duplicated
  // chat entering rename mode at once (edit state is keyed by chat.id).
  const renderChatRow = (
    chat: Conversation,
    opts?: { showRepoTag?: boolean; keyPrefix?: string; actions?: boolean },
  ) => {
    const showActions = opts?.actions !== false;
    const isActiveChat = chat.id === activeChatId;
    // Gate edit mode on showActions too — otherwise an open-only Recents row
    // would still render the rename *form* (not just the trigger) whenever its
    // repo-card twin is being renamed, since edit state is keyed by chat.id.
    const isEditing = showActions && editingChatId === chat.id;
    const messageCount = chat.messages.filter((m) => !m.isToolResult).length;
    const subtitle = opts?.showRepoTag
      ? `${repoTagForChat(chat)} · ${timeAgoCompact(chat.lastMessageAt)}`
      : `${messageCount} msg${messageCount !== 1 ? 's' : ''} · ${timeAgoCompact(chat.lastMessageAt)}`;

    return (
      <div
        key={`${opts?.keyPrefix ?? ''}${chat.id}`}
        className={`flex items-center gap-1 rounded-xl border border-transparent transition-colors duration-200 ${
          isActiveChat
            ? 'border-push-accent/40 bg-push-accent/10'
            : 'hover:border-push-edge-subtle hover:bg-push-surface-hover/60'
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
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-emerald-300 transition-colors hover:bg-push-status-success-bg hover:text-emerald-200"
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
              onClick={() => openChat(chat.id)}
              className="min-w-0 flex-1 spring-press px-3 py-2.5 text-left"
            >
              <p
                className={`truncate text-push-sm ${isActiveChat ? 'text-push-fg' : 'text-push-fg-secondary'}`}
              >
                {chat.title}
              </p>
              <p className="mt-0.5 text-push-2xs text-push-fg-muted">{subtitle}</p>
            </button>
            {showActions && (
              <>
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
          className={`w-[86vw] rounded-r-2xl border-r ${HUB_GLASS_PANEL_CLASS} p-0 text-push-fg shadow-push-glass sm:max-w-sm [&>[data-slot=sheet-close]]:text-push-fg-secondary [&>[data-slot=sheet-close]]:hover:text-push-fg`}
        >
          {/* Subtle top highlight */}
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-16 rounded-tr-2xl bg-gradient-to-b from-white/[0.03] to-transparent" />
          <div className="relative h-full overflow-hidden">
            {/* Sky ambient wash behind the header — carries the chat's glow
                identity into the drawer, fading out before the chat list so it
                never competes with row legibility. */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 -top-20 z-0 h-48 bg-[radial-gradient(58%_100%_at_50%_0%,rgb(var(--push-accent-rgb)_/_0.17),transparent_72%)] blur-2xl"
            />
            <div className="absolute inset-0 flex flex-col">
              <SheetHeader className={`border-b ${HUB_GLASS_HAIRLINE} pb-3`}>
                <SheetTitle className="flex items-center gap-2 text-push-lg font-display font-semibold text-push-fg">
                  <HistoryStackIcon className="h-4 w-4 text-push-fg-dim" />
                  <span>Chats</span>
                </SheetTitle>
                <SheetDescription className="text-push-fg-muted">Repos and chats</SheetDescription>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => {
                      onNewChat();
                      onOpenChange(false);
                    }}
                    className={`inline-flex h-9 items-center gap-1.5 px-3 text-xs font-medium text-push-fg-secondary ${DRAWER_CONTROL_SURFACE_CLASS} ${DRAWER_CONTROL_INTERACTIVE_CLASS}`}
                  >
                    <div className="pointer-events-none absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/[0.05] to-transparent" />
                    <Plus className="h-3.5 w-3.5" />
                    <span>New chat</span>
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
                <div className="space-y-2 stagger-in">
                  {/* Connected — live daemon (CLI/TUI) sessions, leading the
                      drawer so a `/rc` from the terminal pops up right
                      next to the cloud chats (Claude Code-style). Rendered
                      whenever the paired daemon reports sessions; searchable
                      like the chat rows. */}
                  {filteredCliSessions.length > 0 && (
                    <div className={`${DRAWER_SECTION_SURFACE_CLASS} ${GLASS_SURFACE}`}>
                      <div className="px-1 py-2.5 text-push-xs font-medium uppercase tracking-wide text-emerald-300/90">
                        {cliSectionTitle}
                      </div>
                      <div className="space-y-1 px-0 pb-0">
                        {filteredCliSessions.map((s) => (
                          <CliSessionRow
                            key={s.sessionId}
                            session={s}
                            onResume={onResumeCliSession ? () => onResumeCliSession(s) : undefined}
                          />
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Recents — cross-repo, recency-first entry point. Hidden
                      while searching (the repo rows already filter), so it
                      stays a quick-resume lane rather than a second result set. */}
                  {!isSearching && recentChats.length > 0 && (
                    <div className={`${DRAWER_SECTION_SURFACE_CLASS} ${GLASS_SURFACE}`}>
                      <div className="px-1 py-2.5 text-push-xs font-medium uppercase tracking-wide text-push-fg-secondary">
                        Recents
                      </div>
                      <div className="space-y-1 px-0 pb-0">
                        {recentChats.map((chat) =>
                          renderChatRow(chat, {
                            showRepoTag: true,
                            keyPrefix: 'recent-',
                            actions: false,
                          }),
                        )}
                      </div>
                    </div>
                  )}

                  {filteredRepoRows.map(({ repo, chats }) => {
                    const isExpanded =
                      isSearching ||
                      (expandedRepos[repo.full_name] ?? activeRepo?.full_name === repo.full_name);
                    const isActiveRepo = activeRepo?.id === repo.id;
                    return (
                      <div
                        key={repo.id}
                        className={`${DRAWER_SECTION_SURFACE_CLASS} ${
                          isActiveRepo ? GLASS_ACTIVE_CLASS : DRAWER_SECTION_RESTING_CLASS
                        }`}
                      >
                        <div className="relative">
                          <button
                            onClick={() => toggleRepo(repo.full_name, isExpanded)}
                            className="flex w-full items-center gap-2 rounded-xl px-1 py-2.5 pr-10 text-left transition-colors"
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
                              <p className="truncate text-push-base font-medium text-push-fg">
                                {repo.name}
                              </p>
                              <p className="text-push-xs text-push-fg-muted">
                                {chats.length} chat{chats.length !== 1 ? 's' : ''}
                              </p>
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
                            className={`${GLASS_GHOST_BUTTON_CLASS} absolute right-0.5 top-1/2 h-8 w-8 -translate-y-1/2`}
                            aria-label={`Customize ${repo.name}`}
                            title="Customize repo"
                          >
                            <Palette className="h-3.5 w-3.5" />
                          </button>
                        </div>

                        {isExpanded && (
                          <div className="space-y-1 px-0 pb-0">
                            {chats.length === 0 ? (
                              <div className="rounded-xl border border-push-edge/70 bg-push-surface/20 px-3 py-2.5 text-push-xs text-push-fg-muted">
                                No chats yet
                              </div>
                            ) : (
                              chats.map((chat) => renderChatRow(chat))
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {filteredChatModeChats.length > 0 && (
                    <div className={`${DRAWER_SECTION_SURFACE_CLASS} ${GLASS_SURFACE}`}>
                      <div className="px-1 py-2.5 text-push-xs font-medium uppercase tracking-wide text-push-violet">
                        Chats
                      </div>
                      <div className="space-y-1 px-0 pb-0">
                        {filteredChatModeChats.map((chat) => renderChatRow(chat))}
                      </div>
                    </div>
                  )}
                  {filteredLocalPcChats.length > 0 && (
                    <div className={`${DRAWER_SECTION_SURFACE_CLASS} ${GLASS_SURFACE}`}>
                      <div className="px-1 py-2.5 text-push-xs font-medium uppercase tracking-wide text-push-link">
                        Local PC
                      </div>
                      <div className="space-y-1 px-0 pb-0">
                        {filteredLocalPcChats.map((chat) => renderChatRow(chat))}
                      </div>
                    </div>
                  )}
                  {filteredRelayChats.length > 0 && (
                    <div className={`${DRAWER_SECTION_SURFACE_CLASS} ${GLASS_SURFACE}`}>
                      <div className="px-1 py-2.5 text-push-xs font-medium uppercase tracking-wide text-push-link">
                        Remote
                      </div>
                      <div className="space-y-1 px-0 pb-0">
                        {filteredRelayChats.map((chat) => renderChatRow(chat))}
                      </div>
                    </div>
                  )}
                  {filteredUnscopedChats.length > 0 && (
                    <div className={`${DRAWER_SECTION_SURFACE_CLASS} ${GLASS_SURFACE}`}>
                      <div className="px-1 py-2.5 text-push-xs font-medium uppercase tracking-wide text-push-fg-muted">
                        Unscoped
                      </div>
                      <div className="space-y-1 px-0 pb-0">
                        {filteredUnscopedChats.map((chat) => renderChatRow(chat))}
                      </div>
                    </div>
                  )}
                  {filteredRepoRows.length === 0 &&
                    filteredUnscopedChats.length === 0 &&
                    filteredChatModeChats.length === 0 &&
                    filteredLocalPcChats.length === 0 &&
                    filteredRelayChats.length === 0 &&
                    filteredCliSessions.length === 0 && (
                      <div className="rounded-xl border border-dashed border-push-edge/70 bg-push-surface/15 px-3 py-4 text-center text-push-sm text-push-fg-muted">
                        No repos or chats match your search.
                      </div>
                    )}
                </div>
              </div>

              <div
                className={`flex items-center gap-2 border-t ${HUB_GLASS_HAIRLINE} ${GLASS_FILL_FAINT} px-3 py-3`}
              >
                <PushMarkIcon className="h-[13px] w-[13px] shrink-0 text-push-accent" />
                <div className="min-w-0 flex-1">
                  <p className="text-push-xs font-medium text-push-fg-secondary">Push</p>
                  <p className="truncate text-push-2xs text-push-fg-dim">Your repo, in one chat</p>
                </div>
                {daemonActions && (
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={daemonActions.onCustomizeAppearance}
                      className={`${GLASS_GHOST_BUTTON_CLASS} h-8 w-8`}
                      aria-label={`Customize ${daemonActions.daemonLabel} appearance`}
                      title="Customize appearance"
                    >
                      <Palette className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={daemonActions.onLeave}
                      className={`${GLASS_GHOST_BUTTON_CLASS} h-8 w-8`}
                      aria-label={`Leave ${daemonActions.daemonLabel}`}
                      title={`Leave ${daemonActions.daemonLabel}`}
                    >
                      <ArrowLeft className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={daemonActions.onUnpair}
                      className={`${GLASS_GHOST_BUTTON_CLASS} h-8 w-8 hover:text-rose-200`}
                      aria-label="Unpair"
                      title={`Unpair this ${daemonActions.daemonLabel}`}
                    >
                      <daemonActions.unpairIcon className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                )}
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
