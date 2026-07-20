/**
 * Declared model metadata for Push's curated model ids.
 *
 * Runtime catalog fetches still win when available. This file is the cold-cache
 * source derived from models.dev plus explicit provider-private overrides for
 * ids models.dev cannot see (Sakana Fugu, some Zen/Fireworks aliases).
 * Name-based family guesses stay as the final fallback in context-budget.
 */

export interface DeclaredModelMetadata {
  readonly contextLimit: number;
  readonly reasoning: boolean;
  readonly toolCall: boolean;
  readonly structuredOutput: boolean;
  readonly inputModalities: readonly string[];
  readonly outputModalities: readonly string[];
  readonly attachment: boolean;
}

const TEXT = ['text'] as const;
const TEXT_IMAGE = ['text', 'image'] as const;
const TEXT_IMAGE_PDF = ['text', 'image', 'pdf'] as const;
const TEXT_IMAGE_VIDEO = ['text', 'image', 'video'] as const;
const TEXT_IMAGE_AUDIO_VIDEO = ['text', 'image', 'audio', 'video'] as const;
const TEXT_IMAGE_AUDIO_VIDEO_PDF = ['text', 'image', 'audio', 'video', 'pdf'] as const;
const TEXT_PDF = ['text', 'pdf'] as const;
const IMAGE_TEXT_VIDEO = ['image', 'text', 'video'] as const;
const PDF_IMAGE_TEXT = ['pdf', 'image', 'text'] as const;

function M(
  contextLimit: number,
  reasoning: boolean,
  toolCall: boolean,
  structuredOutput: boolean,
  inputModalities: readonly string[],
  outputModalities: readonly string[] = TEXT,
  attachment = inputModalities.includes('image') || inputModalities.includes('pdf'),
): DeclaredModelMetadata {
  return {
    contextLimit,
    reasoning,
    toolCall,
    structuredOutput,
    inputModalities,
    outputModalities,
    attachment,
  };
}

