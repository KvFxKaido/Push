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
    agentEvents: [],
    runEvents: [],
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
    conversationsLoaded: true,
    activeChatId: 'chat-1',
    switchChat: vi.fn(),
    createNewChat: vi.fn(),
    deleteChat: vi.fn(),
    renameChat: vi.fn(),
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

// See the matching helper in LocalPcChatScreen.test.tsx — daemon now
// mounts useWorkspaceComposerState, which reads `model` for every
// provider. Stub each provider config so SSR doesn't crash on the
// pickers it can't reach in this test.
function makeProviderStub(model = '') {
  return {
    model,
    setModel: vi.fn(),
    hasKey: false,
    keyInput: '',
    setKeyInput: vi.fn(),
    setKey: vi.fn(),
    clearKey: vi.fn(),
  };
}

function makeExperimentalStub() {
  return {
    ...makeProviderStub(),
    baseUrl: '',
    baseUrlInput: '',
    setBaseUrlInput: vi.fn(),
    baseUrlError: null,
    setBaseUrl: vi.fn(),
    clearBaseUrl: vi.fn(),
    modelInput: '',
    setModelInput: vi.fn(),
    clearModel: vi.fn(),
    deployments: [],
    activeDeploymentId: null,
    saveDeployment: vi.fn(),
    selectDeployment: vi.fn(),
    removeDeployment: vi.fn(),
    clearDeployments: vi.fn(),
    deploymentLimitReached: false,
    isConfigured: false,
  };
}

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
      activeBackend: 'cloudflare',
      setActiveBackend: vi.fn(),
      setPreferredProvider: vi.fn(),
      clearPreferredProvider: vi.fn(),
      ollama: makeProviderStub(),
      openRouter: makeProviderStub(),
      cloudflare: {
        ...makeProviderStub('@cf/qwen/qwen3-30b-a3b-fp8'),
        configured: true,
        statusLoading: false,
        statusError: null,
      },
      zen: makeProviderStub(),
      nvidia: makeProviderStub(),
      blackbox: makeProviderStub(),
      kilocode: makeProviderStub(),
      openadapter: makeProviderStub(),
      azure: makeExperimentalStub(),
      bedrock: makeExperimentalStub(),
      vertex: {
        ...makeProviderStub(),
        keyError: null,
        region: '',
        regionInput: '',
        setRegionInput: vi.fn(),
        regionError: null,
        setRegion: vi.fn(),
        clearRegion: vi.fn(),
        modelInput: '',
        setModelInput: vi.fn(),
        modelOptions: [],
        clearModel: vi.fn(),
        mode: 'unconfigured',
        transport: 'openapi',
        projectId: null,
        hasLegacyConfig: false,
        isConfigured: false,
      },
      anthropic: makeProviderStub(),
      openai: makeProviderStub(),
      google: makeProviderStub(),
      tavily: makeProviderStub(),
      ollamaModelOptions: [],
      openRouterModelOptions: [],
      cloudflareModelOptions: ['@cf/qwen/qwen3-30b-a3b-fp8', '@cf/meta/llama-3-8b'],
      zenModelOptions: [],
      nvidiaModelOptions: [],
      blackboxModelOptions: [],
      kilocodeModelOptions: [],
      openAdapterModelOptions: [],
      anthropicModelOptions: [],
      openaiModelOptions: [],
      googleModelOptions: [],
      ollamaModels: { loading: false, error: null, updatedAt: null },
      openRouterModels: { loading: false, error: null, updatedAt: null },
      cloudflareModels: { loading: false, error: null, updatedAt: null },
      zenModels: { loading: false, error: null, updatedAt: null },
      nvidiaModels: { loading: false, error: null, updatedAt: null },
      blackboxModels: { loading: false, error: null, updatedAt: null },
      kilocodeModels: { loading: false, error: null, updatedAt: null },
      openAdapterModels: { loading: false, error: null, updatedAt: null },
      refreshOllamaModels: vi.fn(),
      refreshOpenRouterModels: vi.fn(),
      refreshCloudflareModels: vi.fn(),
      refreshZenModels: vi.fn(),
      refreshNvidiaModels: vi.fn(),
      refreshBlackboxModels: vi.fn(),
      refreshKilocodeModels: vi.fn(),
      refreshOpenAdapterModels: vi.fn(),
      zenGoMode: false,
      setZenGoMode: vi.fn(),
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
import type { RelayBinding, WorkspaceScreenAuthProps } from '@/types';

const binding: RelayBinding = {
  deploymentUrl: 'https://push.ishawnd.workers.dev',
  sessionId: 'remote-session-1',
  token: 'pushd_da_test_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  attachTokenId: 'pdat_test',
};

// Minimal auth surface — the daemon shell forwards this into the hub
// Settings tab. The SSR test doesn't open the hub so the values just
// need to satisfy the type, not exercise the Settings UI.
const auth: WorkspaceScreenAuthProps = {
  token: null,
  patToken: null,
  validatedUser: null,
  isAppAuth: false,
  installationId: null,
  appLoading: false,
  appError: null,
  connectApp: () => {},
  installApp: () => {},
  setInstallationIdManually: async () => false,
};
const onDisconnect = () => {};

describe('RelayChatScreen', () => {
  it('renders the Remote chip and daemon provider/model controls', () => {
    const html = renderToStaticMarkup(
      <RelayChatScreen
        binding={binding}
        onLeave={() => {}}
        onUnpair={() => {}}
        auth={auth}
        onDisconnect={onDisconnect}
      />,
    );

    expect(html).toContain('Remote');
    expect(html).toContain('push.ishawnd.workers.dev');
    expect(html).toContain('aria-label="Leave remote daemon"');
    // ChatInput now drives the daemon input — same provider+model
    // affordances as repo/chat mode. The chip surfaces the active
    // provider's model name; the catalog mock pins `cloudflare` +
    // `@cf/qwen/qwen3-30b-a3b-fp8`.
    expect(html).toContain('title="Backend and model"');
    expect(html).toContain('qwen3-30b-a3b-fp8');
  });
});
