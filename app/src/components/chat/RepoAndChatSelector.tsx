import { useState } from 'react';
import { ChevronDown, Plus, Trash2, MessageSquare, Lock, GitPullRequest } from 'lucide-react';
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
}: RepoAndChatSelectorProps) {
  const [open, setOpen] = useState(false);

  const activeConv = conversations[activeChatId];
  const chatTitle = activeConv?.title || 'New Chat';
  const repoName = activeRepo?.name;

  // Build trigger label: "repo / chat ▾" or just "Push"
  const triggerLabel = repoName
    ? (
        <>
          <span className="text-[#fafafa] font-semibold truncate">{repoName}</span>
          <span className="text-[#27272a] mx-0.5">/</span>
          <span className="text-[#a1a1aa] truncate">{chatTitle}</span>
        </>
      )
    : <span className="text-[#fafafa] font-semibold">Push</span>;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger className="flex items-center gap-1.5 h-9 px-2 rounded-lg text-sm hover:bg-[#0d0d0d] transition-colors duration-200 outline-none min-w-0 max-w-[240px] active:scale-[0.98]">
        <span className="flex items-center min-w-0 truncate">{triggerLabel}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-[#52525b] transition-transform duration-200 ${
            open ? 'rotate-180' : ''
          }`}
        />
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="start"
        sideOffset={8}
        className="w-[300px] max-h-[70vh] overflow-y-auto bg-[#000] border-[#1a1a1a] rounded-xl shadow-xl"
      >
        {/* --- REPOS section --- */}
        {repos.length > 0 && (
          <>
            <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-[#52525b] font-medium px-3 py-1.5">
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
                  className={`flex items-center gap-2.5 px-3 py-2 cursor-pointer rounded-lg mx-1 ${
                    isActive ? 'bg-[#0070f3]/10' : ''
                  }`}
                >
                  <span className={`flex-1 truncate text-sm font-medium ${
                    isActive ? 'text-[#0070f3]' : 'text-[#a1a1aa]'
                  }`}>
                    {repo.name}
                  </span>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {repo.private && <Lock className="h-3 w-3 text-[#3f3f46]" />}
                    {repo.activity.open_prs > 0 && (
                      <span className="flex items-center gap-0.5 text-xs text-[#3f3f46]">
                        <GitPullRequest className="h-3 w-3" />
                        {repo.activity.open_prs}
                      </span>
                    )}
                  </div>
                </DropdownMenuItem>
              );
            })}

            <DropdownMenuSeparator className="bg-[#1a1a1a]" />
          </>
        )}

        {/* --- CHATS section --- */}
        <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-[#52525b] font-medium px-3 py-1.5">
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
              className={`flex items-center gap-2.5 px-3 py-2.5 cursor-pointer rounded-lg mx-1 ${
                isActiveChat ? 'bg-[#0d0d0d]' : ''
              }`}
            >
              <MessageSquare className="h-3.5 w-3.5 shrink-0 text-[#52525b]" />
              <div className="flex-1 min-w-0">
                <div className="text-sm text-[#fafafa] truncate">{conv.title}</div>
                <div className="text-[11px] text-[#52525b]">
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
                  className="h-7 w-7 flex items-center justify-center rounded-md text-[#52525b] hover:text-red-400 hover:bg-[#1a1a1a] transition-colors duration-150 shrink-0"
                  aria-label={`Delete ${conv.title}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </DropdownMenuItem>
          );
        })}

        <DropdownMenuSeparator className="bg-[#1a1a1a]" />

        {/* --- New Chat --- */}
        <DropdownMenuItem
          onSelect={() => {
            onNewChat();
            setOpen(false);
          }}
          className="flex items-center gap-2.5 px-3 py-2.5 cursor-pointer text-[#0070f3] hover:text-[#0060d3] rounded-lg mx-1"
        >
          <Plus className="h-4 w-4" />
          <span className="text-sm font-medium">New Chat</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
