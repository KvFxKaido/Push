/**
 * Curated model lists per provider.
 * Free-text input is always accepted — these are suggestions, not constraints.
 */

export const OPENROUTER_MODELS: readonly string[] = [
  'anthropic/claude-haiku-4.5:nitro',
  'anthropic/claude-opus-4.6:nitro',
  'anthropic/claude-sonnet-4.6:nitro',
  'arcee-ai/virtuoso-large',
  'cohere/command-a',
  'deepseek/deepseek-r1',
  'deepseek/deepseek-v3.2:nitro',
  'google/gemini-2.5-flash:nitro',
  'google/gemini-2.5-pro:nitro',
  'google/gemini-3-flash-preview:nitro',
  'google/gemini-3.1-flash-lite-preview:nitro',
  'google/gemini-3.1-pro-preview:nitro',
  'google/gemini-3.1-pro-preview-customtools:nitro',
  'inception/mercury-2',
  'meta-llama/llama-4-maverick',
  'minimax/minimax-m2.5',
  'mistralai/codestral-2508',
  'mistralai/devstral-2512',
  'mistralai/mistral-large-2512',
  'moonshotai/kimi-k2.5:nitro',
  'openai/gpt-5-mini',
  'openai/gpt-5.2-codex',
  'openai/gpt-5.3-codex',
  'openai/gpt-5.4',
  'openai/gpt-5.4-pro',
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
];

export const OLLAMA_MODELS: readonly string[] = [
  // Cloud-first curated fallback. Live `/models` fetch and free-text entry
  // cover account-specific availability beyond this baseline.
  'gemini-3-flash-preview',
];

export const ZEN_MODELS: readonly string[] = [
  'openai/gpt-5.3-codex',
  'openai/gpt-5.2-codex',
  'qwen3-coder',
  'gemini-3-flash',
  'gemini-3-pro',
  'kimi-k2.5',
  'kimi-k2.5-free',
  'minimax-m2.5-free',
  'big-pickle',
];

export const NVIDIA_MODELS: readonly string[] = [
  'nvidia/llama-3.1-nemotron-70b-instruct',
  'meta/llama-3.3-70b-instruct',
  'meta/llama-3.1-405b-instruct',
  'deepseek-ai/deepseek-r1',
  'qwen/qwen2.5-coder-32b-instruct',
  'mistralai/mistral-large-2-instruct',
];

export const KILOCODE_MODELS: readonly string[] = [
  'google/gemini-3-flash-preview',
  'anthropic/claude-sonnet-4.6',
  'openai/gpt-5.2',
  'moonshotai/kimi-k2.5',
  'kilo-auto/balanced',
];

export const BLACKBOX_MODELS: readonly string[] = [
  'blackbox-ai',
  'blackbox-pro',
  'blackbox-search',
];

export const OPENADAPTER_MODELS: readonly string[] = [
  'deepseek/deepseek-r1',
  'deepseek/deepseek-v3',
  'qwen/qwen3-coder',
  'qwen/qwen3.5',
  'mistralai/mistral-large',
  'mistralai/devstral',
  'moonshotai/kimi-k2.5',
  'minimax/minimax-m2.5',
  'meta-llama/llama-4-maverick',
  'z-ai/glm-5',
];

export type ProviderId = 'ollama' | 'openrouter' | 'zen' | 'nvidia' | 'kilocode' | 'blackbox' | 'openadapter';

const CATALOG: Record<ProviderId, readonly string[]> = {
  ollama: OLLAMA_MODELS,
  openrouter: OPENROUTER_MODELS,
  zen: ZEN_MODELS,
  nvidia: NVIDIA_MODELS,
  kilocode: KILOCODE_MODELS,
  blackbox: BLACKBOX_MODELS,
  openadapter: OPENADAPTER_MODELS,
};

/** Default model per provider — keep in sync with PROVIDER_CONFIGS in provider.ts. */
export const DEFAULT_MODELS: Record<ProviderId, string> = {
  ollama: 'gemini-3-flash-preview',
  openrouter: 'anthropic/claude-sonnet-4.6:nitro',
  zen: 'big-pickle',
  nvidia: 'nvidia/llama-3.1-nemotron-70b-instruct',
  kilocode: 'google/gemini-3-flash-preview',
  blackbox: 'blackbox-ai',
  openadapter: 'deepseek/deepseek-v3',
} as const;

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
