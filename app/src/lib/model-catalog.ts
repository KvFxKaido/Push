import { getOllamaKey } from '@/hooks/useOllamaConfig';
import { getOpenRouterKey } from '@/hooks/useOpenRouterConfig';
import { getZenKey } from '@/hooks/useZenConfig';
import { getNvidiaKey } from '@/hooks/useNvidiaConfig';
import { getBlackboxKey } from '@/hooks/useBlackboxConfig';
import { safeStorageGet, safeStorageSet } from './safe-storage';
import { PROVIDER_URLS } from './providers';
import { asRecord } from './utils';

const MODELS_FETCH_TIMEOUT_MS = 12_000;
const MODELS_DEV_OPENROUTER_URL = 'https://models.dev/api.json';
const MODELS_DEV_OPENROUTER_CACHE_KEY = 'push:models-dev:openrouter-models';
const MODELS_DEV_NVIDIA_CACHE_KEY = 'push:models-dev:nvidia-models';
const MODELS_DEV_OLLAMA_CACHE_KEY = 'push:models-dev:ollama-cloud-models';
const MODELS_DEV_OPENCODE_CACHE_KEY = 'push:models-dev:opencode-models';
const MODELS_DEV_OPENROUTER_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const NVIDIA_MAX_CURATED_MODELS = 32;
const OLLAMA_MAX_CURATED_MODELS = 40;
const OPENCODE_MAX_CURATED_MODELS = 48;
export const MIN_CONTEXT_TOKENS = 64000;
const OPENROUTER_PRIORITY_MODELS = [
  'anthropic/claude-haiku-4.5:nitro',
  'anthropic/claude-opus-4.6:nitro',
  'anthropic/claude-sonnet-4.6:nitro',
  'arcee-ai/virtuoso-large',
  'inception/mercury-2',
  'inception/mercury-coder',

  'cohere/command-a',
  'deepseek/deepseek-r1',
  'deepseek/deepseek-v3.2:nitro',
  'google/gemini-2.5-flash:nitro',
  'google/gemini-2.5-pro:nitro',
  'google/gemini-3-flash-preview:nitro',
  'google/gemini-3.1-flash-lite-preview:nitro',
  'google/gemini-3.1-pro-preview:nitro',
  'google/gemini-3.1-pro-preview-customtools:nitro',
  'meta-llama/llama-4-maverick',
  'minimax/minimax-m2.5',
  'minimax/minimax-m2.7:nitro',
  'mistralai/codestral-2508',
  'mistralai/devstral-2512',
  'mistralai/mistral-large-2512',
  'mistralai/mistral-small-2603',

  'moonshotai/kimi-k2.5:nitro',
  'openai/gpt-5-mini',
  'openai/gpt-5.2-codex',
  'openai/gpt-5.3-codex',
  'openai/gpt-5.4',
  'openai/gpt-5.4-pro',
  'openai/gpt-5.4-mini',
  'openai/gpt-5.4-nano',
  'xiaomi/mimo-v2-omni',
  'xiaomi/mimo-v2-pro',

  'perplexity/sonar-pro',
  'qwen/qwen3-coder-flash',
  'qwen/qwen3-coder-plus',
  'qwen/qwen3.5-397b-a17b:nitro',
  'stepfun/step-3.5-flash',
  'x-ai/grok-4.1-fast',
  'x-ai/grok-4.20-beta',
  'z-ai/glm-4.7:nitro',
  'z-ai/glm-5:nitro',
  'z-ai/glm-5-turbo:nitro',
] as const;
const NVIDIA_PRIORITY_MODELS = [
  'nvidia/llama-3.1-nemotron-70b-instruct',
  'meta/llama-3.3-70b-instruct',
  'meta/llama-3.1-405b-instruct',
  'deepseek-ai/deepseek-r1',
  'qwen/qwen2.5-coder-32b-instruct',
  'mistralai/mistral-large-2-instruct',
] as const;
const OLLAMA_PRIORITY_MODELS = [
  'gemini-3-flash-preview',
  'glm-5',
  'qwen3-coder-next',
  'qwen3-coder:480b',
  'kimi-k2.5',
  'deepseek-v3.2',
  'devstral-2:123b',
  'qwen3-vl:235b-instruct',
  'gemma3:27b',
  'nemotron-3-super',
  'minimax-m2.5',
] as const;
const OPENCODE_PRIORITY_MODELS = [
  'openai/gpt-5.3-codex',
  'openai/gpt-5.2-codex',
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'gemini-3.1-pro',
  'gemini-3-flash',
  'openai/gpt-5.4',
  'openai/gpt-5.4-pro',
  'qwen3-coder',
  'kimi-k2.5',
  'glm-5',
  'openai/gpt-5.1-codex-mini',
] as const;

