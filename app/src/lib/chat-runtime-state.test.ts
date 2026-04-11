import { describe, expect, it } from 'vitest';
import type { AgentStatusEvent, Conversation, QueuedFollowUp, RunEvent } from '@/types';
import {
  buildAgentEventsByChat,
  buildQueuedFollowUpsByChat,
  buildRunEventsByChat,
  sanitizeConversationRuntimeState,
  setConversationAgentEvents,
  setConversationQueuedFollowUps,
  setConversationRunEvents,
} from './chat-runtime-state';

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'chat-1',
    title: 'Chat',
    messages: [],
    createdAt: 1,
    lastMessageAt: 1,
    ...overrides,
  };
}

function makeAgentEvent(overrides: Partial<AgentStatusEvent> = {}): AgentStatusEvent {
  return {
    id: 'event-1',
    timestamp: 1,
    source: 'orchestrator',
    phase: 'Thinking...',
    ...overrides,
  };
}

function makeQueuedFollowUp(overrides: Partial<QueuedFollowUp> = {}): QueuedFollowUp {
  return {
    text: 'follow up',
    queuedAt: 1,
    ...overrides,
  };
}

function makeRunEvent(
  overrides: Partial<Extract<RunEvent, { type: 'tool.execution_start' }>> = {},
): Extract<RunEvent, { type: 'tool.execution_start' }> {
  return {
    id: 'run-1',
    timestamp: 1,
    type: 'tool.execution_start',
    round: 1,
    executionId: 'exec-1',
    toolName: 'Read file',
    toolSource: 'sandbox',
    ...overrides,
  };
}

describe('chat-runtime-state', () => {
  it('builds per-chat indexes from persisted run state', () => {
    const event = makeAgentEvent();
    const runEvent = makeRunEvent();
    const followUp = makeQueuedFollowUp();
    const conversations = {
      'chat-1': makeConversation({
        runState: {
          agentEvents: [event],
          runEvents: [runEvent],
          queuedFollowUps: [followUp],
        },
      }),
      'chat-2': makeConversation({ id: 'chat-2', title: 'Other' }),
    };

    expect(buildAgentEventsByChat(conversations)).toEqual({
      'chat-1': [event],
    });
    expect(buildRunEventsByChat(conversations)).toEqual({
      'chat-1': [runEvent],
    });
    expect(buildQueuedFollowUpsByChat(conversations)).toEqual({
      'chat-1': [followUp],
    });
  });

  it('preserves the other runtime payload when updating queued follow-ups or events', () => {
    const event = makeAgentEvent();
    const runEvent = makeRunEvent();
    const followUp = makeQueuedFollowUp();
    const conversation = makeConversation({
      runState: {
        agentEvents: [event],
        runEvents: [runEvent],
      },
    });

    const withQueue = setConversationQueuedFollowUps(conversation, [followUp]);
    expect(withQueue.runState).toEqual({
      agentEvents: [event],
      runEvents: [runEvent],
      queuedFollowUps: [followUp],
    });

    const withEvents = setConversationAgentEvents(withQueue, []);
    expect(withEvents.runState).toEqual({
      runEvents: [runEvent],
      queuedFollowUps: [followUp],
    });

    const withRunEvents = setConversationRunEvents(withEvents, []);
    expect(withRunEvents.runState).toEqual({
      queuedFollowUps: [followUp],
    });
  });

  it('drops empty runtime state during sanitization', () => {
    const conversation = makeConversation({
      runState: {
        agentEvents: [],
        queuedFollowUps: [],
      },
    });

    expect(sanitizeConversationRuntimeState(conversation)).toEqual(makeConversation());
  });
});
