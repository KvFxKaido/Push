/**
 * Shared native function-calling gate primitives.
 *
 * `lib/capability-profile.ts` owns the cross-surface decision algorithm. These
 * are the lower-level model-id exceptions it consumes after each surface has
 * supplied its catalog metadata.
 */
import { OPENAI_MODELS } from './provider-models.js';

const OPENAI_NATIVE_TOOL_CALLING_MODELS: ReadonlySet<string> = new Set(OPENAI_MODELS);

/**
 * Ollama-hosted model ids denied native function calling even when capability
 * metadata reports support. MiniMax M3 on Ollama Cloud's OpenAI-compatible
 * path stalls (~20s) and returns empty after the first `role: "tool"` result
 * (ollama/ollama#16389) — fatal to Push's multi-round tool loop, while
 * text-dispatch works fine. Both the hosted-catalog id and the `:cloud` tag a
 * local install registers are listed. Removal is tracked in #1289 — remove
 * entries there once the upstream fix lands.
 */
export const OLLAMA_NATIVE_TOOL_CALLING_DENYLIST: ReadonlySet<string> = new Set([
  'minimax-m3',
  'minimax-m3:cloud',
]);

/** OpenAI-family model id (curated catalog or `gpt-4*` / `gpt-5*` shape). */
export function looksLikeOpenAIToolCallingModel(modelId: string): boolean {
  const m = modelId.trim().toLowerCase();
  return OPENAI_NATIVE_TOOL_CALLING_MODELS.has(modelId) || /^gpt-[45](?:$|[-.]|o)/.test(m);
}
