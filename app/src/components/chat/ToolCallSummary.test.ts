import { describe, it, expect } from 'vitest';
import type { ChatMessage } from '@/types';
import { groupChatMessages } from './ChatContainer';
import { buildSummaryLine } from './ToolCallSummary';

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

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
    toolMeta: { toolName: 'sandbox_exec', source: 'assistant', durationMs: 120 },
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
    toolMeta: { toolName, source: 'assistant', durationMs: 120 },
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
    const group = out[0] as { type: 'toolGroup'; items: any[] };
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
    const group = out[0] as { type: 'toolGroup'; items: any[] };
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
    const items = [{ callMsg: toolCallMsg('1'), resultMsg: toolResultMsg('1', 'sandbox_exec') }];
    expect(buildSummaryLine(items)).toBe('Ran a command');
  });

  it('summarises 3 files as "Read 3 files"', () => {
    const items = Array.from({ length: 3 }, (_, i) => ({
      callMsg: toolCallMsg(`c${i}`),
      resultMsg: toolResultMsg(`r${i}`, 'read_file'),
    }));
    expect(buildSummaryLine(items)).toBe('Read 3 files');
  });

  it('summarises mixed tools', () => {
    const items = [
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
