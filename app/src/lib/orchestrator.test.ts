import { describe, expect, it } from 'vitest';
import { getContextBudget, ORCHESTRATOR_SYSTEM_PROMPT } from './orchestrator';

describe('ORCHESTRATOR_SYSTEM_PROMPT', () => {
  it('includes clarification guidance for when to ask vs assume', () => {
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('## Clarifications and Assumptions');
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('First try to resolve ambiguity from the chat, repo context, and available inspection tools.');
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('If a genuine ambiguity remains and it would materially change the approach, risk wasted/incorrect work, or depend on user preference');
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('with 2–4 concrete options.');
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('If the ambiguity is minor or reversible, make the best reasonable assumption, state it briefly, and continue.');
  });
});

describe('getContextBudget', () => {
  it('keeps the default budget for regular OpenRouter models', () => {
    expect(getContextBudget('openrouter', 'mistralai/mistral-large-2512')).toEqual({
      maxTokens: 100_000,
      targetTokens: 88_000,
      summarizeTokens: 88_000,
    });
  });

  it('uses the large Gemini budget for Gemini models', () => {
    expect(getContextBudget('openrouter', 'google/gemini-3.1-pro-preview:nitro')).toEqual({
      maxTokens: 850_000,
      targetTokens: 800_000,
      summarizeTokens: 88_000,
    });
  });

  it('uses the large Gemini budget for Vertex Gemini models too', () => {
    expect(getContextBudget('vertex', 'google/gemini-2.5-pro')).toEqual({
      maxTokens: 850_000,
      targetTokens: 800_000,
      summarizeTokens: 88_000,
    });
  });

  it('uses the large-context budget for non-Haiku Claude models', () => {
    expect(getContextBudget('openrouter', 'anthropic/claude-sonnet-4.6:nitro')).toEqual({
      maxTokens: 850_000,
      targetTokens: 800_000,
      summarizeTokens: 88_000,
    });
  });

  it('keeps Haiku models on the default budget', () => {
    expect(getContextBudget('openrouter', 'anthropic/claude-3.5-haiku:nitro')).toEqual({
      maxTokens: 100_000,
      targetTokens: 88_000,
      summarizeTokens: 88_000,
    });
  });

  it('uses the conservative large-context budget for gpt-5.4-pro', () => {
    expect(getContextBudget('openrouter', 'openai/gpt-5.4-pro')).toEqual({
      maxTokens: 850_000,
      targetTokens: 725_000,
      summarizeTokens: 160_000,
    });
  });

  it('uses the same large-context budget for regular gpt-5.4', () => {
    expect(getContextBudget('openrouter', 'openai/gpt-5.4')).toEqual({
      maxTokens: 850_000,
      targetTokens: 725_000,
      summarizeTokens: 160_000,
    });
  });

  it('uses the Grok budget for Grok models', () => {
    expect(getContextBudget('openrouter', 'x-ai/grok-4.1-fast')).toEqual({
      maxTokens: 1_500_000,
      targetTokens: 1_350_000,
      summarizeTokens: 180_000,
    });
  });
});
