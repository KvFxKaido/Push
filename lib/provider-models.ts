/**
 * Shared provider model defaults and curated suggestion lists.
 *
 * Keep this module data-only so both the web app and CLI can consume it
 * without inheriting each other's runtime-specific catalog logic.
 */

/**
 * Providers whose curated models + defaults are shared between the web app
 * and CLI. Intentionally excludes `cloudflare` — that provider relies on the
 * Worker's native `env.AI` binding, which doesn't exist in the CLI runtime.
 * The `CLOUDFLARE_*` constants are still exported from this file so the web
 * side can import them directly without going through the shared catalog.
 */
export type SharedProviderModelId =
  | 'ollama'
  | 'openrouter'
  | 'zai'
  | 'kimi'
  | 'huggingface'
  | 'zen'
  | 'fireworks'
  | 'deepseek'
  | 'sakana'
  | 'openai'
  | 'xai'
  | 'anthropic'
  | 'google';

// Ollama Cloud is retiring `gemini-3-flash-preview` (deprecation notice
// 2026-07; recommended replacement: minimax-m3). The retired id stays
// callable via free-text entry until Ollama removes it.
export const OLLAMA_DEFAULT_MODEL = 'minimax-m3';
export const OPENROUTER_DEFAULT_MODEL = 'anthropic/claude-sonnet-4.6:nitro';
export const ZAI_DEFAULT_MODEL = 'glm-5.2';
export const KIMI_DEFAULT_MODEL = 'kimi-k2.7-code-highspeed';
// Hugging Face Inference Providers router (router.huggingface.co, OpenAI-compatible).
// Model ids are `org/model` hub ids, optionally `:provider`-suffixed to pin a host.
// Verified live on /v1/models 2026-07-10.
export const HUGGINGFACE_DEFAULT_MODEL = 'deepseek-ai/DeepSeek-V4-Pro';
export const CLOUDFLARE_DEFAULT_MODEL = '@cf/qwen/qwen3-30b-a3b-fp8';
/** Maximum length for OpenRouter session_id field (per API spec). */
export const OPENROUTER_MAX_SESSION_ID_LENGTH = 256;
export const ZEN_DEFAULT_MODEL = 'big-pickle';
// Verified serverless slug (fireworks.ai/models/deepseek-ai/deepseek-v4-pro, 2026-06-17) —
// DeepSeek's flagship MoE: frontier reasoning, strong coding, up to 1M context. Re-check
// against /api/fireworks/models if it 404s.
export const FIREWORKS_DEFAULT_MODEL = 'accounts/fireworks/models/deepseek-v4-pro';
// Direct DeepSeek API (api.deepseek.com) — OpenAI-compatible. `deepseek-v4-pro`
// is DeepSeek's flagship (frontier reasoning + thinking mode, up to 1M context);
// `deepseek-v4-flash` is the faster, cheaper sibling. The legacy `deepseek-chat`
// / `deepseek-reasoner` aliases (non-thinking / thinking mode of v4-flash) are
// deprecated 2026-07-24, so they're left out of the curated list — free-text
// entry still resolves them until then.
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-pro';
// Sakana AI's Fugu is a multi-agent orchestration router over frontier LLMs,
// exposed as one OpenAI-compatible endpoint (launched 2026-06-22). `fugu` is the
// low-latency everyday default; `fugu-ultra` coordinates a deeper agent pool
// (1M context, tool calling, prompt caching).
export const SAKANA_DEFAULT_MODEL = 'fugu';

// Direct-provider defaults — populated by the scaffolding PR; the streaming /
// auth / system-prompt wiring lands per-provider in follow-up PRs that consume
// the matching entry in `lib/provider-definition.ts`.
export const OPENAI_DEFAULT_MODEL = 'gpt-5.4';
export const XAI_DEFAULT_MODEL = 'grok-4.5';
export const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-4-6';
export const GOOGLE_DEFAULT_MODEL = 'gemini-3.5-flash';

export const OLLAMA_MODELS: string[] = [
  // Cloud-first curated fallback. Live `/models` fetch and free-text entry
  // cover account-specific availability beyond this baseline. This list also
  // feeds the CLI native-FC allowlist (cli/native-tool-gate.ts), minus the
  // ids in OLLAMA_NATIVE_TOOL_CALLING_DENYLIST (lib/native-tool-gate.ts) —
  // minimax-m3 stays curated but rides text-dispatch until ollama/ollama#16389
  // is fixed. `gemini-3-flash-preview` is intentionally absent, so a free-text
  // pick of it also rides text-dispatch until Ollama retires the id.
  OLLAMA_DEFAULT_MODEL,
];

