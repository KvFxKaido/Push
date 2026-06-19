import { describe, it, expect } from 'vitest';
import type { ChatCard, ChatMessage } from '@/types';
import {
  groupChatMessages,
  buildSummaryLine,
  isPendingActionCard,
  collectPendingActionCards,
  type ToolCallPair,
} from './tool-call-utils';

function textMsg(id: string, content: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    content,
    timestamp: Date.now(),
    status: 'done',
  };
}

function toolCallMsg(id: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    status: 'done',
    isToolCall: true,
    toolMeta: {
      toolName: 'sandbox_exec',
      source: 'assistant',
      durationMs: 120,
      triggeredBy: 'assistant',
    },
  };
}

function toolResultMsg(id: string, toolName = 'sandbox_exec'): ChatMessage {
  return {
    id,
    role: 'user',
    content: '[TOOL_RESULT] ok',
    timestamp: Date.now(),
    status: 'done',
    isToolResult: true,
    toolMeta: {
      toolName,
      source: 'assistant',
      durationMs: 120,
      triggeredBy: 'assistant',
    },
  };
}

/* ------------------------------------------------------------------ */
/*  groupChatMessages                                                 */
/* ------------------------------------------------------------------ */

describe('groupChatMessages', () => {
  it('passes plain text messages through unchanged', () => {
    const msgs = [textMsg('a', 'Hello'), textMsg('b', 'World')];
    const out = groupChatMessages(msgs);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ type: 'text', message: msgs[0] });
    expect(out[1]).toMatchObject({ type: 'text', message: msgs[1] });
  });

  it('groups a single tool-call + result pair', () => {
    const msgs = [toolCallMsg('tc1'), toolResultMsg('tr1')];
    const out = groupChatMessages(msgs);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'toolGroup' });
    const group = out[0] as { type: 'toolGroup'; items: ToolCallPair[] };
    expect(group.items).toHaveLength(1);
    expect(group.items[0].callMsg.id).toBe('tc1');
    expect(group.items[0].resultMsg.id).toBe('tr1');
  });

  it('groups multiple consecutive tool-call pairs', () => {
    const msgs = [
      toolCallMsg('tc1'),
      toolResultMsg('tr1', 'read_file'),
      toolCallMsg('tc2'),
      toolResultMsg('tr2', 'sandbox_exec'),
    ];
    const out = groupChatMessages(msgs);
    expect(out).toHaveLength(1);
    const group = out[0] as { type: 'toolGroup'; items: ToolCallPair[] };
    expect(group.items).toHaveLength(2);
  });

  it('separates text before and after tool group', () => {
    const msgs = [
      textMsg('a', 'Before'),
      toolCallMsg('tc1'),
      toolResultMsg('tr1'),
      textMsg('b', 'After'),
    ];
    const out = groupChatMessages(msgs);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ type: 'text' });
    expect(out[1]).toMatchObject({ type: 'toolGroup' });
    expect(out[2]).toMatchObject({ type: 'text' });
  });

  it('drops orphan tool results', () => {
    const msgs = [textMsg('a', 'Hi'), toolResultMsg('orphan')];
    const out = groupChatMessages(msgs);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'text' });
  });
});

/* ------------------------------------------------------------------ */
/*  buildSummaryLine                                                  */
/* ------------------------------------------------------------------ */

