/**
 * Shared context budget and token estimation utilities.
 *
 * Unified module used by both the web app and CLI.
 * Extracted from app/src/lib/orchestrator.ts and cli/context-manager.mjs
 * during Track 2 convergence.
 *
 * Runtime-agnostic — no localStorage or browser APIs.
 */

// ---------------------------------------------------------------------------
// Context Budget — model-aware token limits
// ---------------------------------------------------------------------------

export interface ContextBudget {
  maxTokens: number;
  targetTokens: number;
  /** Threshold at which old tool results get summarized. Capped at the
   *  default 88K so smaller-window models don't summarize past their target,
   *  and so large-window models don't accumulate excessive tool noise before
   *  the first summarization pass. */
  summarizeTokens: number;
}

// Rolling window config — token-based context management
const DEFAULT_CONTEXT_MAX_TOKENS = 100_000; // Hard cap
const DEFAULT_CONTEXT_TARGET_TOKENS = 88_000; // Soft target leaves room for system prompt + response

// Universal budget formula. Both ratios stay below the model's real window
// because the heuristic token estimator can undercount on code-dense or
// CJK-heavy conversations — the 8% headroom covers that drift plus the
// system prompt and response budget the API counts against the same window.
export const MAX_RATIO = 0.92;
export const TARGET_RATIO = 0.85;

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  maxTokens: DEFAULT_CONTEXT_MAX_TOKENS,
  targetTokens: DEFAULT_CONTEXT_TARGET_TOKENS,
  summarizeTokens: DEFAULT_CONTEXT_TARGET_TOKENS,
};

/**
 * Derive a context budget from a known window size. Both surfaces use the
 * same ratios so a model's `maxTokens`/`targetTokens` only depend on its
 * window — whether the window came from a catalog probe (web) or the
 * name-pattern fallback (CLI + web fallback) is irrelevant here.
 */
export function budgetFromWindow(windowTokens: number): ContextBudget {
  const maxTokens = Math.floor(windowTokens * MAX_RATIO);
  const targetTokens = Math.floor(windowTokens * TARGET_RATIO);
  return {
    maxTokens,
    targetTokens,
    summarizeTokens: Math.min(DEFAULT_CONTEXT_TARGET_TOKENS, targetTokens),
  };
}

/**
 * OpenRouter (and similar gateways) append routing variants like ":nitro",
 * ":free", or ":beta" to the catalog's base IDs. Strip on the last colon to
 * normalize a model ID for lookup. Two consumers:
 *
 * - The web's catalog probe keys metadata on the bare base ID, so without
 *   stripping, `anthropic/claude-sonnet-4.6:nitro` misses the catalog window.
 * - The CLI's name-pattern fallback in `getContextBudget` retries with the
 *   stripped ID when the original name doesn't match a family token. This
 *   matters mainly for hypothetical IDs where the suffix obscures an
 *   otherwise-recognizable base — most real routed IDs (e.g. those carrying
 *   `claude`, `gemini`) already match before stripping.
 */
export function stripRoutingSuffix(model: string): string {
  const colon = model.lastIndexOf(':');
  return colon > 0 ? model.slice(0, colon) : model;
}

/**
 * Coarse name-pattern table for models without catalog metadata. Matches the
 * major model families' real context windows so providers that don't expose
 * `context_length` (Ollama Cloud, Cloudflare Workers AI, etc.) still get a
 * sensible budget.
 *
 * Order matters — more specific patterns first so haiku doesn't get
 * bucketed with the larger Claude family, and `deepseek-v4` doesn't get
 * bucketed with the smaller v3/earlier window.
 */
export function guessWindowFromName(model: string): number {
  const m = model.toLowerCase();
  if (m.includes('haiku')) return 200_000;
  if (m.includes('claude')) return 1_000_000;
  if (m.includes('gemini')) return 1_000_000;
  if (m.includes('grok')) return 2_000_000;
  if (m.includes('kimi') || m.includes('moonshot')) return 256_000;
  if (m.includes('gpt-5')) return 1_000_000;
  // DeepSeek v4 family ships with 1M context. v3 and earlier topped at
  // 128K. Listed below the v4 check so `deepseek-v4-pro` doesn't get
  // bucketed with the older window.
  if (m.includes('deepseek-v4')) return 1_000_000;
  if (m.includes('deepseek')) return 128_000;
  return 0;
}

/**
 * Resolve a context budget from provider + model using the name-pattern
 * fallback. Provider is accepted for API parity with the web wrapper but is
 * unused here — `guessWindowFromName` is purely name-based.
 *
 * Web's `orchestrator-context.ts#getContextBudget` layers catalog probing on
 * top of this; the CLI calls this directly. Returns a fresh copy so callers
 * can mutate without poisoning the shared default.
 */
export function getContextBudget(_provider?: string, model?: string): ContextBudget {
  const normalizedModel = (model || '').trim();
  if (!normalizedModel) return { ...DEFAULT_CONTEXT_BUDGET };

  let windowTokens = guessWindowFromName(normalizedModel);
  if (windowTokens === 0) {
    const baseId = stripRoutingSuffix(normalizedModel);
    if (baseId !== normalizedModel) {
      windowTokens = guessWindowFromName(baseId);
    }
  }

  if (windowTokens <= 0) return { ...DEFAULT_CONTEXT_BUDGET };
  return budgetFromWindow(windowTokens);
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
 * Samples the text to pick an appropriate ratio instead of using a single
 * fixed divisor. Still conservative (slightly over-estimates) to avoid
 * blowing past real limits.
 */
export function estimateTokens(text: string): number {
  if (typeof text !== 'string' || !text) return 0;
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

/** Minimal message shape for token estimation — keeps this module decoupled from app types. */
export interface TokenEstimationMessage {
  content: string;
  thinking?: string;
  attachments?: Array<{ type: string; content: string }>;
}

/**
 * Estimate tokens for a single chat message.
 * Accounts for thinking blocks and attachments when present.
 */
export function estimateMessageTokens(msg: TokenEstimationMessage): number {
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
 */
export function estimateContextTokens(messages: TokenEstimationMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateMessageTokens(msg);
  }
  return total;
}
