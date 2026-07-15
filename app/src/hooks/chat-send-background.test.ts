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
vi.mock('@/lib/sandbox-client', () => ({
  getSandboxOwnerToken: vi.fn(() => 'owner-token'),
}));
vi.mock('@/hooks/useUserProfile', () => ({
  getUserProfile: vi.fn(() => null),
}));

import { getActiveProvider } from '@/lib/orchestrator';
import { isProviderEngineCapable } from '@/lib/provider-engine-capability';
import {
  hasActiveBackgroundJob,
  resolveSendEngineTrigger,
  startBackgroundMainChatTurn,
} from './chat-send-background';

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
      ...makeRefs(),
      conversationsRef: makeConversations('openrouter'),
      chatId: 'chat1',
    });
    expect(trigger).toBe('inline-delegation');
  });

  it('routes to the engine when background-mode is on and the provider is engine-capable', () => {
    storage.map.set(BG_KEY, '1');
    const trigger = resolveSendEngineTrigger({
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
      ...makeRefs(),
      conversationsRef: makeConversations('openrouter'),
      chatId: 'chat1',
    });
    expect(trigger).toBeNull();
  });

  it('checks capability for the chat-locked provider, not the global default', () => {
    resolveSendEngineTrigger({
      ...makeRefs(),
      conversationsRef: makeConversations('openrouter'),
      chatId: 'chat1',
    });
    expect(isProviderEngineCapable).toHaveBeenCalledWith('openrouter');
  });

  it('checks capability for the global default provider on a fresh chat', () => {
    vi.mocked(getActiveProvider).mockReturnValue('zen' as never);
    resolveSendEngineTrigger({
      ...makeRefs(),
      conversationsRef: { current: {} },
      chatId: null,
    });
    expect(isProviderEngineCapable).toHaveBeenCalledWith('zen');
  });

  it('honors an explicit per-send provider request over the chat lock', () => {
    resolveSendEngineTrigger({
      ...makeRefs(),
      conversationsRef: makeConversations('ollama'),
      chatId: 'chat1',
      requestedProvider: 'openrouter',
    });
    expect(isProviderEngineCapable).toHaveBeenCalledWith('openrouter');
  });

  it('keeps the existing repo/branch guard for both bypass routes', () => {
    storage.map.set(BG_KEY, '1');
    expect(
      resolveSendEngineTrigger({
        ...makeRefs({ repo: null }),
        conversationsRef: makeConversations('ollama'),
        chatId: 'chat1',
      }),
    ).toBeNull();
  });

  it('routes a clearly-conversational repo turn to the inline lane by default', () => {
    const routeEvents: unknown[] = [];
    expect(
      resolveSendEngineTrigger({
        ...makeRefs(),
        conversationsRef: makeConversations('ollama'),
        chatId: 'chat1',
        messageText: 'what changed recently in Push?',
        onRouteEvent: (event) => routeEvents.push(event),
      }),
    ).toBe('inline-delegation');
    expect(routeEvents).toEqual([
      {
        type: 'turn.route',
        route: 'inline-delegation',
        reason: 'conversational_inline',
        intent: 'conversational',
        repoBranchReady: true,
      },
    ]);
  });

  it('keeps a clearly-conversational no-repo turn on the Orchestrator loop', () => {
    const routeEvents: unknown[] = [];
    expect(
      resolveSendEngineTrigger({
        ...makeRefs({ repo: null }),
        conversationsRef: makeConversations('ollama'),
        chatId: 'chat1',
        messageText: 'what changed recently in Push?',
        onRouteEvent: (event) => routeEvents.push(event),
      }),
    ).toBeNull();
    expect(routeEvents).toEqual([]);
  });

  it('keeps the delegated opt-out on the Orchestrator loop for conversational repo turns', () => {
    const routeEvents: unknown[] = [];
    storage.map.set(MODE_KEY, 'delegated');
    expect(
      resolveSendEngineTrigger({
        ...makeRefs(),
        conversationsRef: makeConversations('ollama'),
        chatId: 'chat1',
        messageText: 'what changed recently in Push?',
        onRouteEvent: (event) => routeEvents.push(event),
      }),
    ).toBeNull();
    expect(routeEvents).toEqual([]);
  });

  it('keeps a coding-intent turn on the inline lane', () => {
    expect(
      resolveSendEngineTrigger({
        ...makeRefs(),
        conversationsRef: makeConversations('ollama'),
        chatId: 'chat1',
        messageText: 'fix the failing reviewer test',
      }),
    ).toBe('inline-delegation');
  });

  it('keeps an attachment-bearing turn on the inline lane even with conversational text', () => {
    expect(
      resolveSendEngineTrigger({
        ...makeRefs(),
        conversationsRef: makeConversations('ollama'),
        chatId: 'chat1',
        messageText: 'what is this?',
        hasAttachments: true,
      }),
    ).toBe('inline-delegation');
  });

  it('still detaches a conversational turn to the engine when background-mode is on', () => {
    const routeEvents: unknown[] = [];
    // The conversational gate only relaxes the inline route; an explicit
    // background-mode detach still wins (it's the more specific intent).
    storage.map.set(BG_KEY, '1');
    expect(
      resolveSendEngineTrigger({
        ...makeRefs(),
        conversationsRef: makeConversations('ollama'),
        chatId: 'chat1',
        messageText: 'what changed recently?',
        onRouteEvent: (event) => routeEvents.push(event),
      }),
    ).toBe('background-mode');
    expect(routeEvents).toEqual([]);
  });
});

