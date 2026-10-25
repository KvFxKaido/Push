import { getZenGoTransport } from './zen-go.js';

/**
 * Which upstream wire a Zen model speaks. Standard (pay-as-you-go) Zen serves
 * each model on exactly one endpoint and answers the others with
 * `400 ModelProtocolUnsupported`:
 *   - `anthropic` → `/zen/v1/messages` (Anthropic Messages)
 *   - `responses` → `/zen/v1/responses` (OpenAI Responses)
 *   - `openai`    → `/zen/v1/chat/completions` (OpenAI Chat Completions)
 *
 * Source: the endpoint column of the OpenCode Console models table
 * (opencode.ai/docs/zen), read 2026-10-25. Families are matched by prefix
 * because the docs route every Claude to Messages and every GPT / Grok / Muse
 * to Responses, so a newly listed member of those families routes correctly
 * without a table edit. Anything unmatched (GLM, Kimi, DeepSeek, MiniMax,
 * Mistral, big-pickle, the free models, Gemini) stays on Chat Completions,
 * the historical default.
 *
 * Go is a separate service with its own table (lib/zen-go.ts): the same id can
 * differ by tier — MiniMax is Messages on Go but Chat Completions on standard.
 */
export type ZenTransport = 'openai' | 'anthropic' | 'responses';

const ZEN_ANTHROPIC_PREFIXES = ['claude-'];
const ZEN_RESPONSES_PREFIXES = ['gpt-', 'grok-', 'muse-'];
// Qwen is split across endpoints on standard Zen; these three are Messages,
// while `qwen3.8-max` is Chat Completions.
const ZEN_ANTHROPIC_MODELS = new Set(['qwen3.5-plus', 'qwen3.6-plus', 'qwen3.8-flash']);

export function getZenTransport(
  model: string | null | undefined,
  options: { go?: boolean } = {},
): ZenTransport {
  if (options.go) return getZenGoTransport(model);
  const id = typeof model === 'string' ? model.trim() : '';
  if (ZEN_ANTHROPIC_MODELS.has(id) || ZEN_ANTHROPIC_PREFIXES.some((p) => id.startsWith(p))) {
    return 'anthropic';
  }
  if (ZEN_RESPONSES_PREFIXES.some((p) => id.startsWith(p))) return 'responses';
  return 'openai';
}
