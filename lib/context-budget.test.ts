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
