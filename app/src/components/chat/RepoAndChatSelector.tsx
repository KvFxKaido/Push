import { useState } from 'react';
import { ChevronDown, Plus, Trash2, MessageSquare, Lock, GitPullRequest, Box, House } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { Conversation, RepoWithActivity, ActiveRepo } from '@/types';

interface RepoAndChatSelectorProps {
  repos: RepoWithActivity[];
  activeRepo: ActiveRepo | null;
  onSelectRepo: (repo: RepoWithActivity) => void;
  conversations: Record<string, Conversation>;
  sortedChatIds: string[];
  activeChatId: string;
  onSwitchChat: (id: string) => void;
  onNewChat: () => void;
  onDeleteChat: (id: string) => void;
  onBrowseRepos?: () => void;
  onSandboxMode?: () => void;
}

export function RepoAndChatSelector({
  repos,
  activeRepo,
  onSelectRepo,
  conversations,
  sortedChatIds,
  activeChatId,
  onSwitchChat,
  onNewChat,
  onDeleteChat,
  onBrowseRepos,
  onSandboxMode,
}: RepoAndChatSelectorProps) {
  const [open, setOpen] = useState(false);
  const repoName = activeRepo?.name;

  // Build trigger label: repo name or just "Push"
  const triggerLabel = repoName
    ? <span className="truncate font-semibold text-push-fg">{repoName}</span>
    : <span className="font-semibold text-push-fg">Push</span>;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger className="flex h-9 min-w-0 max-w-[240px] items-center gap-1.5 rounded-lg border border-push-edge bg-push-surface px-2 text-sm outline-none transition-colors duration-200 hover:border-[#31425a] hover:bg-[#0d1119] active:scale-[0.98]">
        <span className="flex items-center min-w-0 truncate">{triggerLabel}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-push-fg-dim transition-transform duration-200 ${
            open ? 'rotate-180' : ''
          }`}
        />
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="start"
        sideOffset={8}
        className="max-h-[70dvh] w-[300px] overflow-y-auto rounded-xl border border-push-edge bg-push-grad-card shadow-[0_18px_40px_rgba(0,0,0,0.62)]"
      >
        {/* --- REPOS section --- */}
        {repos.length > 0 && (
          <>
            <DropdownMenuLabel className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-push-fg-dim">
              Repos
            </DropdownMenuLabel>

            {repos.map((repo) => {
              const isActive = activeRepo?.id === repo.id;
              return (
                <DropdownMenuItem
                  key={repo.id}
                  onSelect={(e) => {
                    e.preventDefault(); // Keep dropdown open on repo click
                    onSelectRepo(repo);
                  }}
                  className={`mx-1 flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 ${
                    isActive ? 'bg-[#0b74e8]/15' : 'hover:bg-[#0d1119]'
                  }`}
                >
                  <span className={`flex-1 truncate text-sm font-medium ${
                    isActive ? 'text-push-link' : 'text-[#c5cfde]'
                  }`}>
                    {repo.name}
                  </span>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {repo.private && <Lock className="h-3 w-3 text-[#5f6b80]" />}
                    {repo.activity.open_prs > 0 && (
                      <span className="flex items-center gap-0.5 text-xs text-[#5f6b80]">
                        <GitPullRequest className="h-3 w-3" />
                        {repo.activity.open_prs}
                      </span>
                    )}
                  </div>
                </DropdownMenuItem>
              );
            })}

            {/* --- Home --- */}
            {onBrowseRepos && (
              <DropdownMenuItem
                onSelect={() => {
                  onBrowseRepos();
                  setOpen(false);
                }}
                className="mx-1 mt-1 flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-push-link hover:bg-[#0d1119] hover:text-[#86ccff]"
              >
                <House className="h-4 w-4" />
                <span className="text-sm font-medium">Home</span>
              </DropdownMenuItem>
            )}

            {/* --- New Sandbox --- */}
            {onSandboxMode && (
              <DropdownMenuItem
                onSelect={() => {
                  onSandboxMode();
                  setOpen(false);
                }}
                className="mx-1 flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-emerald-300 hover:bg-[#0d1119] hover:text-emerald-200"
              >
                <Box className="h-4 w-4" />
                <span className="text-sm font-medium">New Sandbox</span>
              </DropdownMenuItem>
            )}

            <DropdownMenuSeparator className="bg-push-edge" />
          </>
        )}

        {/* --- CHATS section --- */}
        <DropdownMenuLabel className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-push-fg-dim">
          Chats
        </DropdownMenuLabel>

        {sortedChatIds.map((id) => {
          const conv = conversations[id];
          if (!conv) return null;
          const isActiveChat = id === activeChatId;
          const msgCount = conv.messages.filter((m) => !m.isToolResult).length;

          return (
            <DropdownMenuItem
              key={id}
              onSelect={() => {
                onSwitchChat(id);
                setOpen(false);
              }}
              className={`mx-1 flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2.5 ${
                isActiveChat ? 'bg-[#101621]' : 'hover:bg-[#0d1119]'
              }`}
            >
              <MessageSquare className="h-3.5 w-3.5 shrink-0 text-push-fg-dim" />
              <div className="flex-1 min-w-0">
                <div className="truncate text-sm text-push-fg">{conv.title}</div>
                <div className="text-[11px] text-push-fg-dim">
                  {msgCount} msg{msgCount !== 1 ? 's' : ''}
                </div>
              </div>
              {sortedChatIds.length > 1 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    onDeleteChat(id);
                  }}
                  className="h-7 w-7 shrink-0 rounded-md text-push-fg-dim transition-colors duration-150 hover:bg-[#1a1f2b] hover:text-red-400"
                  aria-label={`Delete ${conv.title}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </DropdownMenuItem>
          );
        })}

        <DropdownMenuSeparator className="bg-push-edge" />

        {/* --- New Chat --- */}
        <DropdownMenuItem
          onSelect={() => {
            onNewChat();
            setOpen(false);
          }}
          className="mx-1 flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2.5 text-push-link hover:bg-[#0d1119] hover:text-[#86ccff]"
        >
          <Plus className="h-4 w-4" />
          <span className="text-sm font-medium">New Chat</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
