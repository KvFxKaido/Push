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
  ZEN_MODELS,
} from '../lib/provider-models.ts';
import {
  looksLikeOpenAIToolCallingModel,
  OLLAMA_NATIVE_TOOL_CALLING_DENYLIST,
} from '../lib/native-tool-gate.ts';

// Name-based curated allowlists. For the providers also gated by name on the web
// surface, these are the SAME `lib/provider-models.ts` data the web gate builds
// from, so the two stay in lockstep (pinned by the web↔CLI drift test in
// `app/src/lib/model-catalog.test.ts`). The capability-based providers
// (openrouter / ollama / nvidia) are gated by models.dev metadata on
// the web; the CLI has no models.dev cache, so it falls back to the curated
// catalog here — an intentional, documented surface difference the drift test
// excludes from its parity assertions.
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
  zen: new Set(ZEN_MODELS),
};

export function cliProviderModelSupportsNativeToolCalling(
  provider: string,
  modelId: string | undefined,
): boolean {
  if (!modelId) return false;
  // Shared name-based decisions (single definition in `lib/native-tool-gate.ts`),
  // kept identical to the web gate.
  if (provider === 'openai') {
    return looksLikeOpenAIToolCallingModel(modelId);
  }
  const allowlist = CURATED_NATIVE_TOOL_MODELS[provider];
  return allowlist ? allowlist.has(modelId) : false;
}