export const OPENROUTER_MODELS: string[] = [
  'anthropic/claude-haiku-4.5:nitro',
  'anthropic/claude-opus-4.6:nitro',
  'anthropic/claude-sonnet-4.6:nitro',
  'cohere/command-a',
  'deepseek/deepseek-r1',
  'deepseek/deepseek-v3.2:nitro',
  'google/gemini-2.5-flash:nitro',
  'google/gemini-2.5-pro:nitro',
  'google/gemini-3-flash-preview:nitro',
  'google/gemini-3.1-flash-lite:nitro',
  'google/gemini-3.1-pro-preview:nitro',
  'google/gemini-3.1-pro-preview-customtools:nitro',
  'google/gemini-3.5-flash:nitro',
  'google/gemma-4-31b-it:nitro',
  'inception/mercury-2',
  'meta-llama/llama-4-maverick',
  'minimax/minimax-m2.5',
  'minimax/minimax-m2.7:nitro',
  'minimax/minimax-m3',
  'mistralai/codestral-2508',
  'mistralai/devstral-2512',
  'mistralai/mistral-large-2512',
  'mistralai/mistral-small-2603',
  'moonshotai/kimi-k2.5:nitro',
  'openai/gpt-5-mini',
  'openai/gpt-5.2-codex',
  'openai/gpt-5.3-codex',
  'openai/gpt-5.4',
  'openai/gpt-5.4-mini',
  'openai/gpt-5.4-nano',
  'openai/gpt-5.4-pro',
  'xiaomi/mimo-v2.5',
  'xiaomi/mimo-v2.5-pro',
  'perplexity/sonar-pro',
  'qwen/qwen3-coder-flash',
  'qwen/qwen3-coder-plus',
  'qwen/qwen3.5-397b-a17b:nitro',
  'stepfun/step-3.5-flash',
  'x-ai/grok-4.3',
  'x-ai/grok-4.20',
  'x-ai/grok-4.20-beta',
  'z-ai/glm-4.7:nitro',
  'z-ai/glm-5:nitro',
  'z-ai/glm-5.1:nitro',
  'z-ai/glm-5-turbo',
];

// Z.ai's direct Chat Completions model enum, refreshed from the API reference
// on 2026-07-10. Free-text entry covers newer / account-specific ids.
export const ZAI_MODELS: string[] = [
  ZAI_DEFAULT_MODEL,
  'glm-5.1',
  'glm-5-turbo',
  'glm-5',
  'glm-4.7',
  'glm-4.7-flash',
  'glm-4.7-flashx',
  'glm-4.6',
  'glm-4.5',
  'glm-4.5-air',
  'glm-4.5-x',
  'glm-4.5-airx',
  'glm-4.5-flash',
  'glm-4-32b-0414-128k',
];

// Kimi's current direct API lineup. K2.7 Code Highspeed is the recommended
// programming-agent endpoint; free-text entry covers account-specific ids.
// kimi-k2.5 dropped from the seed: Moonshot closed it to new registrations at
// the K3 launch and sunsets it platform-wide on 2026-08-31 (free-text entry
// still works for existing users until then). Zen still serves its own
// kimi-k2.5 — ZEN_MODELS is unaffected.
export const KIMI_MODELS: string[] = [KIMI_DEFAULT_MODEL, 'kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6'];

// Curated picker seed for the Hugging Face router — strong open-weight coding
// and agent models verified live with tool support on /v1/models (2026-07-10).
// The live models handler proxies the full router catalog; this list is the
// offline fallback and free-text entry covers everything else (including
// `:provider`-pinned variants).
export const HUGGINGFACE_MODELS: string[] = [
  HUGGINGFACE_DEFAULT_MODEL,
  'deepseek-ai/DeepSeek-V4-Flash',
  'zai-org/GLM-5.2',
  'moonshotai/Kimi-K2.7-Code',
  'Qwen/Qwen3-Coder-Next',
  'MiniMaxAI/MiniMax-M3',
  'openai/gpt-oss-120b',
  // Ant/inclusionAI Ling 2.6 (1T MoE), pinned to the Novita host on the router.
  'inclusionAI/Ling-2.6-1T:novita',
];

