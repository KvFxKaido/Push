import { describe, expect, it } from 'vitest';
import {
  budgetFromWindow,
  estimateMessageTokens,
  getContextBudget,
  guessWindowFromName,
  HANDOFF_CEILING_TOKENS,
  handoffTokensFor,
} from './context-budget.js';

describe('estimateMessageTokens — contentParts (#937)', () => {
  it('adds the vision estimate for image contentParts without double-counting text', () => {
    const text = 'Task: describe this';
    const textOnly = estimateMessageTokens({ content: text });
    const withImage = estimateMessageTokens({
      content: text,
      contentParts: [
        { type: 'text', text },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
      ],
    });
    // Exactly one image's vision estimate (1000) on top of the text turn —
    // the contentParts text mirrors `content` and is not recounted.
    expect(withImage - textOnly).toBe(1000);
  });
});

describe('guessWindowFromName', () => {
  // Catches cases where Ollama Cloud's `/v1/models` (and similar provider
  // catalogs) omit `context_length`, so the only signal Push has is the model
  // name. Order is deliberately specific-first inside the function — these
  // tests pin that order so a future re-shuffle can't silently bucket a
  // narrow-window family with a wider one.

  it('routes the DeepSeek v4 family to a 1M window', () => {
    expect(guessWindowFromName('deepseek-v4-pro')).toBe(1_000_000);
    expect(guessWindowFromName('deepseek-v4-flash')).toBe(1_000_000);
  });

  it('floors older DeepSeek models at 128K (real published window)', () => {
    expect(guessWindowFromName('deepseek-v3.2')).toBe(128_000);
    expect(guessWindowFromName('deepseek-v2-base')).toBe(128_000);
    expect(guessWindowFromName('deepseek-coder')).toBe(128_000);
  });

  it('keeps Haiku narrower than the Claude family default', () => {
    expect(guessWindowFromName('claude-3.5-haiku')).toBe(200_000);
    expect(guessWindowFromName('anthropic/claude-sonnet-4.6')).toBe(1_000_000);
  });

  it('buckets Ollama Cloud open-weight families at their native windows', () => {
    // gpt-oss (both sizes / variants) ships 128K; without this it fell to
    // the 100K default. MiniMax-M2 spans 192K–200K; 200K is safe under the
    // 0.92 ratio.
    expect(guessWindowFromName('gpt-oss:120b')).toBe(128_000);
    expect(guessWindowFromName('gpt-oss:20b')).toBe(128_000);
    expect(guessWindowFromName('gpt-oss-safeguard')).toBe(128_000);
    expect(guessWindowFromName('minimax-m2:cloud')).toBe(200_000);
    expect(guessWindowFromName('minimax-m2.7')).toBe(200_000);
  });

  it('budgets MiniMax-M3 at its 512K standard window, not the M2 fallback', () => {
    // M3 is a ~1M-context model (512K guaranteed standard tier); the broad
    // `minimax` rule would otherwise cap it at 200K and compact far too
    // early. Matched before the generic fallback for both the bare and the
    // OpenRouter-routed / free-tier ids.
    expect(guessWindowFromName('minimax-m3')).toBe(512_000);
    expect(guessWindowFromName('minimax/minimax-m3')).toBe(512_000);
    expect(guessWindowFromName('minimax-m3-free')).toBe(512_000);
  });

  it('separates the 256K qwen3-coder generation from the 128K older line', () => {
    // qwen3-coder (incl. -next and the size variants) is 256K native; the
    // YaRN-extended 1M is deliberately not matched. Older qwen2.5-coder
    // shipped 128K, so the generic coder floor must NOT lift it to 256K —
    // an over-budget there would risk real-window overflow.
    expect(guessWindowFromName('qwen3-coder:480b')).toBe(256_000);
    expect(guessWindowFromName('qwen3-coder-next')).toBe(256_000);
    expect(guessWindowFromName('qwen2.5-coder:32b')).toBe(128_000);
    // An unrecognized coder bump falls to the conservative 128K floor, not
    // the 100K default and not an over-optimistic 256K guess.
    expect(guessWindowFromName('qwen4-coder')).toBe(128_000);
    // Non-coder qwen stays unmatched (left to catalog / default).
    expect(guessWindowFromName('qwen3:235b')).toBe(0);
  });

  it('budgets GLM + Kimi at the 262,144 Workers AI window', () => {
    // GLM-5.2 is natively 1M but Workers AI serves it (and the Kimi K2.x
    // family) at 262,144 (256K). The name fallback must match the served cap,
    // not GLM's native 1M — over-budgeting overflows the real window. Covers
    // both the bare ids and the `@cf/...` ids Workers AI returns.
    expect(guessWindowFromName('@cf/zai-org/glm-5.2')).toBe(262_144);
    expect(guessWindowFromName('glm-5.1')).toBe(262_144);
    expect(guessWindowFromName('@cf/moonshotai/kimi-k2.7-code')).toBe(262_144);
    expect(guessWindowFromName('kimi-k2.6')).toBe(262_144);
    expect(guessWindowFromName('moonshotai/kimi-k2.5')).toBe(262_144);
  });

  it('returns 0 for names that match no pattern', () => {
    expect(guessWindowFromName('mistralai/mistral-large-2512')).toBe(0);
    expect(guessWindowFromName('totally-unknown-model')).toBe(0);
  });
});