export interface OpenRouterCatalogModel {
  id: string;
  name: string;
  inputModalities: string[];
  outputModalities: string[];
  supportedParameters: string[];
  contextLength: number;
  isModerated: boolean;
}

export interface ModelsDevOpenRouterMetadata {
  id: string;
  reasoning: boolean;
  toolCall: boolean;
  structuredOutput: boolean;
  openWeights: boolean;
  inputModalities: string[];
  outputModalities: string[];
  contextLimit: number;
}

interface ModelsDevProviderCachePayload<TModel> {
  fetchedAt: number;
  models: Record<string, TModel>;
}

interface ModelsDevProviderMetadata {
  id: string;
  attachment: boolean;
  reasoning: boolean;
  toolCall: boolean;
  structuredOutput: boolean;
  openWeights: boolean;
  inputModalities: string[];
  outputModalities: string[];
  contextLimit: number;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseOpenRouterModalityString(value: unknown): {
  inputModalities: string[];
  outputModalities: string[];
} {
  if (typeof value !== 'string' || !value.includes('->')) {
    return { inputModalities: [], outputModalities: [] };
  }

  const [input, output] = value.split('->', 2);
  const parseSide = (part: string) =>
    part
      .split('+')
      .map((item) => item.trim())
      .filter(Boolean);

  return {
    inputModalities: parseSide(input),
    outputModalities: parseSide(output),
  };
}

function readCachedModelsDevOpenRouterMetadata(): Record<string, ModelsDevOpenRouterMetadata> | null {
  return readCachedModelsDevMetadata<ModelsDevOpenRouterMetadata>(MODELS_DEV_OPENROUTER_CACHE_KEY);
}

// ---------------------------------------------------------------------------
// Reasoning effort preference (per-provider, localStorage)
// ---------------------------------------------------------------------------

export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high';
const REASONING_EFFORT_KEY_PREFIX = 'push:reasoning-effort:';
const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'medium';
const REASONING_EFFORT_CYCLE: ReasoningEffort[] = ['off', 'low', 'medium', 'high'];

export function getReasoningEffort(provider: string): ReasoningEffort {
  const raw = safeStorageGet(`${REASONING_EFFORT_KEY_PREFIX}${provider}`);
  if (raw && REASONING_EFFORT_CYCLE.includes(raw as ReasoningEffort)) return raw as ReasoningEffort;
  return DEFAULT_REASONING_EFFORT;
}

export function setReasoningEffort(provider: string, effort: ReasoningEffort): void {
  safeStorageSet(`${REASONING_EFFORT_KEY_PREFIX}${provider}`, effort);
}

export function cycleReasoningEffort(provider: string): ReasoningEffort {
  const current = getReasoningEffort(provider);
  const idx = REASONING_EFFORT_CYCLE.indexOf(current);
  const next = REASONING_EFFORT_CYCLE[(idx + 1) % REASONING_EFFORT_CYCLE.length];
  setReasoningEffort(provider, next);
  return next;
}

export const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  off: 'Off',
  low: 'Lo',
  medium: 'Med',
  high: 'Hi',
};

// ---------------------------------------------------------------------------
// Model capabilities
// ---------------------------------------------------------------------------

/** Model capabilities resolved from cached models.dev metadata. */
export interface ResolvedModelCapabilities {
  reasoning: boolean;
  toolCall: boolean;
  vision: boolean;
  imageGen: boolean;
  contextLimit: number;
}

