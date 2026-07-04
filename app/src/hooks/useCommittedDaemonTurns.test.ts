import { describe, expect, it } from 'vitest';
import { appendDaemonTurn } from './useCommittedDaemonTurns';
import type { ChatMessage } from '@/types';

function msg(id: string, role: ChatMessage['role'] = 'assistant'): ChatMessage {
  return { id, role, content: id, timestamp: 0, status: 'done' };
}

describe('appendDaemonTurn', () => {
  it('appends the user/assistant pair in order', () => {
    const user = msg('u1', 'user');
    const assistant = msg('a1', 'assistant');
    expect(appendDaemonTurn([], user, assistant)).toEqual([user, assistant]);
  });

  it('accumulates across multiple calls', () => {
    const first = appendDaemonTurn([], msg('u1', 'user'), msg('a1'));
    const second = appendDaemonTurn(first, msg('u2', 'user'), msg('a2'));
    expect(second.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
  });

  it('is a no-op when the assistant id was already committed', () => {
    const assistant = msg('a1');
    const first = appendDaemonTurn([], msg('u1', 'user'), assistant);
    const second = appendDaemonTurn(first, msg('u1', 'user'), assistant);
    expect(second).toBe(first);
  });
});
