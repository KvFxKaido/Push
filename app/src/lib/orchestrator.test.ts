import { describe, expect, it } from 'vitest';
import { getContextBudget, ORCHESTRATOR_SYSTEM_PROMPT } from './orchestrator';

describe('ORCHESTRATOR_SYSTEM_PROMPT', () => {
  it('includes clarification guidance for when to ask vs assume', () => {
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('## Clarifications and Assumptions');
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain(
      'First try to resolve ambiguity from the chat, repo context, and available inspection tools.',
    );
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain(
      'If a genuine ambiguity remains and it would materially change the approach, risk wasted/incorrect work, or depend on user preference',
    );
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('with 2–4 concrete options.');
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain(
      'If the ambiguity is minor or reversible, make the best reasonable assumption, state it briefly, and continue.',
    );
  });
});

describe('getContextBudget', () => {
  // The current tests assume no models.dev metadata is available. In vitest's
  // Node environment, `window` is undefined, so storage reads return null
  // instead of using browser localStorage. Each scenario therefore exercises
  // the name-pattern fallback in lookupContextWindow.

  it('keeps the default budget for unknown models with no catalog hit', () => {
    expect(getContextBudget('openrouter', 'mistralai/mistral-large-2512')).toEqual({
      maxTokens: 100_000,
      targetTokens: 88_000,
      summarizeTokens: 88_000,
    });
  });

  it('derives a 1M-class budget for Gemini regardless of provider', () => {
    const expected = {
      maxTokens: Math.floor(1_000_000 * 0.92),
      targetTokens: Math.floor(1_000_000 * 0.85),
      summarizeTokens: 88_000,
    };
    expect(getContextBudget('openrouter', 'google/gemini-3.1-pro-preview:nitro')).toEqual(expected);
    expect(getContextBudget('vertex', 'google/gemini-2.5-pro')).toEqual(expected);
  });

  it('derives a 1M-class budget for non-Haiku Claude models', () => {
    expect(getContextBudget('openrouter', 'anthropic/claude-sonnet-4.6:nitro')).toEqual({
      maxTokens: Math.floor(1_000_000 * 0.92),
      targetTokens: Math.floor(1_000_000 * 0.85),
      summarizeTokens: 88_000,
    });
  });

  it('derives a 200K budget for Haiku models (matches their real window)', () => {
    expect(getContextBudget('openrouter', 'anthropic/claude-3.5-haiku:nitro')).toEqual({
      maxTokens: Math.floor(200_000 * 0.92),
      targetTokens: Math.floor(200_000 * 0.85),
      summarizeTokens: 88_000,
    });
  });

  it('derives a 1M-class budget for GPT-5 models', () => {
    const expected = {
      maxTokens: Math.floor(1_000_000 * 0.92),
      targetTokens: Math.floor(1_000_000 * 0.85),
      summarizeTokens: 88_000,
    };
    expect(getContextBudget('openrouter', 'openai/gpt-5.4-pro')).toEqual(expected);
    expect(getContextBudget('openrouter', 'openai/gpt-5.4')).toEqual(expected);
  });

  it('derives a 2M-class budget for Grok models', () => {
    expect(getContextBudget('openrouter', 'x-ai/grok-4.1-fast')).toEqual({
      maxTokens: Math.floor(2_000_000 * 0.92),
      targetTokens: Math.floor(2_000_000 * 0.85),
      summarizeTokens: 88_000,
    });
  });

  it('derives a 256K budget for Kimi/Moonshot models', () => {
    expect(getContextBudget('cloudflare', '@cf/moonshotai/kimi-k2-instruct')).toEqual({
      maxTokens: Math.floor(256_000 * 0.92),
      targetTokens: Math.floor(256_000 * 0.85),
      summarizeTokens: 88_000,
    });
  });

  it('keeps summarizeTokens at or below the target for the unknown-model default fallback', () => {
    // Synthesize a model name that misses every pattern so this exercises the
    // default fallback budget (100K), where summarizeTokens is capped at the
    // same 88K target rather than a truly tiny window.
    const budget = getContextBudget('openrouter', 'unknown-tiny-model');
    expect(budget.summarizeTokens).toBeLessThanOrEqual(budget.targetTokens);
  });
});
