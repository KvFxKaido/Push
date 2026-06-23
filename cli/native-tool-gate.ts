import {
  ANTHROPIC_MODELS,
  BLACKBOX_MODELS,
  FIREWORKS_MODELS,
  GOOGLE_MODELS,
  KILOCODE_MODELS,
  NVIDIA_MODELS,
  OLLAMA_MODELS,
  OPENADAPTER_MODELS,
  OPENAI_MODELS,
  OPENROUTER_MODELS,
  ZEN_MODELS,
} from '../lib/provider-models.ts';

const CURATED_NATIVE_TOOL_MODELS: Record<string, ReadonlySet<string>> = {
  anthropic: new Set(ANTHROPIC_MODELS),
  blackbox: new Set(BLACKBOX_MODELS),
  fireworks: new Set(FIREWORKS_MODELS),
  google: new Set(GOOGLE_MODELS),
  kilocode: new Set(KILOCODE_MODELS),
  nvidia: new Set(NVIDIA_MODELS),
  ollama: new Set(OLLAMA_MODELS),
  openadapter: new Set(OPENADAPTER_MODELS),
  openrouter: new Set(OPENROUTER_MODELS),
  zen: new Set(ZEN_MODELS),
};

function looksLikeOpenAIToolCallingModel(modelId: string): boolean {
  const m = modelId.trim().toLowerCase();
  return OPENAI_MODELS.includes(modelId) || /^gpt-[45](?:$|[-.]|o)/.test(m);
}

export function cliProviderModelSupportsNativeToolCalling(
  provider: string,
  modelId: string | undefined,
): boolean {
  if (!modelId) return false;
  if (provider === 'openai') return looksLikeOpenAIToolCallingModel(modelId);
  const allowlist = CURATED_NATIVE_TOOL_MODELS[provider];
  return allowlist ? allowlist.has(modelId) : false;
}
