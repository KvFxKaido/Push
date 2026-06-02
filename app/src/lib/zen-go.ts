export type ZenGoTransport = 'openai' | 'anthropic';

// Models routed over the Anthropic Messages endpoint instead of the default
// OpenAI-compatible /chat/completions path. Two reasons land a model here:
//   - qwen3.7-max *requires* it: the live Go endpoint rejects it on the oa-compat
//     format ("Model qwen3.7-max is not supported for format oa-compat"), so the
//     openai transport would hard-fail on first use.
//   - the MiniMax family is routed here to match existing behavior (m2.5/m2.7
//     predate this change; m3 follows the family). These ids also accept oa-compat,
//     so flipping any MiniMax id back to openai is a safe one-line change.
const ZEN_GO_ANTHROPIC_MODELS = new Set([
  'minimax-m2.5',
  'minimax-m2.7',
  'minimax-m3',
  'qwen3.7-max',
]);

// Mirrors the live OpenCode Go catalog (opencode.ai/docs Go "How it works").
// Retired in the 2026-06 refresh: hy3-preview, mimo-v2-omni, mimo-v2-pro,
// qwen3.5-plus — dropped from the upstream list and no longer routable.
export const ZEN_GO_MODELS = [
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'glm-5',
  'glm-5.1',
  'kimi-k2.5',
  'kimi-k2.6',
  'mimo-v2.5',
  'mimo-v2.5-pro',
  'minimax-m2.5',
  'minimax-m2.7',
  'minimax-m3',
  'qwen3.6-plus',
  'qwen3.7-max',
] as const;

export const ZEN_GO_DEFAULT_MODEL: (typeof ZEN_GO_MODELS)[number] = 'glm-5.1';

export function getZenGoTransport(model: string | null | undefined): ZenGoTransport {
  const normalized = typeof model === 'string' ? model.trim() : '';
  return ZEN_GO_ANTHROPIC_MODELS.has(normalized) ? 'anthropic' : 'openai';
}
