import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChatMessage } from '@/types';
import type { PushStreamEvent } from '@push/lib/provider-contract';

// --- Mock the two web-module seams; exercise the real engine end-to-end ----

let streamEvents: PushStreamEvent[] = [];
let lastSpanText: string | null = null;
vi.mock('@/lib/orchestrator', () => ({
  // A fake provider stream that replays `streamEvents` and records the span
  // text it was asked to summarize (so tests can assert what was sent).
  getProviderPushStream: () =>
    async function* (req: { messages: { content: string }[] }) {
      lastSpanText = req.messages[0]?.content ?? null;
      for (const e of streamEvents) yield e;
    },
}));

vi.mock('@/lib/orchestrator-context', () => ({
  // Char-length estimators keep the math trivial and deterministic.
  estimateContextTokens: (msgs: { content: string }[]) =>
    msgs.reduce((s, m) => s + (m.content?.length ?? 0), 0),
  estimateMessageTokens: (m: { content: string }) => m.content?.length ?? 0,
  // handoffTokens is the live trigger now (split from summarizeTokens). Keep the
  // two DIFFERENT so this suite pins that the coordinator reads handoffTokens, not
  // summarizeTokens: the conversation totals ~11.4k tokens, so a regression back to
  // summarizeTokens (50k, above the total) would stop triggering and fail the suite.
  getContextBudget: () => ({
    maxTokens: 12000,
    targetTokens: 10000,
    summarizeTokens: 50_000,
    handoffTokens: 5000,
  }),
}));

