/**
 * event-diagnostics.ts — pure helpers for transcript diagnostics the
 * silvery lanes restore from the deleted ANSI TUI:
 *
 *   1. web-search citations → a muted "Sources" block,
 *   2. the empty-run warning (a turn that produced no visible output — the
 *      Tool-Call Parser Convergence Gap symptom),
 *   3. a once-per-type warning when either lane receives an event it does not
 *      handle.
 *
 * Both the inline lane (`controller.ts`'s `onEvent`) and the daemon lane
 * (`daemon-transcript-mirror.ts`) feed these, so the logic lives here, pure and
 * unit-tested, rather than duplicated where it would drift.
 *
 * The lane-specific handled sets are intentionally explicit. A source-level
 * drift test pins them to the inline and daemon switch statements so a new
 * engine event cannot quietly become a silent TUI drop. See #1531.
 */

import type { UrlCitation } from '../../lib/provider-contract.ts';
import { TRANSCRIPT_MUTATION_EVENT_TYPES } from '../../lib/session-transcript-events.ts';
import { safeCitations, sanitizeCitationText } from '../citation-format.js';
import { shouldWarnAboutUnknownEvent } from '../tui-daemon-handshake.js';

/** Events consumed by the inline controller switch (plus citations, which its
 * diagnostic observer renders immediately before that switch). */
export const SILVERY_INLINE_HANDLED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'assistant_thinking_token',
  'assistant_thinking_done',
  'assistant_token',
  'assistant_done',
  'assistant_citations',
  'assistant.tool_prose',
  'tool_call',
  'tool.execution_start',
  'tool_result',
  'tool.execution_complete',
  'warning',
  'error',
  'status',
  'task.ledger_snapshot',
  'task.drift_changed',
  'run_complete',
]);

/** Events consumed across the daemon mirror reducer and the controller's
 * daemon-only approval/transcript-resync path. */
export const SILVERY_DAEMON_HANDLED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'user_message',
  'assistant_thinking_token',
  'assistant_thinking_done',
  'assistant_token',
  'assistant_done',
  'assistant_citations',
  'assistant.tool_prose',
  'tool_call',
  'tool.execution_start',
  'tool_result',
  'tool.execution_complete',
  'subagent.started',
  'subagent.completed',
  'subagent.failed',
  'task_graph.task_ready',
  'task_graph.task_started',
  'task_graph.task_completed',
  'task_graph.task_failed',
  'task_graph.task_cancelled',
  'task_graph.graph_completed',
  'warning',
  'error',
  'status',
  'tool.call_malformed',
  'task.ledger_snapshot',
  'task.drift_changed',
  'run_complete',
  'approval_required',
  'approval_received',
  ...TRANSCRIPT_MUTATION_EVENT_TYPES,
]);

export type SilveryEventLane = 'inline' | 'daemon';

/** True once per unknown type and lane registry. Known global no-ops remain
 * silent through the surviving ANSI-TUI helper. */
export function shouldWarnAboutUnknownSilveryEvent(
  registry: Set<string>,
  eventType: string,
  lane: SilveryEventLane,
): boolean {
  const handled =
    lane === 'inline' ? SILVERY_INLINE_HANDLED_EVENT_TYPES : SILVERY_DAEMON_HANDLED_EVENT_TYPES;
  return !handled.has(eventType) && shouldWarnAboutUnknownEvent(registry, eventType);
}

/**
 * Event types that put a visible row in the transcript. A run that emits NONE
 * of these produced nothing the user can see — the empty-run case. Lifecycle
 * markers (`assistant_done`, `run_complete`, `user_message`) and dev-only
 * events are excluded on purpose: they are not user-visible output.
 *
 * Kept in sync with the cases both lanes actually render; `event-diagnostics.test.ts`
 * pins that correspondence so a new rendered case can't silently fall out of the
 * empty-run accounting.
 */
export const VISIBLE_EMISSION_TYPES: ReadonlySet<string> = new Set([
  // Reasoning is visible through the Ctrl+G live-tail modal. A reasoning-only
  // run therefore is not empty even if it never produces final-answer text.
  'assistant_thinking_token',
  'assistant_token',
  'assistant.tool_prose',
  'tool_call',
  'tool.execution_start',
  'tool_result',
  'tool.execution_complete',
  'assistant_citations',
  'warning',
  'error',
  'status',
  'tool.call_malformed',
  'subagent.started',
  'subagent.completed',
  'subagent.failed',
  'task_graph.task_ready',
  'task_graph.task_started',
  'task_graph.task_completed',
  'task_graph.task_failed',
  'task_graph.task_cancelled',
  'task_graph.graph_completed',
  'task.ledger_snapshot',
  'task.drift_changed',
]);

/** Whether an event type counts toward a run having produced visible output. */
export function isVisibleEmission(eventType: string): boolean {
  return VISIBLE_EMISSION_TYPES.has(eventType);
}

function asCitations(value: unknown): UrlCitation[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is UrlCitation =>
      Boolean(entry) &&
      typeof entry === 'object' &&
      typeof (entry as { url?: unknown }).url === 'string',
  );
}

const MAX_CITATION_ROWS = 8;

/**
 * Render an `assistant_citations` payload as a compact "Sources" block, or null
 * when there is nothing to show (so the caller emits no row). Each source is
 * `title — url`, or just the url when the title is absent or duplicates it.
 * Capped so a search returning dozens of sources doesn't flood the transcript.
 */
export function formatCitationsRow(payload: unknown): string | null {
  const citations = safeCitations(
    asCitations(
      payload && typeof payload === 'object'
        ? (payload as { citations?: unknown }).citations
        : null,
    ),
  );
  if (citations.length === 0) return null;
  const shown = citations.slice(0, MAX_CITATION_ROWS);
  const lines = shown.map(({ citation, url }) => {
    const title = sanitizeCitationText(typeof citation.title === 'string' ? citation.title : '');
    const href = url.href;
    const duplicateTitle = title === href || title === citation.url.trim();
    const label = title && !duplicateTitle ? `${title} — ${href}` : href;
    return `  • ${label}`;
  });
  const header = `Sources (${citations.length})`;
  const overflow =
    citations.length > shown.length ? [`  … +${citations.length - shown.length} more`] : [];
  return [header, ...lines, ...overflow].join('\n');
}

/** The empty-run diagnostic line (Tool-Call Parser Convergence Gap symptom). */
export function formatEmptyRunWarning(): string {
  return (
    'Assistant response was empty — no text, tool calls, or status events. ' +
    'This can happen when the model emits a malformed fenced tool call that the ' +
    'parser silently drops. See docs/decisions/Tool-Call Parser Convergence Gap.md.'
  );
}
