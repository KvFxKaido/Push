/**
 * event-diagnostics.ts — pure helpers for two transcript diagnostics the
 * silvery lanes restore from the deleted ANSI TUI:
 *
 *   1. web-search citations → a muted "Sources" block,
 *   2. the empty-run warning (a turn that produced no visible output — the
 *      Tool-Call Parser Convergence Gap symptom).
 *
 * Both the inline lane (`controller.ts`'s `onEvent`) and the daemon lane
 * (`daemon-transcript-mirror.ts`) feed these, so the logic lives here, pure and
 * unit-tested, rather than duplicated where it would drift.
 *
 * The third old-TUI diagnostic — the unknown-event drift warning
 * (`tui-daemon-handshake.ts`'s surviving `shouldWarnAboutUnknownEvent`) — is
 * deliberately NOT here. It needs a maintained set of TUI-handled event types
 * to decide what "unknown" means, plus a drift-detector test so that set can't
 * rot against the two switch statements. Both of THESE diagnostics rest on a
 * positive list of what to show, which needs no such bookkeeping; the drift
 * warning is a separate, later change. See #1531.
 */

import type { UrlCitation } from '../../lib/provider-contract.ts';
import { safeCitations, sanitizeCitationText } from '../citation-format.js';

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
