/**
 * LocalPcChatScreen.test.tsx — SSR-style render coverage for the
 * local-pc chat shell. Matches the testing style used elsewhere in
 * `app/src/sections/*.test.tsx` (renderToStaticMarkup, node env).
 *
 * Behavior that depends on a live DOM (button clicks driving
 * `setLocalDaemonBinding`, sendMessage round-trips, Stop calling
 * abortStream) is covered at the runtime layer:
 *   - `app/src/lib/web-tool-execution-runtime.test.ts` pins that a
 *     local-daemon binding in the runtime context routes through
 *     `executeSandboxToolCall`'s daemon fork.
 *   - `app/src/lib/sandbox-tools.test.ts` pins each tool's dispatch
 *     fork (read/write/list/diff/exec).
 *
 * What this file asserts: the chat shell renders the expected static
 * affordances and tolerates the SSR-time state (no daemon connection,
 * no messages yet).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// useChat / useLocalDaemon both touch storage (IndexedDB, conversation
// loaders) and WebSocket constructors that don't exist in node. Mock
// them to return inert state so the SSR render exercises ONLY the
// JSX structure under test.
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
    setWorkspaceMode: vi.fn(),
  }),
}));

// Mutable status holder so individual tests can override the default
// `open` state (e.g. to exercise the reconnect banner). `vi.mock` runs
// before imports, so the mock factory references the holder by name
// at module level and reads it lazily inside the hook body.
const useLocalDaemonState: {
  status: { state: string; code?: number; reason?: string };
  reconnectInfo: {
    attempts: number;
    nextAttemptAt: number | null;
    exhausted: boolean;
    maxAttempts: number;
  };
} = {
  status: { state: 'open' },
  reconnectInfo: { attempts: 0, nextAttemptAt: null, exhausted: false, maxAttempts: 6 },
};

vi.mock('@/hooks/useLocalDaemon', () => ({
  useLocalDaemon: () => ({
    status: useLocalDaemonState.status,
    events: [],
    request: vi.fn(),
    reconnect: vi.fn(),
    reconnectInfo: useLocalDaemonState.reconnectInfo,
  }),
}));

vi.mock('@/lib/local-pc-storage', () => ({
  clearPairedDevice: vi.fn(),
}));

// useModelCatalog touches storage + provider configs that aren't
// available in the SSR test env. Return just the subset the local-pc
// chat reads — `availableProviders`, `activeProviderLabel`, and
// `setActiveBackend` — so the picker chip renders without booting
// the full catalog.
vi.mock('@/hooks/useModelCatalog', () => ({
  useModelCatalog: () => ({
    availableProviders: [
      ['cloudflare', 'Cloudflare Workers AI', true],
      ['openrouter', 'OpenRouter', true],
    ] as const,
    activeProviderLabel: 'cloudflare',
    setActiveBackend: vi.fn(),
  }),
}));

vi.mock('@/lib/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/providers')>();
  return {
    ...actual,
    setPreferredProvider: vi.fn(),
    getModelForRole: vi.fn(() => ({ id: '@cf/meta/llama-3-8b' })),
  };
});

import { LocalPcChatScreen } from './LocalPcChatScreen';
import type { LocalPcBinding } from '@/types';

const binding: LocalPcBinding = {
  port: 49152,
  token: 'pushd_test_token_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  boundOrigin: 'http://localhost:5173',
};

describe('LocalPcChatScreen', () => {
  beforeEach(() => {
    // Reset the shared hook state between cases — vi.mock is hoisted
    // once per module, so a test that flips it (e.g. unreachable +
    // banner) would leak into later cases without this reset.
    useLocalDaemonState.status = { state: 'open' };
    useLocalDaemonState.reconnectInfo = {
      attempts: 0,
      nextAttemptAt: null,
      exhausted: false,
      maxAttempts: 6,
    };
  });

  it('renders the mode chip with the binding port', () => {
    const html = renderToStaticMarkup(<LocalPcChatScreen binding={binding} onUnpair={() => {}} />);
    // LocalPcModeChip renders the port — verify it's wired in.
    expect(html).toContain(':49152');
    // "Local PC" label is the chip's prefix.
    expect(html).toContain('Local PC');
  });

  it('renders an Unpair button with an accessible label', () => {
    const html = renderToStaticMarkup(<LocalPcChatScreen binding={binding} onUnpair={() => {}} />);
    expect(html).toContain('aria-label="Unpair"');
    expect(html).toContain('Unpair');
  });

  it('renders the compose textarea and send button', () => {
    const html = renderToStaticMarkup(<LocalPcChatScreen binding={binding} onUnpair={() => {}} />);
    expect(html).toContain('<textarea');
    expect(html).toContain('aria-label="Message"');
    expect(html).toContain('aria-label="Send"');
  });

  it('does NOT render a Stop button when not streaming (default mock state)', () => {
    // The Stop button is conditional on isStreaming. Default mock returns
    // false, so it should be absent — Unpair is the only header button.
    const html = renderToStaticMarkup(<LocalPcChatScreen binding={binding} onUnpair={() => {}} />);
    expect(html).not.toContain('aria-label="Stop"');
  });

  it('shows an "Ask the local daemon" placeholder when the WS is open', () => {
    const html = renderToStaticMarkup(<LocalPcChatScreen binding={binding} onUnpair={() => {}} />);
    expect(html).toContain('Ask the local daemon');
  });

  it('omits cloud-shaped affordances (no Sandbox / Branch / FileBrowser UI)', () => {
    // Regression guard: the new screen should not pull in cloud-specific
    // chrome. If a future refactor accidentally routes a sandbox-aware
    // component through here, the mention of these terms surfaces it.
    const html = renderToStaticMarkup(<LocalPcChatScreen binding={binding} onUnpair={() => {}} />);
    expect(html).not.toContain('FileBrowser');
    expect(html).not.toContain('Snapshot');
  });

  it('shows a reconnecting banner with countdown while auto-retry is pending', () => {
    // Simulate the hook reporting an active backoff: status went
    // unreachable after one failed open, the scheduler queued retry
    // #1 (1s into the future), and attempts=1 since the retry has
    // been scheduled. The banner reads attempts directly — it's the
    // retry number currently pending.
    useLocalDaemonState.status = { state: 'unreachable', code: 1006, reason: 'refused' };
    useLocalDaemonState.reconnectInfo = {
      attempts: 1,
      nextAttemptAt: Date.now() + 1_000,
      exhausted: false,
      maxAttempts: 6,
    };
    const html = renderToStaticMarkup(<LocalPcChatScreen binding={binding} onUnpair={() => {}} />);
    expect(html).toMatch(/Reconnecting to local daemon in \ds/);
    expect(html).toContain('attempt 1 of 6');
  });

  it('shows a reconnecting banner for post-open `closed` (mid-session drop)', () => {
    // Pin the closed-state reconnect path (Phase 1.f review feedback):
    // the most common drop is a successful open followed by a
    // network/daemon failure — the adapter reports that as
    // `state: 'closed'` with an abnormal code, NOT `unreachable`.
    // The banner must still render the live retry countdown.
    useLocalDaemonState.status = { state: 'closed', code: 1006, reason: 'abnormal closure' };
    useLocalDaemonState.reconnectInfo = {
      attempts: 2,
      nextAttemptAt: Date.now() + 2_000,
      exhausted: false,
      maxAttempts: 6,
    };
    const html = renderToStaticMarkup(<LocalPcChatScreen binding={binding} onUnpair={() => {}} />);
    expect(html).toContain('Reconnecting to local daemon');
    expect(html).toContain('attempt 2 of 6');
  });

  it('shows a Retry button once auto-reconnect is exhausted', () => {
    // After 6 unreachables, the hook flips `exhausted: true` and clears
    // the schedule. The banner surfaces a manual Retry button — the
    // mode chip alone wouldn't make the failure recoverable from the
    // chat surface.
    useLocalDaemonState.status = { state: 'unreachable', code: 1006, reason: 'refused' };
    useLocalDaemonState.reconnectInfo = {
      attempts: 6,
      nextAttemptAt: null,
      exhausted: true,
      maxAttempts: 6,
    };
    const html = renderToStaticMarkup(<LocalPcChatScreen binding={binding} onUnpair={() => {}} />);
    expect(html).toContain('aria-label="Retry connection"');
    expect(html).toContain('after 6 attempts');
  });

  it('omits the reconnect banner while the WS is open', () => {
    // Default `status: open` — no banner, no extra chrome. The header
    // is the only thing above the chat container.
    const html = renderToStaticMarkup(<LocalPcChatScreen binding={binding} onUnpair={() => {}} />);
    expect(html).not.toContain('Reconnecting to local daemon');
    expect(html).not.toContain('aria-label="Retry connection"');
  });

  it('renders the model picker chip in the input area with the active provider', () => {
    // The chip is the surface that finally tells the user which
    // provider + model they're talking to on local-pc — before this,
    // the local-pc chat silently inherited the cloud orchestrator's
    // last selection. The catalog mock pins `cloudflare` + the
    // `@cf/meta/llama-3-8b` model.
    const html = renderToStaticMarkup(<LocalPcChatScreen binding={binding} onUnpair={() => {}} />);
    expect(html).toContain('aria-label="Local PC model and provider"');
    expect(html).toContain('Cloudflare Workers AI');
    expect(html).toContain('llama-3-8b');
  });

  it('omits the approval prompt when no approval_required events have arrived', () => {
    // Phase 3 slice 4: the prompt is dormant until the daemon emits
    // `approval_required`. The mock useLocalDaemon doesn't replay
    // events, so the queue stays empty and the prompt renders as
    // null. A future test harness that drives a real onEvent
    // callback would assert the populated path; SSR can't drive
    // useState updates from outside the component tree.
    const html = renderToStaticMarkup(<LocalPcChatScreen binding={binding} onUnpair={() => {}} />);
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('aria-label="Approve"');
    expect(html).not.toContain('aria-label="Deny"');
  });
});
