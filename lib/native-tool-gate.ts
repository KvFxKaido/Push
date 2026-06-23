/**
 * Shared native function-calling gate primitives.
 *
 * Native-FC gating runs on two surfaces with different runtime constraints: the
 * web gate (`providerModelSupportsNativeToolCalling` in
 * `app/src/lib/model-catalog.ts`) can read models.dev capability caches and
 * browser config; the CLI gate (`cliProviderModelSupportsNativeToolCalling` in
 * `cli/native-tool-gate.ts`) cannot. The web gate therefore can't be the CLI's
 * definition. To keep the two from drifting, the pieces that ARE pure and shared
 * — the OpenAI/Bedrock model-id shape checks and the curated Vertex model set —
 * live here and are imported by both. A drift-detector test
 * (`app/src/lib/model-catalog.test.ts`) pins web↔CLI parity for the name-based
 * providers; capability-based providers (OpenRouter / Ollama / Nvidia via
 * models.dev) are intentionally resolved per surface and excluded from parity.
 */
import { OPENAI_MODELS, VERTEX_MODELS } from './provider-models.js';

const OPENAI_NATIVE_TOOL_CALLING_MODELS: ReadonlySet<string> = new Set(OPENAI_MODELS);

/** Curated Vertex model ids cleared for native function calling. */
export const VERTEX_NATIVE_TOOL_CALLING_MODELS: ReadonlySet<string> = new Set(VERTEX_MODELS);

/** OpenAI-family model id (curated catalog or `gpt-4*` / `gpt-5*` shape). */
export function looksLikeOpenAIToolCallingModel(modelId: string): boolean {
  const m = modelId.trim().toLowerCase();
  return OPENAI_NATIVE_TOOL_CALLING_MODELS.has(modelId) || /^gpt-[45](?:$|[-.]|o)/.test(m);
}

/** Bedrock Anthropic Claude model id (optionally region-prefixed, e.g. `us.anthropic.claude-…`). */
export function looksLikeBedrockAnthropicToolCallingModel(modelId: string): boolean {
  const m = modelId.trim().toLowerCase();
  return /^(?:[a-z]{2}\.)?anthropic\.claude(?:-[345]|-(?:haiku|opus|sonnet))/.test(m);
}