export const CLOUDFLARE_MODELS: string[] = [
  CLOUDFLARE_DEFAULT_MODEL,
  '@cf/qwen/qwen2.5-coder-32b-instruct',
  '@cf/openai/gpt-oss-20b',
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/google/gemma-3-12b-it',
];

// Full live OpenCode Zen (standard tier) catalog. Free-text entry still covers
// anything not seeded here. Refreshed 2026-06-17 against the Zen dashboard model
// list. Excludes the `Go`-tier models (defined in lib/zen-go.ts, not in
// this shared module) and Claude Fable 5 (intentionally not seeded).
//
// Ids are BARE (`gpt-5.4`, not `openai/gpt-5.4`): the Zen chat API and its
// `/v1/models` listing use a flat `owned_by: opencode` namespace. The
// `opencode/<id>` form some docs show is only OpenCode's own config prefix —
// Push posts straight to /zen/v1/chat/completions, so the provider prefix
// would make the model non-routable. Free variants keep the `-free` suffix.
//
// MiniMax M3 is only offered free-tier (`minimax-m3-free`, rate-limited) on the
// standard endpoint — the paid `minimax-m3` lives on the Go tier.
//
// Grouped by family in order: Zen default, Anthropic Claude, OpenAI GPT-5.x,
// Google Gemini, DeepSeek, Zhipu GLM, Moonshot Kimi, Qwen, xAI Grok, MiniMax,
// then misc. No inline comments inside the array body — the CLI catalog-parity
// test (`cli/tests/model-catalog.test.mjs`) parses this list with a regex that
// would read uppercase tokens in comments (`GPT`, `GLM`, the `AI` in `OpenAI`)
// as unresolvable constant references.
export const ZEN_MODELS: string[] = [
  ZEN_DEFAULT_MODEL,
  'claude-haiku-4.5',
  'claude-opus-4.1',
  'claude-opus-4.5',
  'claude-opus-4.6',
  'claude-opus-4.7',
  'claude-opus-4.8',
  'claude-sonnet-4',
  'claude-sonnet-4.5',
  'claude-sonnet-4.6',
  'gpt-5',
  'gpt-5-codex',
  'gpt-5-nano',
  'gpt-5.1',
  'gpt-5.1-codex',
  'gpt-5.1-codex-max',
  'gpt-5.1-codex-mini',
  'gpt-5.2',
  'gpt-5.2-codex',
  'gpt-5.3-codex',
  'gpt-5.3-codex-spark',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.4-nano',
  'gpt-5.4-pro',
  'gpt-5.5',
  'gpt-5.5-pro',
  'gemini-3-flash',
  'gemini-3.1-pro',
  'gemini-3.5-flash',
  'deepseek-v4-flash',
  'deepseek-v4-flash-free',
  'deepseek-v4-pro',
  'glm-5',
  'glm-5.1',
  'kimi-k2.5',
  'kimi-k2.6',
  'qwen3.5-plus',
  'qwen3.6-plus',
  'qwen3.6-plus-free',
  'grok-build-0.1',
  'minimax-m2.5',
  'minimax-m2.7',
  'minimax-m3-free',
  'mimo-v2.5-free',
  'nemotron-3-ultra-free',
  'north-mini-code-free',
];

// Curated Fireworks serverless models — surfaced in the picker alongside the account's live
// /v1/models (which returns only a narrow subset). Serverless models are callable by slug
// regardless of /v1/models; every slug below was probed callable (HTTP 200) on 2026-06-17.
// The model field also accepts any free-text slug for anything not listed here.
export const FIREWORKS_MODELS: string[] = [
  FIREWORKS_DEFAULT_MODEL,
  'accounts/fireworks/models/deepseek-v4-flash',
  'accounts/fireworks/models/glm-5p2',
  'accounts/fireworks/models/glm-5p1',
  'accounts/fireworks/models/kimi-k2p7-code',
  'accounts/fireworks/models/kimi-k2p6',
  'accounts/fireworks/models/kimi-k2p5',
  'accounts/fireworks/models/qwen3p7-plus',
  'accounts/fireworks/models/qwen3p6-plus',
  'accounts/fireworks/models/minimax-m3',
  'accounts/fireworks/models/minimax-m2p7',
  'accounts/fireworks/models/minimax-m2p5',
  'accounts/fireworks/models/gpt-oss-120b',
  'accounts/fireworks/models/gpt-oss-20b',
  'accounts/fireworks/models/nemotron-3-ultra-nvfp4',
];