const EMPTY_CAPABILITIES: ResolvedModelCapabilities = {
  reasoning: false,
  toolCall: false,
  vision: false,
  imageGen: false,
  contextLimit: 0,
};

function resolveFromOpenRouterMetadata(meta: ModelsDevOpenRouterMetadata): ResolvedModelCapabilities {
  return {
    reasoning: meta.reasoning,
    toolCall: meta.toolCall,
    vision: meta.inputModalities.includes('image'),
    imageGen: meta.outputModalities.includes('image'),
    contextLimit: meta.contextLimit,
  };
}

function resolveFromProviderMetadata(meta: ModelsDevProviderMetadata): ResolvedModelCapabilities {
  return {
    reasoning: meta.reasoning,
    toolCall: meta.toolCall,
    vision: meta.inputModalities.includes('image') || meta.attachment,
    imageGen: meta.outputModalities.includes('image'),
    contextLimit: meta.contextLimit,
  };
}

/**
 * Look up cached model capabilities from models.dev metadata.
 * Works for any provider — checks OpenRouter, Ollama, Nvidia, OpenCode caches.
 */
export function getModelCapabilities(provider: string, modelId: string): ResolvedModelCapabilities {
  if (provider === 'openrouter') {
    const metadata = readCachedModelsDevOpenRouterMetadata();
    const meta = metadata?.[modelId];
    return meta ? resolveFromOpenRouterMetadata(meta) : EMPTY_CAPABILITIES;
  }

  const cacheKey = provider === 'nvidia' ? MODELS_DEV_NVIDIA_CACHE_KEY
    : provider === 'ollama' ? MODELS_DEV_OLLAMA_CACHE_KEY
    : provider === 'zen' ? MODELS_DEV_OPENCODE_CACHE_KEY
    : null;

  if (!cacheKey) return EMPTY_CAPABILITIES;

  const metadata = readCachedModelsDevMetadata<ModelsDevProviderMetadata>(cacheKey);
  const meta = metadata?.[modelId];
  return meta ? resolveFromProviderMetadata(meta) : EMPTY_CAPABILITIES;
}

/** Shorthand for checking OpenRouter reasoning support (used by orchestrator). */
export function openRouterModelSupportsReasoning(modelId: string): boolean {
  return getModelCapabilities('openrouter', modelId).reasoning;
}

/** Build a compact icon string for display in model pickers. */

// ---------------------------------------------------------------------------
// Minimum context floor filtering
// ---------------------------------------------------------------------------

interface ContextFilterResult {
  allowed: boolean;
}

/**
 * Fail-closed context filter: rejects models with unknown/missing contextLimit.
 * Priority models (whitelist) bypass the filter even if metadata is missing.
 */
export function filterModelByContext(
  modelId: string,
  contextLimit: number | undefined | null,
  prioritySet: Set<string>,
  failOpen: boolean = false,
): ContextFilterResult {
  // Whitelist override: priority models always pass
  if (prioritySet.has(modelId)) {
    return { allowed: true };
  }

  // Fail closed: unknown/missing contextLimit is rejected (0 is treated as missing —
  // a zero-token context is never valid data, only a coercion artifact)
  if (contextLimit === undefined || contextLimit === null || contextLimit === 0) {
    if (failOpen) {
      console.warn(`[model-catalog] Allowed ${modelId} with missing contextLimit (fail-open)`);
      return { allowed: true };
    }
    console.debug(`[model-catalog] Rejected ${modelId}: missing contextLimit (metadata unavailable)`);
    return { allowed: false };
  }

  // Must meet minimum threshold
  if (contextLimit < MIN_CONTEXT_TOKENS) {
    console.debug(`[model-catalog] Rejected ${modelId}: contextLimit ${contextLimit} < ${MIN_CONTEXT_TOKENS}`);
    return { allowed: false };
  }

  return { allowed: true };
}
export function formatModelCapabilityHints(caps: ResolvedModelCapabilities): string {
  const icons: string[] = [];
  if (caps.reasoning) icons.push('⚡');  // reasoning/thinking
  if (caps.vision) icons.push('👁');     // vision input
  if (caps.imageGen) icons.push('🎨');   // image generation
  if (caps.toolCall) icons.push('⚙');    // tool/function calling
  return icons.join(' ');
}

