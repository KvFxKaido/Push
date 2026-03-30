/**
 * Curated model lists per provider.
 * Free-text input is always accepted — these are suggestions, not constraints.
 */
import {
  BLACKBOX_MODELS,
  KILOCODE_MODELS,
  NVIDIA_MODELS,
  OLLAMA_MODELS,
  OPENADAPTER_MODELS,
  OPENROUTER_MODELS,
  SHARED_PROVIDER_DEFAULT_MODELS,
  SHARED_PROVIDER_MODEL_CATALOG,
  ZEN_MODELS,
  type SharedProviderModelId,
} from '../lib/provider-models.ts';

export {
  BLACKBOX_MODELS,
  KILOCODE_MODELS,
  NVIDIA_MODELS,
  OLLAMA_MODELS,
  OPENADAPTER_MODELS,
  OPENROUTER_MODELS,
  ZEN_MODELS,
};

export type ProviderId = SharedProviderModelId;

const CATALOG: Record<ProviderId, readonly string[]> = SHARED_PROVIDER_MODEL_CATALOG;

/** Default model per provider — keep in sync with PROVIDER_CONFIGS in provider.ts. */
export const DEFAULT_MODELS: Record<ProviderId, string> = SHARED_PROVIDER_DEFAULT_MODELS;

/**
 * Return the curated model list for a provider.
 * Unknown providers return an empty array.
 */
export function getCuratedModels(providerId: string): readonly string[] {
  return CATALOG[providerId as ProviderId] || [];
}

/**
 * Derive the /models endpoint from a provider's chat/completions URL.
 * Works for all OpenAI-compatible providers.
 */
function deriveModelsUrl(chatUrl: string): string {
  return chatUrl.replace(/\/chat\/completions\/?$/, '/models');
}

interface ProviderConfig {
  id: string;
  url: string;
}

interface FetchModelsOptions {
  timeoutMs?: number;
}

interface FetchModelsResult {
  models: string[];
  source: 'live' | 'curated';
  error?: string;
}

interface ModelEntry {
  id?: string;
  name?: string;
  model?: string;
}

interface ModelsPayload {
  data?: ModelEntry[];
  models?: ModelEntry[];
}

/**
 * Fetch live model list from a provider's /models endpoint.
 * Returns { models: string[], source: 'live' | 'curated', error?: string }.
 * Falls back to curated list on any failure.
 */
export async function fetchModels(
  providerConfig: ProviderConfig,
  apiKey: string | undefined,
  { timeoutMs = 10_000 }: FetchModelsOptions = {},
): Promise<FetchModelsResult> {
  const providerId = providerConfig.id;
  const curated = getCuratedModels(providerId) as string[];

  const modelsUrl = deriveModelsUrl(providerConfig.url);
  // If URL didn't change (no /chat/completions to replace), skip live fetch
  if (modelsUrl === providerConfig.url) {
    return { models: curated, source: 'curated' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = { 'Accept': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    if (providerId === 'openrouter') {
      headers['HTTP-Referer'] = process.env.PUSH_OPENROUTER_REFERER || 'https://push.local';
    }
    const response = await fetch(modelsUrl, { method: 'GET', headers, signal: controller.signal });
    if (!response.ok) {
      return { models: curated, source: 'curated', error: `HTTP ${response.status}` };
    }

    const payload: ModelsPayload = await response.json();

    // OpenAI-compatible: { data: [{ id: "model-name" }, ...] }
    // Ollama native: { models: [{ name: "model-name" }, ...] }
    let ids: string[] = [];
    if (Array.isArray(payload.data)) {
      ids = payload.data
        .map((m: ModelEntry) => m.id || m.name || '')
        .filter(Boolean);
    } else if (Array.isArray(payload.models)) {
      ids = payload.models
        .map((m: ModelEntry) => m.name || m.id || m.model || '')
        .filter(Boolean);
    }

    if (ids.length === 0) {
      return { models: curated, source: 'curated', error: 'empty response' };
    }

    // De-duplicate while preserving first occurrence.
    ids = [...new Set(ids)];

    // Sort: put curated models first (in their original order), then remaining
    const curatedSet = new Set(curated);
    const extra = ids.filter((id: string) => !curatedSet.has(id)).sort();
    // Keep curated order for known models, append discovered ones
    const orderedCurated = curated.filter((id: string) => ids.includes(id));
    const merged = [...orderedCurated, ...extra.filter((id: string) => !orderedCurated.includes(id))];

    return { models: merged, source: 'live' };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof Error && err.name === 'AbortError') {
      return { models: curated, source: 'curated', error: 'timeout' };
    }
    return { models: curated, source: 'curated', error: message };
  } finally {
    clearTimeout(timeout);
  }
}
