/**
 * Curated model lists per provider.
 * Free-text input is always accepted — these are suggestions, not constraints.
 */

export const OPENROUTER_MODELS = [
  'anthropic/claude-sonnet-4.6',
  'anthropic/claude-opus-4.6',
  'anthropic/claude-haiku-4.5',
  'openai/gpt-5.2',
  'openai/gpt-5-mini',
  'openai/o1',
  'openai/gpt-5.2-codex',
  'openai/gpt-5.1-codex',
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
  google: 'gemini-2.5-flash',
  zen: 'qwen3-coder',
};

/**
 * Return the curated model list for a provider.
 * Unknown providers return an empty array.
 */
export function getCuratedModels(providerId) {
  return CATALOG[providerId] || [];
}