function writeCachedModelsDevOpenRouterMetadata(models: Record<string, ModelsDevOpenRouterMetadata>): void {
  writeCachedModelsDevMetadata(MODELS_DEV_OPENROUTER_CACHE_KEY, models);
}

function readCachedModelsDevMetadata<TModel>(storageKey: string): Record<string, TModel> | null {
  const raw = safeStorageGet(storageKey);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<ModelsDevProviderCachePayload<TModel>> | null;
    if (!parsed || typeof parsed.fetchedAt !== 'number' || !parsed.models) {
      return null;
    }
    if (Date.now() - parsed.fetchedAt > MODELS_DEV_OPENROUTER_CACHE_TTL_MS) {
      return null;
    }
    return parsed.models as Record<string, TModel>;
  } catch {
    return null;
  }
}

function writeCachedModelsDevMetadata<TModel>(storageKey: string, models: Record<string, TModel>): void {
  const payload: ModelsDevProviderCachePayload<TModel> = {
    fetchedAt: Date.now(),
    models,
  };
  safeStorageSet(storageKey, JSON.stringify(payload));
}

function extractModelsDevProviderMetadata(
  payload: unknown,
  providerKey: string,
): Record<string, ModelsDevProviderMetadata> {
  const root = asRecord(payload);
  const provider = root ? asRecord(root[providerKey]) : null;
  const models = provider ? asRecord(provider.models) : null;
  if (!models) return {};

  const entries: Record<string, ModelsDevProviderMetadata> = {};
  for (const [id, value] of Object.entries(models)) {
    const record = asRecord(value);
    if (!record) continue;
    const modalities = asRecord(record.modalities);
    const limits = asRecord(record.limit);
    const resolvedId = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : id;
    entries[resolvedId] = {
      id: resolvedId,
      attachment: Boolean(record.attachment),
      reasoning: Boolean(record.reasoning),
      toolCall: Boolean(record.tool_call),
      structuredOutput: Boolean(record.structured_output),
      openWeights: Boolean(record.open_weights),
      inputModalities: normalizeStringArray(modalities?.input),
      outputModalities: normalizeStringArray(modalities?.output),
      contextLimit: typeof limits?.context === 'number' ? limits.context : 0,
    };
  }
  return entries;
}

