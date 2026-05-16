import { useState, useCallback, useMemo, useEffect } from 'react';
import {
  CLOUDFLARE_MODELS,
  getPreferredProvider,
  getCloudflareModelName,
  getCloudflareWorkerConfigured,
  setPreferredProvider,
  setCloudflareModelName,
  setCloudflareWorkerConfigured,
  clearPreferredProvider,
  OPENROUTER_MODELS,
  ZEN_MODELS,
  ZEN_GO_MODELS,
  NVIDIA_MODELS,
  BLACKBOX_MODELS,
  KILOCODE_DEFAULT_MODEL,
  KILOCODE_MODELS,
  OPENADAPTER_MODELS,
  normalizeKilocodeModelName,
  type PreferredProvider,
} from '@/lib/providers';
import { getActiveProvider, type ActiveProvider } from '@/lib/orchestrator';
import { resolveApiUrl } from '@/lib/api-url';
import {
  fetchCloudflareModels,
  fetchOllamaModels,
  fetchOpenRouterModels,
  fetchZenModels,
  fetchNvidiaModels,
  fetchBlackboxModels,
  fetchKilocodeModels,
  fetchOpenAdapterModels,
} from '@/lib/model-catalog';
import { useOllamaConfig } from '@/hooks/useOllamaConfig';
import { useOpenRouterConfig } from '@/hooks/useOpenRouterConfig';
import { useAnthropicConfig } from '@/hooks/useAnthropicConfig';
import { useOpenAIConfig } from '@/hooks/useOpenAIConfig';
import { useGoogleConfig } from '@/hooks/useGoogleConfig';
import { ANTHROPIC_MODELS, GOOGLE_MODELS, OPENAI_MODELS } from '@push/lib/provider-models';
import { useZenConfig } from '@/hooks/useZenConfig';
import { useNvidiaConfig } from '@/hooks/useNvidiaConfig';
import { useBlackboxConfig } from '@/hooks/useBlackboxConfig';
import { useKilocodeConfig } from '@/hooks/useKilocodeConfig';
import { useOpenAdapterConfig } from '@/hooks/useOpenAdapterConfig';
import { useAzureConfig, useBedrockConfig } from '@/hooks/useExperimentalProviderConfig';
import { useTavilyConfig } from '@/hooks/useTavilyConfig';
import type { ExperimentalDeployment } from '@/lib/experimental-providers';
import { useVertexConfig, type VertexConfiguredMode } from '@/hooks/useVertexConfig';
import { shouldAutoFetchProviderModels, scheduleAutoFetch } from './model-catalog-utils';
import type { AIProviderType } from '@/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProviderModelState {
  models: string[];
  loading: boolean;
  error: string | null;
  updatedAt: number | null;
}

interface ProviderKeyConfig {
  setKey: (k: string) => void;
  clearKey: () => void;
  hasKey: boolean;
  model: string;
  setModel: (m: string) => void;
  keyInput: string;
  setKeyInput: (v: string) => void;
}

interface WorkerBoundProviderConfig {
  configured: boolean;
  statusLoading: boolean;
  statusError: string | null;
  model: string;
  setModel: (m: string) => void;
}

interface ExperimentalProviderConfig {
  keyInput: string;
  setKeyInput: (value: string) => void;
  setKey: (k: string) => void;
  clearKey: () => void;
  hasKey: boolean;
  baseUrlInput: string;
  setBaseUrlInput: (value: string) => void;
  baseUrl: string;
  baseUrlError: string | null;
  setBaseUrl: (value: string) => void;
  clearBaseUrl: () => void;
  modelInput: string;
  setModelInput: (value: string) => void;
  model: string;
  setModel: (m: string) => void;
  clearModel: () => void;
  deployments: ExperimentalDeployment[];
  activeDeploymentId: string | null;
  saveDeployment: (model: string) => boolean;
  selectDeployment: (id: string) => void;
  removeDeployment: (id: string) => void;
  clearDeployments: () => void;
  deploymentLimitReached: boolean;
  isConfigured: boolean;
}

interface VertexProviderConfig {
  keyInput: string;
  setKeyInput: (value: string) => void;
  setKey: (value: string) => void;
  clearKey: () => void;
  hasKey: boolean;
  keyError: string | null;
  regionInput: string;
  setRegionInput: (value: string) => void;
  region: string;
  regionError: string | null;
  setRegion: (value: string) => void;
  clearRegion: () => void;
  modelInput: string;
  setModelInput: (value: string) => void;
  model: string;
  modelOptions: string[];
  setModel: (value: string) => void;
  clearModel: () => void;
  mode: VertexConfiguredMode;
  transport: 'openapi' | 'anthropic';
  projectId: string | null;
  hasLegacyConfig: boolean;
  isConfigured: boolean;
}

interface TavilyKeyConfig {
  setKey: (k: string) => void;
  clearKey: () => void;
  hasKey: boolean;
  keyInput: string;
  setKeyInput: (v: string) => void;
}

export interface ModelCatalog {
  // Provider configs (key management + key input state)
  ollama: ProviderKeyConfig;
  openRouter: ProviderKeyConfig;
  cloudflare: WorkerBoundProviderConfig;
  zen: ProviderKeyConfig;
  nvidia: ProviderKeyConfig;
  blackbox: ProviderKeyConfig;
  kilocode: ProviderKeyConfig;
  openadapter: ProviderKeyConfig;
  azure: ExperimentalProviderConfig;
  bedrock: ExperimentalProviderConfig;
  vertex: VertexProviderConfig;
  anthropic: ProviderKeyConfig;
  openai: ProviderKeyConfig;
  google: ProviderKeyConfig;
  tavily: TavilyKeyConfig;

  // Active backend
  activeBackend: PreferredProvider | null;
  setActiveBackend: (p: PreferredProvider | null) => void;
  activeProviderLabel: ActiveProvider;
  availableProviders: readonly (readonly [PreferredProvider, string, boolean])[];
  setPreferredProvider: typeof setPreferredProvider;
  clearPreferredProvider: typeof clearPreferredProvider;

  // Per-provider model state
  ollamaModels: ProviderModelState;
  openRouterModels: ProviderModelState;
  cloudflareModels: ProviderModelState;
  zenModels: ProviderModelState;
  nvidiaModels: ProviderModelState;
  blackboxModels: ProviderModelState;
  kilocodeModels: ProviderModelState;
  openAdapterModels: ProviderModelState;