describe('startBackgroundMainChatTurn', () => {
  it('carries current-turn attachments in the delegation envelope', async () => {
    const attachment = {
      id: 'img-1',
      type: 'image' as const,
      filename: 'screen.png',
      mimeType: 'image/png',
      sizeBytes: 3,
      content: 'data:image/png;base64,abc123',
    };
    const startMainChatJob = vi.fn(async () => ({ ok: true as const, jobId: 'job-1' }));

    const result = await startBackgroundMainChatTurn({
      chatId: 'chat1',
      trimmedText: 'inspect this screenshot',
      attachments: [attachment],
      lockedProvider: 'ollama',
      resolvedModel: 'model-x',
      refs: {
        sandboxIdRef: { current: 'sb-1' },
        repoRef: { current: 'owner/repo' },
        branchInfoRef: { current: { currentBranch: 'main', defaultBranch: 'main' } },
        isMainProtectedRef: { current: true },
        agentsMdRef: { current: 'AGENTS' },
        instructionFilenameRef: { current: 'AGENTS.md' },
      },
      backgroundCoderJob: {
        startMainChatJob,
        startJob: vi.fn(),
        cancelJob: vi.fn(),
        formatPlaceholderText: vi.fn(),
      } as never,
    });

    expect(result).toEqual({ ok: true, jobId: 'job-1' });
    expect(startMainChatJob).toHaveBeenCalledWith(
      expect.objectContaining({
        envelope: expect.objectContaining({
          task: 'inspect this screenshot',
          attachments: [attachment],
        }),
      }),
    );
  });
});

describe('hasActiveBackgroundJob', () => {
  function convWith(status: string): Conversation {
    return {
      id: 'chat-1',
      title: 't',
      messages: [],
      createdAt: 1,
      lastMessageAt: 1,
      pendingJobIds: {
        'job-1': { jobId: 'job-1', status, lastEventId: null, startedAt: 1, updatedAt: 1 },
      },
    } as unknown as Conversation;
  }

  it('counts queued / running / suspended jobs as active', () => {
    expect(hasActiveBackgroundJob(convWith('queued'))).toBe(true);
    expect(hasActiveBackgroundJob(convWith('running'))).toBe(true);
    // A job parked awaiting guidance holds an older checkpoint — a new send must
    // be blocked so the eventual resume doesn't race newer chat work.
    expect(hasActiveBackgroundJob(convWith('suspended'))).toBe(true);
  });

  it('does not count terminal jobs or empty conversations as active', () => {
    expect(hasActiveBackgroundJob(convWith('completed'))).toBe(false);
    expect(hasActiveBackgroundJob(convWith('failed'))).toBe(false);
    expect(hasActiveBackgroundJob(convWith('cancelled'))).toBe(false);
    expect(hasActiveBackgroundJob(undefined)).toBe(false);
  });
});
