import type { RunEvent, RunEventInput } from '@/types';

export const MAX_RUN_EVENTS_PER_CHAT = 400;

export function trimRunEvents(events: RunEvent[]): RunEvent[] {
  if (events.length <= MAX_RUN_EVENTS_PER_CHAT) {
    return events;
  }
  return events.slice(events.length - MAX_RUN_EVENTS_PER_CHAT);
}

export function shouldPersistRunEvent(event: RunEventInput): boolean {
  switch (event.type) {
    case 'assistant.turn_start':
    case 'tool.execution_start':
    case 'subagent.started':
    case 'task_graph.task_ready':
    case 'task_graph.task_started':
    case 'user.follow_up_queued':
    case 'user.follow_up_steered':
      return false;
    default:
      return true;
  }
}

export function mergeRunEventStreams(...streams: readonly RunEvent[][]): RunEvent[] {
  const merged = streams.flat();
  if (merged.length <= 1) {
    return merged[0] ? trimRunEvents([...merged]) : [];
  }
  return trimRunEvents(
    [...merged].sort((left, right) => left.timestamp - right.timestamp),
  );
}

export function summarizeToolResultPreview(text: string, maxLength = 220): string {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => Boolean(line) && line !== '[/TOOL_RESULT]' && !line.startsWith('[TOOL_RESULT'));

  const normalizedLines =
    lines[0]?.startsWith('[Tool Result') && lines.length > 1
      ? lines.slice(1)
      : lines;

  const summary = normalizedLines.join(' ').replace(/\s+/g, ' ').trim();
  if (!summary) {
    return '[no output]';
  }
  if (summary.length <= maxLength) {
    return summary;
  }
  return `${summary.slice(0, maxLength - 1).trimEnd()}...`;
}