describe('getContextBudget (shared)', () => {
  // Spot-checks that the budget shape produced from a name-only resolution
  // is internally consistent for the deepseek case driving this test file.

  it('produces a 1M-class budget for deepseek-v4-pro with no catalog probe', () => {
    const budget = getContextBudget('ollama', 'deepseek-v4-pro');
    expect(budget.maxTokens).toBe(Math.floor(1_000_000 * 0.92));
    expect(budget.targetTokens).toBe(Math.floor(1_000_000 * 0.85));
    // summarizeTokens stays at or below the soft target — invariant from
    // budgetFromWindow that downstream context-trim relies on.
    expect(budget.summarizeTokens).toBeLessThanOrEqual(budget.targetTokens);
  });

  it('uses declared metadata before broad name-pattern fallbacks', () => {
    expect(getContextBudget('openai', 'gpt-5.4-mini')).toEqual(budgetFromWindow(400_000));
    expect(getContextBudget('zen', 'big-pickle')).toEqual(budgetFromWindow(200_000));
    // Grok 4.5 ships 500K, smaller than its 2M grok-4.x siblings, so declared
    // metadata must win over guessWindowFromName('grok') = 2M — otherwise an xai
    // chat defers compaction to ~1.8M and overruns the real window (Codex P2,
    // PR #1392).
    expect(guessWindowFromName('grok-4.5')).toBe(2_000_000);
    expect(getContextBudget('xai', 'grok-4.5')).toEqual(budgetFromWindow(500_000));
    // Grok 4.20 variants are 1M (xAI /v1/models), also under the `grok` = 2M
    // name fallback — declared metadata pins the real window.
    expect(getContextBudget('xai', 'grok-4.20-0309-reasoning')).toEqual(
      budgetFromWindow(1_000_000),
    );
    expect(getContextBudget('xai', 'grok-4.20-0309-non-reasoning')).toEqual(
      budgetFromWindow(1_000_000),
    );
    expect(getContextBudget('xai', 'grok-4.20-multi-agent-0309')).toEqual(
      budgetFromWindow(1_000_000),
    );
  });

  it('keeps Cloudflare gateway-capped models on their cap-aware name fallback', () => {
    // `@cf/zai-org/glm-5.2` is served by Workers AI at 256K, but declared
    // `glm-5.2` is the native 1M. Cross-provider declared matches must not
    // override the cap, or long Workers AI chats overrun the served window.
    expect(getContextBudget('cloudflare', '@cf/zai-org/glm-5.2')).toEqual(
      budgetFromWindow(262_144),
    );
  });

  it('falls back to the default budget when the name matches nothing', () => {
    const budget = getContextBudget(undefined, 'totally-unknown-model');
    expect(budget.maxTokens).toBe(100_000);
    expect(budget.targetTokens).toBe(88_000);
    // No window for the unknown-model fallback → handoff pins to the floor,
    // i.e. today's single-threshold behavior (handoff === summarize).
    expect(budget.handoffTokens).toBe(88_000);
  });
});

describe('handoffTokensFor — the patient, window-aware handoff trigger (§14)', () => {
  // The split: tool-output compression stays eager (lossless), the LLM handoff
  // collapse fills the window before paying the cache-busting round-trip.

  it('fills large windows up to the quality-guard ceiling, not 88K', () => {
    // The whole point of the split — a 1M model collapsed at ~9% of its window
    // was the bug. Now it fills to the ceiling.
    const summarize = 88_000;
    const target = Math.floor(1_000_000 * 0.85);
    expect(handoffTokensFor(1_000_000, summarize, target)).toBe(HANDOFF_CEILING_TOKENS);
    // A 2M window is also ceiling-capped (the middle-ground guard).
    expect(handoffTokensFor(2_000_000, summarize, Math.floor(2_000_000 * 0.85))).toBe(
      HANDOFF_CEILING_TOKENS,
    );
  });

  it('lets mid-size windows breathe between the floor and the ceiling', () => {
    // 256K: 0.7·262144 = 183500, under both the target and the 400K ceiling.
    expect(handoffTokensFor(262_144, 88_000, Math.floor(262_144 * 0.85))).toBe(183_500);
    // 200K Haiku: 0.7·200K = 140K.
    expect(handoffTokensFor(200_000, 88_000, Math.floor(200_000 * 0.85))).toBe(140_000);
  });

  it('collapses back onto the target for sub-~100K windows (no room to be patient)', () => {
    // A 64K window: target (54400) is below the 88K floor, so summarize === target
    // and the clamp pins handoff to target — a single effective threshold.
    const target = Math.floor(64_000 * 0.85); // 54400
    const summarize = Math.min(88_000, target); // 54400
    expect(handoffTokensFor(64_000, summarize, target)).toBe(target);
  });

  it('never undercuts the eager compression floor nor overshoots the drop-backstop', () => {
    for (const window of [64_000, 128_000, 200_000, 262_144, 512_000, 1_000_000, 2_000_000]) {
      const target = Math.floor(window * 0.85);
      const summarize = Math.min(88_000, target);
      const handoff = handoffTokensFor(window, summarize, target);
      // summarize (compress) ≤ handoff (collapse) ≤ target (drop) — the ladder order.
      expect(handoff).toBeGreaterThanOrEqual(summarize);
      expect(handoff).toBeLessThanOrEqual(target);
      expect(handoff).toBeLessThanOrEqual(HANDOFF_CEILING_TOKENS);
    }
  });
});
