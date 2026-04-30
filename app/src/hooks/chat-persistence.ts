import type { AIProviderType, AttachmentData, ChatMessage, Conversation } from '@/types';
import { normalizeKilocodeModelName } from '@/lib/providers';
import { safeStorageGet, safeStorageRemove, safeStorageSet } from '@/lib/safe-storage';

const CONVERSATIONS_KEY = 'diff_conversations';
const ACTIVE_CHAT_KEY = 'diff_active_chat';
const OLD_STORAGE_KEY = 'diff_chat_history';
const ACTIVE_REPO_KEY = 'active_repo';

function sanitizeSandboxStateCards(message: ChatMessage): ChatMessage | null {
  const cards = (message.cards || []).filter((card) => card.type !== 'sandbox-state');
  const sandboxAttachedBanner = /^Sandbox attached on `[^`]+`\.\s*$/;

  // Drop old auto-injected sandbox state messages entirely.
  if (
    message.role === 'assistant' &&
    sandboxAttachedBanner.test(message.content.trim()) &&
    cards.length === 0
  ) {
    return null;
  }

  if (!message.cards) return message;
  return { ...message, cards };
}

export { createId } from '@push/lib/id-utils';

export function generateTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === 'user');
  if (!firstUser) return 'New Chat';
  const content = (firstUser.displayContent ?? firstUser.content).trim();
  return content.length > 30 ? `${content.slice(0, 30)}...` : content;
}

export function normalizeConversationModel(
  provider: AIProviderType | null | undefined,
  model: string | null | undefined,
): string | null {
  if (typeof model !== 'string') return null;
  const trimmed = model.trim();
  if (!trimmed) return null;
  return provider === 'kilocode' ? normalizeKilocodeModelName(trimmed) : trimmed;
}

// Legacy sync save — kept only for old-format migration writes.
// Normal persistence is handled by the dirty-tracking flush effect.
function saveConversationsLegacy(convs: Record<string, Conversation>) {
  safeStorageSet(CONVERSATIONS_KEY, JSON.stringify(convs));
}

export function saveActiveChatId(id: string) {
  safeStorageSet(ACTIVE_CHAT_KEY, id);
}

function getActiveRepoFullName(): string | null {
  try {
    const stored = safeStorageGet(ACTIVE_REPO_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored);
    if (parsed && typeof parsed.full_name === 'string' && parsed.full_name.trim()) {
      return parsed.full_name;
    }
  } catch {
    // Ignore parse errors
  }
  return null;
}

export function loadConversations(): Record<string, Conversation> {
  try {
    const stored = safeStorageGet(CONVERSATIONS_KEY);
    if (stored) {
      const convs: Record<string, Conversation> = JSON.parse(stored);
      let migrated = false;
      for (const id of Object.keys(convs)) {
        const conversation = convs[id];
        const cleaned = (convs[id].messages || [])
          .map(sanitizeSandboxStateCards)
          .filter((m): m is ChatMessage => m !== null);
        const normalizedModel = normalizeConversationModel(
          conversation.provider ?? null,
          conversation.model ?? null,
        );
        convs[id] = {
          ...conversation,
          messages: cleaned,
          model: normalizedModel ?? undefined,
        };
        if ((conversation.model ?? null) !== normalizedModel) {
          migrated = true;
        }
      }

      // Migration: stamp unscoped conversations with the current active repo
      const repoFullName = getActiveRepoFullName();
      if (repoFullName) {
        for (const id of Object.keys(convs)) {
          if (!convs[id].repoFullName) {
            convs[id] = { ...convs[id], repoFullName };
            migrated = true;
          }
        }
      }

      if (migrated) saveConversationsLegacy(convs);

      return convs;
    }
  } catch {
    // Ignore parse errors
  }

  // Migration: check for old single-chat format
  try {
    const oldHistory = safeStorageGet(OLD_STORAGE_KEY);
    if (oldHistory) {
      const oldMessages: ChatMessage[] = JSON.parse(oldHistory);
      if (oldMessages.length > 0) {
        const id = createId();
        const repoFullName = getActiveRepoFullName();
        const migrated: Record<string, Conversation> = {
          [id]: {
            id,
            title: generateTitle(oldMessages),
            messages: oldMessages,
            createdAt: oldMessages[0]?.timestamp || Date.now(),
            lastMessageAt: oldMessages[oldMessages.length - 1]?.timestamp || Date.now(),
            repoFullName: repoFullName || undefined,
          },
        };
        saveConversationsLegacy(migrated);
        saveActiveChatId(id);
        safeStorageRemove(OLD_STORAGE_KEY);
        return migrated;
      }
    }
  } catch {
    // Ignore migration errors
  }

  return {};
}

export function loadActiveChatId(conversations: Record<string, Conversation>): string {
  const stored = safeStorageGet(ACTIVE_CHAT_KEY);
  if (stored && conversations[stored]) return stored;
  // Default to most recent conversation or empty
  const ids = Object.keys(conversations);
  if (ids.length === 0) return '';
  return ids.sort((a, b) => conversations[b].lastMessageAt - conversations[a].lastMessageAt)[0];
}

export function shouldPrewarmSandbox(text: string, attachments?: AttachmentData[]): boolean {
  const normalized = text.toLowerCase();
  const intentRegex =
    /\b(edit|modify|change|refactor|fix|implement|write|create|add|remove|rename|run|test|build|lint|compile|typecheck|type-check|commit|push|patch|bug|failing|error|debug)\b/;
  if (intentRegex.test(normalized)) return true;

  const fileHintRegex =
    /\b([a-z0-9_\-/]+\.(ts|tsx|js|jsx|py|rs|go|java|rb|css|html|json|md|yml|yaml|toml|sh))\b/i;
  if (fileHintRegex.test(text)) return true;

  if (attachments?.some((att) => att.type === 'code' || att.type === 'document')) {
    return true;
  }
  return false;
}