async function fetchModelsDevProviderMetadata(
  providerKey: string,
  cacheKey: string,
): Promise<Record<string, ModelsDevProviderMetadata>> {
  const cached = readCachedModelsDevMetadata<ModelsDevProviderMetadata>(cacheKey);
  if (cached) return cached;

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), MODELS_FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(MODELS_DEV_OPENROUTER_URL, {
      method: 'GET',
      signal: controller.signal,
      cache: 'force-cache',
    });
    if (!res.ok) throw new Error(`models.dev metadata failed (${res.status})`);
    const payload = (await res.json()) as unknown;
    const metadata = extractModelsDevProviderMetadata(payload, providerKey);
    if (Object.keys(metadata).length > 0) {
      writeCachedModelsDevMetadata(cacheKey, metadata);
    }
    return metadata;
  } catch {
    return cached ?? {};
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function extractModelsDevOpenRouterMetadata(payload: unknown): Record<string, ModelsDevOpenRouterMetadata> {
  const root = asRecord(payload);
  const provider = root ? asRecord(root.openrouter) : null;
  const models = provider ? asRecord(provider.models) : null;
  if (!models) return {};

  const entries: Record<string, ModelsDevOpenRouterMetadata> = {};
  for (const [id, value] of Object.entries(models)) {
    const record = asRecord(value);
    if (!record) continue;
    const modalities = asRecord(record.modalities);
    const limits = asRecord(record.limit);
    const resolvedId = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : id;
    entries[resolvedId] = {
      id: resolvedId,
      reasoning: Boolean(record.reasoning),
      toolCall: Boolean(record.tool_call),
      structuredOutput: Boolean(record.structured_output),
      openWeights: Boolean(record.open_weights),
      inputModalities: normalizeStringArray(modalities?.input),
      outputModalities: normalizeStringArray(modalities?.output),
      contextLimit: typeof limits?.context === 'number' ? limits.context : 0,
    };
  }
  return entries;
}

async function fetchModelsDevOpenRouterMetadata(): Promise<Record<string, ModelsDevOpenRouterMetadata>> {
  const cached = readCachedModelsDevOpenRouterMetadata();
  if (cached) return cached;

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), MODELS_FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(MODELS_DEV_OPENROUTER_URL, {
      method: 'GET',
      signal: controller.signal,
      cache: 'force-cache',
    });
    if (!res.ok) throw new Error(`models.dev metadata failed (${res.status})`);
    const payload = (await res.json()) as unknown;
    const metadata = extractModelsDevOpenRouterMetadata(payload);
    if (Object.keys(metadata).length > 0) {
      writeCachedModelsDevOpenRouterMetadata(metadata);
    }
    return metadata;
  } catch {
    return cached ?? {};
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function fetchModelsDevNvidiaMetadata(): Promise<Record<string, ModelsDevProviderMetadata>> {
  return fetchModelsDevProviderMetadata('nvidia', MODELS_DEV_NVIDIA_CACHE_KEY);
}

async function fetchModelsDevOllamaMetadata(): Promise<Record<string, ModelsDevProviderMetadata>> {
  return fetchModelsDevProviderMetadata('ollama-cloud', MODELS_DEV_OLLAMA_CACHE_KEY);
}

async function fetchModelsDevOpencodeMetadata(): Promise<Record<string, ModelsDevProviderMetadata>> {
  return fetchModelsDevProviderMetadata('opencode', MODELS_DEV_OPENCODE_CACHE_KEY);
}

export function parseOpenRouterCatalog(payload: unknown): OpenRouterCatalogModel[] {
  const root = asRecord(payload);
  const data = Array.isArray(root?.data) ? root.data : [];
  const models: OpenRouterCatalogModel[] = [];

  for (const item of data) {
    const record = asRecord(item);
    if (!record || typeof record.id !== 'string' || !record.id.trim()) continue;

    const architecture = asRecord(record.architecture);
    const topProvider = asRecord(record.top_provider);
    const fallbackModalities = parseOpenRouterModalityString(architecture?.modality);
    const inputModalities = normalizeStringArray(architecture?.input_modalities);
    const outputModalities = normalizeStringArray(architecture?.output_modalities);

    models.push({
      id: record.id.trim(),
      name: typeof record.name === 'string' && record.name.trim() ? record.name.trim() : record.id.trim(),
      inputModalities: inputModalities.length > 0 ? inputModalities : fallbackModalities.inputModalities,
      outputModalities: outputModalities.length > 0 ? outputModalities : fallbackModalities.outputModalities,
      supportedParameters: normalizeStringArray(record.supported_parameters),
      contextLength:
        typeof topProvider?.context_length === 'number'
          ? topProvider.context_length
          : typeof record.context_length === 'number'
            ? record.context_length
            : 0,
      isModerated: Boolean(topProvider?.is_moderated),
    });
  }

  return models;
}

/** Strip OpenRouter routing suffixes (:nitro, :free, etc.) for catalog/metadata lookups. */
function openRouterBaseId(id: string): string {
  const colon = id.lastIndexOf(':');
  return colon > 0 ? id.slice(0, colon) : id;
}

export function buildCuratedOpenRouterModelList(
  models: OpenRouterCatalogModel[],
  metadataById?: Record<string, ModelsDevOpenRouterMetadata>,
): string[] {
  const liveIds = new Set(models.map((m) => m.id));

  const prioritySet = new Set<string>(OPENROUTER_PRIORITY_MODELS);
  const modelsById = Object.fromEntries(models.map((m) => [m.id, m]));
  // Apply context filtering to priority models (they bypass context check but must be in live catalog)
  return OPENROUTER_PRIORITY_MODELS.filter((id) => {
    // Match against catalog using base ID (catalog lists base models, not routing variants)
    const baseId = openRouterBaseId(id);
    if (!liveIds.has(id) && !liveIds.has(baseId)) return false;
    // Priority models bypass context filter but still check if it's a text chat model
    const meta = metadataById?.[id] ?? metadataById?.[baseId];
    // When metadata is available, exclude image-output-only models
    if (meta?.outputModalities?.includes('image') && !meta.outputModalities?.includes('text')) return false;
    const contextLimit = meta?.contextLimit ?? modelsById[id]?.contextLength ?? modelsById[baseId]?.contextLength;
    const filterResult = filterModelByContext(id, contextLimit, prioritySet);
    return filterResult.allowed;
  });
}

function isProviderTextChatModel(id: string, metadata?: ModelsDevProviderMetadata): boolean {
  // Check for image output or non-text-only modalities
  if (metadata?.outputModalities?.includes('image')) return false;
  if ((metadata?.outputModalities?.length ?? 0) > 0 && !metadata?.outputModalities?.includes('text')) return false;

  const normalized = id.toLowerCase();
  if (/(embed|embedding|rerank|retriev|nv-rerank|nvolve)/.test(normalized)) return false;
  return true;
}

function isNvidiaChatModel(id: string, metadata?: ModelsDevProviderMetadata): boolean {
  return isProviderTextChatModel(id, metadata);
}

export function buildCuratedNvidiaModelList(
  modelIds: string[],
  metadataById: Record<string, ModelsDevProviderMetadata>,
): string[] {
  const prioritySet = new Set<string>(NVIDIA_PRIORITY_MODELS);

  const candidates = modelIds.filter((id) => {
    const meta = metadataById[id];
    if (!isNvidiaChatModel(id, meta)) return false;

    // Apply context floor filtering (whitelist bypass via prioritySet)
    const contextLimit = meta?.contextLimit;
    const filterResult = filterModelByContext(id, contextLimit, prioritySet);
    return filterResult.allowed;
  });

  if (candidates.length === 0) return [];

  const preferred = NVIDIA_PRIORITY_MODELS.filter((id) => candidates.includes(id));
  const rest = candidates
    .filter((id) => !prioritySet.has(id as typeof NVIDIA_PRIORITY_MODELS[number]))
    .sort((a, b) => a.localeCompare(b));

  return [...preferred, ...rest].slice(0, NVIDIA_MAX_CURATED_MODELS);
}

function isOllamaChatModel(id: string, metadata?: ModelsDevProviderMetadata): boolean {
  if (!isProviderTextChatModel(id, metadata)) return false;
  return true;
}

export function buildCuratedOllamaModelList(
  modelIds: string[],
  metadataById: Record<string, ModelsDevProviderMetadata>,
): string[] {
  const prioritySet = new Set<string>(OLLAMA_PRIORITY_MODELS);

  const candidates = modelIds.filter((id) => {
    const meta = metadataById[id];
    if (!isOllamaChatModel(id, meta)) return false;

    // Apply context floor filtering (whitelist bypass via prioritySet)
    const contextLimit = meta?.contextLimit;
    const filterResult = filterModelByContext(id, contextLimit, prioritySet, true);
    return filterResult.allowed;
  });

  if (candidates.length === 0) return [];

  const preferred = OLLAMA_PRIORITY_MODELS.filter((id) => candidates.includes(id));
  const rest = candidates
    .filter((id) => !prioritySet.has(id as typeof OLLAMA_PRIORITY_MODELS[number]))
    .sort((a, b) => a.localeCompare(b));

  return [...preferred, ...rest].slice(0, OLLAMA_MAX_CURATED_MODELS);
}

function isOpencodeChatModel(id: string, metadata?: ModelsDevProviderMetadata): boolean {
  if (!isProviderTextChatModel(id, metadata)) return false;
  return true;
}

export function buildCuratedOpencodeModelList(
  modelIds: string[],
  metadataById: Record<string, ModelsDevProviderMetadata>,
): string[] {
  const prioritySet = new Set<string>(OPENCODE_PRIORITY_MODELS);

  const candidates = modelIds.filter((id) => {
    const meta = metadataById[id];
    if (!isOpencodeChatModel(id, meta)) return false;

    // Apply context floor filtering (whitelist bypass via prioritySet)
    const contextLimit = meta?.contextLimit;
    const filterResult = filterModelByContext(id, contextLimit, prioritySet);
    return filterResult.allowed;
  });

  if (candidates.length === 0) return [];

  const preferred = OPENCODE_PRIORITY_MODELS.filter((id) => candidates.includes(id));
  const rest = candidates
    .filter((id) => !prioritySet.has(id as typeof OPENCODE_PRIORITY_MODELS[number]))
    .sort((a, b) => a.localeCompare(b));

  return [...preferred, ...rest].slice(0, OPENCODE_MAX_CURATED_MODELS);
}

function normalizeModelList(payload: unknown): string[] {
  const ids = new Set<string>();

  const maybePushId = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) {
      ids.add(value.trim());
    }
  };

  const fromArray = (arr: unknown[]) => {
    for (const item of arr) {
      if (typeof item === 'string') {
        maybePushId(item);
        continue;
      }
      const rec = asRecord(item);
      if (!rec) continue;
      maybePushId(rec.id);
      maybePushId(rec.name);
      maybePushId(rec.model);
    }
  };

  const visited = new WeakSet<object>();
  const fromRecord = (rec: Record<string, unknown>) => {
    if (visited.has(rec)) return;
    visited.add(rec);

    if (Array.isArray(rec.data)) fromArray(rec.data);
    if (Array.isArray(rec.models)) fromArray(rec.models);
    if (Array.isArray(rec.items)) fromArray(rec.items);
    if (Array.isArray(rec.list)) fromArray(rec.list);
    if (Array.isArray(rec.model_list)) fromArray(rec.model_list);

    const nestedData = asRecord(rec.data);
    if (nestedData) fromRecord(nestedData);
    const nestedResult = asRecord(rec.result);
    if (nestedResult) fromRecord(nestedResult);
    const nestedOutput = asRecord(rec.output);
    if (nestedOutput) fromRecord(nestedOutput);
  };

  if (Array.isArray(payload)) {
    fromArray(payload);
  } else {
    const rec = asRecord(payload);
    if (rec) fromRecord(rec);
  }

  return Array.from(ids).sort((a, b) => a.localeCompare(b));
}

