import { describe, expect, it } from 'vitest';
import {
  buildHandoffBlock,
  COMPACTION_HANDOFF_PREFIX,
  isHandoffBlock,
  partitionForLlmCompaction,
  renderSpanForSummary,
  resolveLlmCompactionPolicy,
  shouldRunLlmCompaction,
  summarizeContextViaModel,
  type CompactableMessage,
} from './llm-compaction.ts';
import type { LlmMessage, PushStream, PushStreamEvent } from './provider-contract.ts';

const msg = (
  role: CompactableMessage['role'],
  content: string,
  isToolResult = false,
): CompactableMessage => ({ role, content, isToolResult });

// 1 token per character — simple deterministic estimator for the tests.
const estimateMessageTokens = (m: CompactableMessage) => m.content.length;

describe('shouldRunLlmCompaction', () => {
  it('fires at or above the trigger', () => {
    expect(shouldRunLlmCompaction(100, { triggerTokens: 100 })).toBe(true);
    expect(shouldRunLlmCompaction(101, { triggerTokens: 100 })).toBe(true);
  });
  it('stays quiet below the trigger', () => {
    expect(shouldRunLlmCompaction(99, { triggerTokens: 100 })).toBe(false);
  });
});

describe('resolveLlmCompactionPolicy', () => {
  const budget = {
    summarizeTokens: 88_000,
    handoffTokens: 400_000,
  };

  it('uses patient handoff tokens for web', () => {
    const policy = resolveLlmCompactionPolicy({ surface: 'web', budget });
    expect(policy.triggerSource).toBe('handoffTokens');
    expect(policy.triggerTokens).toBe(400_000);
    expect(policy.preserveTailTokens).toBe(24_000);
    expect(policy.minSummarizeTokens).toBe(4_000);
  });

  it('uses eager summarize tokens for the bounded CLI lead preamble', () => {
    const policy = resolveLlmCompactionPolicy({ surface: 'cli-lead', budget });
    expect(policy.triggerSource).toBe('summarizeTokens');
    expect(policy.triggerTokens).toBe(88_000);
    expect(policy.preserveTailTokens).toBe(24_000);
  });

  it('derives tail preservation from the trigger before the cap applies', () => {
    const policy = resolveLlmCompactionPolicy({
      surface: 'web',
      budget: { summarizeTokens: 10_000, handoffTokens: 20_000 },
    });
    expect(policy.preserveTailTokens).toBe(8_000);
  });
});

describe('partitionForLlmCompaction', () => {
  const opts = { estimateMessageTokens, preserveTailTokens: 10, minSummarizeTokens: 10 };

  it('pins the first user turn, preserves the recent tail, summarizes the middle', () => {
    const messages = [
      msg('user', 'GOAL'.padEnd(20, 'g')), // head (first user turn)
      msg('assistant', 'a'.repeat(30)), // middle
      msg('user', 'r'.repeat(30), true), // middle (tool result)
      msg('assistant', 'b'.repeat(6)), // tail
      msg('user', 'c'.repeat(6)), // tail
    ];
    const out = partitionForLlmCompaction(messages, opts);
    expect(out.head).toHaveLength(1);
    expect(out.head[0].content.startsWith('GOAL')).toBe(true);
    expect(out.summarize).toHaveLength(2);
    expect(out.summarizeTokens).toBe(60);
    // Tail preserved by token budget (>= 10 tokens of most-recent turns).
    expect(out.tail.length).toBeGreaterThanOrEqual(1);
    expect(out.tail[out.tail.length - 1].content.startsWith('c')).toBe(true);
  });

  it('skips (empty summarize) when the eligible middle is below minSummarizeTokens', () => {
    const messages = [
      msg('user', 'goal'),
      msg('assistant', 'tiny'),
      msg('user', 'recent-tail-message'),
    ];
    const out = partitionForLlmCompaction(messages, {
      ...opts,
      minSummarizeTokens: 1000,
    });
    expect(out.summarize).toHaveLength(0);
    expect(out.summarizeTokens).toBe(0);
  });

  it('handles a history with no real user turn (head empty)', () => {
    const messages = [
      msg('assistant', 'a'.repeat(30)),
      msg('user', 'r'.repeat(30), true),
      msg('assistant', 'b'.repeat(20)),
    ];
    const out = partitionForLlmCompaction(messages, opts);
    expect(out.head).toHaveLength(0);
    expect(out.summarize.length).toBeGreaterThan(0);
  });
});

describe('renderSpanForSummary', () => {
  it('labels tool results distinctly from turns and is deterministic', () => {
    const span = [msg('assistant', 'did X'), msg('user', 'ls output', true)];
    const text = renderSpanForSummary(span);
    expect(text).toBe('### ASSISTANT\ndid X\n\n### TOOL_RESULT\nls output');
  });
});

describe('handoff block', () => {
  it('frames the summary and round-trips through isHandoffBlock', () => {
    const block = buildHandoffBlock('  Goal: ship it.  ');
    expect(block).toContain(COMPACTION_HANDOFF_PREFIX);
    expect(block).toContain('Goal: ship it.');
    expect(isHandoffBlock(block)).toBe(true);
    expect(isHandoffBlock('a normal assistant message')).toBe(false);
  });
});

// --- summarizeContextViaModel against a fake PushStream -------------------

function fakeStream(events: PushStreamEvent[]): PushStream<LlmMessage> {
  return async function* () {
    for (const e of events) yield e;
  };
}

function throwingStream(message: string): PushStream<LlmMessage> {
  return async function* () {
    throw new Error(message);
    // eslint-disable-next-line no-unreachable
    yield { type: 'done' } as PushStreamEvent;
  };
}

describe('summarizeContextViaModel', () => {
  const base = {
    provider: 'anthropic' as const,
    model: 'claude-x',
    spanText: '### ASSISTANT\ndid work',
  };

  it('returns the accumulated summary text on success', async () => {
    const stream = fakeStream([
      { type: 'text_delta', text: 'Goal: ' },
      { type: 'text_delta', text: 'resume.' },
      { type: 'done' },
    ] as PushStreamEvent[]);
    const out = await summarizeContextViaModel({ ...base, stream });
    expect(out.error).toBeNull();
    expect(out.summary).toBe('Goal: resume.');
  });

  it('surfaces an error and null summary when the stream throws', async () => {
    const out = await summarizeContextViaModel({
      ...base,
      stream: throwingStream('boom'),
    });
    expect(out.summary).toBeNull();
    expect(out.error).toBeInstanceOf(Error);
  });

  it('treats empty output as a failure (caller falls back to the heuristic)', async () => {
    const stream = fakeStream([{ type: 'done' }] as PushStreamEvent[]);
    const out = await summarizeContextViaModel({ ...base, stream });
    expect(out.summary).toBeNull();
    expect(out.error).toBeInstanceOf(Error);
  });
});
