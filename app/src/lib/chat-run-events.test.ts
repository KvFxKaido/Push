import { describe, expect, it } from 'vitest';
import type { RunEvent } from '@/types';
import { MAX_RUN_EVENTS_PER_CHAT, summarizeToolResultPreview, trimRunEvents } from './chat-run-events';

function makeRunEvent(id: number): RunEvent {
  return {
    id: `event-${id}`,
    timestamp: id,
    type: 'assistant.turn_start',
    round: id,
  };
}

describe('chat-run-events', () => {
  it('trims persisted run events to the newest entries', () => {
    const events = Array.from({ length: MAX_RUN_EVENTS_PER_CHAT + 2 }, (_, index) => makeRunEvent(index));

    const trimmed = trimRunEvents(events);

    expect(trimmed).toHaveLength(MAX_RUN_EVENTS_PER_CHAT);
    expect(trimmed[0]?.id).toBe('event-2');
    expect(trimmed.at(-1)?.id).toBe(`event-${MAX_RUN_EVENTS_PER_CHAT + 1}`);
  });

  it('builds compact previews from tool result text', () => {
    const preview = summarizeToolResultPreview(`
      [Tool Result — delegate_coder]

      Updated auth flow and added tests.
    `);

    expect(preview).toBe('Updated auth flow and added tests.');
  });
});
