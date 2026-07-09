import { beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory storage backing the safe-storage mock. loadConversations,
// getActiveRepoFullName, and saveConversationsLegacy all route through it.
const store: Record<string, string> = {};
vi.mock('@/lib/safe-storage', () => ({
  safeStorageGet: (key: string) => (key in store ? store[key] : null),
  safeStorageSet: (key: string, value: string) => {
    store[key] = value;
    return true;
  },
  safeStorageRemove: (key: string) => {
    delete store[key];
    return true;
  },
}));

import { loadConversations } from './chat-persistence';

const CONVERSATIONS_KEY = 'diff_conversations';

function conv(id: string, extra: Record<string, unknown>) {
  return { id, title: id, messages: [], createdAt: 1, lastMessageAt: 1, ...extra };
}

describe('loadConversations — retired provider lock normalization', () => {
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
  });

  it('clears a persisted lock for a since-removed provider, preserving valid and unset ones', () => {
    // Regression for the Codex P2 on the experimental-providers removal: a
    // conversation persisted with provider "vertex" (now removed) would reach
    // getProviderPushStream via the commit/push auditor and throw, since the
    // factory map has no entry. The lock must be dropped on load.
    store[CONVERSATIONS_KEY] = JSON.stringify({
      stale: conv('stale', { provider: 'vertex', model: 'gemini-2.5-pro' }),
      alsoStale: conv('alsoStale', { provider: 'bedrock', model: 'm' }),
      valid: conv('valid', { provider: 'anthropic', model: 'claude-haiku-4-5' }),
      unset: conv('unset', {}),
      unsetWithModel: conv('unsetWithModel', { model: 'claude-haiku-4-5' }),
    });

    const loaded = loadConversations();

    // Retired provider lock AND its model are dropped together — a leftover model
    // id would otherwise be preferred by resolveChatProviderSelection on resume.
    expect(loaded.stale.provider).toBeUndefined();
    expect(loaded.stale.model).toBeUndefined();
    expect(loaded.alsoStale.provider).toBeUndefined();
    expect(loaded.alsoStale.model).toBeUndefined();
    // A valid lock keeps both.
    expect(loaded.valid.provider).toBe('anthropic');
    expect(loaded.valid.model).toBe('claude-haiku-4-5');
    // No lock at all: provider stays unset, and a standalone model is NOT dropped.
    expect(loaded.unset.provider).toBeUndefined();
    expect(loaded.unsetWithModel.model).toBe('claude-haiku-4-5');
  });

  it('persists the cleared lock back to storage (migration flag fires)', () => {
    store[CONVERSATIONS_KEY] = JSON.stringify({
      stale: conv('stale', { provider: 'azure', model: 'm' }),
    });

    loadConversations();

    // saveConversationsLegacy wrote the normalized set back — the stale provider
    // is gone from persisted storage, not just the in-memory copy.
    const persisted = JSON.parse(store[CONVERSATIONS_KEY]);
    expect(persisted.stale.provider).toBeUndefined();
    expect(persisted.stale.model).toBeUndefined();
  });
});
