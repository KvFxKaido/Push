import type { AIProviderType, AIProviderConfig, AIModel, AgentRole } from '@/types';
import { getAzureModelName, getBedrockModelName } from '@/hooks/useExperimentalProviderConfig';
import { getVertexModelName } from '@/hooks/useVertexConfig';
import { resolveApiUrl } from './api-url';
import { getModelCapabilities } from './model-capabilities';
import { safeStorageGet, safeStorageRemove, safeStorageSet } from './safe-storage';
import { VERTEX_DEFAULT_MODEL as SHARED_VERTEX_DEFAULT_MODEL } from './vertex-provider';
import { ZEN_GO_DEFAULT_MODEL, ZEN_GO_MODELS as SHARED_ZEN_GO_MODELS } from './zen-go';
import {
  PROVIDER_DEFINITIONS,
  getProviderModelStorageKey,
  isRealProviderId,
  type ProviderDefinition,
  type RealProviderId,
} from '@push/lib/provider-definition';
export {
  ANTHROPIC_DEFAULT_MODEL,
  ANTHROPIC_MODELS,
  CLOUDFLARE_DEFAULT_MODEL,
  CLOUDFLARE_MODELS,
  DEEPSEEK_DEFAULT_MODEL,
  DEEPSEEK_MODELS,
  FIREWORKS_DEFAULT_MODEL,
  FIREWORKS_MODELS,
  GOOGLE_DEFAULT_MODEL,
  GOOGLE_MODELS,
  KILOCODE_DEFAULT_MODEL,
  KILOCODE_MODELS,
  NVIDIA_DEFAULT_MODEL,
  NVIDIA_MODELS,
  OLLAMA_DEFAULT_MODEL,
  OPENAI_DEFAULT_MODEL,
  OPENAI_MODELS,
  OPENROUTER_DEFAULT_MODEL,
  OPENROUTER_MODELS,
  SAKANA_DEFAULT_MODEL,
  SAKANA_MODELS,
  ZEN_DEFAULT_MODEL,
  ZEN_MODELS,
} from '@push/lib/provider-models';
import {
  ANTHROPIC_DEFAULT_MODEL,
  CLOUDFLARE_DEFAULT_MODEL,
  DEEPSEEK_DEFAULT_MODEL,
  FIREWORKS_DEFAULT_MODEL,
  GOOGLE_DEFAULT_MODEL,
  KILOCODE_DEFAULT_MODEL,
  NVIDIA_DEFAULT_MODEL,
  OLLAMA_DEFAULT_MODEL,
  OPENAI_DEFAULT_MODEL,
  OPENROUTER_DEFAULT_MODEL,
  SAKANA_DEFAULT_MODEL,
  ZEN_DEFAULT_MODEL,
} from '@push/lib/provider-models';

// ---------------------------------------------------------------------------
// Provider URL registry — single source of truth for dev/prod endpoints
// ---------------------------------------------------------------------------

/** Resolve a provider endpoint: dev uses Vite proxy paths, prod goes through
 *  resolveApiUrl so the Capacitor WebView gets an absolute Worker URL while
 *  the same-origin web build keeps relative paths. */
function providerUrl(devPath: string, prodPath: string): string {
  return import.meta.env.DEV ? devPath : resolveApiUrl(prodPath);
}

type ProviderUrlPair = { chat: string; models: string };

const DEV_PROXY_PATHS: Partial<Record<RealProviderId, ProviderUrlPair>> = {
  ollama: {
    chat: '/ollama/v1/chat/completions',
    models: '/ollama/v1/models',
  },
  openrouter: {
    chat: '/openrouter/api/v1/responses',
    models: '/openrouter/api/v1/models',
  },
  zen: {
    chat: '/opencode/zen/v1/chat/completions',
    models: '/opencode/zen/v1/models',
  },
  nvidia: {
    chat: '/nvidia/v1/chat/completions',
    models: '/nvidia/v1/models',
  },
};

