import type { AIProviderType, ChatMessage } from '@/types';
import { getModelCapabilities } from './model-catalog';

// Context mode config (runtime toggle from Settings)
const CONTEXT_MODE_STORAGE_KEY = 'push_context_mode';
export type ContextMode = 'graceful' | 'none';

// Rolling window config — token-based context management
const DEFAULT_CONTEXT_MAX_TOKENS = 100_000; // Hard cap
const DEFAULT_CONTEXT_TARGET_TOKENS = 88_000; // Soft target leaves room for system prompt + response

// Universal budget formula. Both ratios stay below the model's real window
// because the heuristic token estimator can undercount on code-dense or
// CJK-heavy conversations — the 8% headroom covers that drift plus the
// system prompt and response budget the API counts against the same window.
const MAX_RATIO = 0.92;
const TARGET_RATIO = 0.85;

export interface ContextBudget {
  maxTokens: number;
  targetTokens: number;
  /** Threshold at which old tool results get summarized. Capped at the
   *  default 88K so smaller-window models don't summarize past their target,
   *  and so large-window models don't accumulate excessive tool noise before
   *  the first summarization pass. */
  summarizeTokens: number;
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  maxTokens: DEFAULT_CONTEXT_MAX_TOKENS,
  targetTokens: DEFAULT_CONTEXT_TARGET_TOKENS,
  summarizeTokens: DEFAULT_CONTEXT_TARGET_TOKENS,
};

function budgetFromWindow(windowTokens: number): ContextBudget {
  const maxTokens = Math.floor(windowTokens * MAX_RATIO);
  const targetTokens = Math.floor(windowTokens * TARGET_RATIO);
  return {
    maxTokens,
    targetTokens,
    summarizeTokens: Math.min(DEFAULT_CONTEXT_TARGET_TOKENS, targetTokens),
  };
}

// Catalog metadata (models.dev) only loads for providers that fetch it:
// openrouter, blackbox, nvidia, ollama, zen. Other providers (cloudflare,
// vertex, bedrock, azure, kilocode, openadapter) hand us a model name with
// no metadata, so we probe sibling catalogs by name and finally fall through
// to a coarse name-pattern table that captures the major model families'
// real context windows.
const CATALOG_PROBE_PROVIDERS: readonly AIProviderType[] = [
  'openrouter',
  'zen',
  'ollama',
  'nvidia',
  'blackbox',
];

function guessWindowFromName(model: string): number {
  const m = model.toLowerCase();
  // Order matters — more specific patterns first so haiku doesn't get
  // bucketed with the larger Claude family, and deepseek-v4 doesn't get
  // bucketed with the smaller v3/earlier window.
  if (m.includes('haiku')) return 200_000;
  if (m.includes('claude')) return 1_000_000;
  if (m.includes('gemini')) return 1_000_000;
  if (m.includes('grok')) return 2_000_000;
  if (m.includes('kimi') || m.includes('moonshot')) return 256_000;
  if (m.includes('gpt-5')) return 1_000_000;
  // DeepSeek v4 family ships with 1M context. v3 and earlier topped at
  // 128K. Listed below the v4 check so `deepseek-v4-pro` doesn't get
  // bucketed with the older window. Ollama Cloud's /v1/models response
  // doesn't include context_length, so without these patterns deepseek
  // falls through to the 100K default.
  if (m.includes('deepseek-v4')) return 1_000_000;
  if (m.includes('deepseek')) return 128_000;
  return 0;
}

// OpenRouter (and similar gateways) append routing variants like ":nitro",
// ":free", or ":beta" to the catalog's base IDs. Strip on the last colon so
// catalog probes don't silently miss for routed selections — without this,
// `anthropic/claude-sonnet-4.6:nitro` would skip the catalog window entirely
// and fall through to the coarse name-pattern table.
function stripRoutingSuffix(model: string): string {
  const colon = model.lastIndexOf(':');
  return colon > 0 ? model.slice(0, colon) : model;
}

function probeWindow(provider: AIProviderType, model: string): number {
  const direct = getModelCapabilities(provider, model).contextLimit;
  if (direct > 0) return direct;
  const baseId = stripRoutingSuffix(model);
  if (baseId === model) return 0;
  return getModelCapabilities(provider, baseId).contextLimit;
}