describe('buildSummaryLine', () => {
  it('summarises a single command as "Ran a command"', () => {
    const items: ToolCallPair[] = [
      { callMsg: toolCallMsg('1'), resultMsg: toolResultMsg('1', 'sandbox_exec') },
    ];
    expect(buildSummaryLine(items)).toBe('Ran a command');
  });

  it('uses the captured target for a single call: "Ran npm test"', () => {
    const call = toolCallMsg('1');
    call.toolMeta = { ...call.toolMeta!, target: 'npm test' };
    const items: ToolCallPair[] = [
      { callMsg: call, resultMsg: toolResultMsg('1', 'sandbox_exec') },
    ];
    expect(buildSummaryLine(items)).toBe('Ran npm test');
  });

  it('reads the target off the result message too', () => {
    const result = toolResultMsg('1', 'read_file');
    result.toolMeta = { ...result.toolMeta!, target: 'config.json' };
    const items: ToolCallPair[] = [{ callMsg: toolCallMsg('1'), resultMsg: result }];
    expect(buildSummaryLine(items)).toBe('Read config.json');
  });

  it('falls back to the noun form when a single call has no target', () => {
    const items: ToolCallPair[] = [
      { callMsg: toolCallMsg('1'), resultMsg: toolResultMsg('1', 'sandbox_exec') },
    ];
    expect(buildSummaryLine(items)).toBe('Ran a command');
  });

  it('ignores the target for batches (keeps the aggregated count form)', () => {
    const items: ToolCallPair[] = Array.from({ length: 2 }, (_, i) => {
      const call = toolCallMsg(`c${i}`);
      call.toolMeta = { ...call.toolMeta!, toolName: 'read_file', target: `file${i}.ts` };
      return { callMsg: call, resultMsg: toolResultMsg(`r${i}`, 'read_file') };
    });
    expect(buildSummaryLine(items)).toBe('Read 2 files');
  });

  it('summarises 3 files as "Read 3 files"', () => {
    const items: ToolCallPair[] = Array.from({ length: 3 }, (_, i) => ({
      callMsg: toolCallMsg(`c${i}`),
      resultMsg: toolResultMsg(`r${i}`, 'read_file'),
    }));
    expect(buildSummaryLine(items)).toBe('Read 3 files');
  });

  it('summarises mixed tools', () => {
    const items: ToolCallPair[] = [
      { callMsg: toolCallMsg('1'), resultMsg: toolResultMsg('1', 'sandbox_exec') },
      { callMsg: toolCallMsg('2'), resultMsg: toolResultMsg('2', 'read_file') },
      { callMsg: toolCallMsg('3'), resultMsg: toolResultMsg('3', 'read_file') },
    ];
    const line = buildSummaryLine(items);
    expect(line).toContain('Ran 1 command');
    expect(line).toContain('Read 2 files');
    expect(line).toContain(',');
  });
});

/* ------------------------------------------------------------------ */
/*  Pending-action cards (hoisted out of collapsed groups)             */
/* ------------------------------------------------------------------ */

const askCard = (responseText?: string): ChatCard =>
  ({
    type: 'ask-user',
    data: { question: 'Pick one', options: [{ id: 'a', label: 'A' }], responseText },
  }) as ChatCard;

const commitCard = (status: string): ChatCard =>
  ({
    type: 'commit-review',
    data: {
      diff: { diff: '', filesChanged: 0, additions: 0, deletions: 0, truncated: false },
      auditVerdict: { verdict: 'safe', summary: '', risks: [], filesReviewed: 0 },
      commitMessage: 'feat: thing',
      status,
    },
  }) as ChatCard;

describe('isPendingActionCard', () => {
  it('treats an unanswered ask-user card as pending', () => {
    expect(isPendingActionCard(askCard())).toBe(true);
    expect(isPendingActionCard(askCard('   '))).toBe(true);
  });

  it('treats an answered ask-user card as resolved', () => {
    expect(isPendingActionCard(askCard('Option A'))).toBe(false);
  });

  it('treats commit-review as pending until it reaches a terminal state', () => {
    for (const status of ['pending', 'refreshing', 'approved', 'pushing', 'error']) {
      expect(isPendingActionCard(commitCard(status))).toBe(true);
    }
    expect(isPendingActionCard(commitCard('committed'))).toBe(false);
    expect(isPendingActionCard(commitCard('rejected'))).toBe(false);
  });

  it('ignores non-action cards', () => {
    expect(isPendingActionCard({ type: 'file', data: {} } as ChatCard)).toBe(false);
  });
});

describe('collectPendingActionCards', () => {
  it('hoists pending cards with their original message id + card index', () => {
    const callMsg: ChatMessage = {
      ...toolCallMsg('tc1'),
      // [resolved ask, pending commit] — index 1 must survive the filter.
      cards: [askCard('done'), commitCard('pending')],
    };
    const items: ToolCallPair[] = [{ callMsg, resultMsg: toolResultMsg('tr1') }];

    const hoisted = collectPendingActionCards(items);
    expect(hoisted).toHaveLength(1);
    expect(hoisted[0]).toMatchObject({ messageId: 'tc1', cardIndex: 1 });
    expect(hoisted[0].card.type).toBe('commit-review');
  });

  it('returns nothing when every card is resolved', () => {
    const callMsg: ChatMessage = {
      ...toolCallMsg('tc1'),
      cards: [askCard('answered'), commitCard('committed')],
    };
    expect(collectPendingActionCards([{ callMsg, resultMsg: toolResultMsg('tr1') }])).toHaveLength(
      0,
    );
  });
});