function requireProviderProxyPaths(def: ProviderDefinition): ProviderUrlPair {
  if (!def.webProxyPath || !def.modelsProxyPath) {
    throw new Error(`Provider "${def.id}" is missing web proxy paths`);
  }
  return { chat: def.webProxyPath, models: def.modelsProxyPath };
}

const REAL_PROVIDER_URLS = Object.fromEntries(
  PROVIDER_DEFINITIONS.map((def) => {
    const workerPaths = requireProviderProxyPaths(def);
    const devPaths = DEV_PROXY_PATHS[def.id] ?? workerPaths;
    return [
      def.id,
      {
        chat: providerUrl(devPaths.chat, workerPaths.chat),
        models: providerUrl(devPaths.models, workerPaths.models),
      },
    ];
  }),
) as Record<RealProviderId, ProviderUrlPair>;

export const PROVIDER_URLS: Record<AIProviderType, ProviderUrlPair> = {
  ...REAL_PROVIDER_URLS,
  demo: { chat: '', models: '' },
};

// Experimental direct-deployment defaults — only used as placeholders before the user
// configures a concrete deployment/model.
export const AZURE_DEFAULT_MODEL = 'gpt-4.1';
export const BEDROCK_DEFAULT_MODEL = 'anthropic.claude-3-7-sonnet-20250219-v1:0';
export const VERTEX_DEFAULT_MODEL = SHARED_VERTEX_DEFAULT_MODEL;
export const ZEN_GO_MODELS: string[] = [...SHARED_ZEN_GO_MODELS];
export { ZEN_GO_DEFAULT_MODEL };

export const ZEN_GO_URLS = {
  chat: providerUrl('/opencode/zen/go/v1/chat/completions', '/api/zen/go/chat'),
};

const MODEL_ROUTE_PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  'arcee-ai': 'Arcee AI',
  cohere: 'Cohere',
  deepseek: 'DeepSeek',
  google: 'Google',
  'kilo-auto': 'Kilo Auto',
  meta: 'Meta',
  'meta-llama': 'Meta',
  minimax: 'MiniMax',
  mistralai: 'Mistral',
  moonshotai: 'Moonshot',
  openai: 'OpenAI',
  perplexity: 'Perplexity',
  qwen: 'Qwen',
  stepfun: 'StepFun',
  'x-ai': 'xAI',
  'z-ai': 'Zhipu',
};

const LEGACY_KILOCODE_MODEL_MIGRATIONS: Record<string, string> = {
  'google/gemini-2.0-flash': 'google/gemini-3-flash-preview',
  'anthropic/claude-3.5-sonnet': 'anthropic/claude-sonnet-4.6',
  'openai/gpt-4o': 'openai/gpt-5.2',
};

export function normalizeKilocodeModelName(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) return KILOCODE_DEFAULT_MODEL;

  const migrated = LEGACY_KILOCODE_MODEL_MIGRATIONS[trimmed];
  if (migrated) return migrated;

  if (!trimmed.includes('/') || /\s/.test(trimmed)) {
    return KILOCODE_DEFAULT_MODEL;
  }

  return trimmed;
}

export function normalizeFireworksModelName(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) return FIREWORKS_DEFAULT_MODEL;

  if (!trimmed.includes('/') || /\s/.test(trimmed)) {
    return FIREWORKS_DEFAULT_MODEL;
  }

  return trimmed;
}

export function normalizeSakanaModelName(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) return SAKANA_DEFAULT_MODEL;
  if (/\s/.test(trimmed)) return SAKANA_DEFAULT_MODEL;
  return trimmed;
}

function normalizeProviderModelId(_provider: AIProviderType | string, modelId: string): string {
  return modelId.trim();
}

export function getModelDisplayGroupKey(
  provider: AIProviderType | string,
  modelId: string,
): string {
  const normalized = normalizeProviderModelId(provider, modelId);
  if (provider === 'cloudflare' && normalized.startsWith('@')) {
    const parts = normalized.split('/');
    if (parts.length >= 3) return parts[1] || '';
  }
  const slash = normalized.indexOf('/');
  if (slash > 0) return normalized.slice(0, slash);
  return '';
}