  // Model option lists (includes selected even if not in fetched list)
  ollamaModelOptions: string[];
  openRouterModelOptions: string[];
  cloudflareModelOptions: string[];
  zenModelOptions: string[];
  nvidiaModelOptions: string[];
  blackboxModelOptions: string[];
  kilocodeModelOptions: string[];
  openAdapterModelOptions: string[];
  anthropicModelOptions: string[];
  openaiModelOptions: string[];
  googleModelOptions: string[];

  // Zen Go tier
  zenGoMode: boolean;
  setZenGoMode: (enabled: boolean) => void;

  // Refresh callbacks
  refreshOllamaModels: () => Promise<void>;
  refreshOpenRouterModels: () => Promise<void>;
  refreshCloudflareModels: () => Promise<void>;
  refreshZenModels: () => Promise<void>;
  refreshNvidiaModels: () => Promise<void>;
  refreshBlackboxModels: () => Promise<void>;
  refreshKilocodeModels: () => Promise<void>;
  refreshOpenAdapterModels: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function includeSelectedModel(
  models: string[],
  selectedModel: string | null | undefined,
): string[] {
  if (!selectedModel) return [...models];
  const available = new Set(models);
  if (available.has(selectedModel)) return [...models];
  return [selectedModel, ...models];
}

// ---------------------------------------------------------------------------
// ModelControl — picker-shaped view over the catalog for a single provider
// ---------------------------------------------------------------------------

/**
 * Picker-ready view of one provider's slice of the catalog. The shape
 * matches what `ModelPicker` consumes — value, options, onChange, plus
 * loading/error/refresh affordances when the provider supports them.
 *
 * Built via `buildModelControl(catalog, provider, lockedModel?)`. Lives
 * next to `useModelCatalog` so the per-provider field names stay in one
 * file: any new provider added to `ModelCatalog` forces an obvious update
 * to the switch below, instead of drift between this helper and the
 * catalog hook.
 */
export interface ModelControl {
  provider: PreferredProvider;
  providerLabel: string;
  value: string;
  options: string[];
  onChange: (model: string) => void;
  loading?: boolean;
  error?: string | null;
  onRefresh?: () => Promise<void>;
  allowCustom?: boolean;
}

function resolveProviderLabel(
  catalog: ModelCatalog,
  provider: PreferredProvider,
  fallback: string,
): string {
  return catalog.availableProviders.find(([id]) => id === provider)?.[1] ?? fallback;
}

/**
 * Build a `ModelControl` for `provider` from `catalog`. When the active
 * chat has locked a specific model (`lockedModel`), surface that value
 * so the picker reflects what the next turn will actually route through.
 *
 * Returns `null` for providers the daemon/picker surfaces don't drive
 * directly (e.g. `demo`) so callers can fall back to a static label.
 */
export function buildModelControl(
  catalog: ModelCatalog,
  provider: AIProviderType | null | undefined,
  lockedModel: string | null = null,
): ModelControl | null {
  switch (provider) {
    case 'ollama':
      return {
        provider,
        providerLabel: resolveProviderLabel(catalog, provider, 'Ollama'),
        value: lockedModel ?? catalog.ollama.model,
        options: includeSelectedModel(
          catalog.ollamaModelOptions,
          lockedModel ?? catalog.ollama.model,
        ),
        onChange: catalog.ollama.setModel,
        loading: catalog.ollamaModels.loading,
        error: catalog.ollamaModels.error,
        onRefresh: catalog.refreshOllamaModels,
        allowCustom: true,
      };
    case 'openrouter':
      return {
        provider,
        providerLabel: resolveProviderLabel(catalog, provider, 'OpenRouter'),
        value: lockedModel ?? catalog.openRouter.model,
        options: includeSelectedModel(
          catalog.openRouterModelOptions,
          lockedModel ?? catalog.openRouter.model,
        ),
        onChange: catalog.openRouter.setModel,
        loading: catalog.openRouterModels.loading,
        error: catalog.openRouterModels.error,
        onRefresh: catalog.refreshOpenRouterModels,
      };
    case 'cloudflare':
      return {
        provider,
        providerLabel: resolveProviderLabel(catalog, provider, 'Cloudflare Workers AI'),
        value: lockedModel ?? catalog.cloudflare.model,
        options: includeSelectedModel(
          catalog.cloudflareModelOptions,
          lockedModel ?? catalog.cloudflare.model,
        ),
        onChange: catalog.cloudflare.setModel,
        loading: catalog.cloudflareModels.loading,
        error: catalog.cloudflareModels.error,
        onRefresh: catalog.refreshCloudflareModels,
      };
    case 'zen':
      return {
        provider,
        providerLabel: resolveProviderLabel(catalog, provider, 'OpenCode Zen'),
        value: lockedModel ?? catalog.zen.model,
        options: includeSelectedModel(catalog.zenModelOptions, lockedModel ?? catalog.zen.model),
        onChange: catalog.zen.setModel,
        loading: catalog.zenModels.loading,
        error: catalog.zenModels.error,
        onRefresh: catalog.refreshZenModels,
      };
    case 'nvidia':
      return {
        provider,
        providerLabel: resolveProviderLabel(catalog, provider, 'Nvidia NIM'),
        value: lockedModel ?? catalog.nvidia.model,
        options: includeSelectedModel(
          catalog.nvidiaModelOptions,
          lockedModel ?? catalog.nvidia.model,
        ),
        onChange: catalog.nvidia.setModel,
        loading: catalog.nvidiaModels.loading,
        error: catalog.nvidiaModels.error,
        onRefresh: catalog.refreshNvidiaModels,
      };
    case 'blackbox':
      return {
        provider,
        providerLabel: resolveProviderLabel(catalog, provider, 'Blackbox AI'),
        value: lockedModel ?? catalog.blackbox.model,
        options: includeSelectedModel(
          catalog.blackboxModelOptions,
          lockedModel ?? catalog.blackbox.model,
        ),
        onChange: catalog.blackbox.setModel,
        loading: catalog.blackboxModels.loading,
        error: catalog.blackboxModels.error,
        onRefresh: catalog.refreshBlackboxModels,
      };
    case 'kilocode':
      return {
        provider,
        providerLabel: resolveProviderLabel(catalog, provider, 'Kilo Code'),
        value: lockedModel ?? catalog.kilocode.model,
        options: includeSelectedModel(
          catalog.kilocodeModelOptions,
          lockedModel ?? catalog.kilocode.model,
        ),
        onChange: catalog.kilocode.setModel,
        loading: catalog.kilocodeModels.loading,
        error: catalog.kilocodeModels.error,
        onRefresh: catalog.refreshKilocodeModels,
      };
    case 'openadapter':
      return {
        provider,
        providerLabel: resolveProviderLabel(catalog, provider, 'OpenAdapter'),
        value: lockedModel ?? catalog.openadapter.model,
        options: includeSelectedModel(
          catalog.openAdapterModelOptions,
          lockedModel ?? catalog.openadapter.model,
        ),
        onChange: catalog.openadapter.setModel,
        loading: catalog.openAdapterModels.loading,
        error: catalog.openAdapterModels.error,
        onRefresh: catalog.refreshOpenAdapterModels,
      };
    case 'azure': {
      const value = lockedModel ?? catalog.azure.model;
      const options = catalog.azure.deployments.map((deployment) => deployment.model);
      return {
        provider,
        providerLabel: resolveProviderLabel(catalog, provider, 'Azure OpenAI'),
        value,
        options: includeSelectedModel(options, value),
        onChange: catalog.azure.setModel,
        allowCustom: true,
      };
    }
    case 'bedrock': {
      const value = lockedModel ?? catalog.bedrock.model;
      const options = catalog.bedrock.deployments.map((deployment) => deployment.model);
      return {
        provider,
        providerLabel: resolveProviderLabel(catalog, provider, 'AWS Bedrock'),
        value,
        options: includeSelectedModel(options, value),
        onChange: catalog.bedrock.setModel,
        allowCustom: true,
      };
    }
    case 'vertex':
      return {
        provider,
        providerLabel: resolveProviderLabel(catalog, provider, 'Google Vertex'),
        value: lockedModel ?? catalog.vertex.model,
        options: includeSelectedModel(
          catalog.vertex.modelOptions,
          lockedModel ?? catalog.vertex.model,
        ),
        onChange: catalog.vertex.setModel,
        allowCustom: true,
      };
    case 'anthropic':
      return {
        provider,
        providerLabel: resolveProviderLabel(catalog, provider, 'Anthropic'),
        value: lockedModel ?? catalog.anthropic.model,
        options: includeSelectedModel(
          catalog.anthropicModelOptions,
          lockedModel ?? catalog.anthropic.model,
        ),
        onChange: catalog.anthropic.setModel,
        allowCustom: true,
      };
    case 'openai':
      return {
        provider,
        providerLabel: resolveProviderLabel(catalog, provider, 'OpenAI'),
        value: lockedModel ?? catalog.openai.model,
        options: includeSelectedModel(
          catalog.openaiModelOptions,
          lockedModel ?? catalog.openai.model,
        ),
        onChange: catalog.openai.setModel,
        allowCustom: true,
      };
    case 'google':
      return {
        provider,
        providerLabel: resolveProviderLabel(catalog, provider, 'Google Gemini'),
        value: lockedModel ?? catalog.google.model,
        options: includeSelectedModel(
          catalog.googleModelOptions,
          lockedModel ?? catalog.google.model,
        ),
        onChange: catalog.google.setModel,
        allowCustom: true,
      };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useModelCatalog(): ModelCatalog {
  // Provider key/model configs
  const ollamaCfg = useOllamaConfig();
  const openRouterCfg = useOpenRouterConfig();
  const zenCfg = useZenConfig();
  const nvidiaCfg = useNvidiaConfig();
  const blackboxCfg = useBlackboxConfig();
  const kilocodeCfg = useKilocodeConfig();
  const openAdapterCfg = useOpenAdapterConfig();
  const anthropicCfg = useAnthropicConfig();
  const openaiCfg = useOpenAIConfig();
  const googleCfg = useGoogleConfig();
  const azureCfg = useAzureConfig();
  const bedrockCfg = useBedrockConfig();
  const vertexCfg = useVertexConfig();
  const tavilyCfg = useTavilyConfig();

  // Key input state (controlled text fields for Settings UI)
  const [ollamaKeyInput, setOllamaKeyInput] = useState('');
  const [openRouterKeyInput, setOpenRouterKeyInput] = useState('');
  const [zenKeyInput, setZenKeyInput] = useState('');
  const [nvidiaKeyInput, setNvidiaKeyInput] = useState('');
  const [blackboxKeyInput, setBlackboxKeyInput] = useState('');
  const [kilocodeKeyInput, setKilocodeKeyInput] = useState('');
  const [openAdapterKeyInput, setOpenAdapterKeyInput] = useState('');
  const [anthropicKeyInput, setAnthropicKeyInput] = useState('');
  const [openaiKeyInput, setOpenaiKeyInput] = useState('');
  const [googleKeyInput, setGoogleKeyInput] = useState('');
  const [azureKeyInput, setAzureKeyInput] = useState('');
  const [azureBaseUrlInput, setAzureBaseUrlInput] = useState('');
  const [azureModelInput, setAzureModelInput] = useState('');
  const [bedrockKeyInput, setBedrockKeyInput] = useState('');
  const [bedrockBaseUrlInput, setBedrockBaseUrlInput] = useState('');
  const [bedrockModelInput, setBedrockModelInput] = useState('');
  const [vertexKeyInput, setVertexKeyInput] = useState('');
  const [vertexRegionInput, setVertexRegionInput] = useState('');
  const [vertexModelInput, setVertexModelInput] = useState('');
  const [tavilyKeyInput, setTavilyKeyInput] = useState('');
  const [cloudflareConfigured, setCloudflareConfiguredState] = useState<boolean>(() =>
    getCloudflareWorkerConfigured(),
  );
  const [cloudflareStatusLoading, setCloudflareStatusLoading] = useState(false);
  const [cloudflareStatusError, setCloudflareStatusError] = useState<string | null>(null);
  const [cloudflareModel, setCloudflareModelState] = useState<string>(() =>
    getCloudflareModelName(),
  );

  const setCloudflareConfiguredStateAndPersist = useCallback((configured: boolean) => {
    setCloudflareConfiguredState(configured);
    setCloudflareWorkerConfigured(configured);
  }, []);

  const setCloudflareModel = useCallback((value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setCloudflareModelName(trimmed);
    setCloudflareModelState(getCloudflareModelName());
  }, []);

  const refreshCloudflareStatus = useCallback(async () => {
    setCloudflareStatusLoading(true);
    setCloudflareStatusError(null);
    try {
      const response = await fetch(resolveApiUrl('/api/health'), { cache: 'no-store' });
      // Parse the payload regardless of HTTP status: /api/health can return
      // structured JSON with services.cloudflare.configured even on a 503,
      // and we still want that signal so stale-configured state gets cleared
      // after a binding removal. Only surface an error if the payload itself
      // is missing or lacks the cloudflare service entry.
      type HealthPayload = { services?: { cloudflare?: { configured?: boolean } } };
      let payload: HealthPayload | null = null;
      try {
        payload = (await response.json()) as HealthPayload;
      } catch {
        // Non-JSON body (e.g. HTML error page) — fall through to the shape error.
      }
      const services = payload?.services;
      if (services && 'cloudflare' in services) {
        setCloudflareConfiguredStateAndPersist(Boolean(services.cloudflare?.configured));
        return;
      }
      throw new Error(`Worker health check returned unexpected shape (${response.status})`);
    } catch (err) {
      setCloudflareStatusError(
        err instanceof Error ? err.message : 'Failed to load Worker health status.',
      );
    } finally {
      setCloudflareStatusLoading(false);
    }
  }, [setCloudflareConfiguredStateAndPersist]);

  // Active backend state
  const [activeBackend, setActiveBackend] = useState<PreferredProvider | null>(() =>
    getPreferredProvider(),
  );
  const activeProviderLabel = getActiveProvider();

  // Available providers (filtered by key presence)
  const availableProviders = (
    [
      ['ollama', 'Ollama', ollamaCfg.hasKey],
      ['openrouter', 'OpenRouter', openRouterCfg.hasKey],
      ['cloudflare', 'Cloudflare Workers AI', cloudflareConfigured],
      ['zen', 'OpenCode Zen', zenCfg.hasKey],
      ['nvidia', 'Nvidia NIM', nvidiaCfg.hasKey],
      ['blackbox', 'Blackbox AI', blackboxCfg.hasKey],
      ['kilocode', 'Kilo Code', kilocodeCfg.hasKey],
      ['openadapter', 'OpenAdapter', openAdapterCfg.hasKey],
      ['azure', 'Azure OpenAI', azureCfg.isConfigured],
      ['bedrock', 'AWS Bedrock', bedrockCfg.isConfigured],
      ['vertex', 'Google Vertex', vertexCfg.isConfigured],
      ['anthropic', 'Anthropic', anthropicCfg.hasKey],
      ['openai', 'OpenAI', openaiCfg.hasKey],
      ['google', 'Google Gemini', googleCfg.hasKey],
    ] as const
  ).filter(([, , has]) => has);

  // ----- Per-provider model lists -----

  const [ollamaModelList, setOllamaModelList] = useState<string[]>([]);
  const [openRouterModelList, setOpenRouterModelList] = useState<string[]>([]);
  const [cloudflareModelList, setCloudflareModelList] = useState<string[]>([]);
  const [zenModelList, setZenModelList] = useState<string[]>([]);
  const [nvidiaModelList, setNvidiaModelList] = useState<string[]>([]);
  const [blackboxModelList, setBlackboxModelList] = useState<string[]>([]);
  const [kilocodeModelList, setKilocodeModelList] = useState<string[]>([]);
  const [openAdapterModelList, setOpenAdapterModelList] = useState<string[]>([]);

  const [ollamaLoading, setOllamaLoading] = useState(false);
  const [openRouterLoading, setOpenRouterLoading] = useState(false);
  const [cloudflareLoading, setCloudflareLoading] = useState(false);
  const [zenLoading, setZenLoading] = useState(false);
  const [nvidiaLoading, setNvidiaLoading] = useState(false);
  const [blackboxLoading, setBlackboxLoading] = useState(false);
  const [kilocodeLoading, setKilocodeLoading] = useState(false);
  const [openAdapterLoading, setOpenAdapterLoading] = useState(false);

  const [ollamaError, setOllamaError] = useState<string | null>(null);
  const [openRouterError, setOpenRouterError] = useState<string | null>(null);
  const [cloudflareError, setCloudflareError] = useState<string | null>(null);
  const [zenError, setZenError] = useState<string | null>(null);
  const [nvidiaError, setNvidiaError] = useState<string | null>(null);
  const [blackboxError, setBlackboxError] = useState<string | null>(null);
  const [kilocodeError, setKilocodeError] = useState<string | null>(null);
  const [openAdapterError, setOpenAdapterError] = useState<string | null>(null);

  const [ollamaUpdatedAt, setOllamaUpdatedAt] = useState<number | null>(null);
  const [openRouterUpdatedAt, setOpenRouterUpdatedAt] = useState<number | null>(null);
  const [cloudflareUpdatedAt, setCloudflareUpdatedAt] = useState<number | null>(null);
  const [zenUpdatedAt, setZenUpdatedAt] = useState<number | null>(null);
  const [nvidiaUpdatedAt, setNvidiaUpdatedAt] = useState<number | null>(null);
  const [blackboxUpdatedAt, setBlackboxUpdatedAt] = useState<number | null>(null);
  const [kilocodeUpdatedAt, setKilocodeUpdatedAt] = useState<number | null>(null);
  const [openAdapterUpdatedAt, setOpenAdapterUpdatedAt] = useState<number | null>(null);

  // Generic refresh helper
  const refreshModels = useCallback(
    async (params: {
      hasKey: boolean;
      isLoading: boolean;
      setLoading: (v: boolean) => void;
      setError: (v: string | null) => void;
      setModels: (m: string[]) => void;
      setUpdatedAt: (v: number) => void;
      fetchModels: () => Promise<string[]>;
      emptyMessage: string;
      failureMessage: string;
    }) => {
      if (!params.hasKey || params.isLoading) return;
      params.setLoading(true);
      params.setError(null);
      try {
        const models = await params.fetchModels();
        params.setModels(models);
        params.setUpdatedAt(Date.now());
        if (models.length === 0) params.setError(params.emptyMessage);
      } catch (err) {
        params.setError(err instanceof Error ? err.message : params.failureMessage);
      } finally {
        params.setLoading(false);
      }
    },
    [],
  );

  // Per-provider refresh callbacks
  const refreshOllamaModels = useCallback(async () => {
    await refreshModels({
      hasKey: ollamaCfg.hasKey,
      isLoading: ollamaLoading,
      setLoading: setOllamaLoading,
      setError: setOllamaError,
      setModels: setOllamaModelList,
      setUpdatedAt: setOllamaUpdatedAt,
      fetchModels: fetchOllamaModels,
      emptyMessage: 'No models returned by Ollama.',
      failureMessage: 'Failed to load Ollama models.',
    });
  }, [ollamaCfg.hasKey, ollamaLoading, refreshModels]);

  const refreshOpenRouterModels = useCallback(async () => {
    await refreshModels({
      hasKey: openRouterCfg.hasKey,
      isLoading: openRouterLoading,
      setLoading: setOpenRouterLoading,
      setError: setOpenRouterError,
      setModels: setOpenRouterModelList,
      setUpdatedAt: setOpenRouterUpdatedAt,
      fetchModels: fetchOpenRouterModels,
      emptyMessage: 'No models returned by OpenRouter.',
      failureMessage: 'Failed to load OpenRouter models.',
    });
  }, [openRouterCfg.hasKey, openRouterLoading, refreshModels]);

  const refreshCloudflareModels = useCallback(async () => {
    if (cloudflareLoading) return;
    setCloudflareLoading(true);
    setCloudflareError(null);
    try {
      const models = await fetchCloudflareModels();
      setCloudflareModelList(models);
      setCloudflareUpdatedAt(Date.now());
      setCloudflareConfiguredStateAndPersist(true);
      setCloudflareStatusError(null);
      if (models.length === 0) {
        setCloudflareError('No models returned by Cloudflare Workers AI.');
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to load Cloudflare Workers AI models.';
      setCloudflareError(message);
      // Only flip `configured` to false on errors that explicitly indicate a
      // missing binding. A looser match (e.g. "workers ai") would catch every
      // timeout and 5xx message, since all CF errors mention the provider,
      // and would wrongly hide the provider on transient failures.
      if (/not configured|worker binding/i.test(message)) {
        setCloudflareConfiguredStateAndPersist(false);
        setCloudflareModelList([]);
        setCloudflareUpdatedAt(null);
      }
    } finally {
      setCloudflareLoading(false);
    }
  }, [cloudflareLoading, setCloudflareConfiguredStateAndPersist]);

  const refreshZenStandardModels = useCallback(async () => {
    await refreshModels({
      hasKey: zenCfg.hasKey,
      isLoading: zenLoading,
      setLoading: setZenLoading,
      setError: setZenError,
      setModels: setZenModelList,
      setUpdatedAt: setZenUpdatedAt,
      fetchModels: fetchZenModels,
      emptyMessage: 'No models returned by OpenCode Zen.',
      failureMessage: 'Failed to load OpenCode Zen models.',
    });
  }, [zenCfg.hasKey, zenLoading, refreshModels]);

  const refreshZenModels = useCallback(async () => {
    if (zenCfg.goMode) {
      setZenError(null);
      return;
    }
    await refreshZenStandardModels();
  }, [refreshZenStandardModels, zenCfg.goMode]);

  const refreshNvidiaModels = useCallback(async () => {
    await refreshModels({
      hasKey: nvidiaCfg.hasKey,
      isLoading: nvidiaLoading,
      setLoading: setNvidiaLoading,
      setError: setNvidiaError,
      setModels: setNvidiaModelList,
      setUpdatedAt: setNvidiaUpdatedAt,
      fetchModels: fetchNvidiaModels,
      emptyMessage: 'No models returned by Nvidia NIM.',
      failureMessage: 'Failed to load Nvidia NIM models.',
    });
  }, [nvidiaCfg.hasKey, nvidiaLoading, refreshModels]);

  const refreshBlackboxModels = useCallback(async () => {
    await refreshModels({
      hasKey: blackboxCfg.hasKey,
      isLoading: blackboxLoading,
      setLoading: setBlackboxLoading,
      setError: setBlackboxError,
      setModels: setBlackboxModelList,
      setUpdatedAt: setBlackboxUpdatedAt,
      fetchModels: fetchBlackboxModels,
      emptyMessage: 'No models returned by Blackbox AI.',
      failureMessage: 'Failed to load Blackbox AI models.',
    });
  }, [blackboxCfg.hasKey, blackboxLoading, refreshModels]);

  const refreshKilocodeModels = useCallback(async () => {
    await refreshModels({
      hasKey: kilocodeCfg.hasKey,
      isLoading: kilocodeLoading,
      setLoading: setKilocodeLoading,
      setError: setKilocodeError,
      setModels: setKilocodeModelList,
      setUpdatedAt: setKilocodeUpdatedAt,
      fetchModels: fetchKilocodeModels,
      emptyMessage: 'No models returned by Kilo Code.',
      failureMessage: 'Failed to load Kilo Code models.',
    });
  }, [kilocodeCfg.hasKey, kilocodeLoading, refreshModels]);

  const refreshOpenAdapterModels = useCallback(async () => {
    await refreshModels({
      hasKey: openAdapterCfg.hasKey,
      isLoading: openAdapterLoading,
      setLoading: setOpenAdapterLoading,
      setError: setOpenAdapterError,
      setModels: setOpenAdapterModelList,
      setUpdatedAt: setOpenAdapterUpdatedAt,
      fetchModels: fetchOpenAdapterModels,
      emptyMessage: 'No models returned by OpenAdapter.',
      failureMessage: 'Failed to load OpenAdapter models.',
    });
  }, [openAdapterCfg.hasKey, openAdapterLoading, refreshModels]);

  // Auto-fetch models when key becomes available.
  // The active provider fetches immediately; all others are deferred via
  // requestIdleCallback (or a short setTimeout) so startup isn't blocked.
  useEffect(() => {
    void refreshCloudflareStatus();
  }, [refreshCloudflareStatus]);

  useEffect(
    () =>
      scheduleAutoFetch(
        shouldAutoFetchProviderModels({
          hasKey: ollamaCfg.hasKey,
          modelCount: ollamaModelList.length,
          loading: ollamaLoading,
          error: ollamaError,
        }),
        activeProviderLabel === 'ollama',
        () => {
          void refreshOllamaModels();
        },
      ),
    [
      activeProviderLabel,
      ollamaCfg.hasKey,
      ollamaError,
      ollamaLoading,
      ollamaModelList.length,
      refreshOllamaModels,
    ],
  );
  useEffect(
    () =>
      scheduleAutoFetch(
        shouldAutoFetchProviderModels({
          hasKey: openRouterCfg.hasKey,
          modelCount: openRouterModelList.length,
          loading: openRouterLoading,
          error: openRouterError,
        }),
        activeProviderLabel === 'openrouter',
        () => {
          void refreshOpenRouterModels();
        },
      ),
    [
      activeProviderLabel,
      openRouterCfg.hasKey,
      openRouterError,
      openRouterLoading,
      openRouterModelList.length,
      refreshOpenRouterModels,
    ],
  );
  useEffect(
    () =>
      scheduleAutoFetch(
        shouldAutoFetchProviderModels({
          hasKey: cloudflareConfigured,
          modelCount: cloudflareModelList.length,
          loading: cloudflareLoading,
          error: cloudflareError,
        }),
        activeProviderLabel === 'cloudflare',
        () => {
          void refreshCloudflareModels();
        },
      ),
    [
      activeProviderLabel,
      cloudflareConfigured,
      cloudflareError,
      cloudflareLoading,
      cloudflareModelList.length,
      refreshCloudflareModels,
    ],
  );
  useEffect(
    () =>
      scheduleAutoFetch(
        !zenCfg.goMode &&
          shouldAutoFetchProviderModels({
            hasKey: zenCfg.hasKey,
            modelCount: zenModelList.length,
            loading: zenLoading,
            error: zenError,
          }),
        activeProviderLabel === 'zen',
        () => {
          void refreshZenStandardModels();
        },
      ),
    [
      activeProviderLabel,
      refreshZenStandardModels,
      zenCfg.goMode,
      zenCfg.hasKey,
      zenError,
      zenLoading,
      zenModelList.length,
    ],
  );
  useEffect(
    () =>
      scheduleAutoFetch(
        shouldAutoFetchProviderModels({
          hasKey: nvidiaCfg.hasKey,
          modelCount: nvidiaModelList.length,
          loading: nvidiaLoading,
          error: nvidiaError,
        }),
        activeProviderLabel === 'nvidia',
        () => {
          void refreshNvidiaModels();
        },
      ),
    [
      activeProviderLabel,
      nvidiaCfg.hasKey,
      nvidiaError,
      nvidiaLoading,
      nvidiaModelList.length,
      refreshNvidiaModels,
    ],
  );
  useEffect(
    () =>
      scheduleAutoFetch(
        shouldAutoFetchProviderModels({
          hasKey: blackboxCfg.hasKey,
          modelCount: blackboxModelList.length,
          loading: blackboxLoading,
          error: blackboxError,
        }),
        activeProviderLabel === 'blackbox',
        () => {
          void refreshBlackboxModels();
        },
      ),
    [
      activeProviderLabel,
      blackboxCfg.hasKey,
      blackboxError,
      blackboxLoading,
      blackboxModelList.length,
      refreshBlackboxModels,
    ],
  );
  useEffect(
    () =>
      scheduleAutoFetch(
        shouldAutoFetchProviderModels({
          hasKey: kilocodeCfg.hasKey,
          modelCount: kilocodeModelList.length,
          loading: kilocodeLoading,
          error: kilocodeError,
        }),
        activeProviderLabel === 'kilocode',
        () => {
          void refreshKilocodeModels();
        },
      ),
    [
      activeProviderLabel,
      kilocodeCfg.hasKey,
      kilocodeError,
      kilocodeLoading,
      kilocodeModelList.length,
      refreshKilocodeModels,
    ],
  );
  useEffect(
    () =>
      scheduleAutoFetch(
        shouldAutoFetchProviderModels({
          hasKey: openAdapterCfg.hasKey,
          modelCount: openAdapterModelList.length,
          loading: openAdapterLoading,
          error: openAdapterError,
        }),
        activeProviderLabel === 'openadapter',
        () => {
          void refreshOpenAdapterModels();
        },
      ),
    [
      activeProviderLabel,
      openAdapterCfg.hasKey,
      openAdapterError,
      openAdapterLoading,
      openAdapterModelList.length,
      refreshOpenAdapterModels,
    ],
  );

  // Clear models when key is removed
  useEffect(() => {
    if (!cloudflareConfigured) {
      setCloudflareModelList([]);
      setCloudflareError(null);
      setCloudflareUpdatedAt(null);
      setCloudflareLoading(false);
    }
  }, [cloudflareConfigured]);
  useEffect(() => {
    if (!ollamaCfg.hasKey) {
      setOllamaModelList([]);
      setOllamaError(null);
      setOllamaUpdatedAt(null);
    }
  }, [ollamaCfg.hasKey]);
  useEffect(() => {
    if (!openRouterCfg.hasKey) {
      setOpenRouterModelList([]);
      setOpenRouterError(null);
      setOpenRouterUpdatedAt(null);
    }
  }, [openRouterCfg.hasKey]);
  useEffect(() => {
    if (!zenCfg.hasKey) {
      setZenModelList([]);
      setZenError(null);
      setZenUpdatedAt(null);
      setZenLoading(false);
    }
  }, [zenCfg.hasKey]);
  useEffect(() => {
    if (!nvidiaCfg.hasKey) {
      setNvidiaModelList([]);
      setNvidiaError(null);
      setNvidiaUpdatedAt(null);
    }
  }, [nvidiaCfg.hasKey]);
  useEffect(() => {
    if (!blackboxCfg.hasKey) {
      setBlackboxModelList([]);
      setBlackboxError(null);
      setBlackboxUpdatedAt(null);
    }
  }, [blackboxCfg.hasKey]);
  useEffect(() => {
    if (!kilocodeCfg.hasKey) {
      setKilocodeModelList([]);
      setKilocodeError(null);
      setKilocodeUpdatedAt(null);
    }
  }, [kilocodeCfg.hasKey]);
  useEffect(() => {
    if (!openAdapterCfg.hasKey) {
      setOpenAdapterModelList([]);
      setOpenAdapterError(null);
      setOpenAdapterUpdatedAt(null);
    }
  }, [openAdapterCfg.hasKey]);

  const kilocodeSelectedModel = kilocodeCfg.model;
  const setKilocodeModel = kilocodeCfg.setModel;

  useEffect(() => {
    const normalizedSelectedModel = normalizeKilocodeModelName(kilocodeSelectedModel);
    if (normalizedSelectedModel !== kilocodeSelectedModel) {
      setKilocodeModel(normalizedSelectedModel);
      return;
    }

    if (kilocodeModelList.length === 0 || kilocodeModelList.includes(normalizedSelectedModel)) {
      return;
    }

    const fallbackModel = kilocodeModelList.includes(KILOCODE_DEFAULT_MODEL)
      ? KILOCODE_DEFAULT_MODEL
      : kilocodeModelList[0];
    if (fallbackModel && fallbackModel !== kilocodeSelectedModel) {
      setKilocodeModel(fallbackModel);
    }
  }, [kilocodeModelList, kilocodeSelectedModel, setKilocodeModel]);

  const activeZenModelList = useMemo(
    () => (zenCfg.goMode ? [] : zenModelList),
    [zenCfg.goMode, zenModelList],
  );
  const activeZenLoading = zenCfg.goMode ? false : zenLoading;
  const activeZenError = zenCfg.goMode ? null : zenError;
  const activeZenUpdatedAt = zenCfg.goMode ? null : zenUpdatedAt;

  // Model option lists (ensure selected model is always included)
  const ollamaModelOptions = useMemo(
    () => includeSelectedModel(ollamaModelList, ollamaCfg.model),
    [ollamaModelList, ollamaCfg.model],
  );
  const openRouterModelOptions = useMemo(
    () =>
      includeSelectedModel(
        openRouterModelList.length > 0 ? openRouterModelList : OPENROUTER_MODELS,
        openRouterCfg.model,
      ),
    [openRouterCfg.model, openRouterModelList],
  );
  const cloudflareModelOptions = useMemo(
    () =>
      includeSelectedModel(
        cloudflareModelList.length > 0 ? cloudflareModelList : CLOUDFLARE_MODELS,
        cloudflareModel,
      ),
    [cloudflareModel, cloudflareModelList],
  );
  const zenModelOptions = useMemo(
    () =>
      includeSelectedModel(
        activeZenModelList.length > 0
          ? activeZenModelList
          : zenCfg.goMode
            ? ZEN_GO_MODELS
            : ZEN_MODELS,
        zenCfg.model,
      ),
    [activeZenModelList, zenCfg.goMode, zenCfg.model],
  );
  const nvidiaModelOptions = useMemo(
    () => includeSelectedModel(nvidiaModelList, nvidiaCfg.model),
    [nvidiaModelList, nvidiaCfg.model],
  );
  const blackboxModelOptions = useMemo(
    () =>
      includeSelectedModel(
        blackboxModelList.length > 0 ? blackboxModelList : BLACKBOX_MODELS,
        blackboxCfg.model,
      ),
    [blackboxModelList, blackboxCfg.model],
  );
  const kilocodeModelOptions = useMemo(() => {
    const selectedModel = normalizeKilocodeModelName(kilocodeSelectedModel);
    if (kilocodeModelList.length > 0) {
      return kilocodeModelList.includes(selectedModel)
        ? includeSelectedModel(kilocodeModelList, selectedModel)
        : [...kilocodeModelList];
    }
    return includeSelectedModel(KILOCODE_MODELS, selectedModel);
  }, [kilocodeModelList, kilocodeSelectedModel]);
  const openAdapterModelOptions = useMemo(
    () =>
      includeSelectedModel(
        openAdapterModelList.length > 0 ? openAdapterModelList : OPENADAPTER_MODELS,
        openAdapterCfg.model,
      ),
    [openAdapterModelList, openAdapterCfg.model],
  );
  // Anthropic uses the curated list directly — no live `/v1/models` proxy yet
  // (curated covers MVP; live fetching can land in a follow-up with a Worker
  // /api/anthropic/models proxy that does more than echo the curated list).
  const anthropicModelOptions = useMemo(
    () => includeSelectedModel(ANTHROPIC_MODELS, anthropicCfg.model),
    [anthropicCfg.model],
  );
  // OpenAI: curated list for now. A live /v1/models proxy could land later
  // once we filter to chat-capable models (the upstream list contains
  // embeddings/audio/etc. that aren't useful in the chat dropdown).
  const openaiModelOptions = useMemo(
    () => includeSelectedModel(OPENAI_MODELS, openaiCfg.model),
    [openaiCfg.model],
  );
  // Google: curated list for MVP. A live /v1beta/models proxy could land
  // later — it ships chat-capable models alongside embedding/image-only
  // entries, so the live path needs a filter before it's useful here.
  const googleModelOptions = useMemo(
    () => includeSelectedModel(GOOGLE_MODELS, googleCfg.model),
    [googleCfg.model],
  );
  const vertexModelOptions = useMemo(
    () => includeSelectedModel(vertexCfg.modelOptions, vertexCfg.model),
    [vertexCfg.modelOptions, vertexCfg.model],
  );

  return {
    ollama: {
      setKey: ollamaCfg.setKey,
      clearKey: ollamaCfg.clearKey,
      hasKey: ollamaCfg.hasKey,
      model: ollamaCfg.model,
      setModel: ollamaCfg.setModel,
      keyInput: ollamaKeyInput,
      setKeyInput: setOllamaKeyInput,
    },
    openRouter: {
      setKey: openRouterCfg.setKey,
      clearKey: openRouterCfg.clearKey,
      hasKey: openRouterCfg.hasKey,
      model: openRouterCfg.model,
      setModel: openRouterCfg.setModel,
      keyInput: openRouterKeyInput,
      setKeyInput: setOpenRouterKeyInput,
    },
    cloudflare: {
      configured: cloudflareConfigured,
      statusLoading: cloudflareStatusLoading,
      statusError: cloudflareStatusError,
      model: cloudflareModel,
      setModel: setCloudflareModel,
    },
    zen: {
      setKey: zenCfg.setKey,
      clearKey: zenCfg.clearKey,
      hasKey: zenCfg.hasKey,
      model: zenCfg.model,
      setModel: zenCfg.setModel,
      keyInput: zenKeyInput,
      setKeyInput: setZenKeyInput,
    },
    nvidia: {
      setKey: nvidiaCfg.setKey,
      clearKey: nvidiaCfg.clearKey,
      hasKey: nvidiaCfg.hasKey,
      model: nvidiaCfg.model,
      setModel: nvidiaCfg.setModel,
      keyInput: nvidiaKeyInput,
      setKeyInput: setNvidiaKeyInput,
    },
    blackbox: {
      setKey: blackboxCfg.setKey,
      clearKey: blackboxCfg.clearKey,
      hasKey: blackboxCfg.hasKey,
      model: blackboxCfg.model,
      setModel: blackboxCfg.setModel,
      keyInput: blackboxKeyInput,
      setKeyInput: setBlackboxKeyInput,
    },
    kilocode: {
      setKey: kilocodeCfg.setKey,
      clearKey: kilocodeCfg.clearKey,
      hasKey: kilocodeCfg.hasKey,
      model: kilocodeCfg.model,
      setModel: kilocodeCfg.setModel,
      keyInput: kilocodeKeyInput,
      setKeyInput: setKilocodeKeyInput,
    },
    openadapter: {
      setKey: openAdapterCfg.setKey,
      clearKey: openAdapterCfg.clearKey,
      hasKey: openAdapterCfg.hasKey,
      model: openAdapterCfg.model,
      setModel: openAdapterCfg.setModel,
      keyInput: openAdapterKeyInput,
      setKeyInput: setOpenAdapterKeyInput,
    },
    azure: {
      keyInput: azureKeyInput,
      setKeyInput: setAzureKeyInput,
      setKey: azureCfg.setKey,
      clearKey: azureCfg.clearKey,
      hasKey: azureCfg.hasKey,
      baseUrlInput: azureBaseUrlInput,
      setBaseUrlInput: setAzureBaseUrlInput,
      baseUrl: azureCfg.baseUrl,
      baseUrlError: azureCfg.baseUrlError,
      setBaseUrl: azureCfg.setBaseUrl,
      clearBaseUrl: azureCfg.clearBaseUrl,
      modelInput: azureModelInput,
      setModelInput: setAzureModelInput,
      model: azureCfg.model,
      setModel: azureCfg.setModel,
      clearModel: azureCfg.clearModel,
      deployments: azureCfg.deployments,
      activeDeploymentId: azureCfg.activeDeploymentId,
      saveDeployment: azureCfg.saveDeployment,
      selectDeployment: azureCfg.selectDeployment,
      removeDeployment: azureCfg.removeDeployment,
      clearDeployments: azureCfg.clearDeployments,
      deploymentLimitReached: azureCfg.deploymentLimitReached,
      isConfigured: azureCfg.isConfigured,
    },
    bedrock: {
      keyInput: bedrockKeyInput,
      setKeyInput: setBedrockKeyInput,
      setKey: bedrockCfg.setKey,
      clearKey: bedrockCfg.clearKey,
      hasKey: bedrockCfg.hasKey,
      baseUrlInput: bedrockBaseUrlInput,
      setBaseUrlInput: setBedrockBaseUrlInput,
      baseUrl: bedrockCfg.baseUrl,
      baseUrlError: bedrockCfg.baseUrlError,
      setBaseUrl: bedrockCfg.setBaseUrl,
      clearBaseUrl: bedrockCfg.clearBaseUrl,
      modelInput: bedrockModelInput,
      setModelInput: setBedrockModelInput,
      model: bedrockCfg.model,
      setModel: bedrockCfg.setModel,
      clearModel: bedrockCfg.clearModel,
      deployments: bedrockCfg.deployments,
      activeDeploymentId: bedrockCfg.activeDeploymentId,
      saveDeployment: bedrockCfg.saveDeployment,
      selectDeployment: bedrockCfg.selectDeployment,
      removeDeployment: bedrockCfg.removeDeployment,
      clearDeployments: bedrockCfg.clearDeployments,
      deploymentLimitReached: bedrockCfg.deploymentLimitReached,
      isConfigured: bedrockCfg.isConfigured,
    },
    anthropic: {
      setKey: anthropicCfg.setKey,
      clearKey: anthropicCfg.clearKey,
      hasKey: anthropicCfg.hasKey,
      model: anthropicCfg.model,
      setModel: anthropicCfg.setModel,
      keyInput: anthropicKeyInput,
      setKeyInput: setAnthropicKeyInput,
    },
    openai: {
      setKey: openaiCfg.setKey,
      clearKey: openaiCfg.clearKey,
      hasKey: openaiCfg.hasKey,
      model: openaiCfg.model,
      setModel: openaiCfg.setModel,
      keyInput: openaiKeyInput,
      setKeyInput: setOpenaiKeyInput,
    },
    google: {
      setKey: googleCfg.setKey,
      clearKey: googleCfg.clearKey,
      hasKey: googleCfg.hasKey,
      model: googleCfg.model,
      setModel: googleCfg.setModel,
      keyInput: googleKeyInput,
      setKeyInput: setGoogleKeyInput,
    },
    vertex: {
      keyInput: vertexKeyInput,
      setKeyInput: setVertexKeyInput,
      setKey: vertexCfg.setKey,
      clearKey: vertexCfg.clearKey,
      hasKey: vertexCfg.hasKey,
      keyError: vertexCfg.keyError,
      regionInput: vertexRegionInput,
      setRegionInput: setVertexRegionInput,
      region: vertexCfg.region,
      regionError: vertexCfg.regionError,
      setRegion: vertexCfg.setRegion,
      clearRegion: vertexCfg.clearRegion,
      modelInput: vertexModelInput,
      setModelInput: setVertexModelInput,
      model: vertexCfg.model,
      modelOptions: vertexModelOptions,
      setModel: vertexCfg.setModel,
      clearModel: vertexCfg.clearModel,
      mode: vertexCfg.mode,
      transport: vertexCfg.transport,
      projectId: vertexCfg.projectId,
      hasLegacyConfig: vertexCfg.hasLegacyConfig,
      isConfigured: vertexCfg.isConfigured,
    },
    tavily: {
      setKey: tavilyCfg.setKey,
      clearKey: tavilyCfg.clearKey,
      hasKey: tavilyCfg.hasKey,
      keyInput: tavilyKeyInput,
      setKeyInput: setTavilyKeyInput,
    },

    activeBackend,
    setActiveBackend,
    activeProviderLabel,
    availableProviders,
    setPreferredProvider,
    clearPreferredProvider,

    ollamaModels: {
      models: ollamaModelList,
      loading: ollamaLoading,
      error: ollamaError,
      updatedAt: ollamaUpdatedAt,
    },
    openRouterModels: {
      models: openRouterModelList,
      loading: openRouterLoading,
      error: openRouterError,
      updatedAt: openRouterUpdatedAt,
    },
    cloudflareModels: {
      models: cloudflareModelList,
      loading: cloudflareLoading,
      error: cloudflareError,
      updatedAt: cloudflareUpdatedAt,
    },
    zenModels: {
      models: activeZenModelList,
      loading: activeZenLoading,
      error: activeZenError,
      updatedAt: activeZenUpdatedAt,
    },
    nvidiaModels: {
      models: nvidiaModelList,
      loading: nvidiaLoading,
      error: nvidiaError,
      updatedAt: nvidiaUpdatedAt,
    },
    blackboxModels: {
      models: blackboxModelList,
      loading: blackboxLoading,
      error: blackboxError,
      updatedAt: blackboxUpdatedAt,
    },
    kilocodeModels: {
      models: kilocodeModelList,
      loading: kilocodeLoading,
      error: kilocodeError,
      updatedAt: kilocodeUpdatedAt,
    },
    openAdapterModels: {
      models: openAdapterModelList,
      loading: openAdapterLoading,
      error: openAdapterError,
      updatedAt: openAdapterUpdatedAt,
    },

    ollamaModelOptions,
    openRouterModelOptions,
    cloudflareModelOptions,
    zenModelOptions,
    nvidiaModelOptions: nvidiaModelList.length > 0 ? nvidiaModelOptions : NVIDIA_MODELS,
    blackboxModelOptions,
    kilocodeModelOptions,
    openAdapterModelOptions,
    anthropicModelOptions,
    openaiModelOptions,
    googleModelOptions,

    zenGoMode: zenCfg.goMode,
    setZenGoMode: zenCfg.setGoMode,

    refreshOllamaModels,
    refreshOpenRouterModels,
    refreshCloudflareModels,
    refreshZenModels,
    refreshNvidiaModels,
    refreshBlackboxModels,
    refreshKilocodeModels,
    refreshOpenAdapterModels,
  };
}
