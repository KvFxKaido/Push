import type {
  AgentStatusEvent,
  Conversation,
  ConversationRunState,
  RunEvent,
  QueuedFollowUp,
} from '@/types';
import { trimRunEvents } from './chat-run-events';

function normalizeRunState(runState?: ConversationRunState): ConversationRunState | undefined {
  const agentEvents = runState?.agentEvents?.length ? runState.agentEvents : undefined;
  const runEvents = runState?.runEvents?.length ? trimRunEvents(runState.runEvents) : undefined;
  const queuedFollowUps = runState?.queuedFollowUps?.length ? runState.queuedFollowUps : undefined;

  if (!agentEvents && !runEvents && !queuedFollowUps) {
    return undefined;
  }

  return {
    ...(agentEvents ? { agentEvents } : {}),
    ...(runEvents ? { runEvents } : {}),
    ...(queuedFollowUps ? { queuedFollowUps } : {}),
  };
}

function withRunState(
  conversation: Conversation,
  runState?: ConversationRunState,
): Conversation {
  const normalized = normalizeRunState(runState);
  if (!normalized) {
    const nextConversation = { ...conversation };
    delete nextConversation.runState;
    return nextConversation;
  }
  return { ...conversation, runState: normalized };
}

export function buildAgentEventsByChat(
  conversations: Record<string, Conversation>,
): Record<string, AgentStatusEvent[]> {
  const result: Record<string, AgentStatusEvent[]> = {};

  for (const [chatId, conversation] of Object.entries(conversations)) {
    const events = conversation.runState?.agentEvents;
    if (events?.length) {
      result[chatId] = events;
    }
  }

  return result;
}

export function buildQueuedFollowUpsByChat(
  conversations: Record<string, Conversation>,
): Record<string, QueuedFollowUp[]> {
  const result: Record<string, QueuedFollowUp[]> = {};

  for (const [chatId, conversation] of Object.entries(conversations)) {
    const queuedFollowUps = conversation.runState?.queuedFollowUps;
    if (queuedFollowUps?.length) {
      result[chatId] = queuedFollowUps;
    }
  }

  return result;
}

export function buildRunEventsByChat(
  conversations: Record<string, Conversation>,
): Record<string, RunEvent[]> {
  const result: Record<string, RunEvent[]> = {};

  for (const [chatId, conversation] of Object.entries(conversations)) {
    const runEvents = conversation.runState?.runEvents;
    if (runEvents?.length) {
      result[chatId] = runEvents;
    }
  }

  return result;
}

export function setConversationAgentEvents(
  conversation: Conversation,
  agentEvents: AgentStatusEvent[],
): Conversation {
  return withRunState(conversation, {
    ...conversation.runState,
    agentEvents,
  });
}

export function setConversationRunEvents(
  conversation: Conversation,
  runEvents: RunEvent[],
): Conversation {
  return withRunState(conversation, {
    ...conversation.runState,
    runEvents,
  });
}

export function setConversationQueuedFollowUps(
  conversation: Conversation,
  queuedFollowUps: QueuedFollowUp[],
): Conversation {
  return withRunState(conversation, {
    ...conversation.runState,
    queuedFollowUps,
  });
}

export function sanitizeConversationRuntimeState(
  conversation: Conversation,
): Conversation {
  return withRunState(conversation, conversation.runState);
}
