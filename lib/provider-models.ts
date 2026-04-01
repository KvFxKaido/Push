/**
 * Shared provider model defaults and curated suggestion lists.
 *
 * Keep this module data-only so both the web app and CLI can consume it
 * without inheriting each other's runtime-specific catalog logic.
 */

export type SharedProviderModelId =
  | 'ollama'
  | 'openrouter'
  | 'zen'
  | 'nvidia'
  | 'kilocode'
  | 'blackbox'
  | 'openadapter';

export const OLLAMA_DEFAULT_MODEL = 'gemini-3-flash-preview';
export const OPENROUTER_DEFAULT_MODEL = 'anthropic/claude-sonnet-4.6:nitro';
export const ZEN_DEFAULT_MODEL = 'big-pickle';
export const NVIDIA_DEFAULT_MODEL = 'nvidia/llama-3.1-nemotron-70b-instruct';
export const KILOCODE_DEFAULT_MODEL = 'google/gemini-3-flash-preview';
export const BLACKBOX_DEFAULT_MODEL = 'blackbox-ai';
export const OPENADAPTER_DEFAULT_MODEL = 'deepseek/deepseek-v3';

export const OLLAMA_MODELS: string[] = [
  // Cloud-first curated fallback. Live `/models` fetch and free-text entry
  // cover account-specific availability beyond this baseline.
  OLLAMA_DEFAULT_MODEL,
];

export const OPENROUTER_MODELS: string[] = [
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
  'qwen/qwen3.6-plus-preview:free',
  'stepfun/step-3.5-flash',
  'x-ai/grok-4.1-fast',
  'x-ai/grok-4.20',
  'x-ai/grok-4.20-beta',
  'z-ai/glm-4.7:nitro',
  'z-ai/glm-5:nitro',
  'z-ai/glm-5-turbo:nitro',
];

export const ZEN_MODELS: string[] = [
  'openai/gpt-5.3-codex',
  'openai/gpt-5.2-codex',
  'qwen3-coder',
  'gemini-3-flash',
  'gemini-3-pro',
  'kimi-k2.5',
  'kimi-k2.5-free',
  'minimax-m2.5-free',
  ZEN_DEFAULT_MODEL,
];

export const NVIDIA_MODELS: string[] = [
  NVIDIA_DEFAULT_MODEL,
  'meta/llama-3.3-70b-instruct',
  'meta/llama-3.1-405b-instruct',
  'deepseek-ai/deepseek-r1',
  'qwen/qwen2.5-coder-32b-instruct',
  'mistralai/mistral-large-2-instruct',
];

export const KILOCODE_MODELS: string[] = [
  KILOCODE_DEFAULT_MODEL,
  'anthropic/claude-sonnet-4.6',
  'openai/gpt-5.2',
  'moonshotai/kimi-k2.5',
  'kilo-auto/balanced',
];

export const BLACKBOX_MODELS: string[] = [
  BLACKBOX_DEFAULT_MODEL,
  'blackbox-pro',
  'blackbox-search',
];

export const OPENADAPTER_MODELS: string[] = [
  'deepseek/deepseek-r1',
  OPENADAPTER_DEFAULT_MODEL,
  'qwen/qwen3-coder',
  'qwen/qwen3.5',
  'mistralai/mistral-large',
  'mistralai/devstral',
  'moonshotai/kimi-k2.5',
  'minimax/minimax-m2.5',
  'meta-llama/llama-4-maverick',
  'z-ai/glm-5',
];

export const SHARED_PROVIDER_MODEL_CATALOG: Record<SharedProviderModelId, string[]> = {
  ollama: OLLAMA_MODELS,
  openrouter: OPENROUTER_MODELS,
  zen: ZEN_MODELS,
  nvidia: NVIDIA_MODELS,
  kilocode: KILOCODE_MODELS,
  blackbox: BLACKBOX_MODELS,
  openadapter: OPENADAPTER_MODELS,
};

export const SHARED_PROVIDER_DEFAULT_MODELS: Record<SharedProviderModelId, string> = {
  ollama: OLLAMA_DEFAULT_MODEL,
  openrouter: OPENROUTER_DEFAULT_MODEL,
  zen: ZEN_DEFAULT_MODEL,
  nvidia: NVIDIA_DEFAULT_MODEL,
  kilocode: KILOCODE_DEFAULT_MODEL,
  blackbox: BLACKBOX_DEFAULT_MODEL,
  openadapter: OPENADAPTER_DEFAULT_MODEL,
};

export function getSharedCuratedModels(providerId: string): readonly string[] {
  return SHARED_PROVIDER_MODEL_CATALOG[providerId as SharedProviderModelId] || [];
}