const PROVIDER_MODEL_METADATA: Record<string, Record<string, DeclaredModelMetadata>> = {
  openrouter: {
    'anthropic/claude-haiku-4.5:nitro': M(200000, true, true, true, TEXT_IMAGE_PDF),
    'anthropic/claude-opus-4.6:nitro': M(1000000, true, true, true, TEXT_IMAGE_PDF),
    'anthropic/claude-sonnet-4.6:nitro': M(1000000, true, true, true, TEXT_IMAGE_PDF),
    'cohere/command-a': M(256000, false, false, true, TEXT, TEXT, false),
    'deepseek/deepseek-r1': M(64000, true, true, true, TEXT, TEXT, false),
    'deepseek/deepseek-v3.2:nitro': M(128000, true, true, true, TEXT, TEXT, false),
    'google/gemini-2.5-flash:nitro': M(1048576, true, true, true, TEXT_IMAGE_AUDIO_VIDEO_PDF),
    'google/gemini-2.5-pro:nitro': M(1048576, true, true, true, TEXT_IMAGE_AUDIO_VIDEO_PDF),
    'google/gemini-3-flash-preview:nitro': M(1048576, true, true, true, TEXT_IMAGE_AUDIO_VIDEO_PDF),
    'google/gemini-3.1-flash-lite:nitro': M(1048576, true, true, true, TEXT_IMAGE_AUDIO_VIDEO_PDF),
    'google/gemini-3.1-pro-preview:nitro': M(1048576, true, true, true, TEXT_IMAGE_AUDIO_VIDEO_PDF),
    'google/gemini-3.1-pro-preview-customtools:nitro': M(
      1048576,
      true,
      true,
      true,
      TEXT_IMAGE_AUDIO_VIDEO_PDF,
    ),
    'google/gemini-3.5-flash:nitro': M(1048576, true, true, true, TEXT_IMAGE_AUDIO_VIDEO_PDF),
    'google/gemma-4-31b-it:nitro': M(262144, true, true, true, IMAGE_TEXT_VIDEO),
    'inception/mercury-2': M(128000, true, true, true, TEXT, TEXT, false),
    'meta-llama/llama-4-maverick': M(1048576, false, true, true, TEXT_IMAGE),
    'minimax/minimax-m2.5': M(196608, true, true, true, TEXT, TEXT, false),
    'minimax/minimax-m2.7:nitro': M(196608, true, true, true, TEXT, TEXT, false),
    'minimax/minimax-m3': M(524288, true, true, true, TEXT_IMAGE_VIDEO),
    'mistralai/codestral-2508': M(256000, false, true, true, TEXT_PDF),
    'mistralai/devstral-2512': M(262144, false, true, true, TEXT_PDF),
    'mistralai/mistral-large-2512': M(262144, false, true, true, TEXT_IMAGE_PDF),
    'mistralai/mistral-small-2603': M(262144, true, true, true, TEXT_IMAGE),
    'moonshotai/kimi-k2.5:nitro': M(256000, true, true, true, TEXT_IMAGE),
    'openai/gpt-5-mini': M(400000, true, true, true, TEXT_IMAGE_PDF),
    'openai/gpt-5.2-codex': M(400000, true, true, true, TEXT_IMAGE),
    'openai/gpt-5.3-codex': M(400000, true, true, true, TEXT_IMAGE_PDF),
    'openai/gpt-5.4': M(1050000, true, true, true, TEXT_IMAGE_PDF),
    'openai/gpt-5.4-mini': M(400000, true, true, true, PDF_IMAGE_TEXT),
    'openai/gpt-5.4-nano': M(400000, true, true, true, PDF_IMAGE_TEXT),
    'openai/gpt-5.4-pro': M(1050000, true, true, true, TEXT_IMAGE_PDF),
    'perplexity/sonar-pro': M(200000, false, false, false, TEXT_IMAGE),
    'qwen/qwen3-coder-flash': M(1000000, false, true, false, TEXT, TEXT, false),
    'qwen/qwen3-coder-plus': M(1000000, false, true, true, TEXT, TEXT, false),
    'qwen/qwen3.5-397b-a17b:nitro': M(131072, true, true, true, TEXT_IMAGE_VIDEO),
    'stepfun/step-3.5-flash': M(262144, true, true, false, TEXT, TEXT, false),
    'x-ai/grok-4.20': M(2000000, true, true, true, TEXT_IMAGE_PDF),
    'x-ai/grok-4.20-beta': M(2000000, true, true, true, TEXT_IMAGE_PDF),
    'z-ai/glm-4.7:nitro': M(202752, true, true, true, TEXT, TEXT, false),
    'z-ai/glm-5:nitro': M(202752, true, true, true, TEXT, TEXT, false),
    'z-ai/glm-5.1:nitro': M(202752, true, true, true, TEXT, TEXT, false),
    'z-ai/glm-5-turbo': M(262144, true, true, false, TEXT, TEXT, false),
  },
  zai: {
    'glm-5.2': M(1000000, true, true, true, TEXT, TEXT, false),
    'glm-5.1': M(200000, true, true, true, TEXT, TEXT, false),
    'glm-5-turbo': M(262144, true, true, false, TEXT, TEXT, false),
    'glm-5': M(200000, true, true, true, TEXT, TEXT, false),
    'glm-4.7': M(200000, true, true, true, TEXT, TEXT, false),
    'glm-4.6': M(200000, true, true, true, TEXT, TEXT, false),
    'glm-4.5': M(128000, true, true, true, TEXT, TEXT, false),
  },
  kimi: {
    'kimi-k2.7-code-highspeed': M(262144, true, true, true, TEXT_IMAGE_VIDEO),
    'kimi-k2.7-code': M(262144, true, true, true, TEXT_IMAGE_VIDEO),
    'kimi-k2.6': M(262144, true, true, true, TEXT_IMAGE_VIDEO),
    'kimi-k2.5': M(262144, true, true, true, TEXT_IMAGE_VIDEO),
  },
  // Hugging Face router aggregates hosts with differing context windows per
  // model; these declare the MINIMUM across live hosts (router routing may
  // land on the smallest) — from /v1/models per-provider context_length,
  // 2026-07-10. Tool support verified live on every host serving these ids.
  huggingface: {
    'deepseek-ai/DeepSeek-V4-Pro': M(512000, true, true, true, TEXT),
    'deepseek-ai/DeepSeek-V4-Flash': M(1048576, true, true, true, TEXT),
    'zai-org/GLM-5.2': M(262144, true, true, true, TEXT),
    'moonshotai/Kimi-K2.7-Code': M(262144, true, true, true, TEXT_IMAGE),
    'Qwen/Qwen3-Coder-Next': M(262144, false, true, true, TEXT),
    'MiniMaxAI/MiniMax-M3': M(512000, true, true, true, TEXT_IMAGE),
    'openai/gpt-oss-120b': M(131072, true, true, true, TEXT),
    // Ling 2.6 1T: 256K context, text-only, tool-calling + reasoning (HF model
    // card). Keyed without the `:novita` routing suffix — lookup strips it.
    'inclusionAI/Ling-2.6-1T': M(262144, true, true, true, TEXT),
  },
  zen: {
    'big-pickle': M(200000, true, true, true, TEXT, TEXT, false),
    'claude-haiku-4.5': M(200000, true, true, false, TEXT_IMAGE_PDF),
    'claude-opus-4.1': M(200000, true, true, false, TEXT_IMAGE_PDF),
    'claude-opus-4.5': M(200000, true, true, false, TEXT_IMAGE_PDF),
    'claude-opus-4.6': M(200000, true, true, false, TEXT_IMAGE_PDF),
    'claude-opus-4.7': M(200000, true, true, false, TEXT_IMAGE_PDF),
    'claude-opus-4.8': M(200000, true, true, false, TEXT_IMAGE_PDF),
    'claude-sonnet-4': M(1000000, true, true, false, TEXT_IMAGE_PDF),
    'claude-sonnet-4.5': M(200000, true, true, false, TEXT_IMAGE_PDF),
    'claude-sonnet-4.6': M(200000, true, true, false, TEXT_IMAGE_PDF),
    'gpt-5': M(400000, true, true, true, TEXT_IMAGE),
    'gpt-5-codex': M(400000, true, true, true, TEXT_IMAGE),
    'gpt-5-nano': M(400000, true, true, true, TEXT_IMAGE),
    'gpt-5.1': M(400000, true, true, true, TEXT_IMAGE),
    'gpt-5.1-codex': M(400000, true, true, true, TEXT_IMAGE),
    'gpt-5.1-codex-max': M(400000, true, true, true, TEXT_IMAGE),
    'gpt-5.1-codex-mini': M(400000, true, true, true, TEXT_IMAGE),
    'gpt-5.2': M(400000, true, true, true, TEXT_IMAGE),
    'gpt-5.2-codex': M(400000, true, true, true, TEXT_IMAGE_PDF),
    'gpt-5.3-codex': M(400000, true, true, true, TEXT_IMAGE_PDF),
    'gpt-5.3-codex-spark': M(128000, true, true, true, TEXT, TEXT, false),
    'gpt-5.4': M(1050000, true, true, true, TEXT_IMAGE_PDF),
    'gpt-5.4-mini': M(400000, true, true, true, TEXT_IMAGE_PDF),
    'gpt-5.4-nano': M(400000, true, true, true, TEXT_IMAGE_PDF),
    'gpt-5.4-pro': M(1050000, true, true, false, TEXT_IMAGE_PDF),
    'gpt-5.5': M(1050000, true, true, true, TEXT_IMAGE_PDF),
    'gpt-5.5-pro': M(1050000, true, true, false, TEXT_IMAGE_PDF),
    'gemini-3-flash': M(1048576, true, true, true, TEXT_IMAGE_AUDIO_VIDEO_PDF),
    'gemini-3.1-pro': M(1048576, true, true, true, TEXT_IMAGE_AUDIO_VIDEO_PDF),
    'gemini-3.5-flash': M(1048576, true, true, true, TEXT_IMAGE_AUDIO_VIDEO_PDF),
    'deepseek-v4-flash': M(1000000, true, true, true, TEXT, TEXT, false),
    'deepseek-v4-flash-free': M(200000, true, true, true, TEXT, TEXT, false),
    'deepseek-v4-pro': M(1000000, true, true, true, TEXT, TEXT, false),
    'glm-5': M(204800, true, true, false, TEXT, TEXT, false),
    'glm-5.1': M(204800, true, true, false, TEXT, TEXT, false),
    'glm-5.2': M(1000000, true, true, true, TEXT, TEXT, false),
    'kimi-k2.5': M(262144, true, true, false, TEXT_IMAGE_VIDEO),
    'kimi-k2.6': M(262144, true, true, false, TEXT_IMAGE_VIDEO),
    'kimi-k2.7-code': M(262144, true, true, false, TEXT_IMAGE_VIDEO),
    'qwen3.5-plus': M(262144, true, true, false, TEXT_IMAGE_VIDEO),
    'qwen3.6-plus': M(262144, true, true, false, TEXT_IMAGE_VIDEO),
    'qwen3.6-plus-free': M(262144, true, true, false, TEXT_IMAGE_VIDEO),
    'qwen3.7-max': M(1000000, true, true, false, TEXT, TEXT, false),
    'qwen3.7-plus': M(1000000, true, true, false, TEXT_IMAGE),
    'grok-build-0.1': M(256000, true, true, true, TEXT_IMAGE),
    'minimax-m2.5': M(204800, true, true, false, TEXT, TEXT, false),
    'minimax-m2.7': M(204800, true, true, false, TEXT, TEXT, false),
    'minimax-m3': M(512000, true, true, false, TEXT_IMAGE_VIDEO),
    'minimax-m3-free': M(200000, true, true, false, TEXT_IMAGE_VIDEO, TEXT, false),
    'mimo-v2.5': M(1000000, true, true, false, TEXT_IMAGE_AUDIO_VIDEO),
    'mimo-v2.5-free': M(200000, true, true, false, TEXT_IMAGE_AUDIO_VIDEO),
    'mimo-v2.5-pro': M(1048576, true, true, false, TEXT, TEXT, true),
    'nemotron-3-ultra-free': M(1000000, true, true, false, TEXT, TEXT, false),
    'north-mini-code-free': M(256000, true, true, true, TEXT, TEXT, false),
  },
  ollama: {
    // Retiring on Ollama Cloud (2026-07 notice); kept until the id 404s so
    // free-text picks still resolve declared metadata.
    'gemini-3-flash-preview': M(1048576, true, true, false, TEXT_IMAGE),
    'minimax-m3': M(512000, true, true, false, TEXT_IMAGE_VIDEO),
  },
  openai: {
    'gpt-5.4': M(1050000, true, true, true, TEXT_IMAGE_PDF),
    'gpt-5.4-mini': M(400000, true, true, true, TEXT_IMAGE),
    'gpt-5.4-nano': M(400000, true, true, true, TEXT_IMAGE),
    'gpt-5.4-pro': M(1050000, true, true, false, TEXT_IMAGE),
    'gpt-5.3-codex': M(400000, true, true, true, TEXT_IMAGE_PDF),
    'gpt-5.2-codex': M(400000, true, true, true, TEXT_IMAGE_PDF),
    'gpt-5-mini': M(400000, true, true, true, TEXT_IMAGE),
  },
  anthropic: {
    'claude-fable-5': M(1000000, true, true, true, TEXT_IMAGE_PDF),
    'claude-opus-4-8': M(1000000, true, true, true, TEXT_IMAGE_PDF),
    'claude-sonnet-5': M(1000000, true, true, true, TEXT_IMAGE_PDF),
    'claude-opus-4-7': M(1000000, true, true, false, TEXT_IMAGE_PDF),
    'claude-sonnet-4-6': M(1000000, true, true, false, TEXT_IMAGE_PDF),
    'claude-haiku-4-5-20251001': M(200000, true, true, true, TEXT_IMAGE_PDF),
  },
  google: {
    'gemini-3.5-flash': M(1048576, true, true, true, TEXT_IMAGE_AUDIO_VIDEO_PDF),
    'gemini-3.1-pro-preview': M(1048576, true, true, true, TEXT_IMAGE_AUDIO_VIDEO_PDF),
    'gemini-3.1-flash-lite': M(1048576, true, true, true, TEXT_IMAGE_AUDIO_VIDEO_PDF),
    'gemini-3-flash-preview': M(1048576, true, true, true, TEXT_IMAGE_AUDIO_VIDEO_PDF),
    'gemini-2.5-pro': M(1048576, true, true, true, TEXT_IMAGE_AUDIO_VIDEO_PDF),
    'gemini-2.5-flash': M(1048576, true, true, true, TEXT_IMAGE_AUDIO_VIDEO_PDF),
  },
  deepseek: {
    'deepseek-v4-pro': M(1000000, true, true, true, TEXT, TEXT, false),
    'deepseek-v4-flash': M(1000000, true, true, true, TEXT, TEXT, false),
  },
  fireworks: {
    'accounts/fireworks/models/deepseek-v4-pro': M(1000000, true, true, true, TEXT, TEXT, false),
    'accounts/fireworks/models/deepseek-v4-flash': M(1000000, true, true, true, TEXT, TEXT, false),
    'accounts/fireworks/models/glm-5p2': M(1048575, true, true, false, TEXT, TEXT, false),
    'accounts/fireworks/models/glm-5p1': M(202800, true, true, false, TEXT, TEXT, false),
    'accounts/fireworks/models/kimi-k2p7-code': M(262000, true, true, false, TEXT_IMAGE),
    'accounts/fireworks/models/kimi-k2p6': M(262000, true, true, false, TEXT_IMAGE),
    'accounts/fireworks/models/kimi-k2p5': M(256000, true, true, false, TEXT_IMAGE),
    'accounts/fireworks/models/qwen3p7-plus': M(262144, true, true, false, TEXT_IMAGE),
    'accounts/fireworks/models/qwen3p6-plus': M(262144, true, true, false, TEXT_IMAGE),
    'accounts/fireworks/models/minimax-m3': M(512000, true, true, false, TEXT, TEXT, true),
    'accounts/fireworks/models/minimax-m2p7': M(196608, true, true, false, TEXT, TEXT, false),
    'accounts/fireworks/models/minimax-m2p5': M(204800, true, true, false, TEXT, TEXT, false),
    'accounts/fireworks/models/gpt-oss-120b': M(131072, true, true, false, TEXT, TEXT, false),
    'accounts/fireworks/models/gpt-oss-20b': M(131072, true, true, false, TEXT, TEXT, false),
    'accounts/fireworks/models/nemotron-3-ultra-nvfp4': M(
      1000000,
      true,
      true,
      false,
      TEXT,
      TEXT,
      false,
    ),
  },
  sakana: {
    fugu: M(1000000, true, true, false, TEXT_IMAGE),
    'fugu-ultra': M(1000000, true, true, false, TEXT_IMAGE),
  },
  xai: {
    // Grok 4.5 ships a 500K window (confirmed on the xAI console and OpenRouter)
    // — notably SMALLER than its 2M grok-4.x siblings, so the `grok → 2M` name
    // fallback in context-budget.ts over-budgets it and defers compaction to
    // ~1.8M, well past the real window (xAI then rejects/truncates). Declared
    // metadata wins over the name guess, so xai chats compact at the true 500K.
    // Covers the OpenRouter `x-ai/grok-4.5` path too via leaf-strip → grok-4.5.
    'grok-4.5': M(500000, true, true, true, TEXT_IMAGE_PDF),
    // Grok 4.20 variants ship a 1M window (xAI /v1/models, probed 2026-07-10) —
    // NOT the 2M the `grok` name-fallback assumes (nor the 2M the OpenRouter
    // `x-ai/grok-4.20` entry claims), so declare them explicitly to avoid
    // over-deferring compaction ~2x past the real window. Input is text+image
    // (xAI reports no PDF); the variants differ only in the reasoning flag.
    'grok-4.20-0309-reasoning': M(1000000, true, true, true, TEXT_IMAGE),
    'grok-4.20-0309-non-reasoning': M(1000000, false, true, true, TEXT_IMAGE),
    'grok-4.20-multi-agent-0309': M(1000000, true, true, true, TEXT_IMAGE),
    // Grok 4.3 is also 1M (xAI /v1/models, probed 2026-07-10), text+image — same
    // over-budget under the `grok` = 2M name fallback, so declare it too.
    'grok-4.3': M(1000000, true, true, true, TEXT_IMAGE),
  },
};

