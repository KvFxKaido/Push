/**
 * v1-downgrade.ts — Synthesize v2 delegation events into v1-shaped
 * `assistant_token` events for clients that don't advertise `event_v2`.
 *
 * Why this exists: the daemon wire protocol is a strict superset of
 * v1 — the v2 delta is a handful of new event types (`subagent.*`,
 * `task_graph.*`) that extend the existing `RunEvent` vocabulary. A v1
 * client attached to a v2 session sees raw envelopes with `type`
 * fields it doesn't recognize and silently drops them, so the user
 * sees nothing while a sub-agent runs. Per Option C in
 * `docs/decisions/push-runtime-v2.md` (section "v1 Client Handling"),
 * the daemon synthesizes the missing events into plain
 * `assistant_token` events on the PARENT's runId, prefixed with
 * `[Role]`, so v1 clients get a human-readable transcript line for
 * every delegation milestone with zero client-side changes.
 *
 * The real (v2) events continue to fire unchanged for v2 clients.
 * This module only produces the v1-shaped shadow for clients the
 * per-client fan-out in `cli/pushd.ts:broadcastEvent` has already
 * classified as v1 (absence of `'event_v2'` in the attach-time
 * capabilities list).
 *
 * Non-goals:
 *
 *   - Approval events. A v1 client that receives an `approval_required`
 *     event scoped to a sub-agent has no way to route `submit_approval`
 *     back to the right child, because the approvalId → delegation map
 *     lives server-side. We pass approval events through verbatim to
 *     v1 clients: the existing daemon-level routing (approvalId →
 *     delegation entry) already lets the response land on the correct
 *     delegated run. Documented in the synthesizer's "skip" branch
 *     below and in the design doc around line 186.
 *
 *   - assistant.turn_start / assistant.turn_end / tool.* v2 events.
 *     Not yet emitted by pushd today, so there is nothing to downgrade.
 *     When they start flowing, a follow-up can extend the mapping.
 *
 *   - External deps. `cli/` is zero-external-deps by convention.
 */

import { PROTOCOL_VERSION } from './session-store.js';

/** Envelope shape we read from and emit to. Mirrors `SessionEvent`. */
export interface DowngradeEventEnvelope {
  v: string;
  kind: 'event';
  sessionId: string;
  runId?: string;
  seq: number;
  ts: number;
  type: string;
  payload?: unknown;
}

/**
 * Set of v2 event types this module transforms into `assistant_token`
 * shadows. Every entry here must have a matching branch in
 * `synthesizeV1DelegationEvent`.
 */