function lookupContextWindow(provider: AIProviderType | undefined, model: string): number {
  if (provider) {
    const cap = probeWindow(provider, model);
    if (cap > 0) return cap;
  }
  // Same model id often exists in another provider's catalog (e.g.,
  // gemini-2.5-pro is in OpenRouter, Zen, and Ollama metadata). Try those
  // before falling back to name patterns.
  for (const probe of CATALOG_PROBE_PROVIDERS) {
    if (probe === provider) continue;
    const cap = probeWindow(probe, model);
    if (cap > 0) return cap;
  }
  return guessWindowFromName(model);
}

export function getContextBudget(provider?: AIProviderType, model?: string): ContextBudget {
  const normalizedModel = (model || '').trim();
  if (!normalizedModel) return DEFAULT_CONTEXT_BUDGET;
  const windowTokens = lookupContextWindow(provider, normalizedModel);
  if (windowTokens <= 0) return DEFAULT_CONTEXT_BUDGET;
  return budgetFromWindow(windowTokens);
}

export function getContextMode(): ContextMode {
  try {
    const stored = localStorage.getItem(CONTEXT_MODE_STORAGE_KEY);
    if (stored === 'none') return 'none';
  } catch {
    // ignore storage errors
  }
  return 'graceful';
}

export function setContextMode(mode: ContextMode): void {
  try {
    localStorage.setItem(CONTEXT_MODE_STORAGE_KEY, mode);
  } catch {
    // ignore storage errors
  }
}

// ---------------------------------------------------------------------------
// Token Estimation — rough heuristic, no tokenizer dependency
// ---------------------------------------------------------------------------

/**
 * Estimate token count from text using content-aware heuristics.
 *
 * Different content types tokenize at different rates:
 * - Dense code (brackets, operators, short names): ~3.0 chars/token
 * - Mixed code/prose (tool results, diffs): ~3.5 chars/token
 * - English prose: ~4.0 chars/token
 * - CJK / non-ASCII text: ~1.5 chars/token (each char is typically its own token)
 *
 * We sample the text to pick an appropriate ratio instead of using a single
 * fixed divisor.  Still conservative (slightly over-estimates) to avoid
 * blowing past real limits.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const len = text.length;

  // For short text, the overhead of sampling isn't worth it
  if (len < 200) return Math.ceil(len / 3.2);

  // Sample up to 500 chars from the middle of the text to classify content
  const sampleStart = Math.max(0, Math.floor(len / 2) - 250);
  const sample = text.slice(sampleStart, sampleStart + 500);

  // Count content signals
  const nonAsciiCount = (sample.match(/[^\u0020-\u007E\n\r\t]/g) || []).length;
  const codeSymbolCount = (sample.match(/[{}()[\];=<>|&!+\-*/^~@#$%]/g) || []).length;
  const sampleLen = sample.length;

  // High non-ASCII ratio → CJK/emoji-heavy, each char ≈ 1 token
  if (nonAsciiCount / sampleLen > 0.3) {
    // Blend: non-ASCII chars at 1.5, ASCII chars at 3.5
    const nonAsciiRatio = nonAsciiCount / sampleLen;
    const blendedRate = nonAsciiRatio * 1.5 + (1 - nonAsciiRatio) * 3.5;
    return Math.ceil(len / blendedRate);
  }

  // High code-symbol density → dense code, tighter tokenization
  if (codeSymbolCount / sampleLen > 0.12) {
    return Math.ceil(len / 3.0);
  }

  // Default: mixed content
  return Math.ceil(len / 3.5);
}

export function estimateMessageTokens(msg: ChatMessage): number {
  let tokens = estimateTokens(msg.content) + 4; // 4 tokens overhead per message
  if (msg.thinking) tokens += estimateTokens(msg.thinking);
  if (msg.attachments) {
    for (const att of msg.attachments) {
      if (att.type === 'image')
        tokens += 1000; // rough estimate for vision
      else tokens += estimateTokens(att.content);
    }
  }
  return tokens;
}

/**
 * Estimate total tokens for an array of chat messages.
 * Exported so useChat can expose context usage to the UI.
 */
export function estimateContextTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateMessageTokens(msg);
  }
  return total;
}
