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
import { describe, expect, it, vi } from 'vitest';
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

vi.mock('@/hooks/useLocalDaemon', () => ({
  useLocalDaemon: () => ({
    status: { state: 'open', reason: null },
    events: [],
    request: vi.fn(),
    reconnect: vi.fn(),
  }),
}));

vi.mock('@/lib/local-pc-storage', () => ({
  clearPairedDevice: vi.fn(),
}));

import { LocalPcChatScreen } from './LocalPcChatScreen';
import type { LocalPcBinding } from '@/types';

const binding: LocalPcBinding = {
  port: 49152,
  token: 'pushd_test_token_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  boundOrigin: 'http://localhost:5173',
};

describe('LocalPcChatScreen', () => {
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
});