export const V1_SYNTHESIZABLE_EVENT_TYPES = new Set<string>([
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

/**
 * True if `type` is a v2 delegation event that a v1 client would not
 * recognize. Non-delegation events (`assistant_token`, `tool_call`,
 * `tool_result`, `status`, `run_complete`, `error`, `session_started`,
 * `approval_required`, etc.) pass through unchanged — callers should
 * short-circuit on this check and emit the original event.
 */
export function isV2DelegationEvent(type: string): boolean {
  return V1_SYNTHESIZABLE_EVENT_TYPES.has(type);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Resolve the parent runId to attribute synthesized tokens to. For
 * `subagent.*` events, the envelope's `runId` is the *childRunId* and
 * the parent is in `payload.parentRunId`. For `task_graph.*` events,
 * the envelope's `runId` is already the parent. Fallback order:
 *
 *   1. `payload.parentRunId` (preferred for subagent.*)
 *   2. `event.runId` (the envelope field — already parent for task_graph.*)
 *   3. null → caller should drop the synthesized event entirely,
 *      since there is no legitimate runId to attribute it to.
 */
function resolveParentRunId(event: DowngradeEventEnvelope): string | null {
  const payload = isPlainObject(event.payload) ? event.payload : {};
  const fromPayload = pickString(payload, 'parentRunId');
  if (fromPayload) return fromPayload;
  if (typeof event.runId === 'string' && event.runId.length > 0) return event.runId;
  return null;
}

/**
 * Extract a human-readable role label for the `[Role]` prefix. Prefers
 * the explicit `role` field (present on subagent.* payloads), then
 * falls back to `agent` (present on both subagent.* and task_graph.*),
 * then to a generic literal.
 */
function resolveRoleLabel(payload: Record<string, unknown>): string {
  return pickString(payload, 'role') || pickString(payload, 'agent') || 'agent';
}

/** Capitalize the first letter so `[Coder]` reads nicely. */
function titleCase(value: string): string {
  if (!value) return value;
  return value[0].toUpperCase() + value.slice(1);
}

/**
 * Build an `assistant_token` envelope on the parent runId. The shape
 * mirrors what `cli/engine.ts` dispatches for streamed tokens today
 * (`{ text: string }`), so v1 clients can render it with zero special
 * handling.
 */
function makeTokenEnvelope(
  source: DowngradeEventEnvelope,
  parentRunId: string,
  text: string,
): DowngradeEventEnvelope {
  return {
    v: PROTOCOL_VERSION,
    kind: 'event',
    sessionId: source.sessionId,
    runId: parentRunId,
    seq: source.seq,
    ts: source.ts,
    type: 'assistant_token',
    payload: { text },
  };
}

/**
 * Transform a v2 delegation event into zero or more v1-shaped
 * `assistant_token` envelopes addressed to the parent run. Returns an
 * empty array when:
 *
 *   - The event type is not a synthesizable v2 delegation type.
 *   - The payload is not a plain object (defensive — strict mode
 *     should have caught this upstream, but we don't want to crash
 *     the fan-out loop for a single malformed event).
 *   - No parent runId can be resolved (no `payload.parentRunId` AND
 *     no envelope `runId`). Attributing the synthesized token to
 *     "nowhere" would violate envelope validation.
 *
 * Otherwise returns `[synthesizedEvent]`. The return type is an array
 * so future event types that fan out to multiple lines (e.g. multi-
 * line completion summaries) can extend the contract without changing
 * the caller.
 */
export function synthesizeV1DelegationEvent(
  event: DowngradeEventEnvelope,
): DowngradeEventEnvelope[] {
  if (!isV2DelegationEvent(event.type)) return [];
  if (!isPlainObject(event.payload)) return [];

  const parentRunId = resolveParentRunId(event);
  if (!parentRunId) return [];

  const payload = event.payload;
  const role = titleCase(resolveRoleLabel(payload));

  switch (event.type) {
    case 'subagent.started': {
      const detail = pickString(payload, 'detail') || pickString(payload, 'agent') || 'running';
      return [makeTokenEnvelope(event, parentRunId, `[${role}] started: ${detail}\n`)];
    }
    case 'subagent.completed': {
      const summary = pickString(payload, 'summary') || 'done';
      return [makeTokenEnvelope(event, parentRunId, `[${role}] completed: ${summary}\n`)];
    }
    case 'subagent.failed': {
      const error = pickString(payload, 'error') || 'unknown error';
      return [makeTokenEnvelope(event, parentRunId, `[${role}] failed: ${error}\n`)];
    }
    case 'task_graph.task_ready': {
      const taskId = pickString(payload, 'taskId') || 'unknown';
      const agent = pickString(payload, 'agent') || 'agent';
      return [
        makeTokenEnvelope(event, parentRunId, `[TaskGraph] task ready: ${taskId} (${agent})\n`),
      ];
    }
    case 'task_graph.task_started': {
      const taskId = pickString(payload, 'taskId') || 'unknown';
      const agent = pickString(payload, 'agent') || 'agent';
      const detail = pickString(payload, 'detail') || 'running';
      return [
        makeTokenEnvelope(
          event,
          parentRunId,
          `[TaskGraph] task started: ${taskId} (${agent}) — ${detail}\n`,
        ),
      ];
    }
    case 'task_graph.task_completed': {
      const taskId = pickString(payload, 'taskId') || 'unknown';
      const agent = pickString(payload, 'agent') || 'agent';
      // `summary` is required by the schema and can legitimately be an
      // empty string — fall back to a literal so the downgrade line
      // isn't ambiguous.
      const rawSummary = typeof payload.summary === 'string' ? payload.summary : '';
      const summary = rawSummary || 'done';
      return [
        makeTokenEnvelope(
          event,
          parentRunId,
          `[TaskGraph] task completed: ${taskId} (${agent}) — ${summary}\n`,
        ),
      ];
    }
    case 'task_graph.task_failed': {
      const taskId = pickString(payload, 'taskId') || 'unknown';
      const agent = pickString(payload, 'agent') || 'agent';
      const error = pickString(payload, 'error') || 'unknown error';
      return [
        makeTokenEnvelope(
          event,
          parentRunId,
          `[TaskGraph] task failed: ${taskId} (${agent}) — ${error}\n`,
        ),
      ];
    }
    case 'task_graph.task_cancelled': {
      const taskId = pickString(payload, 'taskId') || 'unknown';
      const agent = pickString(payload, 'agent') || 'agent';
      const reason = pickString(payload, 'reason') || 'cancelled';
      return [
        makeTokenEnvelope(
          event,
          parentRunId,
          `[TaskGraph] task cancelled: ${taskId} (${agent}) — ${reason}\n`,
        ),
      ];
    }
    case 'task_graph.graph_completed': {
      const nodeCount =
        typeof payload.nodeCount === 'number' && Number.isFinite(payload.nodeCount)
          ? payload.nodeCount
          : 0;
      const success = payload.success === true;
      return [
        makeTokenEnvelope(
          event,
          parentRunId,
          `[TaskGraph] graph completed: ${nodeCount} nodes, success=${success}\n`,
        ),
      ];
    }
    default:
      // Unreachable — `isV2DelegationEvent` gate above keeps the switch
      // exhaustive. Kept explicit so a future event-type addition that
      // forgets the switch branch fails the test suite loudly.
      return [];
  }
}
