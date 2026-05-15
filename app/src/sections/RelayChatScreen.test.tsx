/**
 * RelayChatScreen.test.tsx — SSR-style render coverage for the
 * Remote daemon chat shell. Mirrors LocalPcChatScreen coverage but
 * exercises the relay wrapper so Remote does not drift from the
 * shared daemon input controls.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@/hooks/useChat', () => ({
  useChat: () => ({
    messages: [],
    sendMessage: vi.fn(),
    agentStatus: { active: false, phase: '' },
    isStreaming: false,
    abortStream: vi.fn(),
    interruptedCheckpoint: null,
    resumeInterruptedRun: vi.fn(),
    dismissResume: vi.fn(),
    handleCardAction: vi.fn(),
    setLocalDaemonBinding: vi.fn(),
    setWorkspaceContext: vi.fn(),
    setWorkspaceMode: vi.fn(),
    conversations: {},
    conversationsLoaded: false,
    activeChatId: null,
    switchChat: vi.fn(),
    createNewChat: vi.fn(),
    lockedProvider: null,
    isProviderLocked: false,
    lockedModel: null,
    isModelLocked: false,
  }),
}));

vi.mock('@/hooks/useRelayDaemon', () => ({
  useRelayDaemon: () => ({
    status: { state: 'open' },
    request: vi.fn(),
    reconnect: vi.fn(),
    reconnectInfo: { attempts: 0, nextAttemptAt: null, exhausted: false, maxAttempts: 6 },
    liveBinding: null,
    replayUnavailableAt: null,
  }),
}));

vi.mock('@/lib/relay-storage', () => ({
  clearPairedRemote: vi.fn(),
}));

vi.mock('@/hooks/useModelCatalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useModelCatalog')>();
  return {
    ...actual,
    useModelCatalog: () => ({
      availableProviders: [
        ['cloudflare', 'Cloudflare Workers AI', true],
        ['openrouter', 'OpenRouter', true],
      ] as const,
      activeProviderLabel: 'cloudflare',
      setActiveBackend: vi.fn(),
      cloudflare: {
        model: '@cf/qwen/qwen3-30b-a3b-fp8',
        setModel: vi.fn(),
      },
      cloudflareModelOptions: ['@cf/qwen/qwen3-30b-a3b-fp8', '@cf/meta/llama-3-8b'],
      cloudflareModels: {
        loading: false,
        error: null,
      },
      refreshCloudflareModels: vi.fn(),
    }),
  };
});

vi.mock('@/lib/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/providers')>();
  return {
    ...actual,
    setPreferredProvider: vi.fn(),
  };
});

import { RelayChatScreen } from './RelayChatScreen';
import type { RelayBinding } from '@/types';

const binding: RelayBinding = {
  deploymentUrl: 'https://push.ishawnd.workers.dev',
  sessionId: 'remote-session-1',
  token: 'pushd_da_test_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  attachTokenId: 'pdat_test',
};

describe('RelayChatScreen', () => {
  it('renders the Remote chip and daemon provider/model controls', () => {
    const html = renderToStaticMarkup(
      <RelayChatScreen binding={binding} onLeave={() => {}} onUnpair={() => {}} />,
    );

    expect(html).toContain('Remote');
    expect(html).toContain('push.ishawnd.workers.dev');
    expect(html).toContain('aria-label="Leave remote daemon"');
    expect(html).toContain('aria-label="Daemon provider"');
    expect(html).toContain('aria-label="Select daemon model"');
    expect(html).toContain('Cloudflare Workers AI');
    expect(html).toContain('qwen3-30b-a3b-fp8');
  });
});