export const DEEPSEEK_MODELS: string[] = [DEEPSEEK_DEFAULT_MODEL, 'deepseek-v4-flash'];
// Sakana Fugu orchestration tiers. The model field also accepts any free-text
// slug; these two are the curated suggestions.
export const SAKANA_MODELS: string[] = [SAKANA_DEFAULT_MODEL, 'fugu-ultra'];

// Curated direct-provider model lists. Free-text entry is still permitted at
// the UI layer; the curated list seeds dropdowns. Refresh against each
// provider's `/v1/models` endpoint once the per-provider PRs land.
export const OPENAI_MODELS: string[] = [
  OPENAI_DEFAULT_MODEL,
  'gpt-5.4-mini',
  'gpt-5.4-nano',
  'gpt-5.4-pro',
  'gpt-5.3-codex',
  'gpt-5.2-codex',
  'gpt-5-mini',
];

// xAI's current public docs recommend Grok 4.5 for both code and chat, with
// Responses API examples using the bare `grok-4.5` id. Free-text entry covers
// account/private variants as they ship.
// xAI Grok chat models, from the live `/grok/v1/models` gateway list (probed
// 2026-07-10, each verified 200 through the gateway). The `grok-imagine-*`
// image/video generation models are intentionally excluded — they don't answer
// the chat/Responses endpoint the xai handler uses.
export const XAI_MODELS: string[] = [
  XAI_DEFAULT_MODEL,
  'grok-4.3',
  'grok-4.20-0309-reasoning',
  'grok-4.20-0309-non-reasoning',
  'grok-4.20-multi-agent-0309',
  'grok-build-0.1',
];

// Generally available current Claude models, refreshed against Anthropic's
// models overview on 2026-07-09. Mythos remains free-text only because it is
// limited-availability Project Glasswing access, not a general picker option.
export const ANTHROPIC_MODELS: string[] = [
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-sonnet-5',
  'claude-opus-4-7',
  ANTHROPIC_DEFAULT_MODEL,
  'claude-haiku-4-5-20251001',
];

export const GOOGLE_MODELS: string[] = [
  GOOGLE_DEFAULT_MODEL,
  'gemini-3.1-pro-preview',
  'gemini-3.1-flash-lite',
  'gemini-3-flash-preview',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
];

export const SHARED_PROVIDER_MODEL_CATALOG: Record<SharedProviderModelId, string[]> = {
  ollama: OLLAMA_MODELS,
  openrouter: OPENROUTER_MODELS,
  zai: ZAI_MODELS,
  kimi: KIMI_MODELS,
  huggingface: HUGGINGFACE_MODELS,
  zen: ZEN_MODELS,
  fireworks: FIREWORKS_MODELS,
  deepseek: DEEPSEEK_MODELS,
  sakana: SAKANA_MODELS,
  openai: OPENAI_MODELS,
  xai: XAI_MODELS,
  anthropic: ANTHROPIC_MODELS,
  google: GOOGLE_MODELS,
};

export const SHARED_PROVIDER_DEFAULT_MODELS: Record<SharedProviderModelId, string> = {
  ollama: OLLAMA_DEFAULT_MODEL,
  openrouter: OPENROUTER_DEFAULT_MODEL,
  zai: ZAI_DEFAULT_MODEL,
  kimi: KIMI_DEFAULT_MODEL,
  huggingface: HUGGINGFACE_DEFAULT_MODEL,
  zen: ZEN_DEFAULT_MODEL,
  fireworks: FIREWORKS_DEFAULT_MODEL,
  deepseek: DEEPSEEK_DEFAULT_MODEL,
  sakana: SAKANA_DEFAULT_MODEL,
  openai: OPENAI_DEFAULT_MODEL,
  xai: XAI_DEFAULT_MODEL,
  anthropic: ANTHROPIC_DEFAULT_MODEL,
  google: GOOGLE_DEFAULT_MODEL,
};

export function getSharedCuratedModels(providerId: string): readonly string[] {
  return SHARED_PROVIDER_MODEL_CATALOG[providerId as SharedProviderModelId] || [];
}
