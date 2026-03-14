import { getOllamaKey } from '@/hooks/useOllamaConfig';
import { getOpenRouterKey } from '@/hooks/useOpenRouterConfig';
import { getZenKey } from '@/hooks/useZenConfig';
import { getNvidiaKey } from '@/hooks/useNvidiaConfig';
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
const OPENROUTER_MAX_CURATED_MODELS = 64;
const NVIDIA_MAX_CURATED_MODELS = 32;
const OLLAMA_MAX_CURATED_MODELS = 40;
const OPENCODE_MAX_CURATED_MODELS = 48;
const OPENROUTER_PRIORITY_MODELS = [
  'anthropic/claude-sonnet-4.6:nitro',
  'anthropic/claude-opus-4.6:nitro',
  'anthropic/claude-haiku-4.5:nitro',
  'openai/gpt-5.4-pro',
  'openai/gpt-5.4',
  'openai/gpt-5-mini:nitro',
  'openai/gpt-5.3-codex',
  'openai/gpt-5.2-codex',
  'openai/gpt-5.1-codex-mini:nitro',
  'google/gemini-3.1-pro-preview:nitro',
  'google/gemini-3-flash-preview:nitro',
  'google/gemini-2.5-flash:nitro',
  'mistralai/devstral-2512',
  'mistralai/mistral-large-2512',
  'qwen/qwen3.5-397b-a17b:nitro',
  'deepseek/deepseek-v3.2:nitro',
  'moonshotai/kimi-k2.5:nitro',
  'x-ai/grok-4.1-fast',
  'cohere/command-r-plus-08-2024',
  'perplexity/sonar-pro',
  'stepfun/step-3.5-flash:nitro',
  'stepfun/step-3.5-flash:free',
  'z-ai/glm-5:nitro',
  'arcee-ai/trinity-large-preview:nitro',
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
  'gpt-5.3-codex',
  'gpt-5.2-codex',
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'gemini-3.1-pro',
  'gemini-3-flash',
  'gpt-5.4',
  'gpt-5.4-pro',
  'qwen3-coder',
  'kimi-k2.5',
  'glm-5',
  'gpt-5.1-codex-mini',
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

function isOpenRouterChatModel(
  model: OpenRouterCatalogModel,
  metadata?: ModelsDevOpenRouterMetadata,
): boolean {
  const outputModalities = new Set([
    ...model.outputModalities,
    ...(metadata?.outputModalities ?? []),
  ]);
  if (!outputModalities.has('text')) return false;

  if (model.id.includes('gpt-image') || outputModalities.has('image')) {
    return false;
  }

  return true;
}

function scoreOpenRouterModel(
  model: OpenRouterCatalogModel,
  metadata?: ModelsDevOpenRouterMetadata,
): number {
  const supportedParameters = new Set(model.supportedParameters);
  const inputModalities = new Set([
    ...model.inputModalities,
    ...(metadata?.inputModalities ?? []),
  ]);
  const id = model.id.toLowerCase();
  let score = 0;

  const priorityIndex = OPENROUTER_PRIORITY_MODELS.indexOf(model.id as typeof OPENROUTER_PRIORITY_MODELS[number]);
  if (priorityIndex >= 0) {
    score += 10_000 - priorityIndex * 100;
  }

  if (supportedParameters.has('tools')) score += 120;
  if (supportedParameters.has('structured_outputs')) score += 60;
  if (supportedParameters.has('reasoning') || supportedParameters.has('include_reasoning')) score += 35;
  if (inputModalities.has('image')) score += 20;
  if (metadata?.toolCall) score += 40;
  if (metadata?.structuredOutput) score += 25;
  if (metadata?.reasoning) score += 20;
  if (metadata?.openWeights) score += 5;

  const contextLength = Math.max(model.contextLength, metadata?.contextLimit ?? 0);
  if (contextLength >= 1_000_000) score += 25;
  else if (contextLength >= 200_000) score += 15;
  else if (contextLength >= 128_000) score += 8;

  if (model.isModerated) score += 2;

  if (id.includes(':free')) score -= 18;
  if (/(mini|nano|flash-lite|haiku)/.test(id)) score -= 6;
  if (/(preview|exp|beta)/.test(id)) score -= 2;

  if (id.includes('claude')) score += 22;
  if (id.includes('opus')) score += 8;
  if (id.includes('sonnet')) score += 6;
  if (id.includes('gpt-5')) score += 20;
  if (id.includes('codex')) score += 10;
  if (id.includes('gemini')) score += 16;
  if (id.includes('mistral')) score += 10;
  if (id.includes('devstral')) score += 8;
  if (id.includes('qwen')) score += 8;
  if (id.includes('deepseek')) score += 8;
  if (id.includes('kimi')) score += 8;
  if (id.includes('grok')) score += 8;
  if (id.includes('command-r')) score += 6;
  if (id.includes('sonar')) score += 5;

  return score;
}

export function buildCuratedOpenRouterModelList(
  models: OpenRouterCatalogModel[],
  metadataById: Record<string, ModelsDevOpenRouterMetadata>,
): string[] {
  const candidates = models.filter((model) => isOpenRouterChatModel(model, metadataById[model.id]));
  if (candidates.length === 0) return [];

  const priority = new Set(OPENROUTER_PRIORITY_MODELS);
  const preferred = OPENROUTER_PRIORITY_MODELS.filter((id) => candidates.some((model) => model.id === id));

  const ranked = candidates
    .filter((model) => !priority.has(model.id as typeof OPENROUTER_PRIORITY_MODELS[number]))
    .sort((a, b) => {
      const scoreDelta = scoreOpenRouterModel(b, metadataById[b.id]) - scoreOpenRouterModel(a, metadataById[a.id]);
      if (scoreDelta !== 0) return scoreDelta;
      const contextDelta = b.contextLength - a.contextLength;
      if (contextDelta !== 0) return contextDelta;
      return a.id.localeCompare(b.id);
    })
    .map((model) => model.id);

  return [...preferred, ...ranked].slice(0, OPENROUTER_MAX_CURATED_MODELS);
}

function isProviderTextChatModel(id: string, metadata?: ModelsDevProviderMetadata): boolean {
  const outputModalities = new Set(metadata?.outputModalities ?? []);
  if (outputModalities.has('image')) return false;
  if (outputModalities.size > 0 && !outputModalities.has('text')) return false;

  const normalized = id.toLowerCase();
  if (/(embed|embedding|rerank|retriev|nv-rerank|nvolve)/.test(normalized)) return false;
  return true;
}

function isNvidiaChatModel(id: string, metadata?: ModelsDevProviderMetadata): boolean {
  return isProviderTextChatModel(id, metadata);
}

function scoreNvidiaModel(id: string, metadata?: ModelsDevProviderMetadata): number {
  const normalized = id.toLowerCase();
  let score = 0;

  const priorityIndex = NVIDIA_PRIORITY_MODELS.indexOf(id as typeof NVIDIA_PRIORITY_MODELS[number]);
  if (priorityIndex >= 0) {
    score += 10_000 - priorityIndex * 100;
  }

  if (metadata?.toolCall) score += 70;
  if (metadata?.structuredOutput) score += 35;
  if (metadata?.reasoning) score += 20;
  if (metadata?.attachment) score += 15;
  if (metadata?.openWeights) score += 5;

  const contextLimit = metadata?.contextLimit ?? 0;
  if (contextLimit >= 1_000_000) score += 25;
  else if (contextLimit >= 200_000) score += 12;
  else if (contextLimit >= 128_000) score += 6;

  if (normalized.includes('nemotron')) score += 16;
  if (normalized.includes('llama')) score += 12;
  if (normalized.includes('deepseek')) score += 12;
  if (normalized.includes('qwen')) score += 10;
  if (normalized.includes('coder')) score += 8;
  if (normalized.includes('mistral')) score += 8;
  if (normalized.includes('instruct')) score += 4;
  if (normalized.includes('nano')) score -= 12;
  if (normalized.includes('vision') || normalized.includes('-vl')) score += 4;

  return score;
}

export function buildCuratedNvidiaModelList(
  modelIds: string[],
  metadataById: Record<string, ModelsDevProviderMetadata>,
): string[] {
  const candidates = modelIds.filter((id) => isNvidiaChatModel(id, metadataById[id]));
  if (candidates.length === 0) return [];

  const priority = new Set(NVIDIA_PRIORITY_MODELS);
  const preferred = NVIDIA_PRIORITY_MODELS.filter((id) => candidates.includes(id));
  const ranked = candidates
    .filter((id) => !priority.has(id as typeof NVIDIA_PRIORITY_MODELS[number]))
    .sort((a, b) => {
      const scoreDelta = scoreNvidiaModel(b, metadataById[b]) - scoreNvidiaModel(a, metadataById[a]);
      if (scoreDelta !== 0) return scoreDelta;
      const contextDelta = (metadataById[b]?.contextLimit ?? 0) - (metadataById[a]?.contextLimit ?? 0);
      if (contextDelta !== 0) return contextDelta;
      return a.localeCompare(b);
    });

  return [...preferred, ...ranked].slice(0, NVIDIA_MAX_CURATED_MODELS);
}

function isOllamaChatModel(id: string, metadata?: ModelsDevProviderMetadata): boolean {
  if (!isProviderTextChatModel(id, metadata)) return false;
  return true;
}

function scoreOllamaModel(id: string, metadata?: ModelsDevProviderMetadata): number {
  const normalized = id.toLowerCase();
  let score = 0;

  const priorityIndex = OLLAMA_PRIORITY_MODELS.indexOf(id as typeof OLLAMA_PRIORITY_MODELS[number]);
  if (priorityIndex >= 0) {
    score += 10_000 - priorityIndex * 100;
  }

  if (metadata?.toolCall) score += 60;
  if (metadata?.reasoning) score += 20;
  if (metadata?.attachment) score += 18;
  if (metadata?.openWeights) score += 5;

  const contextLimit = metadata?.contextLimit ?? 0;
  if (contextLimit >= 1_000_000) score += 25;
  else if (contextLimit >= 200_000) score += 12;
  else if (contextLimit >= 128_000) score += 6;

  if (normalized.includes('gemini')) score += 16;
  if (normalized.includes('glm')) score += 14;
  if (normalized.includes('kimi')) score += 12;
  if (normalized.includes('deepseek')) score += 10;
  if (normalized.includes('devstral')) score += 10;
  if (normalized.includes('qwen')) score += 10;
  if (normalized.includes('coder')) score += 8;
  if (normalized.includes('nemotron')) score += 8;
  if (normalized.includes('gemma')) score += 6;
  if (normalized.includes('vl')) score += 4;
  if (normalized.includes('nano') || normalized.includes(':3b') || normalized.includes(':4b')) score -= 10;

  return score;
}

export function buildCuratedOllamaModelList(
  modelIds: string[],
  metadataById: Record<string, ModelsDevProviderMetadata>,
): string[] {
  const candidates = modelIds.filter((id) => isOllamaChatModel(id, metadataById[id]));
  if (candidates.length === 0) return [];

  const priority = new Set(OLLAMA_PRIORITY_MODELS);
  const preferred = OLLAMA_PRIORITY_MODELS.filter((id) => candidates.includes(id));
  const ranked = candidates
    .filter((id) => !priority.has(id as typeof OLLAMA_PRIORITY_MODELS[number]))
    .sort((a, b) => {
      const scoreDelta = scoreOllamaModel(b, metadataById[b]) - scoreOllamaModel(a, metadataById[a]);
      if (scoreDelta !== 0) return scoreDelta;
      const contextDelta = (metadataById[b]?.contextLimit ?? 0) - (metadataById[a]?.contextLimit ?? 0);
      if (contextDelta !== 0) return contextDelta;
      return a.localeCompare(b);
    });

  return [...preferred, ...ranked].slice(0, OLLAMA_MAX_CURATED_MODELS);
}

function isOpencodeChatModel(id: string, metadata?: ModelsDevProviderMetadata): boolean {
  if (!isProviderTextChatModel(id, metadata)) return false;
  return true;
}

function scoreOpencodeModel(id: string, metadata?: ModelsDevProviderMetadata): number {
  const normalized = id.toLowerCase();
  let score = 0;

  const priorityIndex = OPENCODE_PRIORITY_MODELS.indexOf(id as typeof OPENCODE_PRIORITY_MODELS[number]);
  if (priorityIndex >= 0) {
    score += 10_000 - priorityIndex * 100;
  }

  if (metadata?.toolCall) score += 70;
  if (metadata?.structuredOutput) score += 35;
  if (metadata?.reasoning) score += 22;
  if (metadata?.attachment) score += 15;
  if (metadata?.openWeights) score += 5;

  const contextLimit = metadata?.contextLimit ?? 0;
  if (contextLimit >= 1_000_000) score += 25;
  else if (contextLimit >= 200_000) score += 12;
  else if (contextLimit >= 128_000) score += 6;

  if (normalized.includes('claude')) score += 20;
  if (normalized.includes('opus')) score += 6;
  if (normalized.includes('sonnet')) score += 5;
  if (normalized.includes('gpt-5.4')) score += 16;
  if (normalized.includes('gpt-5.3')) score += 14;
  if (normalized.includes('codex')) score += 12;
  if (normalized.includes('gemini')) score += 12;
  if (normalized.includes('glm')) score += 10;
  if (normalized.includes('kimi')) score += 10;
  if (normalized.includes('qwen')) score += 8;
  if (normalized.includes('coder')) score += 7;
  if (normalized.includes(':free') || normalized.endsWith('-free')) score -= 10;
  if (normalized.includes('nano') || normalized.includes('haiku')) score -= 6;

  return score;
}

export function buildCuratedOpencodeModelList(
  modelIds: string[],
  metadataById: Record<string, ModelsDevProviderMetadata>,
): string[] {
  const candidates = modelIds.filter((id) => isOpencodeChatModel(id, metadataById[id]));
  if (candidates.length === 0) return [];

  const priority = new Set(OPENCODE_PRIORITY_MODELS);
  const preferred = OPENCODE_PRIORITY_MODELS.filter((id) => candidates.includes(id));
  const ranked = candidates
    .filter((id) => !priority.has(id as typeof OPENCODE_PRIORITY_MODELS[number]))
    .sort((a, b) => {
      const scoreDelta = scoreOpencodeModel(b, metadataById[b]) - scoreOpencodeModel(a, metadataById[a]);
      if (scoreDelta !== 0) return scoreDelta;
      const contextDelta = (metadataById[b]?.contextLimit ?? 0) - (metadataById[a]?.contextLimit ?? 0);
      if (contextDelta !== 0) return contextDelta;
      return a.localeCompare(b);
    });

  return [...preferred, ...ranked].slice(0, OPENCODE_MAX_CURATED_MODELS);
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
    if (curated.length > 0) return curated;
    return liveModels;
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
    return normalizeModelList(payload);
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
    if (curated.length > 0) return curated;
    return liveModels;
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
    if (curated.length > 0) return curated;
    return liveModels;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Nvidia NIM model list timed out after ${Math.floor(MODELS_FETCH_TIMEOUT_MS / 1000)}s`);
    }
    throw err;
  } finally {
    window.clearTimeout(timeoutId);
  }
}
