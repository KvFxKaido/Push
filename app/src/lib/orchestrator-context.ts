import type { AIProviderType, ChatMessage } from '@/types';

// Context mode config (runtime toggle from Settings)
const CONTEXT_MODE_STORAGE_KEY = 'push_context_mode';
export type ContextMode = 'graceful' | 'none';

// Rolling window config — token-based context management
const DEFAULT_CONTEXT_MAX_TOKENS = 100_000; // Hard cap
const DEFAULT_CONTEXT_TARGET_TOKENS = 88_000; // Soft target leaves room for system prompt + response
// Gemini models (1M context window) — Google, Ollama, OpenRouter, and Zen with Gemini models
// Keep a ~20% margin below the 1,048,576 API limit because estimateTokens (len/3.5) can
// undercount on code-dense or CJK-heavy conversations.
const GEMINI_CONTEXT_MAX_TOKENS = 850_000;
const GEMINI_CONTEXT_TARGET_TOKENS = 800_000;
// GPT-5.4 models expose a large context window, but we keep a more conservative
// target than Grok because long prompts are materially more expensive.
const GPT5_PRO_CONTEXT_MAX_TOKENS = 850_000;
const GPT5_PRO_CONTEXT_TARGET_TOKENS = 725_000;
const GPT5_PRO_CONTEXT_SUMMARIZE_TOKENS = 160_000;
// Grok models on OpenRouter can expose ~2M context. Keep a larger margin than
// Gemini because token estimation is rough and our tool/system prompt overhead is
// substantial on long-running sessions.
const GROK_CONTEXT_MAX_TOKENS = 1_500_000;
const GROK_CONTEXT_TARGET_TOKENS = 1_350_000;
const GROK_CONTEXT_SUMMARIZE_TOKENS = 180_000;

export interface ContextBudget {
  maxTokens: number;
  targetTokens: number;
  /** Threshold at which old tool results get summarized. Decoupled from
   *  targetTokens so large-context models (Gemini) still get lean working
   *  context without premature message dropping. */
  summarizeTokens: number;
}

const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  maxTokens: DEFAULT_CONTEXT_MAX_TOKENS,
  targetTokens: DEFAULT_CONTEXT_TARGET_TOKENS,
  summarizeTokens: DEFAULT_CONTEXT_TARGET_TOKENS, // same as target for non-Gemini
};

const GEMINI_CONTEXT_BUDGET: ContextBudget = {
  maxTokens: GEMINI_CONTEXT_MAX_TOKENS,
  targetTokens: GEMINI_CONTEXT_TARGET_TOKENS,
  summarizeTokens: DEFAULT_CONTEXT_TARGET_TOKENS, // summarize early like other providers
};

const CLAUDE_CONTEXT_BUDGET: ContextBudget = {
  maxTokens: GEMINI_CONTEXT_MAX_TOKENS,
  targetTokens: GEMINI_CONTEXT_TARGET_TOKENS,
  summarizeTokens: DEFAULT_CONTEXT_TARGET_TOKENS,
};

const GPT5_PRO_CONTEXT_BUDGET: ContextBudget = {
  maxTokens: GPT5_PRO_CONTEXT_MAX_TOKENS,
  targetTokens: GPT5_PRO_CONTEXT_TARGET_TOKENS,
  summarizeTokens: GPT5_PRO_CONTEXT_SUMMARIZE_TOKENS,
};

const GROK_CONTEXT_BUDGET: ContextBudget = {
  maxTokens: GROK_CONTEXT_MAX_TOKENS,
  targetTokens: GROK_CONTEXT_TARGET_TOKENS,
  summarizeTokens: GROK_CONTEXT_SUMMARIZE_TOKENS,
};

function normalizeModelName(model?: string): string {
  return (model || '').trim().toLowerCase();
}

export function getContextBudget(
  provider?: AIProviderType,
  model?: string,
): ContextBudget {
  const normalizedModel = normalizeModelName(model);
  // GPT-5.4 models get a large-context profile, but with a conservative target
  // to avoid turning long sessions into runaway expensive prompts.
  if (normalizedModel.includes('gpt-5.4')) {
    return GPT5_PRO_CONTEXT_BUDGET;
  }

  // Non-Haiku Claude models get the larger 1M-class profile.
  if (normalizedModel.includes('claude') && !normalizedModel.includes('haiku')) {
    return CLAUDE_CONTEXT_BUDGET;
  }

  // OpenRouter or other providers running a Grok model — larger long-term
  // history, but still summarize well before the hard cap.
  if (normalizedModel.includes('grok')) {
    return GROK_CONTEXT_BUDGET;
  }

  // Ollama, OpenRouter, or Zen running a Gemini model — full 1M budget
  if (
    (provider === 'ollama'
      || provider === 'openrouter'
      || provider === 'zen'
      || provider === 'vertex') &&
    normalizedModel.includes('gemini')
  ) {
    return GEMINI_CONTEXT_BUDGET;
  }

  return DEFAULT_CONTEXT_BUDGET;
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
      if (att.type === 'image') tokens += 1000; // rough estimate for vision
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