import { maybeCompactBeforeTurn } from './chat-compaction';
import { isHandoffBlock } from '@push/lib/llm-compaction';
import { createInMemoryVerbatimLog, setDefaultVerbatimLog } from '@push/lib/verbatim-log';
import { COMPACTION_DEGRADATION_THRESHOLD } from '@/lib/chat-message';

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
  lastSpanText = null;
  // Span retention logs its skip/store branches to stderr; keep output quiet.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
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

    // A UI compaction divider was inserted, stamped as the 1st compaction (no
    // degradation nudge yet — that needs "multiple compactions").
    const marker = out.find((x) => x.kind === 'compaction');
    expect(marker).toBeDefined();
    expect(marker?.compactionMeta?.compactionCount).toBe(1);

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

  it('stamps an increasing compaction ordinal so the UI surfaces the degradation nudge', async () => {
    // A prior compaction already happened: its `compaction` marker persists
    // (visibleToModel:false), so a real second compaction finds it in apiMessages.
    const { ctx } = makeCtx();
    const priorMarker = m('prev-marker', 'assistant', '', {
      kind: 'compaction',
      visibleToModel: false,
      compactionMeta: {
        beforeTokens: 90,
        afterTokens: 40,
        phase: 'summarization',
        messagesDropped: 3,
        compactionCount: 1,
      },
    });
    const apiMessages = [
      m('u0', 'user', 'GOAL: build the thing'),
      priorMarker,
      ...bigSpan(),
      m('t1', 'user', 'recent question that must survive'),
    ];

    const out = await maybeCompactBeforeTurn(ctx, {
      apiMessages,
      provider: 'anthropic',
      model: 'claude-x',
    });

    // The new marker is the 2nd compaction → crosses the degradation threshold,
    // so MessageBubble renders the "multiple compactions / fresh branch" nudge.
    const markers = out.filter((x) => x.kind === 'compaction');
    expect(markers.length).toBe(2);
    const fresh = markers.find((x) => x.id !== 'prev-marker');
    expect(fresh?.compactionMeta?.compactionCount).toBe(2);
    expect(fresh?.compactionMeta?.compactionCount).toBeGreaterThanOrEqual(
      COMPACTION_DEGRADATION_THRESHOLD,
    );
  });

  it('partitions over only the model-visible subset on a second compaction', async () => {
    // Simulate a chat that already compacted once: a large hidden span (folded
    // by a prior compaction) plus a prior handoff, then a fresh over-budget
    // visible middle. The hidden raw turns must NOT be re-summarized, and the
    // token math must stay sane (no subtracting hidden tokens from a
    // visible-only `beforeTokens`, which previously produced negative afters).
    const { ctx, appendRunEvent } = makeCtx();
    const hiddenA = m('h1', 'assistant', 'OLD-A '.repeat(2000), { visibleToModel: false });
    const hiddenB = m('h2', 'user', 'OLD-B '.repeat(2000), { visibleToModel: false });
    const priorHandoff = m('ph', 'user', '[CONTEXT HANDOFF]\nearlier work\n[/CONTEXT HANDOFF]', {
      isToolResult: true,
      visibleToModel: true,
    });
    const apiMessages = [
      m('u0', 'user', 'GOAL: build the thing'),
      hiddenA,
      hiddenB,
      priorHandoff,
      ...bigSpan(),
      m('t1', 'user', 'recent question that must survive'),
    ];

    const out = await maybeCompactBeforeTurn(ctx, {
      apiMessages,
      provider: 'anthropic',
      model: 'claude-x',
    });

    // The already-hidden raw turns are untouched and were NOT sent to the
    // summarizer.
    expect(out.find((x) => x.id === 'h1')?.visibleToModel).toBe(false);
    expect(out.find((x) => x.id === 'h2')?.visibleToModel).toBe(false);
    expect(lastSpanText).not.toContain('OLD-A');
    expect(lastSpanText).not.toContain('OLD-B');

    // Token math is sane: after < before and strictly positive (the prior bug
    // subtracted hidden tokens from a visible-only before-count → negative).
    const evt = appendRunEvent.mock.calls.find(
      (c) => (c[1] as { type: string }).type === 'context.compaction',
    )?.[1] as { beforeTokens: number; afterTokens: number };
    expect(evt.afterTokens).toBeGreaterThan(0);
    expect(evt.afterTokens).toBeLessThan(evt.beforeTokens);
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

  it('retains the raw span in the verbatim log and embeds a recall ref in the handoff', async () => {
    const verbatimLog = createInMemoryVerbatimLog();
    setDefaultVerbatimLog(verbatimLog);
    try {
      const { ctx, state } = makeCtx();
      (ctx as { runtimeContext?: unknown }).runtimeContext = {
        memory: { scope: { repoFullName: 'owner/repo', branch: 'main', chatId: 'c1' } },
      };
      state.conversations.c1.messages = conversation();

      const out = await maybeCompactBeforeTurn(ctx, {
        apiMessages: conversation(),
        provider: 'anthropic',
        model: 'claude-x',
      });

      const handoff = out.find((x) => isHandoffBlock(x.content));
      const refMatch = String(handoff?.content ?? '').match(/memory_expand refs=\["(vb_[^"]+)"\]/);
      expect(refMatch).toBeTruthy();
      // The retained entry is the exact rendered span the summarizer received
      // (its user message wraps it in a "span to compact" preamble), scope-
      // guarded to the repo+chat and tagged with the compaction provenance kind.
      // branch is deliberately omitted so the recall ref survives a branch
      // switch (the chat carries across branches; a branch-stamped entry would
      // stop resolving after switch_branch).
      const entry = await verbatimLog.read(refMatch![1]);
      expect(entry?.text).toMatch(/^### ASSISTANT\n/);
      expect(lastSpanText).toContain(entry?.text);
      expect(entry?.kind).toBe('compacted_span');
      expect(entry?.scope).toEqual({ repoFullName: 'owner/repo', chatId: 'c1' });
    } finally {
      setDefaultVerbatimLog(null); // reset the lazy process default for other suites
    }
  });

  it('omits the recall line when no repo scope is available (scratch chat)', async () => {
    // makeCtx carries no runtimeContext → retention skips, compaction still lands.
    const { ctx, state } = makeCtx();
    state.conversations.c1.messages = conversation();
    const out = await maybeCompactBeforeTurn(ctx, {
      apiMessages: conversation(),
      provider: 'anthropic',
      model: 'claude-x',
    });
    const handoff = out.find((x) => isHandoffBlock(x.content));
    expect(handoff).toBeDefined();
    expect(String(handoff?.content ?? '')).not.toContain('memory_expand');
  });
});
