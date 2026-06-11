/**
 * Tests for `resolveSendEngineTrigger` — the turn-dispatch decision across
 * the three routes (CoderJob DO engine / foreground inline lane /
 * Orchestrator loop), including the provider engine-capability fold: a
 * provider whose key exists only in in-app Settings (browser-held) must
 * stay off the engine, because the CoderJob DO authenticates with
 * server-held credentials only. Since the Inline Foreground Lane, the fold
 * applies to the ENGINE route only — the inline lane is a foreground run
 * where browser-held keys work directly.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type React from 'react';
import type { Conversation } from '@/types';

const storage = vi.hoisted(() => ({ map: new Map<string, string>() }));

vi.mock('@/lib/safe-storage', () => ({
  safeStorageGet: (key: string) => storage.map.get(key) ?? null,
  safeStorageSet: (key: string, value: string) => {
    storage.map.set(key, value);
    return true;
  },
  safeStorageRemove: (key: string) => {
    storage.map.delete(key);
    return true;
  },
}));

vi.mock('@/lib/orchestrator', () => ({
  getActiveProvider: vi.fn(() => 'ollama'),
  isProviderAvailable: vi.fn(() => true),
}));
vi.mock('@/lib/provider-engine-capability', () => ({
  isProviderEngineCapable: vi.fn(() => true),
}));

import { getActiveProvider } from '@/lib/orchestrator';
import { isProviderEngineCapable } from '@/lib/provider-engine-capability';
import { resolveSendEngineTrigger } from './chat-send-background';

const BG_KEY = 'push:background-mode-preference';
const MODE_KEY = 'push:delegation-mode-preference';

function makeRefs(opts?: { repo?: string | null; branch?: string | null }) {
  return {
    repoRef: { current: opts?.repo === undefined ? 'owner/repo' : opts.repo },
    branchInfoRef: {
      current: { currentBranch: opts?.branch === undefined ? 'main' : (opts?.branch ?? undefined) },
    },
  } as {
    repoRef: React.MutableRefObject<string | null>;
    branchInfoRef: React.RefObject<{ currentBranch?: string; defaultBranch?: string } | null>;
  };
}

function makeConversations(
  provider?: string,
): React.MutableRefObject<Record<string, Conversation>> {
  return {
    current: {
      chat1: { provider } as unknown as Conversation,
    },
  };
}

beforeEach(() => {
  // Empty storage resolves delegation-mode to its `inline` default; tests
  // that pin the engine route set the background-mode flag explicitly.
  storage.map.clear();
  vi.mocked(isProviderEngineCapable).mockReturnValue(true);
  vi.mocked(getActiveProvider).mockReturnValue('ollama' as never);
});

describe('resolveSendEngineTrigger', () => {
  it('routes to the inline lane by default when repo and branch hold', () => {
    const trigger = resolveSendEngineTrigger({
      hasAttachments: false,
      ...makeRefs(),
      conversationsRef: makeConversations('ollama'),
      chatId: 'chat1',
    });
    expect(trigger).toBe('inline-delegation');
  });

  it('keeps the inline lane for a provider without server-side credentials — the fold is engine-only', () => {
    // Pre-lane, this fell back to null (the Orchestrator loop). The inline
    // lane is a foreground run, so browser-held Settings keys work and the
    // capability fold must not bounce the turn (#889/#890 scope change).
    vi.mocked(isProviderEngineCapable).mockReturnValue(false);
    const trigger = resolveSendEngineTrigger({
      hasAttachments: false,
      ...makeRefs(),
      conversationsRef: makeConversations('openrouter'),
      chatId: 'chat1',
    });
    expect(trigger).toBe('inline-delegation');
  });

  it('routes to the engine when background-mode is on and the provider is engine-capable', () => {
    storage.map.set(BG_KEY, '1');
    const trigger = resolveSendEngineTrigger({
      hasAttachments: false,
      ...makeRefs(),
      conversationsRef: makeConversations('ollama'),
      chatId: 'chat1',
    });
    expect(trigger).toBe('background-mode');
    expect(isProviderEngineCapable).toHaveBeenCalledWith('ollama');
  });

  it('falls back from background-mode to the inline lane when the provider lacks server-side credentials', () => {
    storage.map.set(BG_KEY, '1');
    vi.mocked(isProviderEngineCapable).mockReturnValue(false);
    const trigger = resolveSendEngineTrigger({
      hasAttachments: false,
      ...makeRefs(),
      conversationsRef: makeConversations('openrouter'),
      chatId: 'chat1',
    });
    expect(trigger).toBe('inline-delegation');
  });

  it('keeps an engine-incapable provider on the Orchestrator loop under the delegated opt-out', () => {
    storage.map.set(BG_KEY, '1');
    storage.map.set(MODE_KEY, 'delegated');
    vi.mocked(isProviderEngineCapable).mockReturnValue(false);
    const trigger = resolveSendEngineTrigger({
      hasAttachments: false,
      ...makeRefs(),
      conversationsRef: makeConversations('openrouter'),
      chatId: 'chat1',
    });
    expect(trigger).toBeNull();
  });

  it('checks capability for the chat-locked provider, not the global default', () => {
    resolveSendEngineTrigger({
      hasAttachments: false,
      ...makeRefs(),
      conversationsRef: makeConversations('openrouter'),
      chatId: 'chat1',
    });
    expect(isProviderEngineCapable).toHaveBeenCalledWith('openrouter');
  });

  it('checks capability for the global default provider on a fresh chat', () => {
    vi.mocked(getActiveProvider).mockReturnValue('zen' as never);
    resolveSendEngineTrigger({
      hasAttachments: false,
      ...makeRefs(),
      conversationsRef: { current: {} },
      chatId: null,
    });
    expect(isProviderEngineCapable).toHaveBeenCalledWith('zen');
  });

  it('honors an explicit per-send provider request over the chat lock', () => {
    resolveSendEngineTrigger({
      hasAttachments: false,
      ...makeRefs(),
      conversationsRef: makeConversations('ollama'),
      chatId: 'chat1',
      requestedProvider: 'openrouter',
    });
    expect(isProviderEngineCapable).toHaveBeenCalledWith('openrouter');
  });

  it('keeps the existing repo/branch/attachments guards (both bypass routes)', () => {
    storage.map.set(BG_KEY, '1');
    expect(
      resolveSendEngineTrigger({
        hasAttachments: true,
        ...makeRefs(),
        conversationsRef: makeConversations('ollama'),
        chatId: 'chat1',
      }),
    ).toBeNull();
    expect(
      resolveSendEngineTrigger({
        hasAttachments: false,
        ...makeRefs({ repo: null }),
        conversationsRef: makeConversations('ollama'),
        chatId: 'chat1',
      }),
    ).toBeNull();
  });
});
