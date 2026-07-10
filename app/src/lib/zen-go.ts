export type ZenGoTransport = 'openai' | 'anthropic';

// Models routed over the Anthropic Messages endpoint (/zen/go/v1/messages,
// @ai-sdk/anthropic upstream) instead of the default OpenAI-compatible
// /chat/completions path. Per the live OpenCode Go catalog the entire MiniMax
// and Qwen families publish on the Messages endpoint:
//   - qwen3.7-max *requires* it: the live Go endpoint rejects it on the oa-compat
//     format ("Model qwen3.7-max is not supported for format oa-compat"), so the
//     openai transport would hard-fail on first use. qwen3.6-plus / qwen3.7-plus
//     are listed alongside it under @ai-sdk/anthropic, so they route here too.
//   - the MiniMax family (m2.7/m3) is published under @ai-sdk/anthropic.
//     These ids also accept oa-compat, so flipping any MiniMax id back to openai
//     is a safe one-line change.
// BYOK implication (2026-07-09): this set is exactly the zen surface gateway
// BYOK can NOT serve keyless — /zen/go/v1/messages authenticates via
// `x-api-key`, and custom-provider key injection sets `Authorization` only.
// Do NOT "fix" that by emptying this set: @ai-sdk/anthropic is OpenCode's
// official contract for these models, and oa-compat acceptance is incidental
// upstream behavior that has already flip-flopped (qwen3.7-max rejected
// oa-compat in June, answered it in July). Partial-BYOK settings copy keys
// off `byokPartialNote` in lib/provider-definition.ts.
// NOTE: /zen/go/v1/messages is a single fixed URL shared by all of these models,
// so the model id MUST travel in the request body — `handleZenGoChat` emits it
// (unlike Vertex, which carries the model in the URL path). Dropping the body
// `model` here makes the model undispatchable upstream; see the regression
// where every MiniMax/Qwen id 400'd on a model-less body.
const ZEN_GO_ANTHROPIC_MODELS = new Set([
  'minimax-m2.5',
  'minimax-m2.7',
  'minimax-m3',
  'qwen3.6-plus',
  'qwen3.7-max',
  'qwen3.7-plus',
]);

// Mirrors the live OpenCode Go catalog (opencode.ai/docs/go). Refreshed
// 2026-07-09 against the official endpoints table: re-added minimax-m2.5
// (retired 2026-06-17 as dropped upstream; the current docs list it again on
// /v1/messages under @ai-sdk/anthropic — endpoint splits per model verified
// row-by-row against the docs, no consolidation). 2026-06-17: added glm-5.2
// and kimi-k2.7-code; retired glm-5 and kimi-k2.5. Earlier 2026-06 refresh
// retired hy3-preview, mimo-v2-omni, mimo-v2-pro, qwen3.5-plus.
export const ZEN_GO_MODELS = [
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'glm-5.1',
  'glm-5.2',
  'kimi-k2.6',
  'kimi-k2.7-code',
  'mimo-v2.5',
  'mimo-v2.5-pro',
  'minimax-m2.5',
  'minimax-m2.7',
  'minimax-m3',
  'qwen3.6-plus',
  'qwen3.7-max',
  'qwen3.7-plus',
] as const;

export const ZEN_GO_DEFAULT_MODEL: (typeof ZEN_GO_MODELS)[number] = 'glm-5.1';

export function getZenGoTransport(model: string | null | undefined): ZenGoTransport {
  const normalized = typeof model === 'string' ? model.trim() : '';
  return ZEN_GO_ANTHROPIC_MODELS.has(normalized) ? 'anthropic' : 'openai';
}
