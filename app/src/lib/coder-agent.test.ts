import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/types';
import { normalizeTrimmedRoleAlternation } from './coder-agent';

function msg(
  id: string,
  role: ChatMessage['role'],
  content: string,
  extras: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    role,
    content,
    timestamp: 1,
    ...extras,
  };
}

function hasConsecutiveUsers(messages: ChatMessage[]): boolean {
  for (let i = 1; i < messages.length; i++) {
    if (messages[i - 1].role === 'user' && messages[i].role === 'user') return true;
  }
  return false;
}

describe('normalizeTrimmedRoleAlternation', () => {
  it('drops boundary tool-result user messages', () => {
    const messages: ChatMessage[] = [
      msg('seed', 'user', 'Task: do work'),
      msg('tool', 'user', '[TOOL_RESULT] huge payload', { isToolResult: true }),
      msg('assistant', 'assistant', 'next round'),
    ];

    normalizeTrimmedRoleAlternation(messages, 4, () => 123);

    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('Task: do work');
    expect(messages[1].role).toBe('assistant');
  });

  it('inserts an assistant bridge instead of merging non-tool user content into seed', () => {
    const messages: ChatMessage[] = [
      msg('seed', 'user', 'Task: do work'),
      msg('checkpoint', 'user', '[CHECKPOINT RESPONSE] try B'),
      msg('assistant', 'assistant', 'continuing'),
    ];

    normalizeTrimmedRoleAlternation(messages, 7, () => 456);

    expect(messages[0].content).toBe('Task: do work');
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].content).toContain('[Context bridge]');
    expect(messages[2].role).toBe('user');
    expect(messages[2].content).toContain('[CHECKPOINT RESPONSE]');
    expect(hasConsecutiveUsers(messages)).toBe(false);
  });

  it('merges additional non-seed user runs after the bridge', () => {
    const messages: ChatMessage[] = [
      msg('seed', 'user', 'Task: do work'),
      msg('user-1', 'user', 'first user follow-up'),
      msg('user-2', 'user', 'second user follow-up'),
      msg('assistant', 'assistant', 'continuing'),
    ];

    normalizeTrimmedRoleAlternation(messages, 9, () => 789);

    expect(messages[0].role).toBe('user');
    expect(messages[1].role).toBe('assistant');
    expect(messages[2].role).toBe('user');
    expect(messages[3].role).toBe('assistant');
    expect(messages[2].content).toContain('first user follow-up');
    expect(messages[2].content).toContain('second user follow-up');
    expect(hasConsecutiveUsers(messages)).toBe(false);
  });

  it('drops tool-result users that appear after a bridged non-tool user', () => {
    const messages: ChatMessage[] = [
      msg('seed', 'user', 'Task: do work'),
      msg('user', 'user', 'checkpoint guidance'),
      msg('tool', 'user', '[TOOL_RESULT] payload', { isToolResult: true }),
      msg('assistant', 'assistant', 'continuing'),
    ];

    normalizeTrimmedRoleAlternation(messages, 11, () => 999);

    expect(messages.some((m) => m.isToolResult)).toBe(false);
    expect(messages[0].content).toBe('Task: do work');
    expect(hasConsecutiveUsers(messages)).toBe(false);
  });
});
