/**
 * DaemonModelPicker.test.tsx — SSR-style coverage for the daemon
 * chat input's provider status chip.
 *
 * The actual model combobox is rendered next to this chip by
 * `DaemonChatBody`; this component owns only provider display and
 * provider switching.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { DaemonModelPicker } from './DaemonModelPicker';

const PROVIDERS = [
  ['cloudflare', 'Cloudflare Workers AI', true],
  ['openrouter', 'OpenRouter', true],
  ['ollama', 'Ollama', true],
] as const;

describe('DaemonModelPicker', () => {
  it('renders the active provider label in the chip', () => {
    const html = renderToStaticMarkup(
      <DaemonModelPicker
        activeProvider="cloudflare"
        availableProviders={PROVIDERS}
        onSelectProvider={vi.fn()}
      />,
    );
    expect(html).toContain('Cloudflare Workers AI');
  });

  it('falls back to the provider id when the provider is not in the ready list', () => {
    const html = renderToStaticMarkup(
      <DaemonModelPicker
        activeProvider="azure"
        availableProviders={[]}
        onSelectProvider={vi.fn()}
      />,
    );
    expect(html).toContain('azure');
  });

  it('chip displays lockedProvider when set, regardless of activeProvider', () => {
    // Codex P2 on #522: once useChat locks a chat to its original
    // provider, the chip MUST show the locked one — otherwise the
    // chip lies about which provider the next turn will use.
    const html = renderToStaticMarkup(
      <DaemonModelPicker
        activeProvider="cloudflare"
        lockedProvider="openrouter"
        isProviderLocked
        availableProviders={PROVIDERS}
        onSelectProvider={vi.fn()}
      />,
    );
    expect(html).toContain('OpenRouter');
    expect(html).not.toContain('Cloudflare Workers AI');
  });

  it('surfaces an accessible label and a title hint for the chip', () => {
    const html = renderToStaticMarkup(
      <DaemonModelPicker
        activeProvider="cloudflare"
        availableProviders={PROVIDERS}
        onSelectProvider={vi.fn()}
      />,
    );
    expect(html).toContain('aria-label="Daemon provider"');
    expect(html).toContain('title=');
  });

  // NB: the provider list, "Edit models in Settings" affordance, and
  // empty-state hint live inside a Radix Popover, which renders into
  // a portal that SSR `renderToStaticMarkup` does not include. Those
  // surfaces are covered by the runtime layer: the picker's reactive
  // wiring is exercised through chat-screen integration tests, and
  // the popover content's static structure is straightforward enough
  // that a manual-smoke pass on a real DOM catches regressions. If
  // the project later adds @testing-library/react, the popover
  // assertions can be lifted here.
});
