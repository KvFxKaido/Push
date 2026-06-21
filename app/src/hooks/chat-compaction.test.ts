import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatMessage } from '@/types';
import type { PushStreamEvent } from '@push/lib/provider-contract';

// --- Mock the two web-module seams; exercise the real engine end-to-end ----

let streamEvents: PushStreamEvent[] = [];
vi.mock('@/lib/orchestrator', () => ({
  // A fake provider stream that replays `streamEvents`.
  getProviderPushStream: () =>
    async function* () {
      for (const e of streamEvents) yield e;
    },
}));

vi.mock('@/lib/orchestrator-context', () => ({
  // Char-length estimators keep the math trivial and deterministic.
  estimateContextTokens: (msgs: { content: string }[]) =>
    msgs.reduce((s, m) => s + (m.content?.length ?? 0), 0),
  estimateMessageTokens: (m: { content: string }) => m.content?.length ?? 0,
  getContextBudget: () => ({ maxTokens: 12000, targetTokens: 10000, summarizeTokens: 5000 }),
}));

import { maybeCompactBeforeTurn } from './chat-compaction';
import { isHandoffBlock } from '@push/lib/llm-compaction';

const m = (
  id: string,
  role: ChatMessage['role'],
  content: string,
  extra?: Partial<ChatMessage>,
): ChatMessage => ({
  id,
  role,
  content,
  timestamp: 0,
  status: 'done',
  ...extra,
});

function makeCtx() {
  const state: { conversations: Record<string, { messages: ChatMessage[] }> } = {
    conversations: { c1: { messages: [] } },
  };
  const updateAgentStatus = vi.fn();
  const appendRunEvent = vi.fn();
  const setConversations = vi.fn(
    (updater: (prev: typeof state.conversations) => typeof state.conversations) => {
      state.conversations = updater(state.conversations);
    },
  );
  const ctx = {
    chatId: 'c1',
    abortRef: { current: false },
    updateAgentStatus,
    appendRunEvent,
    setConversations,
    dirtyConversationIdsRef: { current: new Set<string>() },
  } as unknown as Parameters<typeof maybeCompactBeforeTurn>[0];
  return { ctx, state, updateAgentStatus, appendRunEvent, setConversations };
}

const bigSpan = () => [
  m('s1', 'assistant', 'a'.repeat(3000)),
  m('s2', 'user', 'r'.repeat(3000), { isToolResult: true }),
  m('s3', 'assistant', 'b'.repeat(3000)),
];

const conversation = (): ChatMessage[] => [
  m('u0', 'user', 'GOAL: build the thing'),
  ...bigSpan(),
  m('t1', 'user', 'recent question '.repeat(150)), // ~2400 char tail
];

beforeEach(() => {
  streamEvents = [
    { type: 'text_delta', text: 'Goal: build the thing. ' },
    { type: 'text_delta', text: 'Did A and B. Next: C.' },
    { type: 'done' },
  ] as PushStreamEvent[];
});

describe('maybeCompactBeforeTurn', () => {
  it('summarizes the middle span, hides it from the wire, and inserts a handoff + marker', async () => {
    const { ctx, state, updateAgentStatus, appendRunEvent } = makeCtx();
    state.conversations.c1.messages = conversation();
    const apiMessages = conversation();

    const out = await maybeCompactBeforeTurn(ctx, {
      apiMessages,
      provider: 'anthropic',
      model: 'claude-x',
    });

    // Status pill fired.
    expect(updateAgentStatus).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'Compacting context…' }),
      expect.objectContaining({ chatId: 'c1' }),
    );

    // The span (s1..s3) is now hidden from the model. The UI compaction
    // divider is also visibleToModel:false (it's transcript-only) — exclude it.
    const hidden = out
      .filter((x) => x.visibleToModel === false && x.kind !== 'compaction')
      .map((x) => x.id);
    expect(hidden).toEqual(['s1', 's2', 's3']);

    // A model-visible handoff message was inserted.
    const handoff = out.find((x) => isHandoffBlock(x.content));
    expect(handoff).toBeDefined();
    expect(handoff?.isToolResult).toBe(true);
    expect(handoff?.visibleToModel).toBe(true);
    expect(handoff?.content).toContain('Did A and B');

    // A UI compaction divider was inserted.
    expect(out.some((x) => x.kind === 'compaction')).toBe(true);

    // The durable transcript was mutated identically and a run event fired.
    expect(state.conversations.c1.messages.some((x) => x.kind === 'compaction')).toBe(true);
    expect(appendRunEvent).toHaveBeenCalledWith(
      'c1',
      expect.objectContaining({ type: 'context.compaction', phase: 'summarization' }),
    );
    // The goal and the recent tail survive verbatim and model-visible.
    expect(out.find((x) => x.id === 'u0')?.visibleToModel).not.toBe(false);
    expect(out.find((x) => x.id === 't1')?.visibleToModel).not.toBe(false);
  });

  it('is a no-op when the working set is under the trigger', async () => {
    const { ctx, appendRunEvent } = makeCtx();
    const apiMessages = [m('u0', 'user', 'short'), m('a0', 'assistant', 'reply')];
    const out = await maybeCompactBeforeTurn(ctx, {
      apiMessages,
      provider: 'anthropic',
      model: 'claude-x',
    });
    expect(out).toBe(apiMessages);
    expect(appendRunEvent).not.toHaveBeenCalled();
  });

  it('fails soft (returns input unchanged) when the summarizer errors', async () => {
    const { ctx, appendRunEvent } = makeCtx();
    streamEvents = []; // empty stream → empty summary → treated as failure
    const apiMessages = conversation();
    const out = await maybeCompactBeforeTurn(ctx, {
      apiMessages,
      provider: 'anthropic',
      model: 'claude-x',
    });
    expect(out).toBe(apiMessages);
    expect(appendRunEvent).not.toHaveBeenCalled();
  });

  it('skips the model call entirely for the demo provider', async () => {
    const { ctx, updateAgentStatus } = makeCtx();
    const apiMessages = conversation();
    const out = await maybeCompactBeforeTurn(ctx, { apiMessages, provider: 'demo', model: 'demo' });
    expect(out).toBe(apiMessages);
    expect(updateAgentStatus).not.toHaveBeenCalled();
  });
});
