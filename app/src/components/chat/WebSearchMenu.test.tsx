import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@/hooks/useTavilyConfig', () => ({ getTavilyKey: () => null }));
vi.mock('@/hooks/useGoogleConfig', () => ({ getGoogleKey: () => null }));
vi.mock('@/hooks/useOllamaConfig', () => ({ getOllamaKey: () => null }));
vi.mock('@/lib/orchestrator-provider-routing', () => ({
  getActiveProvider: () => 'anthropic',
}));

// Test env is `node` (no DOM/localStorage). Mock the mode helpers directly so
// the trigger renders the controlled value.
let storedMode: 'off' | 'auto' | 'tavily' | 'google-grounding' | 'duckduckgo' | 'ollama' = 'auto';
vi.mock('@/lib/web-search-mode', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/web-search-mode')>('@/lib/web-search-mode');
  return {
    ...actual,
    getWebSearchMode: () => storedMode,
    setWebSearchMode: (m: typeof storedMode) => {
      storedMode = m;
    },
  };
});

import { WebSearchMenu } from './WebSearchMenu';

describe('WebSearchMenu', () => {
  it('renders the Globe trigger labelled with the current mode', () => {
    storedMode = 'tavily';
    const html = renderToStaticMarkup(<WebSearchMenu triggerClassName="trigger" />);
    expect(html).toContain('Web search: Tavily');
  });

  it('reflects "off" in the trigger label', () => {
    storedMode = 'off';
    const html = renderToStaticMarkup(<WebSearchMenu triggerClassName="trigger" />);
    expect(html).toContain('Web search: Off');
  });

  it('reflects "auto" in the trigger label', () => {
    storedMode = 'auto';
    const html = renderToStaticMarkup(<WebSearchMenu triggerClassName="trigger" />);
    expect(html).toContain('Web search: Auto');
  });
});
