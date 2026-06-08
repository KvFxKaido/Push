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

export function makeExperimentalProviderStub() {
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

export function makeVertexProviderStub() {
  return {
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
    mode: 'unconfigured' as const,
    transport: 'openapi' as const,
    projectId: null,
    hasLegacyConfig: false,
    isConfigured: false,
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
    nvidia: makeProviderStub(),
    blackbox: makeProviderStub(),
    kilocode: makeProviderStub(),
    openadapter: makeProviderStub(),
    azure: makeExperimentalProviderStub(),
    bedrock: makeExperimentalProviderStub(),
    vertex: makeVertexProviderStub(),
    anthropic: makeProviderStub(),
    openai: makeProviderStub(),
    google: makeProviderStub(),
    tavily: makeProviderStub(),
    ollamaModelOptions: [],
    openRouterModelOptions: [],
    cloudflareModelOptions: opts.cloudflareModelOptions ?? [],
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
    googleModels: { loading: false, error: null, updatedAt: null },
    openaiModels: { loading: false, error: null, updatedAt: null },
    refreshOllamaModels: vi.fn(),
    refreshOpenRouterModels: vi.fn(),
    refreshCloudflareModels: vi.fn(),
    refreshZenModels: vi.fn(),
    refreshNvidiaModels: vi.fn(),
    refreshBlackboxModels: vi.fn(),
    refreshKilocodeModels: vi.fn(),
    refreshOpenAdapterModels: vi.fn(),
    refreshGoogleModels: vi.fn(),
    refreshOpenAIModels: vi.fn(),
    zenGoMode: false,
    setZenGoMode: vi.fn(),
  };
}
