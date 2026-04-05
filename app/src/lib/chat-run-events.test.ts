import { describe, expect, it } from 'vitest';
import type { RunEvent, RunEventInput } from '@/types';
import {
  mergeRunEventStreams,
  shouldPersistRunEvent,
  trimRunEvents,
  MAX_RUN_EVENTS_PER_CHAT,
} from './chat-run-events';

function makeRunEvent(
  overrides: Partial<Extract<RunEvent, { type: 'tool.execution_complete' }>> = {},
): Extract<RunEvent, { type: 'tool.execution_complete' }> {
  return {
    id: 'run-1',
    timestamp: 1,
    type: 'tool.execution_complete',
    round: 0,
    executionId: 'exec-1',
    toolName: 'Read file',
    toolSource: 'sandbox',
    durationMs: 12,
    isError: false,
    preview: 'Loaded file',
    ...overrides,
  };
}

describe('chat-run-events', () => {
  it('keeps live-only telemetry out of persisted run state', () => {
    const liveOnlyEvents: RunEventInput[] = [
      { type: 'assistant.turn_start', round: 0 },
      {
        type: 'tool.execution_start',
        round: 0,
        executionId: 'exec-1',
        toolName: 'Read file',
        toolSource: 'sandbox',
      },
      {
        type: 'user.follow_up_queued',
        round: 0,
        position: 1,
        preview: 'Look at the failing test next.',
      },
      {
        type: 'user.follow_up_steered',
        round: 0,
        preview: 'Actually inspect lint first.',
        replacedPending: false,
      },
      {
        type: 'subagent.started',
        executionId: 'sub-1',
        agent: 'coder',
      },
      {
        type: 'task_graph.task_ready',
        executionId: 'graph-1',
        taskId: 'explore-auth',
        agent: 'explorer',
        detail: 'Trace auth flow',
      },
      {
        type: 'task_graph.task_started',
        executionId: 'graph-1',
        taskId: 'fix-auth',
        agent: 'coder',
        detail: 'Fix auth flow',
      },
    ];

    liveOnlyEvents.forEach((event) => {
      expect(shouldPersistRunEvent(event)).toBe(false);
    });

    expect(shouldPersistRunEvent({
      type: 'assistant.turn_end',
      round: 0,
      outcome: 'completed',
    })).toBe(true);
    expect(shouldPersistRunEvent({
      type: 'task_graph.task_completed',
      executionId: 'graph-1',
      taskId: 'fix-auth',
      agent: 'coder',
      summary: 'Patched auth flow.',
    })).toBe(true);
  });

  it('merges persisted and live streams in timestamp order', () => {
    const merged = mergeRunEventStreams(
      [
        makeRunEvent({
          id: 'persisted',
          timestamp: 30,
          preview: 'Persisted result',
        }),
      ],
      [
        makeRunEvent({
          id: 'live',
          timestamp: 10,
          preview: 'Live result',
        }),
      ],
    );

    expect(merged.map((event) => event.id)).toEqual(['live', 'persisted']);
  });

  it('still trims merged streams to the configured cap', () => {
    const overLimit = Array.from({ length: MAX_RUN_EVENTS_PER_CHAT + 5 }, (_, index) =>
      makeRunEvent({
        id: `run-${index}`,
        timestamp: index,
      }),
    );

    expect(trimRunEvents(overLimit)).toHaveLength(MAX_RUN_EVENTS_PER_CHAT);
    expect(mergeRunEventStreams(overLimit)).toHaveLength(MAX_RUN_EVENTS_PER_CHAT);
  });
});
