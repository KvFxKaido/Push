/**
 * Curated model lists per provider.
 * Free-text input is always accepted — these are suggestions, not constraints.
 */

export const OPENROUTER_MODELS = [
  'anthropic/claude-sonnet-4.6',
  'anthropic/claude-opus-4.6',
  'anthropic/claude-haiku-4.5',
  'openai/gpt-5.4-pro',
  'openai/gpt-5.4',
  'openai/gpt-5.2-codex',
  'openai/gpt-5.3-codex',
  'stepfun/step-3.5-flash:free',
  'google/gemini-3.1-pro-preview',
  'google/gemini-3.1-pro-preview-customtools',
  'google/gemini-3.1-flash-lite-preview',
  // Mistral (via OpenRouter BYOK)
  'mistralai/mistral-large-2512',
  'mistralai/devstral-2512',
  'mistralai/mistral-medium-3.1',
  // MiniMax (via OpenRouter BYOK)
  'minimax/minimax-m2.5',
  'minimax/minimax-m2.1',
  // Qwen
  'qwen/qwen3.5-flash-02-23',
  // Z.AI (via OpenRouter BYOK)
  'zhipu/glm-4.7',
  'zhipu/glm-5.0',
  // Inception (Mercury diffusion LLMs)
  'inception/mercury-2',
  'inception/mercury-coder',
  'inception/mercury',
  'x-ai/grok-4.1-fast',
  'moonshotai/kimi-k2.5',
];

export const OLLAMA_MODELS = [
  // Cloud-first curated fallback. Live `/models` fetch and free-text entry
  // cover account-specific availability beyond this baseline.
  'gemini-3-flash-preview',
];

export const ZEN_MODELS = [
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

export const NVIDIA_MODELS = [
  'nvidia/llama-3.1-nemotron-70b-instruct',
  'meta/llama-3.3-70b-instruct',
  'meta/llama-3.1-405b-instruct',
  'deepseek-ai/deepseek-r1',
  'qwen/qwen2.5-coder-32b-instruct',
  'mistralai/mistral-large-2-instruct',
];

const CATALOG = {
  ollama: OLLAMA_MODELS,
  openrouter: OPENROUTER_MODELS,
  zen: ZEN_MODELS,
  nvidia: NVIDIA_MODELS,
};

/** Default model per provider — must match PROVIDER_CONFIGS defaults. */
export const DEFAULT_MODELS = {
  ollama: 'gemini-3-flash-preview',
  openrouter: 'anthropic/claude-sonnet-4.6',
  zen: 'big-pickle',
  nvidia: 'nvidia/llama-3.1-nemotron-70b-instruct',
};

/**
 * Return the curated model list for a provider.
 * Unknown providers return an empty array.
 */
export function getCuratedModels(providerId) {
  return CATALOG[providerId] || [];
}

/**
 * Derive the /models endpoint from a provider's chat/completions URL.
 * Works for all OpenAI-compatible providers.
 */
function deriveModelsUrl(chatUrl) {
  return chatUrl.replace(/\/chat\/completions\/?$/, '/models');
}

/**
 * Fetch live model list from a provider's /models endpoint.
 * Returns { models: string[], source: 'live' | 'curated', error?: string }.
 * Falls back to curated list on any failure.
 */
export async function fetchModels(providerConfig, apiKey, { timeoutMs = 10_000 } = {}) {
  const providerId = providerConfig.id;
  const curated = getCuratedModels(providerId);

  const modelsUrl = deriveModelsUrl(providerConfig.url);
  // If URL didn't change (no /chat/completions to replace), skip live fetch
  if (modelsUrl === providerConfig.url) {
    return { models: curated, source: 'curated' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = { 'Accept': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    if (providerId === 'openrouter') {
      headers['HTTP-Referer'] = process.env.PUSH_OPENROUTER_REFERER || 'https://push.local';
    }
    const response = await fetch(modelsUrl, { method: 'GET', headers, signal: controller.signal });
    if (!response.ok) {
      return { models: curated, source: 'curated', error: `HTTP ${response.status}` };
    }

    const payload = await response.json();

    // OpenAI-compatible: { data: [{ id: "model-name" }, ...] }
    // Ollama native: { models: [{ name: "model-name" }, ...] }
    let ids = [];
    if (Array.isArray(payload.data)) {
      ids = payload.data
        .map(m => m.id || m.name || '')
        .filter(Boolean);
    } else if (Array.isArray(payload.models)) {
      ids = payload.models
        .map(m => m.name || m.id || m.model || '')
        .filter(Boolean);
    }

    if (ids.length === 0) {
      return { models: curated, source: 'curated', error: 'empty response' };
    }

    // De-duplicate while preserving first occurrence.
    ids = [...new Set(ids)];

    // Sort: put curated models first (in their original order), then remaining
    const curatedSet = new Set(curated);
    const inCurated = ids.filter(id => curatedSet.has(id));
    const extra = ids.filter(id => !curatedSet.has(id)).sort();
    // Keep curated order for known models, append discovered ones
    const orderedCurated = curated.filter(id => ids.includes(id));
    const merged = [...orderedCurated, ...extra.filter(id => !orderedCurated.includes(id))];

    return { models: merged, source: 'live' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err?.name === 'AbortError') {
      return { models: curated, source: 'curated', error: 'timeout' };
    }
    return { models: curated, source: 'curated', error: message };
  } finally {
    clearTimeout(timeout);
  }
}