export function getModelDisplayGroupLabel(groupKey: string): string {
  return MODEL_ROUTE_PROVIDER_LABELS[groupKey] || groupKey;
}

export function getModelDisplayLeafName(
  provider: AIProviderType | string,
  modelId: string,
): string {
  const normalized = normalizeProviderModelId(provider, modelId);
  if (provider === 'cloudflare' && normalized.startsWith('@')) {
    const parts = normalized.split('/');
    if (parts.length >= 3) return parts.slice(2).join('/');
  }
  const slash = normalized.indexOf('/');
  return slash > 0 ? normalized.slice(slash + 1) : normalized;
}

export function formatModelDisplayName(provider: AIProviderType | string, modelId: string): string {
  const normalized = normalizeProviderModelId(provider, modelId);
  const groupKey = getModelDisplayGroupKey(provider, modelId);
  if (!groupKey) return normalized;
  return `${getModelDisplayGroupLabel(groupKey)} / ${getModelDisplayLeafName(provider, modelId)}`;
}

export function compareProviderModelIds(
  provider: AIProviderType | string,
  left: string,
  right: string,
): number {
  const leftGroup = getModelDisplayGroupLabel(getModelDisplayGroupKey(provider, left));
  const rightGroup = getModelDisplayGroupLabel(getModelDisplayGroupKey(provider, right));
  const groupDiff = leftGroup.localeCompare(rightGroup, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
  if (groupDiff !== 0) return groupDiff;

  const leafDiff = getModelDisplayLeafName(provider, left).localeCompare(
    getModelDisplayLeafName(provider, right),
    undefined,
    { numeric: true, sensitivity: 'base' },
  );
  if (leafDiff !== 0) return leafDiff;

  return normalizeProviderModelId(provider, left).localeCompare(
    normalizeProviderModelId(provider, right),
    undefined,
    { numeric: true, sensitivity: 'base' },
  );
}

/** Build the standard role model set for a provider. */
function makeRoleModels(
  id: string,
  displayName: string,
  provider: AIProviderType,
  context: number,
): AIModel[] {
  return (['orchestrator', 'coder', 'explorer', 'auditor', 'reviewer'] as const).map((role) => ({
    id,
    name: `${displayName} (${role.charAt(0).toUpperCase() + role.slice(1)})`,
    provider,
    role,
    context,
    capabilities: getModelCapabilities(provider, id),
  }));
}

function requireDefaultModel(def: ProviderDefinition): string {
  if (!def.defaultModel) {
    throw new Error(`Provider "${def.id}" is missing a default model`);
  }
  return def.defaultModel;
}

export const PROVIDERS: AIProviderConfig[] = PROVIDER_DEFINITIONS.map((def) => ({
  type: def.id,
  name: def.displayName,
  description: def.settings.description,
  envKey: def.settings.envKey,
  envUrl: def.settings.envUrl,
  models: makeRoleModels(
    requireDefaultModel(def),
    def.displayName,
    def.id,
    def.settings.modelContextWindow,
  ),
}));

export function getProvider(type: AIProviderType): AIProviderConfig | undefined {
  return PROVIDERS.find((p) => p.type === type);
}

export function getDefaultModel(type: AIProviderType): AIModel | undefined {
  const provider = getProvider(type);
  return provider?.models[0];
}

// ---------------------------------------------------------------------------
// Runtime model name — factory + per-provider instances
// ---------------------------------------------------------------------------

function createModelNameStorage(
  storageKey: string,
  defaultModel: string,
  onSet?: () => void,
  normalizeModel?: (model: string) => string,
): { get: () => string; set: (model: string) => void } {
  const sanitizeModel = (model: string): string => {
    const trimmed = model.trim();
    return normalizeModel ? normalizeModel(trimmed) : trimmed;
  };

  return {
    get: () => {
      const stored = safeStorageGet(storageKey);
      if (!stored) return defaultModel;
      const normalized = sanitizeModel(stored);
      if (normalized && normalized !== stored) {
        safeStorageSet(storageKey, normalized);
      }
      return normalized || defaultModel;
    },
    set: (model: string) => {
      const normalized = sanitizeModel(model);
      if (!normalized) return;
      safeStorageSet(storageKey, normalized);
      onSet?.();
    },
  };
}

function requireModelStorageKey(provider: RealProviderId): string {
  const key = getProviderModelStorageKey(provider);
  if (!key) {
    throw new Error(`Provider "${provider}" is missing a model storage key`);
  }
  return key;
}

const ollamaModel = createModelNameStorage(requireModelStorageKey('ollama'), OLLAMA_DEFAULT_MODEL);
export const getOllamaModelName = ollamaModel.get;
export const setOllamaModelName = ollamaModel.set;

const openRouterModel = createModelNameStorage(
  requireModelStorageKey('openrouter'),
  OPENROUTER_DEFAULT_MODEL,
);
export const getOpenRouterModelName = openRouterModel.get;
export const setOpenRouterModelName = openRouterModel.set;

const cloudflareModel = createModelNameStorage(
  requireModelStorageKey('cloudflare'),
  CLOUDFLARE_DEFAULT_MODEL,
);
export const getCloudflareModelName = cloudflareModel.get;
export const setCloudflareModelName = cloudflareModel.set;

const CLOUDFLARE_WORKER_CONFIGURED_KEY = 'cloudflare_worker_configured';
export function getCloudflareWorkerConfigured(): boolean {
  return safeStorageGet(CLOUDFLARE_WORKER_CONFIGURED_KEY) === 'true';
}
export function setCloudflareWorkerConfigured(configured: boolean): void {
  safeStorageSet(CLOUDFLARE_WORKER_CONFIGURED_KEY, configured ? 'true' : 'false');
}

const zenModel = createModelNameStorage(requireModelStorageKey('zen'), ZEN_DEFAULT_MODEL);
export const getZenModelName = zenModel.get;
export const setZenModelName = zenModel.set;

const ZEN_GO_MODE_KEY = 'zen_go_mode';
export function getZenGoMode(): boolean {
  return safeStorageGet(ZEN_GO_MODE_KEY) === 'true';
}
export function setZenGoMode(enabled: boolean): void {
  if (enabled) safeStorageSet(ZEN_GO_MODE_KEY, 'true');
  else safeStorageRemove(ZEN_GO_MODE_KEY);
}

const nvidiaModel = createModelNameStorage(requireModelStorageKey('nvidia'), NVIDIA_DEFAULT_MODEL);
export const getNvidiaModelName = nvidiaModel.get;
export const setNvidiaModelName = nvidiaModel.set;

const azureModel = createModelNameStorage(requireModelStorageKey('azure'), AZURE_DEFAULT_MODEL);
export const setAzureModelName = azureModel.set;

const bedrockModel = createModelNameStorage(
  requireModelStorageKey('bedrock'),
  BEDROCK_DEFAULT_MODEL,
);
export const setBedrockModelName = bedrockModel.set;

const vertexModel = createModelNameStorage(requireModelStorageKey('vertex'), VERTEX_DEFAULT_MODEL);
export const setVertexModelName = vertexModel.set;

const kiloCodeModel = createModelNameStorage(
  requireModelStorageKey('kilocode'),
  KILOCODE_DEFAULT_MODEL,
  undefined,
  normalizeKilocodeModelName,
);
export const getKiloCodeModelName = kiloCodeModel.get;
export const setKiloCodeModelName = kiloCodeModel.set;

const fireworksModel = createModelNameStorage(
  requireModelStorageKey('fireworks'),
  FIREWORKS_DEFAULT_MODEL,
  undefined,
  normalizeFireworksModelName,
);
export const getFireworksModelName = fireworksModel.get;
export const setFireworksModelName = fireworksModel.set;

const sakanaModel = createModelNameStorage(
  requireModelStorageKey('sakana'),
  SAKANA_DEFAULT_MODEL,
  undefined,
  normalizeSakanaModelName,
);
export const getSakanaModelName = sakanaModel.get;
export const setSakanaModelName = sakanaModel.set;

const anthropicModel = createModelNameStorage(
  requireModelStorageKey('anthropic'),
  ANTHROPIC_DEFAULT_MODEL,
);
export const getAnthropicModelName = anthropicModel.get;
export const setAnthropicModelName = anthropicModel.set;

const openaiModel = createModelNameStorage(requireModelStorageKey('openai'), OPENAI_DEFAULT_MODEL);
export const getOpenAIModelName = openaiModel.get;
export const setOpenAIModelName = openaiModel.set;

const googleModel = createModelNameStorage(requireModelStorageKey('google'), GOOGLE_DEFAULT_MODEL);
export const getGoogleModelName = googleModel.get;
export const setGoogleModelName = googleModel.set;

const deepseekModel = createModelNameStorage(
  requireModelStorageKey('deepseek'),
  DEEPSEEK_DEFAULT_MODEL,
);
export const getDeepSeekModelName = deepseekModel.get;
export const setDeepSeekModelName = deepseekModel.set;

/** Runtime model-name getters for providers where the user can override the default. */
const MODEL_NAME_GETTERS: Partial<Record<AIProviderType, () => string>> = {
  ollama: getOllamaModelName,
  openrouter: getOpenRouterModelName,
  cloudflare: getCloudflareModelName,
  zen: getZenModelName,
  nvidia: getNvidiaModelName,
  azure: getAzureModelName,
  bedrock: getBedrockModelName,
  vertex: getVertexModelName,
  kilocode: getKiloCodeModelName,
  fireworks: getFireworksModelName,
  sakana: getSakanaModelName,
  anthropic: getAnthropicModelName,
  openai: getOpenAIModelName,
  google: getGoogleModelName,
  deepseek: getDeepSeekModelName,
};

/** Return the current runtime model name for a provider, or undefined if unknown. */
export function getModelNameForProvider(provider: string): string | undefined {
  return (MODEL_NAME_GETTERS as Record<string, (() => string) | undefined>)[provider]?.();
}

export function getModelForRole(type: AIProviderType, role: AgentRole): AIModel | undefined {
  const provider = getProvider(type);
  const model = provider?.models.find((m) => m.role === role);
  if (!model) return undefined;

  const getter = MODEL_NAME_GETTERS[type];
  if (!getter) return model;

  const resolvedId = getter();
  return {
    ...model,
    id: resolvedId,
    capabilities: getModelCapabilities(type, resolvedId),
  };
}

// ---------------------------------------------------------------------------
// Provider preference — user picks which backend to use
// ---------------------------------------------------------------------------

const PREFERRED_PROVIDER_KEY = 'preferred_provider';

// A user-selectable provider is any real provider — every `AIProviderType`
// except `demo` (the no-key fallback, never an explicit pick). Derived so the id
// vocabulary stays single-sourced in `ALL_PROVIDERS` (provider-contract.ts).
export type PreferredProvider = Exclude<AIProviderType, 'demo'>;

function readStoredProvider(storageKey: string): PreferredProvider | null {
  const stored = safeStorageGet(storageKey);
  return stored && isRealProviderId(stored) ? stored : null;
}

export function getPreferredProvider(): PreferredProvider | null {
  return readStoredProvider(PREFERRED_PROVIDER_KEY);
}

export function setPreferredProvider(provider: PreferredProvider): void {
  safeStorageSet(PREFERRED_PROVIDER_KEY, provider);
  setLastUsedProvider(provider);
}

export function clearPreferredProvider(): void {
  safeStorageRemove(PREFERRED_PROVIDER_KEY);
}

// ---------------------------------------------------------------------------
// Last-used provider — remembered by auto mode
// ---------------------------------------------------------------------------

const LAST_USED_PROVIDER_KEY = 'last_used_provider';

export function getLastUsedProvider(): PreferredProvider | null {
  return readStoredProvider(LAST_USED_PROVIDER_KEY);
}

export function setLastUsedProvider(provider: PreferredProvider): void {
  safeStorageSet(LAST_USED_PROVIDER_KEY, provider);
}