function stripRoutingSuffix(modelId: string): string {
  const colon = modelId.lastIndexOf(':');
  return colon > 0 ? modelId.slice(0, colon) : modelId;
}

function addCandidate(candidates: string[], value: string | undefined): void {
  const normalized = value?.trim();
  if (!normalized || candidates.includes(normalized)) return;
  candidates.push(normalized);
  const stripped = stripRoutingSuffix(normalized);
  if (stripped !== normalized && !candidates.includes(stripped)) {
    candidates.push(stripped);
  }
}

function modelCandidates(provider: string | undefined, modelId: string): string[] {
  const candidates: string[] = [];
  addCandidate(candidates, modelId);

  if (provider === 'openrouter' && !modelId.includes(':')) {
    addCandidate(candidates, `${modelId}:nitro`);
    addCandidate(candidates, `${modelId}:free`);
  }

  for (const candidate of [...candidates]) {
    const slash = candidate.lastIndexOf('/');
    if (slash > 0) addCandidate(candidates, candidate.slice(slash + 1));
  }

  // Provider-private aliases whose public ids differ from models.dev keys.
  if (provider === 'zen' && modelId === 'claude-opus-4.1') {
    addCandidate(candidates, 'claude-opus-4-1');
  }

  return candidates;
}

export function lookupDeclaredModelMetadata(
  provider: string | undefined,
  modelId: string | null | undefined,
): DeclaredModelMetadata | null {
  const normalizedModel = modelId?.trim();
  if (!normalizedModel) return null;

  // Cloudflare Workers AI re-serves third-party models under `@cf/...` ids with
  // gateway-specific *capped* windows (e.g. `@cf/zai-org/glm-5.2` and the Kimi
  // K2.x family are served at 256K, not their native 1M). Leaf-stripping
  // `@cf/zai-org/glm-5.2` → `glm-5.2` would otherwise borrow another provider's
  // native-window metadata and overrun the served window. Reject `@cf/` ids up
  // front, regardless of the provider argument — the web context probe
  // (orchestrator-context.ts) retries the same id against sibling providers
  // (zen/openrouter/…), so a `provider === 'cloudflare'` guard alone (or a guard
  // placed after the provider-specific match) would be bypassed. These ids keep
  // their cap-aware name fallback in context-budget.ts instead.
  if (provider === 'cloudflare' || normalizedModel.startsWith('@cf/')) return null;

  const candidates = modelCandidates(provider, normalizedModel);
  const providerMetadata = provider ? PROVIDER_MODEL_METADATA[provider] : undefined;

  if (providerMetadata) {
    for (const candidate of candidates) {
      const meta = providerMetadata[candidate];
      if (meta) return meta;
    }
  }

  for (const metadata of Object.values(PROVIDER_MODEL_METADATA)) {
    if (metadata === providerMetadata) continue;
    for (const candidate of candidates) {
      const meta = metadata[candidate];
      if (meta) return meta;
    }
  }

  return null;
}
