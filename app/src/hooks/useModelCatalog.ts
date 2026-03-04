import { useState, useCallback, useMemo, useEffect } from 'react';
import {
  getPreferredProvider,
  setPreferredProvider,
  clearPreferredProvider,
  OPENROUTER_MODELS,
  MINIMAX_MODELS,
  ZAI_MODELS,
  GOOGLE_MODELS,
  ZEN_MODELS,
  NVIDIA_MODELS,
  type PreferredProvider,
} from '@/lib/providers';
import { getActiveProvider, type ActiveProvider } from '@/lib/orchestrator';
import {
  fetchOllamaModels,
  fetchMistralModels,
  fetchOpenRouterModels,
  fetchZaiModels,
  fetchGoogleModels,
  fetchZenModels,
  fetchNvidiaModels,
} from '@/lib/model-catalog';
import { useOllamaConfig } from '@/hooks/useOllamaConfig';
import { useMistralConfig } from '@/hooks/useMistralConfig';
import { useOpenRouterConfig } from '@/hooks/useOpenRouterConfig';
import { useMinimaxConfig } from '@/hooks/useMinimaxConfig';
import { useZaiConfig } from '@/hooks/useZaiConfig';
import { useGoogleConfig } from '@/hooks/useGoogleConfig';
import { useZenConfig } from '@/hooks/useZenConfig';
import { useNvidiaConfig } from '@/hooks/useNvidiaConfig';
import { useTavilyConfig } from '@/hooks/useTavilyConfig';

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
  model: string | null;
  setModel: (m: string) => void;
  keyInput: string;
  setKeyInput: (v: string) => void;
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
  mistral: ProviderKeyConfig;
  openRouter: ProviderKeyConfig;
  minimax: ProviderKeyConfig;
  zai: ProviderKeyConfig;
  google: ProviderKeyConfig;
  zen: ProviderKeyConfig;
  nvidia: ProviderKeyConfig;
  tavily: TavilyKeyConfig;

  // Active backend
  activeBackend: PreferredProvider | null;
  setActiveBackend: (p: PreferredProvider | null) => void;
  activeProviderLabel: ActiveProvider;
  availableProviders: readonly (readonly [string, string, boolean])[];
  setPreferredProvider: typeof setPreferredProvider;
  clearPreferredProvider: typeof clearPreferredProvider;

  // Per-provider model state
  ollamaModels: ProviderModelState;
  mistralModels: ProviderModelState;
  openRouterModels: ProviderModelState;
  minimaxModels: ProviderModelState;
  zaiModels: ProviderModelState;
  googleModels: ProviderModelState;
  zenModels: ProviderModelState;
  nvidiaModels: ProviderModelState;

  // Model option lists (includes selected even if not in fetched list)
  ollamaModelOptions: string[];
  mistralModelOptions: string[];
  openRouterModelOptions: string[];
  minimaxModelOptions: string[];
  zaiModelOptions: string[];
  googleModelOptions: string[];
  zenModelOptions: string[];
  nvidiaModelOptions: string[];

  // Refresh callbacks
  refreshOllamaModels: () => Promise<void>;
  refreshMistralModels: () => Promise<void>;
  refreshOpenRouterModels: () => Promise<void>;
  refreshMinimaxModels: () => void;
  refreshZaiModels: () => Promise<void>;
  refreshGoogleModels: () => Promise<void>;
  refreshZenModels: () => Promise<void>;
  refreshNvidiaModels: () => Promise<void>;
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
  const mistralCfg = useMistralConfig();
  const openRouterCfg = useOpenRouterConfig();
  const minimaxCfg = useMinimaxConfig();
  const zaiCfg = useZaiConfig();
  const googleCfg = useGoogleConfig();
  const zenCfg = useZenConfig();
  const nvidiaCfg = useNvidiaConfig();
  const tavilyCfg = useTavilyConfig();

  // Key input state (controlled text fields for Settings UI)
  const [ollamaKeyInput, setOllamaKeyInput] = useState('');
  const [mistralKeyInput, setMistralKeyInput] = useState('');
  const [openRouterKeyInput, setOpenRouterKeyInput] = useState('');
  const [minimaxKeyInput, setMinimaxKeyInput] = useState('');
  const [zaiKeyInput, setZaiKeyInput] = useState('');
  const [googleKeyInput, setGoogleKeyInput] = useState('');
  const [zenKeyInput, setZenKeyInput] = useState('');
  const [nvidiaKeyInput, setNvidiaKeyInput] = useState('');
  const [tavilyKeyInput, setTavilyKeyInput] = useState('');

  // Active backend state
  const [activeBackend, setActiveBackend] = useState<PreferredProvider | null>(() => getPreferredProvider());
  const activeProviderLabel = getActiveProvider();

  // Available providers (filtered by key presence), Zen first
  const availableProviders = ([
    ['zen', 'OpenCode Zen', zenCfg.hasKey],
    ['minimax', 'MiniMax', minimaxCfg.hasKey],
    ['ollama', 'Ollama', ollamaCfg.hasKey],
    ['mistral', 'Mistral', mistralCfg.hasKey],
    ['openrouter', 'OpenRouter', openRouterCfg.hasKey],
    ['zai', 'Z.AI', zaiCfg.hasKey],
    ['google', 'Google', googleCfg.hasKey],
    ['nvidia', 'Nvidia NIM', nvidiaCfg.hasKey],
  ] as const).filter(([, , has]) => has);

  // ----- Per-provider model lists -----

  const [ollamaModelList, setOllamaModelList] = useState<string[]>([]);
  const [mistralModelList, setMistralModelList] = useState<string[]>([]);
  const [openRouterModelList, setOpenRouterModelList] = useState<string[]>([]);
  const minimaxModelList = MINIMAX_MODELS;
  const [zaiModelList, setZaiModelList] = useState<string[]>([]);
  const [googleModelList, setGoogleModelList] = useState<string[]>([]);
  const [zenModelList, setZenModelList] = useState<string[]>([]);
  const [nvidiaModelList, setNvidiaModelList] = useState<string[]>([]);

  const [ollamaLoading, setOllamaLoading] = useState(false);
  const [mistralLoading, setMistralLoading] = useState(false);
  const [openRouterLoading, setOpenRouterLoading] = useState(false);
  const [zaiLoading, setZaiLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [zenLoading, setZenLoading] = useState(false);
  const [nvidiaLoading, setNvidiaLoading] = useState(false);

  const [ollamaError, setOllamaError] = useState<string | null>(null);
  const [mistralError, setMistralError] = useState<string | null>(null);
  const [openRouterError, setOpenRouterError] = useState<string | null>(null);
  const [zaiError, setZaiError] = useState<string | null>(null);
  const [googleError, setGoogleError] = useState<string | null>(null);
  const [zenError, setZenError] = useState<string | null>(null);
  const [nvidiaError, setNvidiaError] = useState<string | null>(null);

  const [ollamaUpdatedAt, setOllamaUpdatedAt] = useState<number | null>(null);
  const [mistralUpdatedAt, setMistralUpdatedAt] = useState<number | null>(null);
  const [openRouterUpdatedAt, setOpenRouterUpdatedAt] = useState<number | null>(null);
  const [zaiUpdatedAt, setZaiUpdatedAt] = useState<number | null>(null);
  const [googleUpdatedAt, setGoogleUpdatedAt] = useState<number | null>(null);
  const [zenUpdatedAt, setZenUpdatedAt] = useState<number | null>(null);
  const [nvidiaUpdatedAt, setNvidiaUpdatedAt] = useState<number | null>(null);

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

  const refreshMistralModels = useCallback(async () => {
    await refreshModels({
      hasKey: mistralCfg.hasKey, isLoading: mistralLoading,
      setLoading: setMistralLoading, setError: setMistralError,
      setModels: setMistralModelList, setUpdatedAt: setMistralUpdatedAt,
      fetchModels: fetchMistralModels,
      emptyMessage: 'No models returned by Mistral.',
      failureMessage: 'Failed to load Mistral models.',
    });
  }, [mistralCfg.hasKey, mistralLoading, refreshModels]);

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

  const refreshMinimaxModels = useCallback(() => {
    // MiniMax uses a fixed curated list; live /models is flaky.
  }, []);

  const refreshZaiModels = useCallback(async () => {
    await refreshModels({
      hasKey: zaiCfg.hasKey, isLoading: zaiLoading,
      setLoading: setZaiLoading, setError: setZaiError,
      setModels: setZaiModelList, setUpdatedAt: setZaiUpdatedAt,
      fetchModels: fetchZaiModels,
      emptyMessage: 'No models returned by Z.AI.',
      failureMessage: 'Failed to load Z.AI models.',
    });
  }, [zaiCfg.hasKey, zaiLoading, refreshModels]);

  const refreshGoogleModels = useCallback(async () => {
    await refreshModels({
      hasKey: googleCfg.hasKey, isLoading: googleLoading,
      setLoading: setGoogleLoading, setError: setGoogleError,
      setModels: setGoogleModelList, setUpdatedAt: setGoogleUpdatedAt,
      fetchModels: fetchGoogleModels,
      emptyMessage: 'No models returned by Google.',
      failureMessage: 'Failed to load Google models.',
    });
  }, [googleCfg.hasKey, googleLoading, refreshModels]);

  const refreshZenModels = useCallback(async () => {
    await refreshModels({
      hasKey: zenCfg.hasKey, isLoading: zenLoading,
      setLoading: setZenLoading, setError: setZenError,
      setModels: setZenModelList, setUpdatedAt: setZenUpdatedAt,
      fetchModels: fetchZenModels,
      emptyMessage: 'No models returned by OpenCode Zen.',
      failureMessage: 'Failed to load OpenCode Zen models.',
    });
  }, [zenCfg.hasKey, zenLoading, refreshModels]);

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

  // Auto-fetch models when key becomes available
  useEffect(() => { if (ollamaCfg.hasKey && ollamaModelList.length === 0 && !ollamaLoading) refreshOllamaModels(); }, [ollamaCfg.hasKey, ollamaModelList.length, ollamaLoading, refreshOllamaModels]);
  useEffect(() => { if (mistralCfg.hasKey && mistralModelList.length === 0 && !mistralLoading) refreshMistralModels(); }, [mistralCfg.hasKey, mistralModelList.length, mistralLoading, refreshMistralModels]);
  useEffect(() => { if (zaiCfg.hasKey && zaiModelList.length === 0 && !zaiLoading) refreshZaiModels(); }, [zaiCfg.hasKey, zaiModelList.length, zaiLoading, refreshZaiModels]);
  useEffect(() => { if (googleCfg.hasKey && googleModelList.length === 0 && !googleLoading) refreshGoogleModels(); }, [googleCfg.hasKey, googleModelList.length, googleLoading, refreshGoogleModels]);
  useEffect(() => { if (zenCfg.hasKey && zenModelList.length === 0 && !zenLoading) refreshZenModels(); }, [zenCfg.hasKey, zenModelList.length, zenLoading, refreshZenModels]);
  useEffect(() => { if (nvidiaCfg.hasKey && nvidiaModelList.length === 0 && !nvidiaLoading) refreshNvidiaModels(); }, [nvidiaCfg.hasKey, nvidiaModelList.length, nvidiaLoading, refreshNvidiaModels]);

  // Clear models when key is removed
  useEffect(() => { if (!ollamaCfg.hasKey) { setOllamaModelList([]); setOllamaError(null); setOllamaUpdatedAt(null); } }, [ollamaCfg.hasKey]);
  useEffect(() => { if (!mistralCfg.hasKey) { setMistralModelList([]); setMistralError(null); setMistralUpdatedAt(null); } }, [mistralCfg.hasKey]);
  useEffect(() => { if (!openRouterCfg.hasKey) { setOpenRouterModelList([]); setOpenRouterError(null); setOpenRouterUpdatedAt(null); } }, [openRouterCfg.hasKey]);
  useEffect(() => { if (!zaiCfg.hasKey) { setZaiModelList([]); setZaiError(null); setZaiUpdatedAt(null); } }, [zaiCfg.hasKey]);
  useEffect(() => { if (!googleCfg.hasKey) { setGoogleModelList([]); setGoogleError(null); setGoogleUpdatedAt(null); } }, [googleCfg.hasKey]);
  useEffect(() => { if (!zenCfg.hasKey) { setZenModelList([]); setZenError(null); setZenUpdatedAt(null); } }, [zenCfg.hasKey]);
  useEffect(() => { if (!nvidiaCfg.hasKey) { setNvidiaModelList([]); setNvidiaError(null); setNvidiaUpdatedAt(null); } }, [nvidiaCfg.hasKey]);

  // Model option lists (ensure selected model is always included)
  const ollamaModelOptions = useMemo(() => includeSelectedModel(ollamaModelList, ollamaCfg.model), [ollamaModelList, ollamaCfg.model]);
  const mistralModelOptions = useMemo(() => includeSelectedModel(mistralModelList, mistralCfg.model), [mistralModelList, mistralCfg.model]);
  const zaiModelOptions = useMemo(() => includeSelectedModel(zaiModelList, zaiCfg.model), [zaiModelList, zaiCfg.model]);
  const minimaxModelOptions = useMemo(() => includeSelectedModel(MINIMAX_MODELS, minimaxCfg.model), [minimaxCfg.model]);
  const googleModelOptions = useMemo(() => includeSelectedModel(googleModelList, googleCfg.model), [googleModelList, googleCfg.model]);
  const zenModelOptions = useMemo(() => includeSelectedModel(zenModelList, zenCfg.model), [zenModelList, zenCfg.model]);
  const nvidiaModelOptions = useMemo(() => includeSelectedModel(nvidiaModelList, nvidiaCfg.model), [nvidiaModelList, nvidiaCfg.model]);

  return {
    ollama: { setKey: ollamaCfg.setKey, clearKey: ollamaCfg.clearKey, hasKey: ollamaCfg.hasKey, model: ollamaCfg.model, setModel: ollamaCfg.setModel, keyInput: ollamaKeyInput, setKeyInput: setOllamaKeyInput },
    mistral: { setKey: mistralCfg.setKey, clearKey: mistralCfg.clearKey, hasKey: mistralCfg.hasKey, model: mistralCfg.model, setModel: mistralCfg.setModel, keyInput: mistralKeyInput, setKeyInput: setMistralKeyInput },
    openRouter: { setKey: openRouterCfg.setKey, clearKey: openRouterCfg.clearKey, hasKey: openRouterCfg.hasKey, model: openRouterCfg.model, setModel: openRouterCfg.setModel, keyInput: openRouterKeyInput, setKeyInput: setOpenRouterKeyInput },
    minimax: { setKey: minimaxCfg.setKey, clearKey: minimaxCfg.clearKey, hasKey: minimaxCfg.hasKey, model: minimaxCfg.model, setModel: minimaxCfg.setModel, keyInput: minimaxKeyInput, setKeyInput: setMinimaxKeyInput },
    zai: { setKey: zaiCfg.setKey, clearKey: zaiCfg.clearKey, hasKey: zaiCfg.hasKey, model: zaiCfg.model, setModel: zaiCfg.setModel, keyInput: zaiKeyInput, setKeyInput: setZaiKeyInput },
    google: { setKey: googleCfg.setKey, clearKey: googleCfg.clearKey, hasKey: googleCfg.hasKey, model: googleCfg.model, setModel: googleCfg.setModel, keyInput: googleKeyInput, setKeyInput: setGoogleKeyInput },
    zen: { setKey: zenCfg.setKey, clearKey: zenCfg.clearKey, hasKey: zenCfg.hasKey, model: zenCfg.model, setModel: zenCfg.setModel, keyInput: zenKeyInput, setKeyInput: setZenKeyInput },
    nvidia: { setKey: nvidiaCfg.setKey, clearKey: nvidiaCfg.clearKey, hasKey: nvidiaCfg.hasKey, model: nvidiaCfg.model, setModel: nvidiaCfg.setModel, keyInput: nvidiaKeyInput, setKeyInput: setNvidiaKeyInput },
    tavily: { setKey: tavilyCfg.setKey, clearKey: tavilyCfg.clearKey, hasKey: tavilyCfg.hasKey, keyInput: tavilyKeyInput, setKeyInput: setTavilyKeyInput },

    activeBackend,
    setActiveBackend,
    activeProviderLabel,
    availableProviders,
    setPreferredProvider,
    clearPreferredProvider,

    ollamaModels: { models: ollamaModelList, loading: ollamaLoading, error: ollamaError, updatedAt: ollamaUpdatedAt },
    mistralModels: { models: mistralModelList, loading: mistralLoading, error: mistralError, updatedAt: mistralUpdatedAt },
    openRouterModels: { models: openRouterModelList, loading: openRouterLoading, error: openRouterError, updatedAt: openRouterUpdatedAt },
    minimaxModels: { models: minimaxModelList, loading: false, error: null, updatedAt: null },
    zaiModels: { models: zaiModelList, loading: zaiLoading, error: zaiError, updatedAt: zaiUpdatedAt },
    googleModels: { models: googleModelList, loading: googleLoading, error: googleError, updatedAt: googleUpdatedAt },
    zenModels: { models: zenModelList, loading: zenLoading, error: zenError, updatedAt: zenUpdatedAt },
    nvidiaModels: { models: nvidiaModelList, loading: nvidiaLoading, error: nvidiaError, updatedAt: nvidiaUpdatedAt },

    ollamaModelOptions,
    mistralModelOptions,
    openRouterModelOptions: openRouterModelList.length > 0 ? openRouterModelList : OPENROUTER_MODELS,
    minimaxModelOptions: minimaxModelList.length > 0 ? minimaxModelOptions : MINIMAX_MODELS,
    zaiModelOptions: zaiModelList.length > 0 ? zaiModelOptions : ZAI_MODELS,
    googleModelOptions: googleModelList.length > 0 ? googleModelOptions : GOOGLE_MODELS,
    zenModelOptions: zenModelList.length > 0 ? zenModelOptions : ZEN_MODELS,
    nvidiaModelOptions: nvidiaModelList.length > 0 ? nvidiaModelOptions : NVIDIA_MODELS,

    refreshOllamaModels,
    refreshMistralModels,
    refreshOpenRouterModels,
    refreshMinimaxModels,
    refreshZaiModels,
    refreshGoogleModels,
    refreshZenModels,
    refreshNvidiaModels,
  };
}
