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

// Mirrors the documented OpenCode Go catalog (opencode.ai/docs/go), refreshed
// 2026-07-26. Keep this shared: provider routing and capability resolution both
// need the exact same model set.
//
// This static list is the SEED and FALLBACK, not the only source: the live
// keyless listing at https://opencode.ai/zen/go/v1/models is authoritative for
// membership, and the web catalog fetches it (Worker `/api/zen/go/models`
// proxies it with this list as the offline fallback). The live listing is a
// superset of the docs — it also serves legacy ids (`glm-5`, `kimi-k2.5`,
// `qwen3.5-plus`, `mimo-v2-pro`, `mimo-v2-omni`, `hy3-preview`) that the docs
// no longer advertise; those are deliberately not seeded here.
//
// What the live listing CANNOT provide is the transport axis above — the
// payload has no such field, and the keyless probe that used to discriminate
// (oa-compat ModelError-before-auth, #756) stopped working when the Go endpoint
// began resolving every catalog model on both endpoints before auth
// (verified 2026-07-26). Transport stays hand-curated in this file; refresh it
// from the docs table's AI SDK column when the catalog moves.
export const ZEN_GO_MODELS = [
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'glm-5.1',
  'glm-5.2',
  'grok-4.5',
  'hy3',
  'kimi-k2.6',
  'kimi-k2.7-code',
  'kimi-k3',
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
