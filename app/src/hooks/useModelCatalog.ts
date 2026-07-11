import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
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
  ZAI_MODELS,
  KIMI_MODELS,
  HUGGINGFACE_MODELS,
  ZEN_MODELS,
  ZEN_GO_MODELS,
  NVIDIA_MODELS,
  FIREWORKS_DEFAULT_MODEL,
  FIREWORKS_MODELS,
  SAKANA_DEFAULT_MODEL,
  SAKANA_MODELS,
  XAI_MODELS,
  DEEPSEEK_MODELS,
  normalizeFireworksModelName,
  normalizeSakanaModelName,
  type PreferredProvider,
} from '@/lib/providers';
import { getActiveProvider, type ActiveProvider } from '@/lib/active-provider';
import { REAL_PROVIDERS, getProviderDisplayName } from '@push/lib/provider-definition';
import { resolveApiUrl } from '@/lib/api-url';
import {
  fetchCloudflareModels,
  fetchOllamaModels,
  fetchOpenRouterModels,
  fetchZaiModels,
  fetchKimiModels,
  fetchHuggingFaceModels,
  fetchZenModels,
  fetchNvidiaModels,
  fetchFireworksModels,
  fetchSakanaModels,
  fetchDeepSeekModels,
  fetchGoogleModels,
  fetchOpenAIModels,
  fetchXAIModels,
} from '@/lib/model-catalog';
import { useOllamaConfig } from '@/hooks/useOllamaConfig';
import { useOpenRouterConfig } from '@/hooks/useOpenRouterConfig';
import { useZaiConfig } from '@/hooks/useZaiConfig';
import { useKimiConfig } from '@/hooks/useKimiConfig';
import { useHuggingFaceConfig } from '@/hooks/useHuggingFaceConfig';
import { useAnthropicConfig } from '@/hooks/useAnthropicConfig';
import { useOpenAIConfig } from '@/hooks/useOpenAIConfig';
import { useXAIConfig } from '@/hooks/useXAIConfig';
import { useGoogleConfig } from '@/hooks/useGoogleConfig';
import { ANTHROPIC_MODELS, GOOGLE_MODELS, OPENAI_MODELS } from '@push/lib/provider-models';
import { useZenConfig } from '@/hooks/useZenConfig';
import { useNvidiaConfig } from '@/hooks/useNvidiaConfig';
import { useFireworksConfig } from '@/hooks/useFireworksConfig';
import { useSakanaConfig } from '@/hooks/useSakanaConfig';
import { useDeepSeekConfig } from '@/hooks/useDeepSeekConfig';
import { useTavilyConfig } from '@/hooks/useTavilyConfig';
import { useProviderCredentials } from '@/hooks/useProviderCredentials';
import {
  canAccessProviderModelCatalog,
  shouldAutoFetchProviderModels,
  scheduleAutoFetch,
  nextModelsRetryDelayMs,
} from './model-catalog-utils';
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
  zai: ProviderKeyConfig;
  kimi: ProviderKeyConfig;
  huggingface: ProviderKeyConfig;
  cloudflare: WorkerBoundProviderConfig;
  zen: ProviderKeyConfig;
  nvidia: ProviderKeyConfig;
  fireworks: ProviderKeyConfig;
  sakana: ProviderKeyConfig;
  deepseek: ProviderKeyConfig;
  anthropic: ProviderKeyConfig;
  openai: ProviderKeyConfig;
  xai: ProviderKeyConfig;
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
  zaiModels: ProviderModelState;
  kimiModels: ProviderModelState;
  huggingfaceModels: ProviderModelState;
  cloudflareModels: ProviderModelState;
  zenModels: ProviderModelState;
  nvidiaModels: ProviderModelState;
  fireworksModels: ProviderModelState;
  sakanaModels: ProviderModelState;
  deepseekModels: ProviderModelState;
  googleModels: ProviderModelState;
  openaiModels: ProviderModelState;
  xaiModels: ProviderModelState;

  // Model option lists (includes selected even if not in fetched list)
  ollamaModelOptions: string[];
  openRouterModelOptions: string[];
  zaiModelOptions: string[];
  kimiModelOptions: string[];
  huggingfaceModelOptions: string[];
  cloudflareModelOptions: string[];
  zenModelOptions: string[];
  nvidiaModelOptions: string[];
  fireworksModelOptions: string[];
  sakanaModelOptions: string[];
  deepseekModelOptions: string[];
  anthropicModelOptions: string[];
  openaiModelOptions: string[];
  xaiModelOptions: string[];
  googleModelOptions: string[];

  // Zen Go tier
  zenGoMode: boolean;
  setZenGoMode: (enabled: boolean) => void;

  // Refresh callbacks
  refreshOllamaModels: () => Promise<void>;
  refreshOpenRouterModels: () => Promise<void>;
  refreshZaiModels: () => Promise<void>;
  refreshKimiModels: () => Promise<void>;
  refreshHuggingFaceModels: () => Promise<void>;
  refreshCloudflareModels: () => Promise<void>;
  refreshZenModels: () => Promise<void>;
  refreshNvidiaModels: () => Promise<void>;
  refreshFireworksModels: () => Promise<void>;
  refreshSakanaModels: () => Promise<void>;
  refreshDeepSeekModels: () => Promise<void>;
  refreshGoogleModels: () => Promise<void>;
  refreshOpenAIModels: () => Promise<void>;
  refreshXAIModels: () => Promise<void>;
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
    case 'zai':
      return {
        provider,
        providerLabel: resolveProviderLabel(catalog, provider, 'Z.ai'),
        value: lockedModel ?? catalog.zai.model,
        options: includeSelectedModel(catalog.zaiModelOptions, lockedModel ?? catalog.zai.model),
        onChange: catalog.zai.setModel,
        loading: catalog.zaiModels.loading,
        error: catalog.zaiModels.error,
        onRefresh: catalog.refreshZaiModels,
        allowCustom: true,
      };
    case 'kimi':
      return {
        provider,
        providerLabel: resolveProviderLabel(catalog, provider, 'Kimi'),
        value: lockedModel ?? catalog.kimi.model,
        options: includeSelectedModel(catalog.kimiModelOptions, lockedModel ?? catalog.kimi.model),
        onChange: catalog.kimi.setModel,
        loading: catalog.kimiModels.loading,
        error: catalog.kimiModels.error,
        onRefresh: catalog.refreshKimiModels,
        allowCustom: true,
      };
    case 'huggingface':
      return {
        provider,
        providerLabel: resolveProviderLabel(catalog, provider, 'Hugging Face'),
        value: lockedModel ?? catalog.huggingface.model,
        options: includeSelectedModel(
          catalog.huggingfaceModelOptions,
          lockedModel ?? catalog.huggingface.model,
        ),
        onChange: catalog.huggingface.setModel,
        loading: catalog.huggingfaceModels.loading,
        error: catalog.huggingfaceModels.error,
        onRefresh: catalog.refreshHuggingFaceModels,
        allowCustom: true,
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
    case 'fireworks':
      return {
        provider,
        providerLabel: resolveProviderLabel(catalog, provider, 'Fireworks AI'),
        value: lockedModel ?? catalog.fireworks.model,
        options: includeSelectedModel(
          catalog.fireworksModelOptions,
          lockedModel ?? catalog.fireworks.model,
        ),
        onChange: catalog.fireworks.setModel,
        loading: catalog.fireworksModels.loading,
        error: catalog.fireworksModels.error,
        onRefresh: catalog.refreshFireworksModels,
      };
    case 'sakana':
      return {
        provider,
        providerLabel: resolveProviderLabel(catalog, provider, 'Sakana AI'),
        value: lockedModel ?? catalog.sakana.model,
        options: includeSelectedModel(
          catalog.sakanaModelOptions,
          lockedModel ?? catalog.sakana.model,
        ),
        onChange: catalog.sakana.setModel,
        loading: catalog.sakanaModels.loading,
        error: catalog.sakanaModels.error,
        onRefresh: catalog.refreshSakanaModels,
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
        loading: catalog.openaiModels.loading,
        error: catalog.openaiModels.error,
        onRefresh: catalog.refreshOpenAIModels,
        allowCustom: true,
      };
    case 'xai':
      return {
        provider,
        providerLabel: resolveProviderLabel(catalog, provider, 'xAI'),
        value: lockedModel ?? catalog.xai.model,
        options: includeSelectedModel(catalog.xaiModelOptions, lockedModel ?? catalog.xai.model),
        onChange: catalog.xai.setModel,
        loading: catalog.xaiModels.loading,
        error: catalog.xaiModels.error,
        onRefresh: catalog.refreshXAIModels,
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
        loading: catalog.googleModels.loading,
        error: catalog.googleModels.error,
        onRefresh: catalog.refreshGoogleModels,
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
  const zaiCfg = useZaiConfig();
  const kimiCfg = useKimiConfig();
  const huggingfaceCfg = useHuggingFaceConfig();
  const zenCfg = useZenConfig();
  const nvidiaCfg = useNvidiaConfig();
  const fireworksCfg = useFireworksConfig();
  const sakanaCfg = useSakanaConfig();
  const deepseekCfg = useDeepSeekConfig();
  const anthropicCfg = useAnthropicConfig();
  const openaiCfg = useOpenAIConfig();
  const xaiCfg = useXAIConfig();
  const googleCfg = useGoogleConfig();
  const tavilyCfg = useTavilyConfig();

  // Key input state (controlled text fields for Settings UI)
  const [ollamaKeyInput, setOllamaKeyInput] = useState('');
  const [openRouterKeyInput, setOpenRouterKeyInput] = useState('');
  const [zaiKeyInput, setZaiKeyInput] = useState('');
  const [kimiKeyInput, setKimiKeyInput] = useState('');
  const [huggingfaceKeyInput, setHuggingFaceKeyInput] = useState('');
  const [zenKeyInput, setZenKeyInput] = useState('');
  const [nvidiaKeyInput, setNvidiaKeyInput] = useState('');
  const [fireworksKeyInput, setFireworksKeyInput] = useState('');
  const [sakanaKeyInput, setSakanaKeyInput] = useState('');
  const [deepseekKeyInput, setDeepseekKeyInput] = useState('');
  const [anthropicKeyInput, setAnthropicKeyInput] = useState('');
  const [openaiKeyInput, setOpenaiKeyInput] = useState('');
  const [xaiKeyInput, setXaiKeyInput] = useState('');
  const [googleKeyInput, setGoogleKeyInput] = useState('');
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

  // Available providers: a provider is usable with a local key OR a
  // server-resolvable credential (gateway BYOK, Worker secret, user-stored
  // key — see worker-provider-capabilities.ts). Local keys alone under-report
  // now that keys can live entirely server-side; the proxy prefers the server
  // credential anyway (standardAuth / BYOK header omission), so a keyless
  // client is fully functional against a credentialed server.
  const credentials = useProviderCredentials();
  const serverUnlocked = (provider: PreferredProvider): boolean =>
    (credentials.sources[provider] ?? null) !== null;
  const providerAvailability = {
    ollama: ollamaCfg.hasKey || serverUnlocked('ollama'),
    openrouter: openRouterCfg.hasKey || serverUnlocked('openrouter'),
    zai: zaiCfg.hasKey || serverUnlocked('zai'),
    kimi: kimiCfg.hasKey || serverUnlocked('kimi'),
    huggingface: huggingfaceCfg.hasKey || serverUnlocked('huggingface'),
    cloudflare: cloudflareConfigured || serverUnlocked('cloudflare'),
    zen: zenCfg.hasKey || serverUnlocked('zen'),
    nvidia: nvidiaCfg.hasKey || serverUnlocked('nvidia'),
    fireworks: fireworksCfg.hasKey || serverUnlocked('fireworks'),
    deepseek: deepseekCfg.hasKey || serverUnlocked('deepseek'),
    sakana: sakanaCfg.hasKey || serverUnlocked('sakana'),
    anthropic: anthropicCfg.hasKey || serverUnlocked('anthropic'),
    openai: openaiCfg.hasKey || serverUnlocked('openai'),
    xai: xaiCfg.hasKey || serverUnlocked('xai'),
    google: googleCfg.hasKey || serverUnlocked('google'),
  } satisfies Record<PreferredProvider, boolean>;

  const catalogAvailable = (provider: PreferredProvider, hasLocalKey: boolean): boolean =>
    canAccessProviderModelCatalog({
      provider,
      hasLocalKey,
      credentialSource: credentials.sources[provider],
    });
  const providerCatalogAvailability = {
    ollama: catalogAvailable('ollama', ollamaCfg.hasKey),
    openrouter: catalogAvailable('openrouter', openRouterCfg.hasKey),
    zai: catalogAvailable('zai', zaiCfg.hasKey),
    kimi: catalogAvailable('kimi', kimiCfg.hasKey),
    huggingface: catalogAvailable('huggingface', huggingfaceCfg.hasKey),
    zen: catalogAvailable('zen', zenCfg.hasKey),
    nvidia: catalogAvailable('nvidia', nvidiaCfg.hasKey),
    fireworks: catalogAvailable('fireworks', fireworksCfg.hasKey),
    deepseek: catalogAvailable('deepseek', deepseekCfg.hasKey),
    sakana: catalogAvailable('sakana', sakanaCfg.hasKey),
    openai: catalogAvailable('openai', openaiCfg.hasKey),
    xai: catalogAvailable('xai', xaiCfg.hasKey),
    google: catalogAvailable('google', googleCfg.hasKey),
  } as const;

  const availableProviders = REAL_PROVIDERS.map(
    (provider) =>
      [provider, getProviderDisplayName(provider), providerAvailability[provider]] as const,
  ).filter(([, , has]) => has);

  // ----- Per-provider model lists -----

  const [ollamaModelList, setOllamaModelList] = useState<string[]>([]);
  const [openRouterModelList, setOpenRouterModelList] = useState<string[]>([]);
  const [zaiModelList, setZaiModelList] = useState<string[]>([]);
  const [kimiModelList, setKimiModelList] = useState<string[]>([]);
  const [huggingfaceModelList, setHuggingFaceModelList] = useState<string[]>([]);
  const [cloudflareModelList, setCloudflareModelList] = useState<string[]>([]);
  const [zenModelList, setZenModelList] = useState<string[]>([]);
  const [nvidiaModelList, setNvidiaModelList] = useState<string[]>([]);
  const [fireworksModelList, setFireworksModelList] = useState<string[]>([]);
  const [sakanaModelList, setSakanaModelList] = useState<string[]>([]);
  const [deepseekModelList, setDeepseekModelList] = useState<string[]>([]);
  const [googleModelList, setGoogleModelList] = useState<string[]>([]);
  const [openaiModelList, setOpenaiModelList] = useState<string[]>([]);
  const [xaiModelList, setXaiModelList] = useState<string[]>([]);

  const [ollamaLoading, setOllamaLoading] = useState(false);
  const [openRouterLoading, setOpenRouterLoading] = useState(false);
  const [zaiLoading, setZaiLoading] = useState(false);
  const [kimiLoading, setKimiLoading] = useState(false);
  const [huggingfaceLoading, setHuggingFaceLoading] = useState(false);
  const [cloudflareLoading, setCloudflareLoading] = useState(false);
  const [zenLoading, setZenLoading] = useState(false);
  const [nvidiaLoading, setNvidiaLoading] = useState(false);
  const [fireworksLoading, setFireworksLoading] = useState(false);
  const [sakanaLoading, setSakanaLoading] = useState(false);
  const [deepseekLoading, setDeepseekLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [openaiLoading, setOpenaiLoading] = useState(false);
  const [xaiLoading, setXaiLoading] = useState(false);

  const [ollamaError, setOllamaError] = useState<string | null>(null);
  const [openRouterError, setOpenRouterError] = useState<string | null>(null);
  const [zaiError, setZaiError] = useState<string | null>(null);
  const [kimiError, setKimiError] = useState<string | null>(null);
  const [huggingfaceError, setHuggingFaceError] = useState<string | null>(null);
  const [cloudflareError, setCloudflareError] = useState<string | null>(null);
  const [zenError, setZenError] = useState<string | null>(null);
  const [nvidiaError, setNvidiaError] = useState<string | null>(null);
  const [fireworksError, setFireworksError] = useState<string | null>(null);
  const [sakanaError, setSakanaError] = useState<string | null>(null);
  const [deepseekError, setDeepseekError] = useState<string | null>(null);
  const [googleError, setGoogleError] = useState<string | null>(null);
  const [openaiError, setOpenaiError] = useState<string | null>(null);
  const [xaiError, setXaiError] = useState<string | null>(null);

  const [ollamaUpdatedAt, setOllamaUpdatedAt] = useState<number | null>(null);
  const [openRouterUpdatedAt, setOpenRouterUpdatedAt] = useState<number | null>(null);
  const [zaiUpdatedAt, setZaiUpdatedAt] = useState<number | null>(null);
  const [kimiUpdatedAt, setKimiUpdatedAt] = useState<number | null>(null);
  const [huggingfaceUpdatedAt, setHuggingFaceUpdatedAt] = useState<number | null>(null);
  const [cloudflareUpdatedAt, setCloudflareUpdatedAt] = useState<number | null>(null);
  const [zenUpdatedAt, setZenUpdatedAt] = useState<number | null>(null);
  const [nvidiaUpdatedAt, setNvidiaUpdatedAt] = useState<number | null>(null);
  const [fireworksUpdatedAt, setFireworksUpdatedAt] = useState<number | null>(null);
  const [sakanaUpdatedAt, setSakanaUpdatedAt] = useState<number | null>(null);
  const [deepseekUpdatedAt, setDeepseekUpdatedAt] = useState<number | null>(null);
  const [googleUpdatedAt, setGoogleUpdatedAt] = useState<number | null>(null);
  const [openaiUpdatedAt, setOpenaiUpdatedAt] = useState<number | null>(null);
  const [xaiUpdatedAt, setXaiUpdatedAt] = useState<number | null>(null);

  // Pending backoff-retry timers, keyed by the provider's stable `setModels`
  // setter. Keyed (not a flat Set) so a fresh fetch for a provider can cancel
  // that provider's in-flight retry — otherwise a manual refresh during backoff
  // would spawn a second concurrent retry chain. Cleared on unmount so a
  // scheduled retry never fires setState after the hook is gone.
  const retryTimersRef = useRef<Map<(m: string[]) => void, number>>(new Map());
  useEffect(() => {
    const timers = retryTimersRef.current;
    return () => {
      for (const id of timers.values()) window.clearTimeout(id);
      timers.clear();
    };
  }, []);

  // Generic refresh helper. On failure it schedules a bounded exponential
  // backoff retry: without this, a single transient model-list failure sets the
  // provider's error and `shouldAutoFetchProviderModels` stays false forever
  // (the `!error` gate), pinning the selector to its hardcoded fallback list for
  // the rest of the session until a manual refresh/remount.
  const refreshModels = useCallback(
    async (params: {
      canFetch: boolean;
      isLoading: boolean;
      setLoading: (v: boolean) => void;
      setError: (v: string | null) => void;
      setModels: (m: string[]) => void;
      setUpdatedAt: (v: number) => void;
      fetchModels: () => Promise<string[]>;
      emptyMessage: string;
      failureMessage: string;
    }) => {
      if (!params.canFetch || params.isLoading) return;
      // Cancel any pending retry for this provider before starting a fresh run,
      // so a manual refresh during backoff doesn't run two retry chains at once.
      const pending = retryTimersRef.current.get(params.setModels);
      if (pending !== undefined) {
        window.clearTimeout(pending);
        retryTimersRef.current.delete(params.setModels);
      }
      const run = async (attempt: number) => {
        params.setLoading(true);
        params.setError(null);
        try {
          const models = await params.fetchModels();
          params.setModels(models);
          params.setUpdatedAt(Date.now());
          if (models.length === 0) params.setError(params.emptyMessage);
        } catch (err) {
          params.setError(err instanceof Error ? err.message : params.failureMessage);
          const delay = nextModelsRetryDelayMs(attempt);
          if (delay != null) {
            // Structured log so a slow/flaky provider endpoint is visible to ops
            // rather than silently degrading to the fallback list.
            console.log(
              JSON.stringify({
                level: 'warn',
                event: 'provider_models_fetch_retry_scheduled',
                attempt: attempt + 1,
                delayMs: delay,
              }),
            );
            const id = window.setTimeout(() => {
              retryTimersRef.current.delete(params.setModels);
              void run(attempt + 1);
            }, delay);
            retryTimersRef.current.set(params.setModels, id);
          }
        } finally {
          params.setLoading(false);
        }
      };
      await run(0);
    },
    [],
  );

  // Per-provider refresh callbacks
  // Metadata-backed providers default `force` to true so the picker's manual
  // refresh revalidates the models.dev cache (surfacing new upstream models the
  // curated builders would otherwise fail-close on). The auto-fetch effects
  // below pass `false` to keep first-load on the cached metadata.
  const refreshOllamaModels = useCallback(
    async (force = true) => {
      await refreshModels({
        canFetch: providerCatalogAvailability.ollama,
        isLoading: ollamaLoading,
        setLoading: setOllamaLoading,
        setError: setOllamaError,
        setModels: setOllamaModelList,
        setUpdatedAt: setOllamaUpdatedAt,
        fetchModels: () => fetchOllamaModels({ forceMetadataRefresh: force }),
        emptyMessage: 'No models returned by Ollama.',
        failureMessage: 'Failed to load Ollama models.',
      });
    },
    [providerCatalogAvailability.ollama, ollamaLoading, refreshModels],
  );

  const refreshOpenRouterModels = useCallback(
    async (force = true) => {
      await refreshModels({
        canFetch: providerCatalogAvailability.openrouter,
        isLoading: openRouterLoading,
        setLoading: setOpenRouterLoading,
        setError: setOpenRouterError,
        setModels: setOpenRouterModelList,
        setUpdatedAt: setOpenRouterUpdatedAt,
        fetchModels: () => fetchOpenRouterModels({ forceMetadataRefresh: force }),
        emptyMessage: 'No models returned by OpenRouter.',
        failureMessage: 'Failed to load OpenRouter models.',
      });
    },
    [providerCatalogAvailability.openrouter, openRouterLoading, refreshModels],
  );

  const refreshZaiModels = useCallback(async () => {
    await refreshModels({
      canFetch: providerCatalogAvailability.zai,
      isLoading: zaiLoading,
      setLoading: setZaiLoading,
      setError: setZaiError,
      setModels: setZaiModelList,
      setUpdatedAt: setZaiUpdatedAt,
      fetchModels: fetchZaiModels,
      emptyMessage: 'No models returned by Z.ai.',
      failureMessage: 'Failed to load Z.ai models.',
    });
  }, [providerCatalogAvailability.zai, zaiLoading, refreshModels]);

  const refreshKimiModels = useCallback(async () => {
    await refreshModels({
      canFetch: providerCatalogAvailability.kimi,
      isLoading: kimiLoading,
      setLoading: setKimiLoading,
      setError: setKimiError,
      setModels: setKimiModelList,
      setUpdatedAt: setKimiUpdatedAt,
      fetchModels: fetchKimiModels,
      emptyMessage: 'No models returned by Kimi.',
      failureMessage: 'Failed to load Kimi models.',
    });
  }, [providerCatalogAvailability.kimi, kimiLoading, refreshModels]);

  const refreshHuggingFaceModels = useCallback(
    async (force = true) => {
      await refreshModels({
        canFetch: providerCatalogAvailability.huggingface,
        isLoading: huggingfaceLoading,
        setLoading: setHuggingFaceLoading,
        setError: setHuggingFaceError,
        setModels: setHuggingFaceModelList,
        setUpdatedAt: setHuggingFaceUpdatedAt,
        fetchModels: () => fetchHuggingFaceModels({ forceMetadataRefresh: force }),
        emptyMessage: 'No models returned by Hugging Face.',
        failureMessage: 'Failed to load Hugging Face models.',
      });
    },
    [providerCatalogAvailability.huggingface, huggingfaceLoading, refreshModels],
  );

  // Manual refresh defaults `force` to true so the picker revalidates the
  // cached binding catalog; the auto-fetch effect below passes `false` to serve
  // first-load from cache. Mirrors the metadata-backed providers above.
  const refreshCloudflareModels = useCallback(
    async (force = true) => {
      if (cloudflareLoading) return;
      setCloudflareLoading(true);
      setCloudflareError(null);
      try {
        const models = await fetchCloudflareModels({ force });
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
    },
    [cloudflareLoading, setCloudflareConfiguredStateAndPersist],
  );

  const refreshZenStandardModels = useCallback(
    async (force = true) => {
      await refreshModels({
        canFetch: providerCatalogAvailability.zen,
        isLoading: zenLoading,
        setLoading: setZenLoading,
        setError: setZenError,
        setModels: setZenModelList,
        setUpdatedAt: setZenUpdatedAt,
        fetchModels: () => fetchZenModels({ forceMetadataRefresh: force }),
        emptyMessage: 'No models returned by OpenCode Zen.',
        failureMessage: 'Failed to load OpenCode Zen models.',
      });
    },
    [providerCatalogAvailability.zen, zenLoading, refreshModels],
  );

  const refreshZenModels = useCallback(
    async (force = true) => {
      if (zenCfg.goMode) {
        setZenError(null);
        return;
      }
      await refreshZenStandardModels(force);
    },
    [refreshZenStandardModels, zenCfg.goMode],
  );

  const refreshNvidiaModels = useCallback(
    async (force = true) => {
      await refreshModels({
        canFetch: providerCatalogAvailability.nvidia,
        isLoading: nvidiaLoading,
        setLoading: setNvidiaLoading,
        setError: setNvidiaError,
        setModels: setNvidiaModelList,
        setUpdatedAt: setNvidiaUpdatedAt,
        fetchModels: () => fetchNvidiaModels({ forceMetadataRefresh: force }),
        emptyMessage: 'No models returned by Nvidia NIM.',
        failureMessage: 'Failed to load Nvidia NIM models.',
      });
    },
    [providerCatalogAvailability.nvidia, nvidiaLoading, refreshModels],
  );

  const refreshFireworksModels = useCallback(async () => {
    await refreshModels({
      canFetch: providerCatalogAvailability.fireworks,
      isLoading: fireworksLoading,
      setLoading: setFireworksLoading,
      setError: setFireworksError,
      setModels: setFireworksModelList,
      setUpdatedAt: setFireworksUpdatedAt,
      fetchModels: fetchFireworksModels,
      emptyMessage: 'No models returned by Fireworks AI.',
      failureMessage: 'Failed to load Fireworks AI models.',
    });
  }, [providerCatalogAvailability.fireworks, fireworksLoading, refreshModels]);

  const refreshDeepSeekModels = useCallback(async () => {
    await refreshModels({
      canFetch: providerCatalogAvailability.deepseek,
      isLoading: deepseekLoading,
      setLoading: setDeepseekLoading,
      setError: setDeepseekError,
      setModels: setDeepseekModelList,
      setUpdatedAt: setDeepseekUpdatedAt,
      fetchModels: fetchDeepSeekModels,
      emptyMessage: 'No models returned by DeepSeek.',
      failureMessage: 'Failed to load DeepSeek models.',
    });
  }, [providerCatalogAvailability.deepseek, deepseekLoading, refreshModels]);

  const refreshSakanaModels = useCallback(async () => {
    await refreshModels({
      canFetch: providerCatalogAvailability.sakana,
      isLoading: sakanaLoading,
      setLoading: setSakanaLoading,
      setError: setSakanaError,
      setModels: setSakanaModelList,
      setUpdatedAt: setSakanaUpdatedAt,
      fetchModels: fetchSakanaModels,
      emptyMessage: 'No models returned by Sakana AI.',
      failureMessage: 'Failed to load Sakana AI models.',
    });
  }, [providerCatalogAvailability.sakana, sakanaLoading, refreshModels]);

  // Google/OpenAI/xAI fetch live lists from the Worker proxies, which filter to
  // chat-capable models and fall back to the curated list on key-missing or
  // upstream failure. No models.dev metadata pass, so no force flag.
  const refreshGoogleModels = useCallback(async () => {
    await refreshModels({
      canFetch: providerCatalogAvailability.google,
      isLoading: googleLoading,
      setLoading: setGoogleLoading,
      setError: setGoogleError,
      setModels: setGoogleModelList,
      setUpdatedAt: setGoogleUpdatedAt,
      fetchModels: fetchGoogleModels,
      emptyMessage: 'No models returned by Google Gemini.',
      failureMessage: 'Failed to load Google Gemini models.',
    });
  }, [providerCatalogAvailability.google, googleLoading, refreshModels]);

  const refreshOpenAIModels = useCallback(async () => {
    await refreshModels({
      canFetch: providerCatalogAvailability.openai,
      isLoading: openaiLoading,
      setLoading: setOpenaiLoading,
      setError: setOpenaiError,
      setModels: setOpenaiModelList,
      setUpdatedAt: setOpenaiUpdatedAt,
      fetchModels: fetchOpenAIModels,
      emptyMessage: 'No models returned by OpenAI.',
      failureMessage: 'Failed to load OpenAI models.',
    });
  }, [providerCatalogAvailability.openai, openaiLoading, refreshModels]);

  const refreshXAIModels = useCallback(async () => {
    await refreshModels({
      canFetch: providerCatalogAvailability.xai,
      isLoading: xaiLoading,
      setLoading: setXaiLoading,
      setError: setXaiError,
      setModels: setXaiModelList,
      setUpdatedAt: setXaiUpdatedAt,
      fetchModels: fetchXAIModels,
      emptyMessage: 'No models returned by xAI.',
      failureMessage: 'Failed to load xAI models.',
    });
  }, [providerCatalogAvailability.xai, xaiLoading, refreshModels]);

  // Auto-fetch models when their catalog becomes reachable.
  // The active provider fetches immediately; all others are deferred via
  // requestIdleCallback (or a short setTimeout) so startup isn't blocked.
  useEffect(() => {
    const id = setTimeout(() => {
      void refreshCloudflareStatus();
    }, 0);
    return () => clearTimeout(id);
  }, [refreshCloudflareStatus]);

  useEffect(
    () =>
      scheduleAutoFetch(
        shouldAutoFetchProviderModels({
          canFetch: providerCatalogAvailability.ollama,
          modelCount: ollamaModelList.length,
          loading: ollamaLoading,
          error: ollamaError,
        }),
        activeProviderLabel === 'ollama',
        () => {
          void refreshOllamaModels(false);
        },
      ),
    [
      activeProviderLabel,
      providerCatalogAvailability.ollama,
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
          canFetch: providerCatalogAvailability.openrouter,
          modelCount: openRouterModelList.length,
          loading: openRouterLoading,
          error: openRouterError,
        }),
        activeProviderLabel === 'openrouter',
        () => {
          void refreshOpenRouterModels(false);
        },
      ),
    [
      activeProviderLabel,
      providerCatalogAvailability.openrouter,
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
          canFetch: providerCatalogAvailability.zai,
          modelCount: zaiModelList.length,
          loading: zaiLoading,
          error: zaiError,
        }),
        activeProviderLabel === 'zai',
        () => {
          void refreshZaiModels();
        },
      ),
    [
      activeProviderLabel,
      providerCatalogAvailability.zai,
      zaiError,
      zaiLoading,
      zaiModelList.length,
      refreshZaiModels,
      refreshKimiModels,
    ],
  );
  useEffect(
    () =>
      scheduleAutoFetch(
        shouldAutoFetchProviderModels({
          canFetch: providerCatalogAvailability.kimi,
          modelCount: kimiModelList.length,
          loading: kimiLoading,
          error: kimiError,
        }),
        activeProviderLabel === 'kimi',
        () => {
          void refreshKimiModels();
        },
      ),
    [
      activeProviderLabel,
      providerCatalogAvailability.kimi,
      kimiError,
      kimiLoading,
      kimiModelList.length,
      refreshKimiModels,
    ],
  );
  useEffect(
    () =>
      scheduleAutoFetch(
        shouldAutoFetchProviderModels({
          canFetch: providerCatalogAvailability.huggingface,
          modelCount: huggingfaceModelList.length,
          loading: huggingfaceLoading,
          error: huggingfaceError,
        }),
        activeProviderLabel === 'huggingface',
        () => {
          void refreshHuggingFaceModels(false);
        },
      ),
    [
      activeProviderLabel,
      providerCatalogAvailability.huggingface,
      huggingfaceError,
      huggingfaceLoading,
      huggingfaceModelList.length,
      refreshHuggingFaceModels,
    ],
  );
  useEffect(
    () =>
      scheduleAutoFetch(
        shouldAutoFetchProviderModels({
          canFetch: cloudflareConfigured,
          modelCount: cloudflareModelList.length,
          loading: cloudflareLoading,
          error: cloudflareError,
        }),
        activeProviderLabel === 'cloudflare',
        () => {
          void refreshCloudflareModels(false);
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
            canFetch: providerCatalogAvailability.zen,
            modelCount: zenModelList.length,
            loading: zenLoading,
            error: zenError,
          }),
        activeProviderLabel === 'zen',
        () => {
          void refreshZenStandardModels(false);
        },
      ),
    [
      activeProviderLabel,
      refreshZenStandardModels,
      zenCfg.goMode,
      providerCatalogAvailability.zen,
      zenError,
      zenLoading,
      zenModelList.length,
    ],
  );
  useEffect(
    () =>
      scheduleAutoFetch(
        shouldAutoFetchProviderModels({
          canFetch: providerCatalogAvailability.nvidia,
          modelCount: nvidiaModelList.length,
          loading: nvidiaLoading,
          error: nvidiaError,
        }),
        activeProviderLabel === 'nvidia',
        () => {
          void refreshNvidiaModels(false);
        },
      ),
    [
      activeProviderLabel,
      providerCatalogAvailability.nvidia,
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
          canFetch: providerCatalogAvailability.fireworks,
          modelCount: fireworksModelList.length,
          loading: fireworksLoading,
          error: fireworksError,
        }),
        activeProviderLabel === 'fireworks',
        () => {
          void refreshFireworksModels();
        },
      ),
    [
      activeProviderLabel,
      providerCatalogAvailability.fireworks,
      fireworksError,
      fireworksLoading,
      fireworksModelList.length,
      refreshFireworksModels,
    ],
  );
  useEffect(
    () =>
      scheduleAutoFetch(
        shouldAutoFetchProviderModels({
          canFetch: providerCatalogAvailability.deepseek,
          modelCount: deepseekModelList.length,
          loading: deepseekLoading,
          error: deepseekError,
        }),
        activeProviderLabel === 'deepseek',
        () => {
          void refreshDeepSeekModels();
        },
      ),
    [
      activeProviderLabel,
      providerCatalogAvailability.deepseek,
      deepseekError,
      deepseekLoading,
      deepseekModelList.length,
      refreshDeepSeekModels,
    ],
  );
  useEffect(
    () =>
      scheduleAutoFetch(
        shouldAutoFetchProviderModels({
          canFetch: providerCatalogAvailability.sakana,
          modelCount: sakanaModelList.length,
          loading: sakanaLoading,
          error: sakanaError,
        }),
        activeProviderLabel === 'sakana',
        () => {
          void refreshSakanaModels();
        },
      ),
    [
      activeProviderLabel,
      providerCatalogAvailability.sakana,
      sakanaError,
      sakanaLoading,
      sakanaModelList.length,
      refreshSakanaModels,
    ],
  );
  useEffect(
    () =>
      scheduleAutoFetch(
        shouldAutoFetchProviderModels({
          canFetch: providerCatalogAvailability.google,
          modelCount: googleModelList.length,
          loading: googleLoading,
          error: googleError,
        }),
        activeProviderLabel === 'google',
        () => {
          void refreshGoogleModels();
        },
      ),
    [
      activeProviderLabel,
      providerCatalogAvailability.google,
      googleError,
      googleLoading,
      googleModelList.length,
      refreshGoogleModels,
    ],
  );
  useEffect(
    () =>
      scheduleAutoFetch(
        shouldAutoFetchProviderModels({
          canFetch: providerCatalogAvailability.openai,
          modelCount: openaiModelList.length,
          loading: openaiLoading,
          error: openaiError,
        }),
        activeProviderLabel === 'openai',
        () => {
          void refreshOpenAIModels();
        },
      ),
    [
      activeProviderLabel,
      providerCatalogAvailability.openai,
      openaiError,
      openaiLoading,
      openaiModelList.length,
      refreshOpenAIModels,
    ],
  );
  useEffect(
    () =>
      scheduleAutoFetch(
        shouldAutoFetchProviderModels({
          canFetch: providerCatalogAvailability.xai,
          modelCount: xaiModelList.length,
          loading: xaiLoading,
          error: xaiError,
        }),
        activeProviderLabel === 'xai',
        () => {
          void refreshXAIModels();
        },
      ),
    [
      activeProviderLabel,
      providerCatalogAvailability.xai,
      xaiError,
      xaiLoading,
      xaiModelList.length,
      refreshXAIModels,
    ],
  );

  // Clear models when their catalog is no longer reachable.
  useEffect(() => {
    if (!cloudflareConfigured) {
      const id = setTimeout(() => {
        setCloudflareModelList([]);
        setCloudflareError(null);
        setCloudflareUpdatedAt(null);
        setCloudflareLoading(false);
      }, 0);
      return () => clearTimeout(id);
    }
  }, [cloudflareConfigured]);
  useEffect(() => {
    if (!providerCatalogAvailability.ollama) {
      const id = setTimeout(() => {
        setOllamaModelList([]);
        setOllamaError(null);
        setOllamaUpdatedAt(null);
      }, 0);
      return () => clearTimeout(id);
    }
  }, [providerCatalogAvailability.ollama]);
  useEffect(() => {
    if (!providerCatalogAvailability.openrouter) {
      const id = setTimeout(() => {
        setOpenRouterModelList([]);
        setOpenRouterError(null);
        setOpenRouterUpdatedAt(null);
      }, 0);
      return () => clearTimeout(id);
    }
  }, [providerCatalogAvailability.openrouter]);
  useEffect(() => {
    if (!providerCatalogAvailability.zai) {
      const id = setTimeout(() => {
        setZaiModelList([]);
        setZaiError(null);
        setZaiUpdatedAt(null);
      }, 0);
      return () => clearTimeout(id);
    }
  }, [providerCatalogAvailability.zai]);
  useEffect(() => {
    if (!providerCatalogAvailability.kimi) {
      const id = setTimeout(() => {
        setKimiModelList([]);
        setKimiError(null);
        setKimiUpdatedAt(null);
      }, 0);
      return () => clearTimeout(id);
    }
  }, [providerCatalogAvailability.kimi]);
  useEffect(() => {
    if (!providerCatalogAvailability.huggingface) {
      const id = setTimeout(() => {
        setHuggingFaceModelList([]);
        setHuggingFaceError(null);
        setHuggingFaceUpdatedAt(null);
      }, 0);
      return () => clearTimeout(id);
    }
  }, [providerCatalogAvailability.huggingface]);
  useEffect(() => {
    if (!providerCatalogAvailability.zen) {
      const id = setTimeout(() => {
        setZenModelList([]);
        setZenError(null);
        setZenUpdatedAt(null);
        setZenLoading(false);
      }, 0);
      return () => clearTimeout(id);
    }
  }, [providerCatalogAvailability.zen]);
  useEffect(() => {
    if (!providerCatalogAvailability.nvidia) {
      const id = setTimeout(() => {
        setNvidiaModelList([]);
        setNvidiaError(null);
        setNvidiaUpdatedAt(null);
      }, 0);
      return () => clearTimeout(id);
    }
  }, [providerCatalogAvailability.nvidia]);
  useEffect(() => {
    if (!providerCatalogAvailability.fireworks) {
      const id = setTimeout(() => {
        setFireworksModelList([]);
        setFireworksError(null);
        setFireworksUpdatedAt(null);
      }, 0);
      return () => clearTimeout(id);
    }
  }, [providerCatalogAvailability.fireworks]);
  useEffect(() => {
    if (!providerCatalogAvailability.deepseek) {
      const id = setTimeout(() => {
        setDeepseekModelList([]);
        setDeepseekError(null);
        setDeepseekUpdatedAt(null);
      }, 0);
      return () => clearTimeout(id);
    }
  }, [providerCatalogAvailability.deepseek]);
  useEffect(() => {
    if (!providerCatalogAvailability.sakana) {
      const id = setTimeout(() => {
        setSakanaModelList([]);
        setSakanaError(null);
        setSakanaUpdatedAt(null);
      }, 0);
      return () => clearTimeout(id);
    }
  }, [providerCatalogAvailability.sakana]);
  useEffect(() => {
    if (!providerCatalogAvailability.google) {
      const id = setTimeout(() => {
        setGoogleModelList([]);
        setGoogleError(null);
        setGoogleUpdatedAt(null);
      }, 0);
      return () => clearTimeout(id);
    }
  }, [providerCatalogAvailability.google]);
  useEffect(() => {
    if (!providerCatalogAvailability.openai) {
      const id = setTimeout(() => {
        setOpenaiModelList([]);
        setOpenaiError(null);
        setOpenaiUpdatedAt(null);
      }, 0);
      return () => clearTimeout(id);
    }
  }, [providerCatalogAvailability.openai]);
  useEffect(() => {
    if (!providerCatalogAvailability.xai) {
      const id = setTimeout(() => {
        setXaiModelList([]);
        setXaiError(null);
        setXaiUpdatedAt(null);
      }, 0);
      return () => clearTimeout(id);
    }
  }, [providerCatalogAvailability.xai]);

  const fireworksSelectedModel = fireworksCfg.model;
  const setFireworksModel = fireworksCfg.setModel;
  const sakanaSelectedModel = sakanaCfg.model;
  const setSakanaModel = sakanaCfg.setModel;

  useEffect(() => {
    const normalizedSelectedModel = normalizeFireworksModelName(fireworksSelectedModel);
    if (normalizedSelectedModel !== fireworksSelectedModel) {
      setFireworksModel(normalizedSelectedModel);
      return;
    }

    // Treat curated serverless models as valid even when absent from the account-scoped live
    // /v1/models — they're callable by slug and `fireworksModelOptions` unions them in. Only a
    // model in neither the live list nor the curated catalog is reset to a known-good default.
    if (
      fireworksModelList.length === 0 ||
      fireworksModelList.includes(normalizedSelectedModel) ||
      FIREWORKS_MODELS.includes(normalizedSelectedModel)
    ) {
      return;
    }

    const fallbackModel = fireworksModelList.includes(FIREWORKS_DEFAULT_MODEL)
      ? FIREWORKS_DEFAULT_MODEL
      : fireworksModelList[0];
    if (fallbackModel && fallbackModel !== fireworksSelectedModel) {
      setFireworksModel(fallbackModel);
    }
  }, [fireworksModelList, fireworksSelectedModel, setFireworksModel]);

  useEffect(() => {
    const normalizedSelectedModel = normalizeSakanaModelName(sakanaSelectedModel);
    if (normalizedSelectedModel !== sakanaSelectedModel) {
      setSakanaModel(normalizedSelectedModel);
      return;
    }

    // Treat curated serverless models as valid even when absent from the account-scoped live
    // /v1/models — they're callable by slug and `sakanaModelOptions` unions them in. Only a
    // model in neither the live list nor the curated catalog is reset to a known-good default.
    if (
      sakanaModelList.length === 0 ||
      sakanaModelList.includes(normalizedSelectedModel) ||
      SAKANA_MODELS.includes(normalizedSelectedModel)
    ) {
      return;
    }

    const fallbackModel = sakanaModelList.includes(SAKANA_DEFAULT_MODEL)
      ? SAKANA_DEFAULT_MODEL
      : sakanaModelList[0];
    if (fallbackModel && fallbackModel !== sakanaSelectedModel) {
      setSakanaModel(fallbackModel);
    }
  }, [sakanaModelList, sakanaSelectedModel, setSakanaModel]);

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
  const zaiModelOptions = useMemo(
    () => includeSelectedModel(zaiModelList.length > 0 ? zaiModelList : ZAI_MODELS, zaiCfg.model),
    [zaiModelList, zaiCfg.model],
  );
  const kimiModelOptions = useMemo(
    () =>
      includeSelectedModel(kimiModelList.length > 0 ? kimiModelList : KIMI_MODELS, kimiCfg.model),
    [kimiModelList, kimiCfg.model],
  );
  const huggingfaceModelOptions = useMemo(
    () =>
      includeSelectedModel(
        huggingfaceModelList.length > 0 ? huggingfaceModelList : HUGGINGFACE_MODELS,
        huggingfaceCfg.model,
      ),
    [huggingfaceModelList, huggingfaceCfg.model],
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
  const deepseekModelOptions = useMemo(
    () =>
      includeSelectedModel(
        deepseekModelList.length > 0 ? deepseekModelList : DEEPSEEK_MODELS,
        deepseekCfg.model,
      ),
    [deepseekModelList, deepseekCfg.model],
  );
  const fireworksModelOptions = useMemo(() => {
    const selectedModel = normalizeFireworksModelName(fireworksSelectedModel);
    // Fireworks /v1/models is account-scoped (a narrow subset), so union the curated catalog with
    // the live list (curated first, deduped) rather than replacing — unlike providers whose live
    // /models already returns the full catalog. Every curated slug is callable by slug.
    const union = [...new Set([...FIREWORKS_MODELS, ...fireworksModelList])];
    return includeSelectedModel(union, selectedModel);
  }, [fireworksModelList, fireworksSelectedModel]);
  const sakanaModelOptions = useMemo(() => {
    const selectedModel = normalizeSakanaModelName(sakanaSelectedModel);
    // Sakana /v1/models is account-scoped (a narrow subset), so union the curated catalog with
    // the live list (curated first, deduped) rather than replacing — unlike providers whose live
    // /models already returns the full catalog. Every curated slug is callable by slug.
    const union = [...new Set([...SAKANA_MODELS, ...sakanaModelList])];
    return includeSelectedModel(union, selectedModel);
  }, [sakanaModelList, sakanaSelectedModel]);
  // Anthropic uses the curated list directly — no live `/v1/models` proxy yet
  // (curated covers MVP; live fetching can land in a follow-up with a Worker
  // /api/anthropic/models proxy that does more than echo the curated list).
  const anthropicModelOptions = useMemo(
    () => includeSelectedModel(ANTHROPIC_MODELS, anthropicCfg.model),
    [anthropicCfg.model],
  );
  // OpenAI: live list via the Worker proxy (`handleOpenAIModels` filters out
  // embeddings/audio/image/etc.); falls back to the curated list before the
  // first fetch resolves or when the proxy returns the curated set.
  const openaiModelOptions = useMemo(
    () =>
      includeSelectedModel(
        openaiModelList.length > 0 ? openaiModelList : OPENAI_MODELS,
        openaiCfg.model,
      ),
    [openaiModelList, openaiCfg.model],
  );
  const xaiModelOptions = useMemo(
    () => includeSelectedModel(xaiModelList.length > 0 ? xaiModelList : XAI_MODELS, xaiCfg.model),
    [xaiModelList, xaiCfg.model],
  );
  // Google: live list via the Worker proxy (`handleGoogleModels` keeps only
  // generateContent-capable models); curated fallback before the first fetch
  // or when the proxy serves the curated set.
  const googleModelOptions = useMemo(
    () =>
      includeSelectedModel(
        googleModelList.length > 0 ? googleModelList : GOOGLE_MODELS,
        googleCfg.model,
      ),
    [googleModelList, googleCfg.model],
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
    zai: {
      setKey: zaiCfg.setKey,
      clearKey: zaiCfg.clearKey,
      hasKey: zaiCfg.hasKey,
      model: zaiCfg.model,
      setModel: zaiCfg.setModel,
      keyInput: zaiKeyInput,
      setKeyInput: setZaiKeyInput,
    },
    kimi: {
      setKey: kimiCfg.setKey,
      clearKey: kimiCfg.clearKey,
      hasKey: kimiCfg.hasKey,
      model: kimiCfg.model,
      setModel: kimiCfg.setModel,
      keyInput: kimiKeyInput,
      setKeyInput: setKimiKeyInput,
    },
    huggingface: {
      setKey: huggingfaceCfg.setKey,
      clearKey: huggingfaceCfg.clearKey,
      hasKey: huggingfaceCfg.hasKey,
      model: huggingfaceCfg.model,
      setModel: huggingfaceCfg.setModel,
      keyInput: huggingfaceKeyInput,
      setKeyInput: setHuggingFaceKeyInput,
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
    fireworks: {
      setKey: fireworksCfg.setKey,
      clearKey: fireworksCfg.clearKey,
      hasKey: fireworksCfg.hasKey,
      model: fireworksCfg.model,
      setModel: fireworksCfg.setModel,
      keyInput: fireworksKeyInput,
      setKeyInput: setFireworksKeyInput,
    },
    sakana: {
      setKey: sakanaCfg.setKey,
      clearKey: sakanaCfg.clearKey,
      hasKey: sakanaCfg.hasKey,
      model: sakanaCfg.model,
      setModel: sakanaCfg.setModel,
      keyInput: sakanaKeyInput,
      setKeyInput: setSakanaKeyInput,
    },
    deepseek: {
      setKey: deepseekCfg.setKey,
      clearKey: deepseekCfg.clearKey,
      hasKey: deepseekCfg.hasKey,
      model: deepseekCfg.model,
      setModel: deepseekCfg.setModel,
      keyInput: deepseekKeyInput,
      setKeyInput: setDeepseekKeyInput,
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
    xai: {
      setKey: xaiCfg.setKey,
      clearKey: xaiCfg.clearKey,
      hasKey: xaiCfg.hasKey,
      model: xaiCfg.model,
      setModel: xaiCfg.setModel,
      keyInput: xaiKeyInput,
      setKeyInput: setXaiKeyInput,
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
    zaiModels: {
      models: zaiModelList,
      loading: zaiLoading,
      error: zaiError,
      updatedAt: zaiUpdatedAt,
    },
    kimiModels: {
      models: kimiModelList,
      loading: kimiLoading,
      error: kimiError,
      updatedAt: kimiUpdatedAt,
    },
    huggingfaceModels: {
      models: huggingfaceModelList,
      loading: huggingfaceLoading,
      error: huggingfaceError,
      updatedAt: huggingfaceUpdatedAt,
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
    fireworksModels: {
      models: fireworksModelList,
      loading: fireworksLoading,
      error: fireworksError,
      updatedAt: fireworksUpdatedAt,
    },
    sakanaModels: {
      models: sakanaModelList,
      loading: sakanaLoading,
      error: sakanaError,
      updatedAt: sakanaUpdatedAt,
    },
    deepseekModels: {
      models: deepseekModelList,
      loading: deepseekLoading,
      error: deepseekError,
      updatedAt: deepseekUpdatedAt,
    },
    googleModels: {
      models: googleModelList,
      loading: googleLoading,
      error: googleError,
      updatedAt: googleUpdatedAt,
    },
    openaiModels: {
      models: openaiModelList,
      loading: openaiLoading,
      error: openaiError,
      updatedAt: openaiUpdatedAt,
    },
    xaiModels: {
      models: xaiModelList,
      loading: xaiLoading,
      error: xaiError,
      updatedAt: xaiUpdatedAt,
    },

    ollamaModelOptions,
    openRouterModelOptions,
    zaiModelOptions,
    kimiModelOptions,
    huggingfaceModelOptions,
    cloudflareModelOptions,
    zenModelOptions,
    nvidiaModelOptions: nvidiaModelList.length > 0 ? nvidiaModelOptions : NVIDIA_MODELS,
    fireworksModelOptions,
    sakanaModelOptions,
    deepseekModelOptions,
    anthropicModelOptions,
    openaiModelOptions,
    xaiModelOptions,
    googleModelOptions,

    zenGoMode: zenCfg.goMode,
    setZenGoMode: zenCfg.setGoMode,

    refreshOllamaModels,
    refreshOpenRouterModels,
    refreshZaiModels,
    refreshKimiModels,
    refreshHuggingFaceModels,
    refreshCloudflareModels,
    refreshZenModels,
    refreshNvidiaModels,
    refreshFireworksModels,
    refreshSakanaModels,
    refreshDeepSeekModels,
    refreshGoogleModels,
    refreshOpenAIModels,
    refreshXAIModels,
  };
}
