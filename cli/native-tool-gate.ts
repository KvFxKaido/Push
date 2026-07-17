import {
  ANTHROPIC_MODELS,
  FIREWORKS_MODELS,
  GOOGLE_MODELS,
  NVIDIA_MODELS,
  OLLAMA_MODELS,
  OPENROUTER_MODELS,
  SAKANA_MODELS,
  XAI_MODELS,
  ZAI_MODELS,
  KIMI_MODELS,
  HUGGINGFACE_MODELS,
  ZEN_MODELS,
} from '../lib/provider-models.ts';
import { OLLAMA_NATIVE_TOOL_CALLING_DENYLIST } from '../lib/native-tool-gate.ts';
import {
  resolvePushCapabilityProfile,
  type PushCapabilityProfileOptions,
  type PushModelCapabilityMetadata,
} from '../lib/capability-profile.ts';
import type { PushCapabilityProfile } from '../lib/capabilities.ts';

// The CLI has no models.dev cache, so its metadata adapter projects curated
// catalogs into the shared profile resolver's raw evidence shape. Provider
// policy and profile coherence stay in `lib/capability-profile.ts`.
const CURATED_NATIVE_TOOL_MODELS: Record<string, ReadonlySet<string>> = {
  anthropic: new Set(ANTHROPIC_MODELS),
  fireworks: new Set(FIREWORKS_MODELS),
  google: new Set(GOOGLE_MODELS),
  nvidia: new Set(NVIDIA_MODELS),
  ollama: new Set(OLLAMA_MODELS.filter((id) => !OLLAMA_NATIVE_TOOL_CALLING_DENYLIST.has(id))),
  openrouter: new Set(OPENROUTER_MODELS),
  sakana: new Set(SAKANA_MODELS),
  xai: new Set(XAI_MODELS),
  zai: new Set(ZAI_MODELS),
  kimi: new Set(KIMI_MODELS),
  huggingface: new Set(HUGGINGFACE_MODELS),
  zen: new Set(ZEN_MODELS),
};

export function cliProviderModelSupportsNativeToolCalling(
  provider: string,
  modelId: string | undefined,
): boolean {
  return resolveCliPushCapabilityProfile(provider, modelId).toolCalling === 'native';
}

function lookupCliPushCapabilityMetadata(
  provider: string,
  modelId: string,
): PushModelCapabilityMetadata {
  const allowlist = CURATED_NATIVE_TOOL_MODELS[provider];
  return { toolCall: allowlist?.has(modelId) ?? false };
}

export function resolveCliPushCapabilityProfile(
  provider: string,
  modelId: string | undefined,
  options?: PushCapabilityProfileOptions,
): PushCapabilityProfile {
  return resolvePushCapabilityProfile(provider, modelId, lookupCliPushCapabilityMetadata, options);
}
