/**
 * Tests for `resolveSendEngineTrigger` — the engine-vs-foreground routing
 * decision, including the provider engine-capability fold: a provider whose
 * key exists only in in-app Settings (browser-held) must keep the turn on the
 * foreground loop, because the CoderJob DO authenticates with Worker-held
 * credentials only.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type React from 'react';
import type { Conversation } from '@/types';

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
  // No storage mock needed: safe-storage returns null in the node test
  // environment, which resolves delegation-mode to its `inline` default —
  // exactly the route this suite pins.
  vi.mocked(isProviderEngineCapable).mockReturnValue(true);
  vi.mocked(getActiveProvider).mockReturnValue('ollama' as never);
});

describe('resolveSendEngineTrigger', () => {
  it('routes to the engine by default (inline) when repo, branch, and capability hold', () => {
    const trigger = resolveSendEngineTrigger({
      hasAttachments: false,
      ...makeRefs(),
      conversationsRef: makeConversations('ollama'),
      chatId: 'chat1',
    });
    expect(trigger).toBe('inline-delegation');
    expect(isProviderEngineCapable).toHaveBeenCalledWith('ollama');
  });

  it('falls back to the foreground loop when the provider lacks server-side credentials', () => {
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

  it('keeps the existing repo/branch/attachments guards', () => {
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
