import { describe, expect, it } from 'vitest';
import { appendQueuedItem, clearQueuedItems, shiftQueuedItem } from './chat-queue';

describe('chat-queue helpers', () => {
  it('appends follow-ups in FIFO order per chat', () => {
    const first = appendQueuedItem({}, 'chat-1', 'one');
    const second = appendQueuedItem(first, 'chat-1', 'two');
    const third = appendQueuedItem(second, 'chat-2', 'other');

    expect(third).toEqual({
      'chat-1': ['one', 'two'],
      'chat-2': ['other'],
    });
  });

  it('shifts the next queued item and removes empty chat queues', () => {
    const existing = {
      'chat-1': ['one', 'two'],
      'chat-2': ['other'],
    };

    const first = shiftQueuedItem(existing, 'chat-1');
    expect(first.item).toBe('one');
    expect(first.next).toEqual({
      'chat-1': ['two'],
      'chat-2': ['other'],
    });

    const second = shiftQueuedItem(first.next, 'chat-1');
    expect(second.item).toBe('two');
    expect(second.next).toEqual({
      'chat-2': ['other'],
    });
  });

  it('clears a queued chat without touching others', () => {
    const existing = {
      'chat-1': ['one'],
      'chat-2': ['other'],
    };

    expect(clearQueuedItems(existing, 'chat-1')).toEqual({
      'chat-2': ['other'],
    });
  });
});
