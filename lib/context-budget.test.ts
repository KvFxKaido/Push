import { describe, expect, it } from 'vitest';
import { estimateMessageTokens, getContextBudget, guessWindowFromName } from './context-budget.js';

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

  it('falls back to the default budget when the name matches nothing', () => {
    const budget = getContextBudget(undefined, 'totally-unknown-model');
    expect(budget.maxTokens).toBe(100_000);
    expect(budget.targetTokens).toBe(88_000);
  });
});
