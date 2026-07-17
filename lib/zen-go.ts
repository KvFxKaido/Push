export type ZenGoTransport = 'openai' | 'anthropic';

// Models routed over the Anthropic Messages endpoint (/zen/go/v1/messages,
// @ai-sdk/anthropic upstream) instead of the default OpenAI-compatible
// /chat/completions path. Per the live OpenCode Go catalog the entire MiniMax
// and Qwen families publish on the Messages endpoint:
//   - qwen3.7-max requires it; the Go endpoint has rejected oa-compat for it.
//   - MiniMax also publishes under @ai-sdk/anthropic, even when an incidental
//     oa-compat path happens to work.
// This set also names the models gateway BYOK cannot serve keyless because the
// Messages route uses x-api-key. Do not erase the transport distinction to make
// auth look uniform. The fixed endpoint also requires the model id in the body.
const ZEN_GO_ANTHROPIC_MODELS = new Set([
  'minimax-m2.5',
  'minimax-m2.7',
  'minimax-m3',
  'qwen3.6-plus',
  'qwen3.7-max',
  'qwen3.7-plus',
]);

// Mirrors the live OpenCode Go catalog (opencode.ai/docs/go), refreshed
// 2026-07-09. Keep this shared: provider routing and capability resolution both
// need the exact same model set.
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
