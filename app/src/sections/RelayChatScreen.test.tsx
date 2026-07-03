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

// Catalog stub shape lives in test-utils so LocalPcChatScreen test
// can share it; see that module for rationale.
vi.mock('@/hooks/useModelCatalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useModelCatalog')>();
  const { makeDaemonModelCatalogStub } = await import('@/test-utils/model-catalog-test-stubs');
  return {
    ...actual,
    useModelCatalog: () =>
      makeDaemonModelCatalogStub({
        cloudflareModel: '@cf/qwen/qwen3-30b-a3b-fp8',
        cloudflareModelOptions: ['@cf/qwen/qwen3-30b-a3b-fp8', '@cf/meta/llama-3-8b'],
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
  tokenKind: 'none',
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
    // Leave/Unpair/Customize moved into the drawer's daemonActions footer
    // so the header row matches repo mode's shape (aside from the mode
    // chip and the absent sandbox chip). Not asserted here: the drawer's
    // Sheet only renders its Portal content when open, and this suite runs
    // in the `node` vitest environment (no jsdom), so opening it isn't
    // exercisable from this test — verified manually in the browser instead.
    expect(html).toContain('aria-label="Open hub"');
    // ChatInput's "Backend and model" pill is now built from the daemon's
    // own reported provider/model (useDaemonSessionModel), not the client
    // -local useModelCatalog stub — Remote's picker should show what the
    // paired session is actually running, not a browser preference with no
    // relation to it. That daemon state is fetched via `useEffect` (a
    // get_session_snapshot + list_providers round-trip), which never runs
    // under `renderToStaticMarkup` (SSR has no commit phase), so the pill
    // is legitimately absent here — this matches real first-paint behavior
    // before the round-trip resolves. Covered instead by
    // useDaemonSessionModel.test.ts's payload-parser tests; interactive
    // coverage needs jsdom, which this suite doesn't have (see the drawer
    // footer note above).
    expect(html).not.toContain('title="Backend and model"');
  });
});
