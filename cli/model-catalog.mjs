/**
 * Curated model lists per provider.
 * Free-text input is always accepted — these are suggestions, not constraints.
 */

export const OPENROUTER_MODELS = [
  'anthropic/claude-sonnet-4.6',
  'anthropic/claude-opus-4.6',
  'anthropic/claude-haiku-4.5',
  'openai/gpt-5.2-codex',
  'openai/gpt-5.1-codex',
  'stepfun/step-3.5-flash:free',
  'qwen/qwen3-coder:free',
  'deepseek/deepseek-r1-0528:free',
  'google/gemini-3-flash-preview',
  'google/gemini-3.1-pro-preview',
  'x-ai/grok-4.1-fast',
  'moonshotai/kimi-k2.5',
];

export const OLLAMA_MODELS = [
  'gemini-3-flash-preview',
  'qwen3',
  'llama4',
  'devstral',
];

export const MISTRAL_MODELS = [
  'devstral-small-latest',
  'mistral-large-latest',
  'codestral-latest',
];

export const ZAI_MODELS = [
  'glm-4.5',
];

export const GOOGLE_MODELS = [
  'gemini-3.1-pro-preview',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-2.0-flash',
];

export const ZEN_MODELS = [
  'qwen3-coder',
  'kimi-k2.5',
  'kimi-k2.5-free',
  'minimax-m2.5-free',
  'big-pickle',
];

const CATALOG = {
  ollama: OLLAMA_MODELS,
  mistral: MISTRAL_MODELS,
  openrouter: OPENROUTER_MODELS,
  zai: ZAI_MODELS,
  google: GOOGLE_MODELS,
  zen: ZEN_MODELS,
};

/** Default model per provider — must match PROVIDER_CONFIGS defaults. */
export const DEFAULT_MODELS = {
  ollama: 'gemini-3-flash-preview',
  mistral: 'devstral-small-latest',
  openrouter: 'anthropic/claude-sonnet-4.6',
  zai: 'glm-4.5',
  google: 'gemini-3.1-pro-preview',
  zen: 'big-pickle',
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
 * Google lists models from the native Generative Language endpoint, not the
 * OpenAI-compatible `/openai/models` path. Convert:
 *   .../v1beta/openai/chat/completions -> .../v1beta/models
 */
function deriveGoogleModelsUrl(chatUrl) {
  const replaced = chatUrl.replace(/\/(v[^/]+)\/openai\/chat\/completions\/?$/, '/$1/models');
  if (replaced === chatUrl) return null;
  return replaced;
}

function addQueryParam(urlStr, key, value) {
  const url = new URL(urlStr);
  url.searchParams.set(key, value);
  return url.toString();
}

/**
 * Fetch live model list from a provider's /models endpoint.
 * Returns { models: string[], source: 'live' | 'curated', error?: string }.
 * Falls back to curated list on any failure.
 */
export async function fetchModels(providerConfig, apiKey, { timeoutMs = 10_000 } = {}) {
  const providerId = providerConfig.id;
  const curated = getCuratedModels(providerId);

  const modelsUrl = providerId === 'google'
    ? (deriveGoogleModelsUrl(providerConfig.url) || deriveModelsUrl(providerConfig.url))
    : deriveModelsUrl(providerConfig.url);
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
    // Google uses ?key= instead of Authorization header
    let url = modelsUrl;
    if (providerId === 'google' && apiKey) {
      url = addQueryParam(url, 'key', apiKey);
      delete headers.Authorization;
    }

    const response = await fetch(url, { method: 'GET', headers, signal: controller.signal });
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
      if (providerId === 'google') {
        ids = payload.models
          .filter((m) => {
            if (!Array.isArray(m?.supportedGenerationMethods)) return true;
            return m.supportedGenerationMethods.includes('generateContent');
          })
          .map(m => m.name || m.id || m.model || '')
          .map((id) => String(id).replace(/^models\//, ''))
          .filter(Boolean);
      } else {
        ids = payload.models
          .map(m => m.name || m.id || m.model || '')
          .filter(Boolean);
      }
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
