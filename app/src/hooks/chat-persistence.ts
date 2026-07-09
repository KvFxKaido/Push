import type { AIProviderType, ChatMessage, Conversation } from '@/types';
import { normalizeFireworksModelName, normalizeKilocodeModelName } from '@/lib/providers';
import { safeStorageGet, safeStorageRemove, safeStorageSet } from '@/lib/safe-storage';
import { createId } from '@push/lib/id-utils';
import { isRealProviderId } from '@push/lib/provider-definition';
import { backfillConversationMessageBranches } from '@/lib/chat-message';

export { createId };

const CONVERSATIONS_KEY = 'diff_conversations';
const ACTIVE_CHAT_KEY = 'diff_active_chat';
const OLD_STORAGE_KEY = 'diff_chat_history';
const ACTIVE_REPO_KEY = 'active_repo';

function sanitizeSandboxStateCards(message: ChatMessage): ChatMessage | null {
  // Deliberate one-way migration: carry-chat was removed (no renderer, no
  // `carry_chat` verb), so legacy `branch_carried` dividers are meaningless and
  // dropped on load. This permanently removes them from persisted transcripts on
  // the next flush — intentional, not an accidental filter.
  if ((message as { kind?: string }).kind === 'branch_carried') return null;

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
  if (provider === 'kilocode') return normalizeKilocodeModelName(trimmed);
  if (provider === 'fireworks') return normalizeFireworksModelName(trimmed);
  return trimmed;
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
        // Drop a persisted provider lock that no longer resolves to a real
        // provider (e.g. a since-removed provider). Downstream reuse outside
        // send-message preparation — the commit/push auditor, compaction —
        // hands the lock straight to getProviderPushStream, which has no factory
        // for an unknown id and throws on use. isRealProviderId gates stored
        // provider selection the same way (see readStoredProvider in lib/providers).
        const rawProvider = conversation.provider ?? null;
        const providerRetired = rawProvider !== null && !isRealProviderId(rawProvider);
        const normalizedProvider = providerRetired ? null : rawProvider;
        // Drop the model alongside a retired provider lock. resolveChatProviderSelection
        // prefers existingModel over the requested/default (provider-selection.ts), so a
        // leftover retired-provider model id would be sent to whatever provider is now
        // active and fail on send. A model with no lock or a valid lock is normalized as before.
        const normalizedModel = providerRetired
          ? null
          : normalizeConversationModel(normalizedProvider, conversation.model ?? null);
        convs[id] = {
          ...conversation,
          messages: cleaned,
          provider: normalizedProvider ?? undefined,
          model: normalizedModel ?? undefined,
        };
        if ((conversation.provider ?? null) !== normalizedProvider) {
          migrated = true;
        }
        if ((conversation.model ?? null) !== normalizedModel) {
          migrated = true;
        }
        const backfilled = backfillConversationMessageBranches(convs[id]);
        if (backfilled.changed) {
          convs[id] = backfilled.conversation;
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
        const backfilled = backfillConversationMessageBranches(migrated[id]);
        if (backfilled.changed) {
          migrated[id] = backfilled.conversation;
        }
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
