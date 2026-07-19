import { describe, expect, it } from 'vitest';

import { routeReplaysReasoningContent } from './reasoning-replay-routing.ts';

describe('routeReplaysReasoningContent', () => {
  it('replays for Kimi direct regardless of model', () => {
    expect(routeReplaysReasoningContent('kimi', 'kimi-k2.7')).toBe(true);
    expect(routeReplaysReasoningContent('kimi', 'anything')).toBe(true);
  });

  it('replays for deepseek/kimi/moonshot models via the OpenAI-compat gateways', () => {
    for (const provider of ['zen', 'openrouter', 'huggingface']) {
      expect(routeReplaysReasoningContent(provider, 'deepseek-v3')).toBe(true);
      expect(routeReplaysReasoningContent(provider, 'moonshotai/kimi-k2')).toBe(true);
      // Non-reasoning model on a gateway that CAN carry it → still no replay.
      expect(routeReplaysReasoningContent(provider, 'llama-3.1-8b')).toBe(false);
    }
  });

  it('never replays to DeepSeek direct (it takes signed thinking, not reasoning_content)', () => {
    // The CLI `deepseek` provider is the Anthropic transport; the field would 400.
    expect(routeReplaysReasoningContent('deepseek', 'deepseek-reasoner')).toBe(false);
  });

  it('does not replay for unrelated providers or missing inputs', () => {
    expect(routeReplaysReasoningContent('ollama', 'mock-model')).toBe(false);
    expect(routeReplaysReasoningContent('fireworks', 'deepseek-v3')).toBe(false);
    expect(routeReplaysReasoningContent(undefined, 'deepseek-v3')).toBe(false);
    expect(routeReplaysReasoningContent('kimi', undefined)).toBe(false);
  });
});
