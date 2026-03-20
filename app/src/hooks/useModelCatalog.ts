import { useState, useCallback, useMemo, useEffect } from 'react';
import {
  getPreferredProvider,
  setPreferredProvider,
  clearPreferredProvider,
  OPENROUTER_MODELS,
  ZEN_MODELS,
  ZEN_GO_MODELS,
  NVIDIA_MODELS,
  BLACKBOX_MODELS,
  type PreferredProvider,
} from '@/lib/providers';
import { getActiveProvider, type ActiveProvider } from '@/lib/orchestrator';
import {
  fetchOllamaModels,
  fetchOpenRouterModels,
  fetchZenModels,
  fetchNvidiaModels,
  fetchBlackboxModels,
} from '@/lib/model-catalog';
import { useOllamaConfig } from '@/hooks/useOllamaConfig';
import { useOpenRouterConfig } from '@/hooks/useOpenRouterConfig';
import { useZenConfig } from '@/hooks/useZenConfig';
import { useNvidiaConfig } from '@/hooks/useNvidiaConfig';
import { useBlackboxConfig } from '@/hooks/useBlackboxConfig';
import { useAzureConfig, useBedrockConfig } from '@/hooks/useExperimentalProviderConfig';
import { useTavilyConfig } from '@/hooks/useTavilyConfig';
import type { ExperimentalDeployment } from '@/lib/experimental-providers';
import { useVertexConfig, type VertexConfiguredMode } from '@/hooks/useVertexConfig';
import { shouldAutoFetchProviderModels } from './model-catalog-utils';

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
  zen: ProviderKeyConfig;
  nvidia: ProviderKeyConfig;
  blackbox: ProviderKeyConfig;
  azure: ExperimentalProviderConfig;
  bedrock: ExperimentalProviderConfig;
  vertex: VertexProviderConfig;
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
  zenModels: ProviderModelState;
  nvidiaModels: ProviderModelState;
  blackboxModels: ProviderModelState;

  // Model option lists (includes selected even if not in fetched list)
  ollamaModelOptions: string[];
  openRouterModelOptions: string[];
  zenModelOptions: string[];
  nvidiaModelOptions: string[];
  blackboxModelOptions: string[];

  // Zen Go tier
  zenGoMode: boolean;
  setZenGoMode: (enabled: boolean) => void;

  // Refresh callbacks
  refreshOllamaModels: () => Promise<void>;
  refreshOpenRouterModels: () => Promise<void>;
  refreshZenModels: () => Promise<void>;
  refreshNvidiaModels: () => Promise<void>;
  refreshBlackboxModels: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function includeSelectedModel(models: string[], selectedModel: string | null | undefined): string[] {
  if (!selectedModel) return [...models];
  const available = new Set(models);
  if (available.has(selectedModel)) return [...models];
  return [selectedModel, ...models];
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

  // Active backend state
  const [activeBackend, setActiveBackend] = useState<PreferredProvider | null>(() => getPreferredProvider());
  const activeProviderLabel = getActiveProvider();

  // Available providers (filtered by key presence)
  const availableProviders = ([
    ['ollama', 'Ollama', ollamaCfg.hasKey],
    ['openrouter', 'OpenRouter', openRouterCfg.hasKey],
    ['zen', 'OpenCode Zen', zenCfg.hasKey],
    ['nvidia', 'Nvidia NIM', nvidiaCfg.hasKey],
    ['blackbox', 'Blackbox AI', blackboxCfg.hasKey],
    ['azure', 'Azure OpenAI', azureCfg.isConfigured],
    ['bedrock', 'AWS Bedrock', bedrockCfg.isConfigured],
    ['vertex', 'Google Vertex', vertexCfg.isConfigured],
  ] as const).filter(([, , has]) => has);

  // ----- Per-provider model lists -----

  const [ollamaModelList, setOllamaModelList] = useState<string[]>([]);
  const [openRouterModelList, setOpenRouterModelList] = useState<string[]>([]);
  const [zenModelList, setZenModelList] = useState<string[]>([]);
  const [nvidiaModelList, setNvidiaModelList] = useState<string[]>([]);
  const [blackboxModelList, setBlackboxModelList] = useState<string[]>([]);

  const [ollamaLoading, setOllamaLoading] = useState(false);
  const [openRouterLoading, setOpenRouterLoading] = useState(false);
  const [zenLoading, setZenLoading] = useState(false);
  const [nvidiaLoading, setNvidiaLoading] = useState(false);
  const [blackboxLoading, setBlackboxLoading] = useState(false);

  const [ollamaError, setOllamaError] = useState<string | null>(null);
  const [openRouterError, setOpenRouterError] = useState<string | null>(null);
  const [zenError, setZenError] = useState<string | null>(null);
  const [nvidiaError, setNvidiaError] = useState<string | null>(null);
  const [blackboxError, setBlackboxError] = useState<string | null>(null);

  const [ollamaUpdatedAt, setOllamaUpdatedAt] = useState<number | null>(null);
  const [openRouterUpdatedAt, setOpenRouterUpdatedAt] = useState<number | null>(null);
  const [zenUpdatedAt, setZenUpdatedAt] = useState<number | null>(null);
  const [nvidiaUpdatedAt, setNvidiaUpdatedAt] = useState<number | null>(null);
  const [blackboxUpdatedAt, setBlackboxUpdatedAt] = useState<number | null>(null);

  // Generic refresh helper
  const refreshModels = useCallback(async (params: {
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
  }, []);

  // Per-provider refresh callbacks
  const refreshOllamaModels = useCallback(async () => {
    await refreshModels({
      hasKey: ollamaCfg.hasKey, isLoading: ollamaLoading,
      setLoading: setOllamaLoading, setError: setOllamaError,
      setModels: setOllamaModelList, setUpdatedAt: setOllamaUpdatedAt,
      fetchModels: fetchOllamaModels,
      emptyMessage: 'No models returned by Ollama.',
      failureMessage: 'Failed to load Ollama models.',
    });
  }, [ollamaCfg.hasKey, ollamaLoading, refreshModels]);

  const refreshOpenRouterModels = useCallback(async () => {
    await refreshModels({
      hasKey: openRouterCfg.hasKey, isLoading: openRouterLoading,
      setLoading: setOpenRouterLoading, setError: setOpenRouterError,
      setModels: setOpenRouterModelList, setUpdatedAt: setOpenRouterUpdatedAt,
      fetchModels: fetchOpenRouterModels,
      emptyMessage: 'No models returned by OpenRouter.',
      failureMessage: 'Failed to load OpenRouter models.',
    });
  }, [openRouterCfg.hasKey, openRouterLoading, refreshModels]);

  const refreshZenStandardModels = useCallback(async () => {
    await refreshModels({
      hasKey: zenCfg.hasKey, isLoading: zenLoading,
      setLoading: setZenLoading, setError: setZenError,
      setModels: setZenModelList, setUpdatedAt: setZenUpdatedAt,
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
      hasKey: nvidiaCfg.hasKey, isLoading: nvidiaLoading,
      setLoading: setNvidiaLoading, setError: setNvidiaError,
      setModels: setNvidiaModelList, setUpdatedAt: setNvidiaUpdatedAt,
      fetchModels: fetchNvidiaModels,
      emptyMessage: 'No models returned by Nvidia NIM.',
      failureMessage: 'Failed to load Nvidia NIM models.',
    });
  }, [nvidiaCfg.hasKey, nvidiaLoading, refreshModels]);

  const refreshBlackboxModels = useCallback(async () => {
    await refreshModels({
      hasKey: blackboxCfg.hasKey, isLoading: blackboxLoading,
      setLoading: setBlackboxLoading, setError: setBlackboxError,
      setModels: setBlackboxModelList, setUpdatedAt: setBlackboxUpdatedAt,
      fetchModels: fetchBlackboxModels,
      emptyMessage: 'No models returned by Blackbox AI.',
      failureMessage: 'Failed to load Blackbox AI models.',
    });
  }, [blackboxCfg.hasKey, blackboxLoading, refreshModels]);

  // Auto-fetch models when key becomes available
  useEffect(() => {
    if (shouldAutoFetchProviderModels({
      hasKey: ollamaCfg.hasKey,
      modelCount: ollamaModelList.length,
      loading: ollamaLoading,
      error: ollamaError,
    })) refreshOllamaModels();
  }, [ollamaCfg.hasKey, ollamaError, ollamaLoading, ollamaModelList.length, refreshOllamaModels]);
  useEffect(() => {
    if (shouldAutoFetchProviderModels({
      hasKey: openRouterCfg.hasKey,
      modelCount: openRouterModelList.length,
      loading: openRouterLoading,
      error: openRouterError,
    })) refreshOpenRouterModels();
  }, [openRouterCfg.hasKey, openRouterError, openRouterLoading, openRouterModelList.length, refreshOpenRouterModels]);
  useEffect(() => {
    if (!zenCfg.goMode && shouldAutoFetchProviderModels({
      hasKey: zenCfg.hasKey,
      modelCount: zenModelList.length,
      loading: zenLoading,
      error: zenError,
    })) refreshZenStandardModels();
  }, [refreshZenStandardModels, zenCfg.goMode, zenCfg.hasKey, zenError, zenLoading, zenModelList.length]);
  useEffect(() => {
    if (shouldAutoFetchProviderModels({
      hasKey: nvidiaCfg.hasKey,
      modelCount: nvidiaModelList.length,
      loading: nvidiaLoading,
      error: nvidiaError,
    })) refreshNvidiaModels();
  }, [nvidiaCfg.hasKey, nvidiaError, nvidiaLoading, nvidiaModelList.length, refreshNvidiaModels]);
  useEffect(() => {
    if (shouldAutoFetchProviderModels({
      hasKey: blackboxCfg.hasKey,
      modelCount: blackboxModelList.length,
      loading: blackboxLoading,
      error: blackboxError,
    })) refreshBlackboxModels();
  }, [blackboxCfg.hasKey, blackboxError, blackboxLoading, blackboxModelList.length, refreshBlackboxModels]);

  // Clear models when key is removed
  useEffect(() => { if (!ollamaCfg.hasKey) { setOllamaModelList([]); setOllamaError(null); setOllamaUpdatedAt(null); } }, [ollamaCfg.hasKey]);
  useEffect(() => { if (!openRouterCfg.hasKey) { setOpenRouterModelList([]); setOpenRouterError(null); setOpenRouterUpdatedAt(null); } }, [openRouterCfg.hasKey]);
  useEffect(() => {
    if (!zenCfg.hasKey) {
      setZenModelList([]); setZenError(null); setZenUpdatedAt(null); setZenLoading(false);
    }
  }, [zenCfg.hasKey]);
  useEffect(() => { if (!nvidiaCfg.hasKey) { setNvidiaModelList([]); setNvidiaError(null); setNvidiaUpdatedAt(null); } }, [nvidiaCfg.hasKey]);
  useEffect(() => { if (!blackboxCfg.hasKey) { setBlackboxModelList([]); setBlackboxError(null); setBlackboxUpdatedAt(null); } }, [blackboxCfg.hasKey]);

  const activeZenModelList = useMemo(
    () => (zenCfg.goMode ? [] : zenModelList),
    [zenCfg.goMode, zenModelList],
  );
  const activeZenLoading = zenCfg.goMode ? false : zenLoading;
  const activeZenError = zenCfg.goMode ? null : zenError;
  const activeZenUpdatedAt = zenCfg.goMode ? null : zenUpdatedAt;

  // Model option lists (ensure selected model is always included)
  const ollamaModelOptions = useMemo(() => includeSelectedModel(ollamaModelList, ollamaCfg.model), [ollamaModelList, ollamaCfg.model]);
  const openRouterModelOptions = useMemo(
    () => includeSelectedModel(openRouterModelList.length > 0 ? openRouterModelList : OPENROUTER_MODELS, openRouterCfg.model),
    [openRouterCfg.model, openRouterModelList],
  );
  const zenModelOptions = useMemo(
    () => includeSelectedModel(
      activeZenModelList.length > 0 ? activeZenModelList : (zenCfg.goMode ? ZEN_GO_MODELS : ZEN_MODELS),
      zenCfg.model,
    ),
    [activeZenModelList, zenCfg.goMode, zenCfg.model],
  );
  const nvidiaModelOptions = useMemo(() => includeSelectedModel(nvidiaModelList, nvidiaCfg.model), [nvidiaModelList, nvidiaCfg.model]);
  const blackboxModelOptions = useMemo(() => includeSelectedModel(blackboxModelList.length > 0 ? blackboxModelList : BLACKBOX_MODELS, blackboxCfg.model), [blackboxModelList, blackboxCfg.model]);
  const vertexModelOptions = useMemo(() => includeSelectedModel(vertexCfg.modelOptions, vertexCfg.model), [vertexCfg.modelOptions, vertexCfg.model]);

  return {
    ollama: { setKey: ollamaCfg.setKey, clearKey: ollamaCfg.clearKey, hasKey: ollamaCfg.hasKey, model: ollamaCfg.model, setModel: ollamaCfg.setModel, keyInput: ollamaKeyInput, setKeyInput: setOllamaKeyInput },
    openRouter: { setKey: openRouterCfg.setKey, clearKey: openRouterCfg.clearKey, hasKey: openRouterCfg.hasKey, model: openRouterCfg.model, setModel: openRouterCfg.setModel, keyInput: openRouterKeyInput, setKeyInput: setOpenRouterKeyInput },
    zen: { setKey: zenCfg.setKey, clearKey: zenCfg.clearKey, hasKey: zenCfg.hasKey, model: zenCfg.model, setModel: zenCfg.setModel, keyInput: zenKeyInput, setKeyInput: setZenKeyInput },
    nvidia: { setKey: nvidiaCfg.setKey, clearKey: nvidiaCfg.clearKey, hasKey: nvidiaCfg.hasKey, model: nvidiaCfg.model, setModel: nvidiaCfg.setModel, keyInput: nvidiaKeyInput, setKeyInput: setNvidiaKeyInput },
    blackbox: { setKey: blackboxCfg.setKey, clearKey: blackboxCfg.clearKey, hasKey: blackboxCfg.hasKey, model: blackboxCfg.model, setModel: blackboxCfg.setModel, keyInput: blackboxKeyInput, setKeyInput: setBlackboxKeyInput },
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
    tavily: { setKey: tavilyCfg.setKey, clearKey: tavilyCfg.clearKey, hasKey: tavilyCfg.hasKey, keyInput: tavilyKeyInput, setKeyInput: setTavilyKeyInput },

    activeBackend,
    setActiveBackend,
    activeProviderLabel,
    availableProviders,
    setPreferredProvider,
    clearPreferredProvider,

    ollamaModels: { models: ollamaModelList, loading: ollamaLoading, error: ollamaError, updatedAt: ollamaUpdatedAt },
    openRouterModels: { models: openRouterModelList, loading: openRouterLoading, error: openRouterError, updatedAt: openRouterUpdatedAt },
    zenModels: { models: activeZenModelList, loading: activeZenLoading, error: activeZenError, updatedAt: activeZenUpdatedAt },
    nvidiaModels: { models: nvidiaModelList, loading: nvidiaLoading, error: nvidiaError, updatedAt: nvidiaUpdatedAt },
    blackboxModels: { models: blackboxModelList, loading: blackboxLoading, error: blackboxError, updatedAt: blackboxUpdatedAt },

    ollamaModelOptions,
    openRouterModelOptions,
    zenModelOptions,
    nvidiaModelOptions: nvidiaModelList.length > 0 ? nvidiaModelOptions : NVIDIA_MODELS,
    blackboxModelOptions,

    zenGoMode: zenCfg.goMode,
    setZenGoMode: zenCfg.setGoMode,

    refreshOllamaModels,
    refreshOpenRouterModels,
    refreshZenModels,
    refreshNvidiaModels,
    refreshBlackboxModels,
  };
}