export async function fetchOllamaModels(): Promise<string[]> {
  const key = getOllamaKey();
  const headers: HeadersInit = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), MODELS_FETCH_TIMEOUT_MS);

  try {
    const [catalogRes, modelsDevMetadata] = await Promise.all([
      fetch(PROVIDER_URLS.ollama.models, {
        method: 'GET',
        headers,
        signal: controller.signal,
        cache: 'no-store',
      }),
      fetchModelsDevOllamaMetadata(),
    ]);

    if (!catalogRes.ok) {
      const detail = await catalogRes.text().catch(() => '');
      throw new Error(`Ollama model list failed (${catalogRes.status}): ${detail.slice(0, 200)}`);
    }

    const payload = (await catalogRes.json()) as unknown;
    const liveModels = normalizeModelList(payload);
    const curated = buildCuratedOllamaModelList(liveModels, modelsDevMetadata);
    // The curated list already contains every model that passed chat + context filtering.
    // Falling back to the raw provider list would bypass those guards.
    return curated;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Ollama model list timed out after ${Math.floor(MODELS_FETCH_TIMEOUT_MS / 1000)}s`);
    }
    throw err;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export async function fetchOpenRouterModels(): Promise<string[]> {
  const key = getOpenRouterKey();
  const headers: HeadersInit = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), MODELS_FETCH_TIMEOUT_MS);

  try {
    const [catalogRes, modelsDevMetadata] = await Promise.all([
      fetch(PROVIDER_URLS.openrouter.models, {
        method: 'GET',
        headers,
        signal: controller.signal,
        cache: 'no-store',
      }),
      fetchModelsDevOpenRouterMetadata(),
    ]);

    if (!catalogRes.ok) {
      const detail = await catalogRes.text().catch(() => '');
      throw new Error(`OpenRouter model list failed (${catalogRes.status}): ${detail.slice(0, 200)}`);
    }

    const payload = (await catalogRes.json()) as unknown;
    const liveModels = parseOpenRouterCatalog(payload);
    const curated = buildCuratedOpenRouterModelList(liveModels, modelsDevMetadata);
    if (curated.length > 0) return curated;
    // Fallback: use catalog contextLength to apply basic context floor filter
    return liveModels
      .filter((m) => m.outputModalities.includes('text') && m.contextLength >= MIN_CONTEXT_TOKENS)
      .map((m) => m.id);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`OpenRouter model list timed out after ${Math.floor(MODELS_FETCH_TIMEOUT_MS / 1000)}s`);
    }
    throw err;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export async function fetchZenModels(): Promise<string[]> {
  const key = getZenKey();
  const headers: HeadersInit = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), MODELS_FETCH_TIMEOUT_MS);

  try {
    const [catalogRes, modelsDevMetadata] = await Promise.all([
      fetch(PROVIDER_URLS.zen.models, {
        method: 'GET',
        headers,
        signal: controller.signal,
        cache: 'no-store',
      }),
      fetchModelsDevOpencodeMetadata(),
    ]);

    if (!catalogRes.ok) {
      const detail = await catalogRes.text().catch(() => '');
      throw new Error(`OpenCode Zen model list failed (${catalogRes.status}): ${detail.slice(0, 200)}`);
    }

    const payload = (await catalogRes.json()) as unknown;
    const liveModels = normalizeModelList(payload);
    const curated = buildCuratedOpencodeModelList(liveModels, modelsDevMetadata);
    // The curated list already contains every model that passed chat + context filtering.
    // Falling back to the raw provider list would bypass those guards.
    return curated;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`OpenCode Zen model list timed out after ${Math.floor(MODELS_FETCH_TIMEOUT_MS / 1000)}s`);
    }
    throw err;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export async function fetchNvidiaModels(): Promise<string[]> {
  const key = getNvidiaKey();
  const headers: HeadersInit = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), MODELS_FETCH_TIMEOUT_MS);

  try {
    const [catalogRes, modelsDevMetadata] = await Promise.all([
      fetch(PROVIDER_URLS.nvidia.models, {
        method: 'GET',
        headers,
        signal: controller.signal,
        cache: 'no-store',
      }),
      fetchModelsDevNvidiaMetadata(),
    ]);

    if (!catalogRes.ok) {
      const detail = await catalogRes.text().catch(() => '');
      throw new Error(`Nvidia NIM model list failed (${catalogRes.status}): ${detail.slice(0, 200)}`);
    }

    const payload = (await catalogRes.json()) as unknown;
    const liveModels = normalizeModelList(payload);
    const curated = buildCuratedNvidiaModelList(liveModels, modelsDevMetadata);
    // The curated list already contains every model that passed chat + context filtering.
    // Falling back to the raw provider list would bypass those guards.
    return curated;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Nvidia NIM model list timed out after ${Math.floor(MODELS_FETCH_TIMEOUT_MS / 1000)}s`);
    }
    throw err;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export async function fetchBlackboxModels(): Promise<string[]> {
  const key = getBlackboxKey();
  const headers: HeadersInit = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), MODELS_FETCH_TIMEOUT_MS);

  try {
    const catalogRes = await fetch(PROVIDER_URLS.blackbox.models, {
      method: 'GET',
      headers,
      signal: controller.signal,
      cache: 'no-store',
    });

    if (!catalogRes.ok) {
      const detail = await catalogRes.text().catch(() => '');
      throw new Error(`Blackbox AI model list failed (${catalogRes.status}): ${detail.slice(0, 200)}`);
    }

    const payload = (await catalogRes.json()) as unknown;
    return normalizeModelList(payload);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Blackbox AI model list timed out after ${Math.floor(MODELS_FETCH_TIMEOUT_MS / 1000)}s`);
    }
    throw err;
  } finally {
    window.clearTimeout(timeoutId);
  }
}
