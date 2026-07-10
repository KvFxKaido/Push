/**
 * model-catalog-test-stubs.ts — minimal shape stubs for the
 * `useModelCatalog` return value used by SSR-style tests that render
 * components reading the full catalog surface (e.g. the daemon shell's
 * `useWorkspaceComposerState` mount).
 *
 * `ModelCatalog` is a fat interface (~80 fields across 15 providers).
 * Test mocks only need the shape to satisfy SSR — the chips don't
 * open, the key inputs aren't typed in — so each provider gets a
 * thin stub with empty strings and `vi.fn()` placeholders.
 *
 * Co-located in `test-utils/` so daemon screen tests (and any future
 * surface that mounts the composer state) can share the same shape
 * without duplicating ~100 lines per test file.
 */
import { vi } from 'vitest';

export function makeProviderStub(model = '') {
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

/**
 * Build a complete `useModelCatalog`-shaped object with Cloudflare set
 * as the active provider. Pass `cloudflareModel` to control the model
 * the daemon picker chip will display. Other providers get inert
 * stubs.
 */
export function makeDaemonModelCatalogStub(opts: {
  cloudflareModel: string;
  cloudflareModelOptions?: string[];
}) {
  return {
    availableProviders: [
      ['cloudflare', 'Cloudflare Workers AI', true],
      ['openrouter', 'OpenRouter', true],
    ] as const,
    activeProviderLabel: 'cloudflare' as const,
    activeBackend: 'cloudflare' as const,
    setActiveBackend: vi.fn(),
    setPreferredProvider: vi.fn(),
    clearPreferredProvider: vi.fn(),
    ollama: makeProviderStub(),
    openRouter: makeProviderStub(),
    cloudflare: {
      ...makeProviderStub(opts.cloudflareModel),
      configured: true,
      statusLoading: false,
      statusError: null,
    },
    zen: makeProviderStub(),
    zai: makeProviderStub(),
    nvidia: makeProviderStub(),
    fireworks: makeProviderStub(),
    sakana: makeProviderStub(),
    deepseek: makeProviderStub(),
    anthropic: makeProviderStub(),
    openai: makeProviderStub(),
    xai: makeProviderStub(),
    google: makeProviderStub(),
    tavily: makeProviderStub(),
    ollamaModelOptions: [],
    openRouterModelOptions: [],
    cloudflareModelOptions: opts.cloudflareModelOptions ?? [],
    zenModelOptions: [],
    zaiModelOptions: [],
    nvidiaModelOptions: [],
    fireworksModelOptions: [],
    sakanaModelOptions: [],
    deepseekModelOptions: [],
    anthropicModelOptions: [],
    openaiModelOptions: [],
    xaiModelOptions: [],
    googleModelOptions: [],
    ollamaModels: { loading: false, error: null, updatedAt: null },
    openRouterModels: { loading: false, error: null, updatedAt: null },
    cloudflareModels: { loading: false, error: null, updatedAt: null },
    zenModels: { loading: false, error: null, updatedAt: null },
    zaiModels: { loading: false, error: null, updatedAt: null },
    nvidiaModels: { loading: false, error: null, updatedAt: null },
    fireworksModels: { loading: false, error: null, updatedAt: null },
    sakanaModels: { loading: false, error: null, updatedAt: null },
    deepseekModels: { loading: false, error: null, updatedAt: null },
    googleModels: { loading: false, error: null, updatedAt: null },
    openaiModels: { loading: false, error: null, updatedAt: null },
    xaiModels: { loading: false, error: null, updatedAt: null },
    refreshOllamaModels: vi.fn(),
    refreshOpenRouterModels: vi.fn(),
    refreshCloudflareModels: vi.fn(),
    refreshZenModels: vi.fn(),
    refreshZaiModels: vi.fn(),
    refreshNvidiaModels: vi.fn(),
    refreshFireworksModels: vi.fn(),
    refreshSakanaModels: vi.fn(),
    refreshDeepSeekModels: vi.fn(),
    refreshGoogleModels: vi.fn(),
    refreshOpenAIModels: vi.fn(),
    refreshXAIModels: vi.fn(),
    zenGoMode: false,
    setZenGoMode: vi.fn(),
  };
}
