/**
 * Shared context budget and token estimation utilities.
 *
 * Unified module used by both the web app and CLI.
 * Extracted from app/src/lib/orchestrator.ts and cli/context-manager.mjs
 * during Track 2 convergence.
 *
 * Runtime-agnostic — no localStorage or browser APIs.
 */

import { lookupDeclaredModelMetadata } from './model-metadata.ts';

// ---------------------------------------------------------------------------
// Context Budget — model-aware token limits
// ---------------------------------------------------------------------------

export interface ContextBudget {
  maxTokens: number;
  targetTokens: number;
  /** Eager, lossless tool-output compression trigger (heuristic Phase 1, plus
   *  the manual `/compact`). Capped at the default 88K so smaller-window models
   *  don't summarize past their target and large-window models don't accumulate
   *  excessive tool noise before the first compression pass. Eager is cheap here:
   *  the raw bytes survive in the verbatim log (§13) and `memory_expand` recalls
   *  them, so compressing early loses no working context. */
  summarizeTokens: number;
  /** Patient, window-aware trigger for the expensive LLM "handoff" collapse
   *  (`lib/llm-compaction.ts`). Unlike `summarizeTokens`, the handoff busts the
   *  prompt cache (it rewrites the prefix) and is lossy in practice, so it fires
   *  late: `HANDOFF_RATIO` of the window, clamped to `[summarizeTokens,
   *  min(targetTokens, HANDOFF_CEILING)]`. Fill-the-window by default; the
   *  ceiling is the middle-ground quality guard. See Agent Runtime Decisions §14. */
  handoffTokens: number;
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

// LLM-handoff collapse — fill the window before paying the cache-busting model
// round-trip. `HANDOFF_RATIO` of the window, never below the eager compression
// floor (`summarizeTokens`) and never above the quality-guard ceiling or the
// lossy drop-backstop (`targetTokens`). Constants are telemetry-tunable (cache-
// hit-rate around compaction events, Agent Runtime Decisions §14) — start generous.
export const HANDOFF_RATIO = 0.7;
export const HANDOFF_CEILING_TOKENS = 400_000;

/**
 * The handoff-collapse trigger for a given window: patient and window-aware.
 * Clamped so it never undercuts the eager compression floor (`summarizeTokens`)
 * nor overshoots the quality ceiling or the lossy drop-backstop (`targetTokens`).
 * For sub-~100K windows the clamp collapses it back onto `targetTokens` (no room
 * to be patient); for ≥256K windows it lets the model fill the window first.
 */
export function handoffTokensFor(
  windowTokens: number,
  summarizeTokens: number,
  targetTokens: number,
): number {
  const patient = Math.floor(windowTokens * HANDOFF_RATIO);
  const high = Math.min(targetTokens, HANDOFF_CEILING_TOKENS);
  return Math.min(high, Math.max(summarizeTokens, patient));
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  maxTokens: DEFAULT_CONTEXT_MAX_TOKENS,
  targetTokens: DEFAULT_CONTEXT_TARGET_TOKENS,
  summarizeTokens: DEFAULT_CONTEXT_TARGET_TOKENS,
  // No real window for the unknown-model fallback; the clamp pins the handoff to
  // the 88K floor (= summarize = target here) — today's single-threshold behavior.
  handoffTokens: DEFAULT_CONTEXT_TARGET_TOKENS,
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
  const summarizeTokens = Math.min(DEFAULT_CONTEXT_TARGET_TOKENS, targetTokens);
  return {
    maxTokens,
    targetTokens,
    summarizeTokens,
    handoffTokens: handoffTokensFor(windowTokens, summarizeTokens, targetTokens),
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
  // Kimi/Moonshot K2.x: 262,144 (256K) — the window Cloudflare Workers AI
  // serves (`@cf/moonshotai/kimi-k2.x`) and Moonshot's own native window.
  if (m.includes('kimi') || m.includes('moonshot')) return 262_144;
  // GLM (Z.ai). GLM-5.2 is natively 1,048,576 (1M) but Workers AI launched
  // `@cf/zai-org/glm-5.2` capped at 262,144 (256K) — budgeting to the native
  // 1M would overflow the served window and truncate/erroring mid-run. Match
  // the served cap; the catalog probe (orchestrator-context) still overrides
  // this with a provider's real window when one is exposed (e.g. a gateway
  // serving the full 1M). Conservative-by-name is the safe direction: the
  // name fallback only runs when no catalog window is known.
  if (m.includes('glm')) return 262_144;
  if (m.includes('gpt-5')) return 1_000_000;
  // Open-weight families served by catalog-less providers (notably Ollama
  // Cloud, which doesn't expose `context_length`). Without these, the
  // flagship cloud models fall through to the 100K default below and get
  // under-budgeted well short of their real windows. This table is a
  // cold-cache / CLI fallback only — the web path resolves the live
  // models.dev window first (see orchestrator-context.ts), so a model
  // present in the catalog auto-corrects without touching this list.
  // Native windows only — YaRN-extended ceilings (e.g. qwen3-coder's 1M)
  // are excluded so the budget can't outrun what the model ships with.
  if (m.includes('gpt-oss')) return 128_000;
  // Qwen coder line has *downward* version variance: the qwen3 generation
  // (480b / 30b / -next) is 256K native, but qwen2.5-coder shipped 128K.
  // Match the 256K generation explicitly, then floor the rest of the coder
  // family at 128K so an unrecognized bump (e.g. a future qwen4-coder)
  // can't silently over-budget past a smaller real window.
  if (m.includes('qwen3-coder')) return 256_000;
  if (m.includes('qwen') && m.includes('coder')) return 128_000;
  // MiniMax: M3 jumps to a 1M long-context tier but only guarantees 512K on
  // the standard tier (above 512K bills at 2x), and the catalog currently
  // reports 512K — so budget M3 to the 512K standard window, matched before
  // the generic fallback so the broad `minimax` rule can't cap it at 200K.
  // The M2 family spans 192K–200K across point releases; 200K stays safe
  // because the 0.92 MAX_RATIO caps the budget below the 192K floor.
  if (m.includes('minimax-m3')) return 512_000;
  if (m.includes('minimax')) return 200_000;
  // DeepSeek v4 family ships with 1M context. v3 and earlier topped at
  // 128K. Listed below the v4 check so `deepseek-v4-pro` doesn't get
  // bucketed with the older window.
  if (m.includes('deepseek-v4')) return 1_000_000;
  if (m.includes('deepseek')) return 128_000;
  // Sakana Fugu orchestration tiers (`fugu`, `fugu-ultra`) advertise a 1M
  // window. Neither models.dev nor the catalog probe knows Fugu yet, so without
  // this both web and CLI fall back to the 100K default and compact ~88K early.
  if (m.includes('fugu')) return 1_000_000;
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
  const windowTokens = resolveContextWindow(_provider, model);
  if (windowTokens === null) return { ...DEFAULT_CONTEXT_BUDGET };
  return budgetFromWindow(windowTokens);
}

/**
 * Resolve the model's real context window when Push has declared metadata or a
 * conservative family fallback. Returns null when the model is unknown so UI
 * surfaces do not present the runtime's generic safety budget as model fact.
 */
export function resolveContextWindow(provider?: string, model?: string | null): number | null {
  const normalizedModel = (model || '').trim();
  if (!normalizedModel) return null;

  const declaredWindow = lookupDeclaredModelMetadata(provider, normalizedModel)?.contextLimit ?? 0;
  if (declaredWindow > 0) return declaredWindow;

  let windowTokens = guessWindowFromName(normalizedModel);
  if (windowTokens === 0) {
    const baseId = stripRoutingSuffix(normalizedModel);
    if (baseId !== normalizedModel) {
      windowTokens = guessWindowFromName(baseId);
    }
  }

  return windowTokens > 0 ? windowTokens : null;
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
  contentParts?: Array<{ type: string; text?: string; image_url?: { url: string } }>;
}

/**
 * Estimate tokens for a single chat message.
 * Accounts for thinking blocks and attachments when present.
 */
export function estimateMessageTokens(msg: TokenEstimationMessage): number {
  let tokens = estimateTokens(msg.content) + 4; // 4 tokens overhead per message
  if (msg.thinking) tokens += estimateTokens(msg.thinking);
  if (msg.contentParts && msg.contentParts.length > 0) {
    // Kernel image turns carry pixels in `contentParts`, not `attachments`.
    // The text part mirrors `content` (already counted), so only add the
    // per-image vision estimate here to avoid double-counting the text.
    for (const part of msg.contentParts) {
      if (part.type === 'image_url') tokens += 1000;
    }
  } else if (msg.attachments) {
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
