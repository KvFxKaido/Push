import { useState } from 'react';
import { ChevronDown, Plus, Trash2, MessageSquare } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { Conversation } from '@/types';

interface ChatSwitcherProps {
  conversations: Record<string, Conversation>;
  sortedChatIds: string[];
  activeChatId: string;
  onSwitch: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}

export function ChatSwitcher({
  conversations,
  sortedChatIds,
  activeChatId,
  onSwitch,
  onNew,
  onDelete,
}: ChatSwitcherProps) {
  const [open, setOpen] = useState(false);
  const activeConv = conversations[activeChatId];
  const displayTitle = activeConv?.title || 'Diff';
  const chatCount = sortedChatIds.length;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger className="flex items-center gap-1.5 h-9 px-2 rounded-lg text-sm font-semibold text-[#fafafa] hover:bg-[#111113] transition-colors duration-200 outline-none min-w-0 max-w-[180px] active:scale-[0.98]">
        <span className="truncate">{displayTitle}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-[#52525b] transition-transform duration-200 ${
            open ? 'rotate-180' : ''
          }`}
        />
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="start"
        sideOffset={8}
        className="w-[280px] max-h-[400px] overflow-y-auto bg-[#09090b] border-[#1a1a1e] rounded-xl shadow-xl"
      >
        <DropdownMenuLabel className="text-xs text-[#52525b] font-medium px-3 py-1.5">
          Chats
        </DropdownMenuLabel>

        {sortedChatIds.map((id) => {
          const conv = conversations[id];
          if (!conv) return null;
          const isActive = id === activeChatId;

          return (
            <DropdownMenuItem
              key={id}
              onClick={() => {
                onSwitch(id);
                setOpen(false);
              }}
              className={`flex items-center gap-2.5 px-3 py-2.5 cursor-pointer rounded-lg mx-1 ${
                isActive ? 'bg-[#111113]' : ''
              }`}
            >
              <MessageSquare className="h-3.5 w-3.5 shrink-0 text-[#52525b]" />
              <div className="flex-1 min-w-0">
                <div className="text-sm text-[#fafafa] truncate">{conv.title}</div>
                <div className="text-[11px] text-[#52525b]">
                  {conv.messages.length} message{conv.messages.length !== 1 ? 's' : ''}
                </div>
              </div>
              {chatCount > 1 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    onDelete(id);
                  }}
                  className="h-7 w-7 flex items-center justify-center rounded-md text-[#52525b] hover:text-red-400 hover:bg-[#1a1a1e] transition-colors duration-150 shrink-0"
                  aria-label={`Delete ${conv.title}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </DropdownMenuItem>
          );
        })}

        <DropdownMenuSeparator className="bg-[#1a1a1e]" />

        <DropdownMenuItem
          onClick={() => {
            onNew();
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
