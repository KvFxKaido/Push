/**
 * DaemonModelPicker.test.tsx — SSR-style coverage for the daemon
 * chat input's provider/model status chip.
 *
 * `getModelForRole` is mocked so the test doesn't depend on a fully
 * populated provider catalog; the picker's responsibility is to
 * RENDER what the catalog tells it (current provider + model leaf)
 * and to surface the available providers as switchable rows. The
 * orchestrator-routing internals are exercised in their own tests.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@/lib/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/providers')>();
  return {
    ...actual,
    // The picker reads `getModelForRole(provider, 'orchestrator')` for
    // the chip's model leaf. Return a deterministic shape so the
    // assertion below ("@cf/meta/llama-3-8b" leaf) is stable.
    getModelForRole: vi.fn((provider: string, role: string) => {
      if (role !== 'orchestrator') return undefined;
      if (provider === 'cloudflare') return { id: '@cf/meta/llama-3-8b' };
      if (provider === 'openrouter') return { id: 'meta-llama/llama-3.1-70b-instruct' };
      return undefined;
    }),
  };
});

import { DaemonModelPicker } from './DaemonModelPicker';

const PROVIDERS = [
  ['cloudflare', 'Cloudflare Workers AI', true],
  ['openrouter', 'OpenRouter', true],
  ['ollama', 'Ollama', true],
] as const;

describe('DaemonModelPicker', () => {
  it('renders the active provider label and the model leaf in the chip', () => {
    const html = renderToStaticMarkup(
      <DaemonModelPicker
        activeProvider="cloudflare"
        availableProviders={PROVIDERS}
        onSelectProvider={vi.fn()}
      />,
    );
    expect(html).toContain('Cloudflare Workers AI');
    // `getModelDisplayLeafName` strips the `@cf/meta/` prefix —
    // the leaf is the part the user actually recognizes.
    expect(html).toContain('llama-3-8b');
  });

  it('omits the model leaf gracefully when no model is configured', () => {
    const html = renderToStaticMarkup(
      <DaemonModelPicker
        activeProvider="ollama"
        availableProviders={PROVIDERS}
        onSelectProvider={vi.fn()}
      />,
    );
    // ollama returns undefined from the mock — chip falls back to
    // provider label only.
    expect(html).toContain('Ollama');
  });

  it('chip displays lockedProvider when set, regardless of activeProvider', () => {
    // Codex P2 on #522: once useChat locks a chat to its original
    // provider, the chip MUST show the locked one — otherwise the
    // chip lies about which provider the next turn will use.
    // `getModelForRole` mock returns the openrouter model for the
    // locked provider; that's the one the chip should render.
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
    expect(html).toContain('llama-3.1-70b-instruct');
    // The cloudflare model from the mock must NOT appear when locked
    // to openrouter — that would be the deceiving behavior.
    expect(html).not.toContain('llama-3-8b');
  });

  it('surfaces an accessible label and a title hint for the chip', () => {
    const html = renderToStaticMarkup(
      <DaemonModelPicker
        activeProvider="cloudflare"
        availableProviders={PROVIDERS}
        onSelectProvider={vi.fn()}
      />,
    );
    expect(html).toContain('aria-label="Daemon model and provider"');
    // The hover hint surfaces the full model id so power users can
    // disambiguate when multiple models share a leaf.
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
