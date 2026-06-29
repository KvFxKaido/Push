import { useMemo, useState } from 'react';
import { Check, MessageSquare, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import type { Conversation } from '@/types';
import { timeAgoCompact } from '@/lib/utils';

interface HubChatsTabProps {
  conversations: Record<string, Conversation>;
  activeChatId: string;
  repoFullName: string | null;
  onSwitchChat: (id: string) => void;
  onNewChat: () => void;
  onDeleteChat: (id: string) => void;
  onRenameChat: (id: string, title: string) => void;
  onClose: () => void;
}

export function HubChatsTab({
  conversations,
  activeChatId,
  repoFullName,
  onSwitchChat,
  onNewChat,
  onDeleteChat,
  onRenameChat,
  onClose,
}: HubChatsTabProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');

  // Filter to current repo only
  const repoChats = useMemo(() => {
    const all = Object.values(conversations);
    if (!repoFullName) {
      // Sandbox mode — show chats without a repo
      return all.filter((c) => !c.repoFullName).sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    }
    return all
      .filter((c) => c.repoFullName === repoFullName)
      .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  }, [conversations, repoFullName]);

  // Apply search filter
  const filteredChats = useMemo(() => {
    if (!searchQuery.trim()) return repoChats;
    const q = searchQuery.toLowerCase();
    return repoChats.filter((c) => c.title.toLowerCase().includes(q));
  }, [repoChats, searchQuery]);

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

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Search + New Chat */}
      <div className="flex items-center gap-2 border-b border-push-edge px-3 py-2">
        <div className="relative min-w-0 flex-1">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-push-fg-dim" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search chats..."
            className="h-8 w-full rounded-lg border border-push-edge bg-push-surface pl-8 pr-3 text-xs text-push-fg-secondary outline-none transition-colors placeholder:text-push-fg-dim focus:border-push-sky/50"
          />
        </div>
        <button
          onClick={() => {
            onNewChat();
            onClose();
          }}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-push-edge bg-push-surface/95 text-push-fg-dim transition-colors hover:border-push-edge-hover hover:text-push-fg-secondary"
          aria-label="New chat"
          title="New chat"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Chat list */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {filteredChats.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
            <MessageSquare className="h-6 w-6 text-push-fg-dim" />
            <p className="text-xs text-push-fg-dim">
              {searchQuery.trim() ? 'No matching chats.' : 'No chats yet.'}
            </p>
          </div>
        ) : (
          filteredChats.map((chat) => {
            const isActive = chat.id === activeChatId;
            const isEditing = editingChatId === chat.id;
            const messageCount = chat.messages.filter((m) => !m.isToolResult).length;
            const branchLabel = chat.repoFullName ? chat.branch : null;

            return (
              <div
                key={chat.id}
                className={`mx-2 flex items-center gap-1 rounded-lg ${isActive ? 'bg-push-surface-raised' : 'hover:bg-push-surface-raised'}`}
              >
                {isEditing ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
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
                      onClick={() => {
                        onSwitchChat(chat.id);
                        onClose();
                      }}
                      className="min-w-0 flex-1 px-2.5 py-2 text-left"
                    >
                      <p
                        className={`truncate text-push-sm ${isActive ? 'text-push-fg' : 'text-push-fg-secondary'}`}
                      >
                        {chat.title}
                      </p>
                      <p className="mt-0.5 text-push-2xs text-push-fg-muted">
                        {messageCount} msg{messageCount !== 1 ? 's' : ''} ·{' '}
                        {branchLabel ? `${branchLabel} · ` : ''}
                        {timeAgoCompact(chat.lastMessageAt)}
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
          })
        )}
      </div>
    </div>
  );
}
