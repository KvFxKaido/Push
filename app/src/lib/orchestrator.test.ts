import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/types';

// Web-search mode controls whether the chat-mode environment description
// still advertises `web_search` (Codex #591 P2: the description is set
// once at workspace setup, so the orchestrator has to override it when
// the user later flips the menu to off).
let webSearchModeForTest: 'auto' | 'off' = 'auto';
vi.mock('./web-search-mode', () => ({
  getWebSearchMode: () => webSearchModeForTest,
  // Default chat-mode tests don't pass a provider, so the helper sees
  // `provider === ''` and returns false — the prompt-engineered tool
  // protocol stays in the prompt, matching pre-change behavior.
  isNativeWebSearchEnabled: (provider: string, _modelId?: string, mode?: string) => {
    const m = mode ?? webSearchModeForTest;
    if (m === 'off') return false;
    if (m === 'auto') return provider === 'google' || provider === 'anthropic';
    return false;
  },
}));

import { getContextBudget, ORCHESTRATOR_SYSTEM_PROMPT, toLLMMessages } from './orchestrator';
import { TOOL_PROTOCOL } from './github-tools';

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
    expect(getContextBudget('openrouter', 'totally-unknown-model')).toEqual({
      maxTokens: 100_000,
      targetTokens: 88_000,
      summarizeTokens: 88_000,
      // Unknown-model default: clamp pins handoff to the 88K floor (no window).
      handoffTokens: 88_000,
    });
  });

  it('derives a 1M-class budget for Gemini regardless of provider', () => {
    const expected = {
      maxTokens: Math.floor(1_048_576 * 0.92),
      targetTokens: Math.floor(1_048_576 * 0.85),
      summarizeTokens: 88_000,
      // handoff = clamp(0.7·1,048,576, 88K, min(target, 400K ceiling)) = 400K ceiling.
      handoffTokens: 400_000,
    };
    expect(getContextBudget('openrouter', 'google/gemini-3.1-pro-preview:nitro')).toEqual(expected);
    expect(getContextBudget('google', 'gemini-2.5-pro')).toEqual(expected);
  });

  it('derives a 1M-class budget for non-Haiku Claude models', () => {
    expect(getContextBudget('openrouter', 'anthropic/claude-sonnet-4.6:nitro')).toEqual({
      maxTokens: Math.floor(1_000_000 * 0.92),
      targetTokens: Math.floor(1_000_000 * 0.85),
      summarizeTokens: 88_000,
      // handoff = clamp(0.7·1M, 88K, min(target, 400K ceiling)) = 400K ceiling.
      handoffTokens: 400_000,
    });
  });

  it('derives a 200K budget for Haiku models (matches their real window)', () => {
    expect(getContextBudget('openrouter', 'anthropic/claude-3.5-haiku:nitro')).toEqual({
      maxTokens: Math.floor(200_000 * 0.92),
      targetTokens: Math.floor(200_000 * 0.85),
      summarizeTokens: 88_000,
      // handoff = clamp(0.7·200K=140K, 88K, min(170K, 400K)) = 140K.
      handoffTokens: 140_000,
    });
  });

  it('derives a 1M-class budget for GPT-5 models', () => {
    const expected = {
      maxTokens: Math.floor(1_050_000 * 0.92),
      targetTokens: Math.floor(1_050_000 * 0.85),
      summarizeTokens: 88_000,
      // handoff = clamp(0.7·1.05M, 88K, min(target, 400K ceiling)) = 400K ceiling.
      handoffTokens: 400_000,
    };
    expect(getContextBudget('openrouter', 'openai/gpt-5.4-pro')).toEqual(expected);
    expect(getContextBudget('openrouter', 'openai/gpt-5.4')).toEqual(expected);
  });

  it('derives a 2M-class budget for Grok models', () => {
    expect(getContextBudget('openrouter', 'x-ai/grok-4.20')).toEqual({
      maxTokens: Math.floor(2_000_000 * 0.92),
      targetTokens: Math.floor(2_000_000 * 0.85),
      summarizeTokens: 88_000,
      // handoff = clamp(0.7·2M, 88K, min(target, 400K ceiling)) = 400K ceiling
      // (the middle-ground guard — a 2M window doesn't carry 1.4M of diluted context).
      handoffTokens: 400_000,
    });
  });

  it('derives a 256K budget for Kimi/Moonshot models', () => {
    // 262,144 = 256 KiB — the exact window Workers AI serves for the Kimi
    // K2.x family (was previously the 256,000 decimal approximation).
    expect(getContextBudget('cloudflare', '@cf/moonshotai/kimi-k2-instruct')).toEqual({
      maxTokens: Math.floor(262_144 * 0.92),
      targetTokens: Math.floor(262_144 * 0.85),
      summarizeTokens: 88_000,
      // handoff = clamp(0.7·262144=183500, 88K, min(222822, 400K)) = 183500.
      handoffTokens: 183_500,
    });
  });

  it('keeps Cloudflare GLM on its 256K served cap, not the declared native 1M', () => {
    // `glm-5.2` IS a declared key (native 1M), so the web context probe's
    // sibling-provider sweep retries `@cf/zai-org/glm-5.2` against zen/openrouter
    // and would leaf-match that 1M entry — overrunning the 262,144 window Workers
    // AI actually serves. Declared metadata must reject `@cf/` ids on every path.
    expect(getContextBudget('cloudflare', '@cf/zai-org/glm-5.2')).toEqual({
      maxTokens: Math.floor(262_144 * 0.92),
      targetTokens: Math.floor(262_144 * 0.85),
      summarizeTokens: 88_000,
      handoffTokens: 183_500,
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
      // handoff = clamp(0.7·1M, 88K, min(target, 400K ceiling)) = 400K ceiling.
      handoffTokens: 400_000,
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
      // handoff = clamp(0.7·128K=89600, 88K, min(108800, 400K)) = 89600.
      handoffTokens: 89_600,
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
    provider: 'zen' | 'openrouter' | 'openai' | undefined = anthropicRoute[0],
    model: string | undefined = anthropicRoute[1],
  ) {
    return toLLMMessages(messages, { providerType: provider, providerModel: model });
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

  it('does NOT emit reasoning_blocks for non-Anthropic-bridge routes (e.g. OpenAI)', () => {
    // OpenAI is a strict OpenAI-compatible upstream — sending the
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
    const llm = buildLlm(messages, 'openai', 'gpt-5');
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

  it('replays plain reasoning_content for Zen DeepSeek thinking-mode models', () => {
    const messages: ChatMessage[] = [
      makeMessage({ id: 'u1', role: 'user', content: 'q' }),
      makeMessage({
        id: 'a1',
        role: 'assistant',
        content: 'a',
        thinking: 'plain reasoning\n  preserved spacing  ',
      }),
      makeMessage({ id: 'u2', role: 'user', content: 'q2' }),
    ];
    const llm = buildLlm(messages, 'zen', 'deepseek-v4-pro');
    const assistant = llm.find((m) => m.role === 'assistant');
    expect(assistant?.reasoning_content).toBe('plain reasoning\n  preserved spacing  ');
  });

  it('replays plain reasoning_content for OpenRouter DeepSeek models', () => {
    const messages: ChatMessage[] = [
      makeMessage({ id: 'u1', role: 'user', content: 'q' }),
      makeMessage({
        id: 'a1',
        role: 'assistant',
        content: 'a',
        thinking: 'openrouter deepseek reasoning',
      }),
      makeMessage({ id: 'u2', role: 'user', content: 'q2' }),
    ];
    const llm = buildLlm(messages, 'openrouter', 'deepseek/deepseek-r1');
    const assistant = llm.find((m) => m.role === 'assistant');
    expect(assistant?.reasoning_content).toBe('openrouter deepseek reasoning');
  });

  it('keeps a Zen DeepSeek assistant turn whose only payload is reasoning_content', () => {
    const messages: ChatMessage[] = [
      makeMessage({ id: 'u1', role: 'user', content: 'q' }),
      makeMessage({
        id: 'a1',
        role: 'assistant',
        content: '',
        thinking: 'thinking before a tool',
      }),
      makeMessage({ id: 'u2', role: 'user', content: 'q2' }),
    ];
    const llm = buildLlm(messages, 'zen', 'deepseek-v4-flash');
    const assistant = llm.find((m) => m.role === 'assistant');
    expect(assistant).toBeDefined();
    expect(assistant?.content).toBe('');
    expect(assistant?.reasoning_content).toBe('thinking before a tool');
  });

  it('replays reasoning_content from a kernel LlmMessage `reasoningContent` field (cast seam)', () => {
    // The inline/CLI kernel lane hands its own LlmMessages to the provider stream
    // through the `PushStream<LlmMessage>` cast seam (chat-send-inline.ts) — they
    // carry reasoning on `reasoningContent`, NOT ChatMessage `.thinking`.
    // toLLMMessages must still emit reasoning_content, else a kernel tool-call turn
    // replays bare and DeepSeek thinking mode 400s the continuation.
    const messages = [
      makeMessage({ id: 'u1', role: 'user', content: 'q' }),
      {
        ...makeMessage({ id: 'a1', role: 'assistant', content: '' }),
        reasoningContent: 'kernel reasoning before the tool call',
      } as ChatMessage,
      makeMessage({ id: 'u2', role: 'user', content: 'q2' }),
    ];
    const assistant = buildLlm(messages, 'zen', 'deepseek-v4-pro').find(
      (m) => m.role === 'assistant',
    );
    expect(assistant?.reasoning_content).toBe('kernel reasoning before the tool call');
  });

  it('prefers ChatMessage `.thinking` over `reasoningContent` when both are present', () => {
    const messages = [
      makeMessage({ id: 'u1', role: 'user', content: 'q' }),
      {
        ...makeMessage({
          id: 'a1',
          role: 'assistant',
          content: 'a',
          thinking: 'orchestrator thinking',
        }),
        reasoningContent: 'kernel reasoning',
      } as ChatMessage,
      makeMessage({ id: 'u2', role: 'user', content: 'q2' }),
    ];
    const assistant = buildLlm(messages, 'zen', 'deepseek-v4-pro').find(
      (m) => m.role === 'assistant',
    );
    expect(assistant?.reasoning_content).toBe('orchestrator thinking');
  });

  it('does NOT replay reasoning_content for non-DeepSeek OpenAI-compatible routes', () => {
    const messages: ChatMessage[] = [
      makeMessage({ id: 'u1', role: 'user', content: 'q' }),
      makeMessage({
        id: 'a1',
        role: 'assistant',
        content: 'a',
        thinking: 'should stay display-only',
      }),
      makeMessage({ id: 'u2', role: 'user', content: 'q2' }),
    ];
    const zenAssistant = buildLlm(messages, 'zen', 'glm-5.1').find((m) => m.role === 'assistant');
    const openRouterAssistant = buildLlm(
      messages,
      'openrouter',
      'anthropic/claude-sonnet-4.6:nitro',
    ).find((m) => m.role === 'assistant');
    const openaiAssistant = buildLlm(messages, 'openai', 'gpt-5').find(
      (m) => m.role === 'assistant',
    );
    expect(zenAssistant?.reasoning_content).toBeUndefined();
    expect(openRouterAssistant?.reasoning_content).toBeUndefined();
    expect(openaiAssistant?.reasoning_content).toBeUndefined();
  });
});

describe('toLLMMessages attachment content blocks', () => {
  function makeMessage(partial: Partial<ChatMessage>): ChatMessage {
    return {
      id: partial.id ?? 'm',
      role: partial.role ?? 'user',
      content: partial.content ?? '',
      timestamp: partial.timestamp ?? 0,
      ...partial,
    };
  }

  it('builds Anthropic-canonical contentBlocks from attachments', () => {
    const llm = toLLMMessages([
      makeMessage({
        id: 'u1',
        role: 'user',
        content: 'see image',
        attachments: [
          {
            id: 'att-1',
            type: 'image',
            filename: 'screen.png',
            mimeType: 'image/png',
            sizeBytes: 3,
            content: 'data:image/png;base64,AAA',
          },
        ],
      }),
    ]);
    const user = llm.find((m) => m.role === 'user');
    expect(user?.content).toBe('see image');
    expect(user?.contentBlocks).toEqual([
      { type: 'text', text: 'see image' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
    ]);
  });

  it('preserves explicit contentParts instead of rebuilding attachments', () => {
    const contentParts = [
      { type: 'text' as const, text: 'explicit' },
      { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,OLD' } },
    ];
    const llm = toLLMMessages([
      makeMessage({
        id: 'u1',
        role: 'user',
        content: 'see image',
        contentParts,
        attachments: [
          {
            id: 'att-1',
            type: 'image',
            filename: 'screen.png',
            mimeType: 'image/png',
            sizeBytes: 3,
            content: 'ftp://example.com/ignored.png',
          },
        ],
      }),
    ]);
    const user = llm.find((m) => m.role === 'user');
    expect(user?.content).toEqual(contentParts);
    expect(user?.contentBlocks).toBeUndefined();
  });
});

describe('toLLMMessages — aborted assistant message leakage', () => {
  // Cancellation invariant pin (Hermes #6 follow-up).
  //
  // When streaming aborts, `chat-stream-round.ts` has already written
  // the partial accumulator into the last assistant message. Before
  // the fix in `chat-round-loop.ts:markPartialAssistantInvisibleOnAbort`,
  // nothing on the abort path finalized that message — the partial
  // (potentially a half-emitted tool call) would ride forward as
  // assistant history on the next send because the wire-rebuild path
  // (`toLLMMessages`) doesn't filter on `status`. The fix flips
  // `visibleToModel: false` on the partial so `filterVisibleStage`
  // in `lib/context-transformer.ts` drops it from the LLM prefix.
  //
  // This test pins that contract end-to-end: a streaming-status
  // assistant message marked `visibleToModel: false` does not reach
  // wire history. The "control" test below pins that a fully-
  // finalized message (`status: 'done'` with default visibility)
  // still rides forward — guarding against an over-eager filter.

  function makeMessage(partial: Partial<ChatMessage>): ChatMessage {
    return {
      id: partial.id ?? 'm',
      role: partial.role ?? 'user',
      content: partial.content ?? '',
      timestamp: partial.timestamp ?? 0,
      ...partial,
    };
  }

  const PARTIAL_TOOL_CALL =
    'Working on it…\n\n```json\n{"tool": "sandbox_exec", "args": {"command": "';

  it('does not forward partial tool-call content from an aborted streaming assistant turn', () => {
    // History: user asks, model starts emitting a tool call, user
    // aborts. The abort path (markPartialAssistantInvisibleOnAbort)
    // flips the partial assistant message to `status: 'done'` +
    // `visibleToModel: false`. The user then sends a new message.
    // toLLMMessages must drop the partial via filterVisibleStage.
    const messages: ChatMessage[] = [
      makeMessage({ id: 'u1', role: 'user', content: 'Run a command.' }),
      makeMessage({
        id: 'a1',
        role: 'assistant',
        content: PARTIAL_TOOL_CALL,
        status: 'done',
        visibleToModel: false,
      }),
      makeMessage({ id: 'u2', role: 'user', content: 'Actually nevermind, summarize instead.' }),
    ];

    const llm = toLLMMessages(messages, { providerType: 'zen', providerModel: 'minimax-m2.7' });

    // Concatenate every assistant message's text content and assert
    // the partial tool-call signature didn't survive. The
    // filterVisibleStage in lib/context-transformer.ts drops the
    // partial because of visibleToModel:false set by the abort
    // helper in chat-round-loop.ts.
    const assistantContent = llm
      .filter((m) => m.role === 'assistant')
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');
    expect(assistantContent).not.toContain('sandbox_exec');
    expect(assistantContent).not.toContain('```json');
  });

  it('forwards a fully-finalized assistant turn unchanged (control)', () => {
    // Counterpart to the failing test above — a completed assistant
    // turn (`status: 'done'`) SHOULD ride forward as history. Pins
    // that any future status-based filter doesn't over-filter and
    // drop legitimate assistant context.
    const messages: ChatMessage[] = [
      makeMessage({ id: 'u1', role: 'user', content: 'What is 2+2?' }),
      makeMessage({
        id: 'a1',
        role: 'assistant',
        content: 'Four.',
        status: 'done',
      }),
      makeMessage({ id: 'u2', role: 'user', content: 'Add another.' }),
    ];
    const llm = toLLMMessages(messages, { providerType: 'zen', providerModel: 'minimax-m2.7' });
    const assistant = llm.find((m) => m.role === 'assistant');
    expect(assistant?.content).toContain('Four');
  });
});

describe('toLLMMessages — kernel contentParts pass-through (#937)', () => {
  function makeMessage(partial: Partial<ChatMessage>): ChatMessage {
    return {
      id: partial.id ?? 'm',
      role: partial.role ?? 'user',
      content: partial.content ?? '',
      timestamp: partial.timestamp ?? 0,
      ...partial,
    };
  }

  it('forwards pre-converted contentParts as multipart content (kernel image turn)', () => {
    // The Coder kernel sets `contentParts` (with no `attachments`); the
    // serializer must send it verbatim, not fall back to the text preamble.
    const messages: ChatMessage[] = [
      makeMessage({
        id: 'u1',
        role: 'user',
        content: 'Task: describe this screenshot',
        contentParts: [
          { type: 'text', text: 'Task: describe this screenshot' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } },
        ],
      }),
    ];
    const llm = toLLMMessages(messages, { providerType: 'zen', providerModel: 'minimax-m2.7' });
    const user = llm.find((m) => m.role === 'user');
    expect(Array.isArray(user?.content)).toBe(true);
    expect(user?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,abc123' },
        }),
      ]),
    );
  });

  it('leaves a plain text turn as a string (no regression)', () => {
    const messages: ChatMessage[] = [makeMessage({ id: 'u1', role: 'user', content: 'hello' })];
    const llm = toLLMMessages(messages, { providerType: 'zen', providerModel: 'minimax-m2.7' });
    expect(llm.find((m) => m.role === 'user')?.content).toBe('hello');
  });
});

describe('toLLMMessages — structured tool contentBlocks', () => {
  function makeMessage(partial: Partial<ChatMessage>): ChatMessage {
    return {
      id: partial.id ?? 'm',
      role: partial.role ?? 'user',
      content: partial.content ?? '',
      timestamp: partial.timestamp ?? 0,
      ...partial,
    };
  }

  const toolUse = {
    type: 'tool_use' as const,
    id: 'toolu_read_1',
    name: 'read_file',
    input: { path: 'README.md' },
  };
  const toolResult = {
    type: 'tool_result' as const,
    tool_use_id: toolUse.id,
    content: '[meta] round=1\nfile body',
  };

  it('emits paired tool sidecars as contentBlocks for neutral routes', () => {
    const llm = toLLMMessages(
      [
        makeMessage({ id: 'u1', role: 'user', content: 'read the file' }),
        makeMessage({
          id: 'a1',
          role: 'assistant',
          content: '```json\n{"tool":"read_file","args":{"path":"README.md"}}\n```',
          reasoningBlocks: [{ type: 'thinking', text: 'need context', signature: 'sig' }],
          toolUses: [toolUse],
        }),
        makeMessage({
          id: 'r1',
          role: 'user',
          content: '[TOOL_RESULT] file body [/TOOL_RESULT]',
          isToolResult: true,
          toolResults: [toolResult],
        }),
      ],
      { providerType: 'anthropic', providerModel: 'claude-sonnet-4.6', emitContentBlocks: true },
    );

    const assistant = llm.find((m) => m.role === 'assistant');
    const result = llm.find(
      (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('file body'),
    );
    expect(assistant?.content).toContain('read_file');
    expect(assistant?.contentBlocks).toEqual([
      { type: 'thinking', text: 'need context', signature: 'sig' },
      { ...toolUse, cache_control: { type: 'ephemeral' } },
    ]);
    expect(result?.contentBlocks).toEqual([
      { ...toolResult, cache_control: { type: 'ephemeral' } },
    ]);
    expect(toolUse).not.toHaveProperty('cache_control');
    expect(toolResult).not.toHaveProperty('cache_control');
  });

  it('keeps strict OpenAI-shaped routes free of the Push-private contentBlocks field', () => {
    const llm = toLLMMessages(
      [
        makeMessage({
          id: 'a1',
          role: 'assistant',
          content: '```json\n{"tool":"read_file","args":{"path":"README.md"}}\n```',
          toolUses: [toolUse],
        }),
        makeMessage({
          id: 'r1',
          role: 'user',
          content: '[TOOL_RESULT] file body [/TOOL_RESULT]',
          isToolResult: true,
          toolResults: [toolResult],
        }),
      ],
      { providerType: 'openai', providerModel: 'gpt-5.1' },
    );

    expect(llm.some((m) => m.contentBlocks && m.contentBlocks.length > 0)).toBe(false);
  });

  it('falls back to text when a tool_result lacks a matching tool_use sidecar', () => {
    const llm = toLLMMessages(
      [
        makeMessage({
          id: 'r1',
          role: 'user',
          content: '[TOOL_RESULT] orphan body [/TOOL_RESULT]',
          isToolResult: true,
          toolResults: [{ type: 'tool_result', tool_use_id: 'missing', content: 'orphan body' }],
        }),
      ],
      { providerType: 'google', providerModel: 'gemini-3-pro', emitContentBlocks: true },
    );

    const result = llm.find((m) => m.role === 'user');
    expect(result?.content).toContain('[TOOL_RESULT]');
    expect(result?.contentBlocks).toBeUndefined();
  });
});

describe('chat-mode web-search gating', () => {
  function buildChatMessages(): ChatMessage[] {
    return [{ id: 'u1', role: 'user', content: 'hi', timestamp: 0 } as unknown as ChatMessage];
  }

  it('keeps the "You have one tool: web_search" hint in the environment when mode is auto', () => {
    webSearchModeForTest = 'auto';
    const llm = toLLMMessages(buildChatMessages(), {
      workspaceContext: {
        description:
          'You are in chat mode — a plain conversation with no repository context and no sandbox.' +
          ' You have one tool: web_search, for looking up current information when the user asks about fresh topics, recent releases, or real-time facts.' +
          ' Focus on being a helpful conversational partner: answer questions, brainstorm ideas, explain concepts, and think through problems together.',
        includeGitHubTools: false,
        mode: 'chat',
      },
    });
    const system = llm.find((m) => m.role === 'system');
    expect(system?.content).toContain('You have one tool: web_search');
  });

  it('overrides the chat-mode description to drop the web_search hint when mode is off', () => {
    webSearchModeForTest = 'off';
    try {
      const llm = toLLMMessages(buildChatMessages(), {
        workspaceContext: {
          description:
            'You are in chat mode — a plain conversation with no repository context and no sandbox.' +
            ' You have one tool: web_search, for looking up current information when the user asks about fresh topics, recent releases, or real-time facts.' +
            ' Focus on being a helpful conversational partner: answer questions, brainstorm ideas, explain concepts, and think through problems together.',
          includeGitHubTools: false,
          mode: 'chat',
        },
      });
      const system = llm.find((m) => m.role === 'system');
      expect(system?.content).not.toContain('You have one tool: web_search');
      expect(system?.content).toContain('Web search is turned off; no tools are available');
    } finally {
      webSearchModeForTest = 'auto';
    }
  });
});

describe('toLLMMessages — GitHub tool protocol lands in the cached stable block', () => {
  function buildMessages(): ChatMessage[] {
    return [{ id: 'u1', role: 'user', content: 'hi', timestamp: 0 } as unknown as ChatMessage];
  }

  it('puts the GitHub protocol in the cache_control stable block, not the volatile tail', () => {
    const llm = toLLMMessages(buildMessages(), {
      providerType: 'anthropic',
      providerModel: 'claude-sonnet-4-6',
      workspaceContext: {
        // Genuinely-volatile workspace status that changes between turns.
        description: 'Repo: acme/widgets\nBranch: main\nDirty files: 3',
        includeGitHubTools: true,
        mode: 'repo',
      },
    });
    const system = llm.find((m) => m.role === 'system');
    // Cacheable provider → system content is the two-block split.
    expect(Array.isArray(system?.content)).toBe(true);
    const blocks = system?.content as Array<{ text?: string; cache_control?: unknown }>;
    expect(blocks.length).toBe(2);
    const [stableBlock, volatileBlock] = blocks;
    // The stable block carries the cache breakpoint; the volatile tail does not.
    expect(stableBlock.cache_control).toEqual({ type: 'ephemeral' });
    expect(volatileBlock.cache_control).toBeUndefined();
    // The large, session-stable GitHub protocol is cached…
    const marker = TOOL_PROTOCOL.split('\n', 1)[0];
    expect(stableBlock.text).toContain(marker);
    // …while the per-turn dirty-file status rides the uncached tail.
    expect(volatileBlock.text).toContain('Dirty files: 3');
    expect(stableBlock.text).not.toContain('Dirty files: 3');
  });
});

describe('toLLMMessages — linked-library context injection (v2b)', () => {
  function buildChatMessages(): ChatMessage[] {
    return [{ id: 'u1', role: 'user', content: 'hi', timestamp: 0 } as unknown as ChatMessage];
  }

  it('injects linkedLibraryContent into the system message when provided', () => {
    const llm = toLLMMessages(buildChatMessages(), {
      workspaceContext: { description: 'chat mode', includeGitHubTools: false, mode: 'chat' },
      linkedLibraryContent:
        '# Linked libraries\n\n## Library: Project ZERO\n\n[Files]\n\nFile: timeline.md\n```\n# Timeline\n```',
    });
    const system = llm.find((m) => m.role === 'system');
    // System content may be plain string (most providers) or a
    // structured array (Anthropic with cache_control). Normalise to a
    // single string for the substring check.
    const text =
      typeof system?.content === 'string'
        ? system.content
        : Array.isArray(system?.content)
          ? system.content.map((part) => ('text' in part ? part.text : '')).join('')
          : '';
    expect(text).toContain('# Linked libraries');
    expect(text).toContain('Project ZERO');
    expect(text).toContain('timeline.md');
  });

  it('does not include the library_context section when linkedLibraryContent is undefined', () => {
    const llm = toLLMMessages(buildChatMessages(), {
      workspaceContext: { description: 'chat mode', includeGitHubTools: false, mode: 'chat' },
    });
    const system = llm.find((m) => m.role === 'system');
    const text =
      typeof system?.content === 'string'
        ? system.content
        : Array.isArray(system?.content)
          ? system.content.map((part) => ('text' in part ? part.text : '')).join('')
          : '';
    expect(text).not.toContain('# Linked libraries');
  });

  it('does not include the library_context section when linkedLibraryContent is empty string', () => {
    const llm = toLLMMessages(buildChatMessages(), {
      workspaceContext: { description: 'chat mode', includeGitHubTools: false, mode: 'chat' },
      linkedLibraryContent: '',
    });
    const system = llm.find((m) => m.role === 'system');
    const text =
      typeof system?.content === 'string'
        ? system.content
        : Array.isArray(system?.content)
          ? system.content.map((part) => ('text' in part ? part.text : '')).join('')
          : '';
    expect(text).not.toContain('# Linked libraries');
  });
});
