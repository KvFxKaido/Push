import { describe, expect, it } from 'vitest';
import { makePendingUserMessage, parseSendUserMessageRunId } from './useDaemonMessageDispatch';

describe('makePendingUserMessage', () => {
  it('builds a done user message stamped with the given time', () => {
    const msg = makePendingUserMessage('hello', 1000);
    expect(msg).toEqual({
      id: 'daemon-pending-1000',
      role: 'user',
      content: 'hello',
      timestamp: 1000,
      status: 'done',
    });
  });

  it('gives distinct ids for distinct timestamps', () => {
    expect(makePendingUserMessage('a', 1).id).not.toEqual(makePendingUserMessage('a', 2).id);
  });
});

describe('parseSendUserMessageRunId', () => {
  it('extracts a string runId from the payload', () => {
    expect(parseSendUserMessageRunId({ runId: 'run_123', accepted: true })).toBe('run_123');
  });

  it('returns null when runId is missing', () => {
    expect(parseSendUserMessageRunId({ accepted: true })).toBeNull();
  });

  it('returns null when runId is an empty string', () => {
    expect(parseSendUserMessageRunId({ runId: '' })).toBeNull();
  });

  it('returns null when runId is not a string', () => {
    expect(parseSendUserMessageRunId({ runId: 42 })).toBeNull();
  });

  it('returns null for a non-object payload', () => {
    expect(parseSendUserMessageRunId(null)).toBeNull();
    expect(parseSendUserMessageRunId(undefined)).toBeNull();
    expect(parseSendUserMessageRunId('run_123')).toBeNull();
  });
});
