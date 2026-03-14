/**
 * Conversation persistence layer backed by IndexedDB.
 *
 * Replaces the old pattern of serializing ALL conversations to a single
 * localStorage JSON blob on every message. Now each conversation is stored
 * as its own IndexedDB record — writes are incremental, reads can be lazy.
 *
 * Migration: on first load, if IndexedDB is empty but localStorage has
 * conversations, they're copied to IndexedDB and the localStorage key is
 * cleared.
 */

import { STORE, getAll, get, put, del, putMany } from './app-db';
import { safeStorageGet, safeStorageRemove } from './safe-storage';
import type { Conversation } from '@/types';

const LEGACY_CONVERSATIONS_KEY = 'diff_conversations';
const MIGRATION_FLAG_KEY = 'push:idb-conversations-migrated';

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** Load all conversations from IndexedDB. */
export async function loadAllConversations(): Promise<Record<string, Conversation>> {
  try {
    const records = await getAll<Conversation>(STORE.conversations);
    const result: Record<string, Conversation> = {};
    for (const conv of records) {
      result[conv.id] = conv;
    }
    return result;
  } catch (err) {
    console.warn('[ConversationStore] IndexedDB read failed, falling back to localStorage', err);
    return loadConversationsFromLocalStorage();
  }
}

/** Load a single conversation by ID. */
export async function loadConversation(id: string): Promise<Conversation | undefined> {
  return get<Conversation>(STORE.conversations, id);
}

// ---------------------------------------------------------------------------
// Write (incremental — only the changed conversation)
// ---------------------------------------------------------------------------

/** Save a single conversation (upsert). */
export async function saveConversation(conv: Conversation): Promise<void> {
  try {
    await put(STORE.conversations, conv);
  } catch (err) {
    console.warn('[ConversationStore] IndexedDB write failed', err);
  }
}

/** Save multiple conversations in a single transaction. */
export async function saveConversations(convs: Conversation[]): Promise<void> {
  try {
    await putMany(STORE.conversations, convs);
  } catch (err) {
    console.warn('[ConversationStore] IndexedDB batch write failed', err);
  }
}

/** Delete a single conversation. */
export async function deleteConversation(id: string): Promise<void> {
  try {
    await del(STORE.conversations, id);
  } catch (err) {
    console.warn('[ConversationStore] IndexedDB delete failed', err);
  }
}

/** Delete multiple conversations and save the remaining set. */
export async function replaceAllConversations(convs: Record<string, Conversation>): Promise<void> {
  try {
    // Clear + re-populate is simpler than diff-deleting
    const { clear } = await import('./app-db');
    await clear(STORE.conversations);
    const values = Object.values(convs);
    if (values.length > 0) {
      await putMany(STORE.conversations, values);
    }
  } catch (err) {
    console.warn('[ConversationStore] IndexedDB replace failed', err);
  }
}

// ---------------------------------------------------------------------------
// Migration from localStorage
// ---------------------------------------------------------------------------

function loadConversationsFromLocalStorage(): Record<string, Conversation> {
  try {
    const stored = safeStorageGet(LEGACY_CONVERSATIONS_KEY);
    if (!stored) return {};
    return JSON.parse(stored) as Record<string, Conversation>;
  } catch {
    return {};
  }
}

/**
 * Migrate conversations from localStorage to IndexedDB.
 * Safe to call multiple times — skips if already migrated or nothing to migrate.
 * Returns the loaded conversations dict.
 */
export async function migrateConversationsToIndexedDB(): Promise<Record<string, Conversation>> {
  // Check if already migrated
  if (safeStorageGet(MIGRATION_FLAG_KEY)) {
    return loadAllConversations();
  }

  // Check if IndexedDB already has data (e.g., partial migration)
  const existing = await loadAllConversations();
  if (Object.keys(existing).length > 0) {
    safeStorageRemove(LEGACY_CONVERSATIONS_KEY);
    return existing;
  }

  // Load from localStorage
  const legacy = loadConversationsFromLocalStorage();
  if (Object.keys(legacy).length === 0) {
    return {};
  }

  // Write to IndexedDB
  const values = Object.values(legacy);
  try {
    await putMany(STORE.conversations, values);
    // Clear localStorage only after successful IndexedDB write
    safeStorageRemove(LEGACY_CONVERSATIONS_KEY);
    console.log(`[ConversationStore] Migrated ${values.length} conversations to IndexedDB`);
  } catch (err) {
    console.warn('[ConversationStore] Migration failed, keeping localStorage', err);
    return legacy;
  }

  return legacy;
}
