import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@/lib/local-daemon-binding';
import type { ChatMessage } from '@/types';
import { projectTurnEvent } from './useRemoteTurnProjection';

function event(
  type: string,
  payload: Record<string, unknown> = {},
  runId: string | undefined = 'run_9',
): SessionEvent {
  return {
    v: 'push.runtime.v1',
    kind: 'event',
    sessionId: 'sess_1',
    seq: 0,
    ts: 1,
    type,
    payload,
    runId,
  } as SessionEvent;
}

describe('projectTurnEvent', () => {
  it('starts a streaming assistant message on the first token', () => {
    const next = projectTurnEvent(null, event('assistant_token', { text: 'Hel' }), 'run_9', 100);
    expect(next).toEqual({
      id: 'remote-run_9',
      role: 'assistant',
      content: 'Hel',
      timestamp: 100,
      status: 'streaming',
    });
  });

  it('accumulates subsequent tokens into the same message', () => {
    let msg: ChatMessage | null = null;
    msg = projectTurnEvent(msg, event('assistant_token', { text: 'Hel' }), 'run_9', 100);
    msg = projectTurnEvent(msg, event('assistant_token', { text: 'lo' }), 'run_9', 200);
    expect(msg?.content).toBe('Hello');
    expect(msg?.timestamp).toBe(100); // creation timestamp preserved
    expect(msg?.status).toBe('streaming');
  });

  it('finalizes the message on assistant_done', () => {
    const streaming = projectTurnEvent(
      null,
      event('assistant_token', { text: 'hi' }),
      'run_9',
      100,
    );
    const done = projectTurnEvent(
      streaming,
      event('assistant_done', { messageId: 'm1' }),
      'run_9',
      200,
    );
    expect(done?.status).toBe('done');
    expect(done?.content).toBe('hi');
  });

  it('finalizes on run_complete too', () => {
    const streaming = projectTurnEvent(
      null,
      event('assistant_token', { text: 'hi' }),
      'run_9',
      100,
    );
    const done = projectTurnEvent(
      streaming,
      event('run_complete', { outcome: 'ok' }),
      'run_9',
      200,
    );
    expect(done?.status).toBe('done');
  });

  it('ignores events from a different run', () => {
    const streaming = projectTurnEvent(
      null,
      event('assistant_token', { text: 'hi' }),
      'run_9',
      100,
    );
    const next = projectTurnEvent(
      streaming,
      event('assistant_token', { text: 'X' }, 'run_other'),
      'run_9',
      200,
    );
    expect(next).toBe(streaming); // unchanged
  });

  it('starts a fresh message when the active run changes', () => {
    const first = projectTurnEvent(null, event('assistant_token', { text: 'old' }), 'run_1', 100);
    const second = projectTurnEvent(
      first,
      event('assistant_token', { text: 'new' }, 'run_2'),
      'run_2',
      200,
    );
    expect(second).toEqual({
      id: 'remote-run_2',
      role: 'assistant',
      content: 'new',
      timestamp: 200,
      status: 'streaming',
    });
  });

  it('is inert when there is no active run', () => {
    expect(projectTurnEvent(null, event('assistant_token', { text: 'hi' }), null, 100)).toBeNull();
  });

  it('ignores non-text events and empty/non-string tokens', () => {
    const start = projectTurnEvent(null, event('assistant_token', { text: 'hi' }), 'run_9', 100);
    expect(projectTurnEvent(start, event('status', { phase: 'x' }), 'run_9', 200)).toBe(start);
    expect(projectTurnEvent(start, event('assistant_token', { text: '' }), 'run_9', 200)).toBe(
      start,
    );
    expect(projectTurnEvent(start, event('assistant_token', { text: 42 }), 'run_9', 200)).toBe(
      start,
    );
  });
});
