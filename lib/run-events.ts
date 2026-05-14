import type { RunEvent, RunEventInput } from './runtime-contract.js';

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
    case 'assistant.prompt_snapshot':
    case 'tool.execution_start':
    case 'subagent.started':
    case 'job.started':
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
  return trimRunEvents([...merged].sort((left, right) => left.timestamp - right.timestamp));
}

/**
 * Convert dispatcher malformed reports into `tool.call_malformed` run-event
 * inputs. This is the single source of truth for the report → event mapping
 * so a new caller can't accidentally drop the wire — the silent-failure
 * shape where the dispatcher produces a report but no event reaches the
 * model's next-turn context, so it retries the same broken call.
 *
 * Callers feed the result through their event sink (`appendRunEvent` on
 * web, `dispatchEvent` + `appendSessionEvent` on the CLI). Tests can
 * inspect the mapped list directly to assert that every report becomes
 * exactly one event.
 *
 * Preview is capped at 500 chars to match the CLI's existing slicing.
 */
const MALFORMED_PREVIEW_MAX_CHARS = 500;

/**
 * Accepts the structural shape of a dispatcher malformed report — the
 * `reason` field is widened to `string` because the CLI wrapper in
 * `cli/tools.ts` re-exports `detectAllToolCalls` with `reason: string`
 * and threading the narrower `ToolMalformedReason` literal union back
 * across that boundary would require a cast at every call site for no
 * runtime benefit (the run event itself stores `reason` as a string).
 */
export interface MalformedReportLike {
  reason: string;
  sample: string;
}

export function buildMalformedToolCallEvents(
  reports: readonly MalformedReportLike[],
  round: number,
): Array<Extract<RunEventInput, { type: 'tool.call_malformed' }>> {
  return reports.map((report) => ({
    type: 'tool.call_malformed' as const,
    round,
    reason: report.reason,
    preview:
      report.sample.length > MALFORMED_PREVIEW_MAX_CHARS
        ? report.sample.slice(0, MALFORMED_PREVIEW_MAX_CHARS)
        : report.sample,
  }));
}

export function summarizeToolResultPreview(text: string, maxLength = 220): string {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) => Boolean(line) && line !== '[/TOOL_RESULT]' && !line.startsWith('[TOOL_RESULT'),
    );

  const normalizedLines =
    lines[0]?.startsWith('[Tool Result') && lines.length > 1 ? lines.slice(1) : lines;

  const summary = normalizedLines.join(' ').replace(/\s+/g, ' ').trim();
  if (!summary) {
    return '[no output]';
  }
  if (summary.length <= maxLength) {
    return summary;
  }
  return `${summary.slice(0, maxLength - 1).trimEnd()}...`;
}
