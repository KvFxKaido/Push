import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/types';
import { getContextBudget, ORCHESTRATOR_SYSTEM_PROMPT, toLLMMessages } from './orchestrator';

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

  it('derives a 1M-class budget for DeepSeek v4 family on Ollama', () => {
    // Ollama Cloud's /v1/models response omits context_length, so v4
    // models with 1M windows would otherwise fall through to the 100K
    // default. The name-pattern fallback rescues them.
    const expected = {
      maxTokens: Math.floor(1_000_000 * 0.92),
      targetTokens: Math.floor(1_000_000 * 0.85),
      summarizeTokens: 88_000,
    };
    expect(getContextBudget('ollama', 'deepseek-v4-pro')).toEqual(expected);
    expect(getContextBudget('ollama', 'deepseek-v4-flash')).toEqual(expected);
  });

  it('derives a 128K budget for older DeepSeek models', () => {
    // v3.x and earlier top out at ~128K; the bare `deepseek` pattern
    // floors them at that instead of the 100K default.
    expect(getContextBudget('ollama', 'deepseek-v3.2')).toEqual({
      maxTokens: Math.floor(128_000 * 0.92),
      targetTokens: Math.floor(128_000 * 0.85),
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

describe('toLLMMessages reasoning_blocks round-trip', () => {
  function makeMessage(partial: Partial<ChatMessage>): ChatMessage {
    return {
      id: partial.id ?? 'm',
      role: partial.role ?? 'user',
      content: partial.content ?? '',
      timestamp: partial.timestamp ?? 0,
      ...partial,
    };
  }

  // `minimax-m2.7` routes through the Anthropic bridge in Zen Go
  // (`getZenGoTransport`), so the orchestrator should emit the wire
  // sidecar for that route.
  const anthropicRoute = ['zen', 'minimax-m2.7'] as const;

  function buildLlm(
    messages: ChatMessage[],
    provider: 'zen' | 'azure' | undefined = anthropicRoute[0],
    model: string | undefined = anthropicRoute[1],
  ) {
    return toLLMMessages(
      messages,
      undefined, // workspaceContext
      undefined, // hasSandbox
      undefined, // systemPromptOverride
      undefined, // scratchpadContent
      provider,
      model,
    );
  }

  it('forwards reasoningBlocks from a prior assistant turn as the wire reasoning_blocks sidecar', () => {
    const messages: ChatMessage[] = [
      makeMessage({ id: 'u1', role: 'user', content: 'Why?' }),
      makeMessage({
        id: 'a1',
        role: 'assistant',
        content: 'Because Rayleigh.',
        reasoningBlocks: [{ type: 'thinking', text: 'recall optics', signature: 'sig-1' }],
      }),
      makeMessage({ id: 'u2', role: 'user', content: 'Continue.' }),
    ];
    const llm = buildLlm(messages);
    const assistant = llm.find((m) => m.role === 'assistant');
    expect(assistant).toBeDefined();
    expect(assistant?.reasoning_blocks).toEqual([
      { type: 'thinking', text: 'recall optics', signature: 'sig-1' },
    ]);
  });

  it('keeps an assistant turn whose only payload is signed reasoning blocks', () => {
    // Anthropic returns thinking-then-tool_use turns where the visible
    // assistant content is empty but signed reasoning is non-empty. The
    // sanitize pass must not drop these — the bridge will emit the
    // thinking blocks as the wire content[].
    const messages: ChatMessage[] = [
      makeMessage({ id: 'u1', role: 'user', content: 'do thing' }),
      makeMessage({
        id: 'a1',
        role: 'assistant',
        content: '',
        reasoningBlocks: [{ type: 'redacted_thinking', data: 'enc' }],
      }),
      makeMessage({ id: 'u2', role: 'user', content: 'follow up' }),
    ];
    const llm = buildLlm(messages);
    const assistant = llm.find((m) => m.role === 'assistant');
    expect(assistant).toBeDefined();
    expect(assistant?.reasoning_blocks).toEqual([{ type: 'redacted_thinking', data: 'enc' }]);
  });

  it('does not emit reasoning_blocks on user messages', () => {
    const messages: ChatMessage[] = [makeMessage({ id: 'u1', role: 'user', content: 'hi' })];
    const llm = buildLlm(messages);
    const user = llm.find((m) => m.role === 'user');
    expect(user?.reasoning_blocks).toBeUndefined();
  });

  it('does NOT emit reasoning_blocks for non-Anthropic-bridge routes (e.g. Azure)', () => {
    // Azure is a strict OpenAI-compatible upstream — sending the
    // Push-private sidecar would be an unknown message parameter and
    // could be rejected. The persisted blocks stay on the ChatMessage
    // either way; they only leak onto the wire when the route hits the
    // Anthropic bridge.
    const messages: ChatMessage[] = [
      makeMessage({ id: 'u1', role: 'user', content: 'q' }),
      makeMessage({
        id: 'a1',
        role: 'assistant',
        content: 'a',
        reasoningBlocks: [{ type: 'thinking', text: 't', signature: 's' }],
      }),
      makeMessage({ id: 'u2', role: 'user', content: 'q2' }),
    ];
    const llm = buildLlm(messages, 'azure', 'gpt-5');
    const assistant = llm.find((m) => m.role === 'assistant');
    expect(assistant?.reasoning_blocks).toBeUndefined();
  });

  it('does NOT emit reasoning_blocks for Zen on an OpenAI-transport model', () => {
    // Same provider, OpenAI-transport model — the route does not pass
    // through the bridge, so the sidecar must not ride along.
    const messages: ChatMessage[] = [
      makeMessage({ id: 'u1', role: 'user', content: 'q' }),
      makeMessage({
        id: 'a1',
        role: 'assistant',
        content: 'a',
        reasoningBlocks: [{ type: 'thinking', text: 't', signature: 's' }],
      }),
      makeMessage({ id: 'u2', role: 'user', content: 'q2' }),
    ];
    const llm = buildLlm(messages, 'zen', 'glm-5.1');
    const assistant = llm.find((m) => m.role === 'assistant');
    expect(assistant?.reasoning_blocks).toBeUndefined();
  });
});
