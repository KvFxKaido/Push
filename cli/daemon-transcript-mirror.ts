import { isEditDiff, type EditDiff } from '../lib/edit-diff.ts';
import { getSubagentDisplay } from '../lib/role-display.ts';
import { isTranscriptMutationEvent } from '../lib/session-transcript-events.ts';
import { isToolCardPayload, type ToolCardPayload } from '../lib/tool-cards.ts';
import { stripToolCallPayload } from '../lib/tool-prose.ts';
import type { SessionEvent } from './session-store.ts';
import {
  formatCitationsRow,
  formatEmptyRunWarning,
  isVisibleEmission,
  shouldWarnAboutUnknownSilveryEvent,
} from './silvery/event-diagnostics.js';
import { formatUnknownEventWarning } from './tui-daemon-handshake.js';
import { sessionMessagesToTranscriptRows } from './tui-history.ts';

export type DaemonTranscriptRole =
  | 'user'
  | 'assistant'
  | 'coder'
  | 'explorer'
  | 'reviewer'
  | 'auditor'
  | 'status';

export interface DaemonTranscriptRow {
  id: string;
  kind: 'message' | 'tool_prose' | 'tool' | 'status' | 'review';
  role: DaemonTranscriptRole;
  text: string;
  live?: boolean;
  toolName?: string;
  /** Stable per-call id minted by the kernel (`tool.execution_start/complete`).
   *  Used to pair a result to its originating call so parallel calls of the
   *  same tool don't cross-attribute output/diff/card. Absent on legacy
   *  id-less events, which fall back to the name+pending scan. */
  executionId?: string;
  args?: unknown;
  /** Compact target label the runtime emits (path, command, query, task
   *  summary). Feeds the semantic tool title; absent for tools with no target. */
  target?: string;
  pending?: boolean;
  isError?: boolean;
  durationMs?: number;
  resultPreview?: string;
  diff?: EditDiff;
  card?: ToolCardPayload;
  timestampMs?: number;
}

export interface DaemonTranscriptSnapshot {
  rows: DaemonTranscriptRow[];
  liveText: string;
  lastSeq: number;
  /** Visible event count for an in-progress run. Carried through reconnect
   * snapshots so a later run_complete cannot misclassify that run as empty. */
  runVisibleEmissionCount?: number;
  /** Unknown types already surfaced by this mirror. Preserved across daemon
   * snapshots so completion resyncs cannot repeat the warning. */
  warnedUnknownEventTypeList?: string[];
}

export interface DaemonTranscriptMirror extends DaemonTranscriptSnapshot {
  nextLocalId: number;
  runVisibleEmissionCount: number;
  warnedUnknownEventTypes: Set<string>;
}

type EventLike = Pick<SessionEvent, 'seq' | 'type' | 'payload'> & { ts?: number };

function payloadOf(event: EventLike): Record<string, unknown> {
  return event.payload && typeof event.payload === 'object'
    ? (event.payload as Record<string, unknown>)
    : {};
}

function stringField(payload: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    if (typeof payload[key] === 'string') return payload[key];
  }
  return '';
}

function eventId(mirror: DaemonTranscriptMirror, event: EventLike, kind: string): string {
  if (Number.isFinite(event.seq) && event.seq > 0) return `daemon-${event.seq}-${kind}`;
  mirror.nextLocalId += 1;
  return `daemon-live-${mirror.nextLocalId}-${kind}`;
}

function activityRole(payload: Record<string, unknown>): 'coder' | 'explorer' {
  const role = stringField(payload, 'role', 'agentRole', 'toolSource');
  if (role === 'explorer') return 'explorer';
  const tool = stringField(payload, 'toolName');
  return /^(read_file|list_files|search|web_search|git_status|git_diff)$/.test(tool)
    ? 'explorer'
    : 'coder';
}

function reviewText(payload: Record<string, unknown>, fallback: string): string {
  const result =
    payload.reviewResult && typeof payload.reviewResult === 'object'
      ? (payload.reviewResult as Record<string, unknown>)
      : null;
  const summary =
    (result && typeof result.summary === 'string' && result.summary) ||
    stringField(payload, 'summary', 'error') ||
    fallback;
  const comments = result && Array.isArray(result.comments) ? result.comments : [];
  const findings = comments.flatMap((comment) => {
    if (!comment || typeof comment !== 'object') return [];
    const finding = comment as Record<string, unknown>;
    const body = stringField(finding, 'body', 'message', 'comment');
    if (!body) return [];
    const path = stringField(finding, 'path', 'file');
    const line = typeof finding.line === 'number' ? `:${finding.line}` : '';
    return [`${path ? `${path}${line} · ` : ''}${body}`];
  });
  return [summary, ...findings].filter(Boolean).join('\n\n');
}

/**
 * Classify assistant rounds from the structured event order, never from their
 * persisted text. An assistant completion followed by tool execution before
 * the next completion is a tool-call round; its raw model-facing payload must
 * not become a transcript message. Modern runs emit `assistant.tool_prose`
 * separately, so suppressing the completion does not suppress narration.
 */
function assistantDoneToolRounds(events: readonly SessionEvent[]): boolean[] {
  const rounds: boolean[] = [];
  for (let index = 0; index < events.length; index++) {
    if (events[index]?.type !== 'assistant_done') continue;
    let hasTool = false;
    for (let next = index + 1; next < events.length; next++) {
      const type = events[next]?.type;
      if (type === 'assistant_done' || type === 'user_message') break;
      if (
        type === 'tool_call' ||
        type === 'tool.execution_start' ||
        type === 'tool.call_malformed'
      ) {
        hasTool = true;
        break;
      }
    }
    rounds.push(hasTool);
  }
  return rounds;
}

export function createDaemonTranscriptMirror(
  snapshot?: Partial<DaemonTranscriptSnapshot> | null,
): DaemonTranscriptMirror {
  return {
    rows: Array.isArray(snapshot?.rows) ? snapshot.rows.map((row) => ({ ...row })) : [],
    liveText: typeof snapshot?.liveText === 'string' ? snapshot.liveText : '',
    lastSeq: typeof snapshot?.lastSeq === 'number' ? snapshot.lastSeq : 0,
    runVisibleEmissionCount:
      typeof snapshot?.runVisibleEmissionCount === 'number' &&
      Number.isFinite(snapshot.runVisibleEmissionCount) &&
      snapshot.runVisibleEmissionCount >= 0
        ? snapshot.runVisibleEmissionCount
        : 0,
    nextLocalId: 0,
    warnedUnknownEventTypes: new Set(
      Array.isArray(snapshot?.warnedUnknownEventTypeList)
        ? snapshot.warnedUnknownEventTypeList.filter(
            (type): type is string => typeof type === 'string',
          )
        : [],
    ),
  };
}

export function snapshotDaemonTranscript(mirror: DaemonTranscriptMirror): DaemonTranscriptSnapshot {
  return {
    rows: mirror.rows.map((row) => ({ ...row })),
    liveText: mirror.liveText,
    lastSeq: mirror.lastSeq,
    runVisibleEmissionCount: mirror.runVisibleEmissionCount,
    // Older in-memory mirrors (including a daemon that survived a CLI update)
    // predate this registry. Omit the optional wire field instead of failing
    // the entire reconnect snapshot on an undefined Set.
    ...(mirror.warnedUnknownEventTypes instanceof Set
      ? { warnedUnknownEventTypeList: [...mirror.warnedUnknownEventTypes] }
      : {}),
  };
}

export function applyDaemonTranscriptEvent(
  mirror: DaemonTranscriptMirror,
  event: EventLike,
): DaemonTranscriptMirror {
  // Hot-updated daemons and legacy test fixtures can hand us the pre-#1531
  // mirror shape. Upgrade it in place before the reducer touches new fields.
  if (!Number.isFinite(mirror.runVisibleEmissionCount)) mirror.runVisibleEmissionCount = 0;
  if (!(mirror.warnedUnknownEventTypes instanceof Set)) {
    mirror.warnedUnknownEventTypes = new Set();
  }
  if (typeof event.seq === 'number') mirror.lastSeq = Math.max(mirror.lastSeq, event.seq);
  const payload = payloadOf(event);
  let visibleEmission = isVisibleEmission(event.type);

  switch (event.type) {
    case 'user_message': {
      // A new prompt starts a fresh run even if the prior process died before
      // emitting run_complete. Never let stale output suppress this run's
      // empty-response diagnostic.
      mirror.runVisibleEmissionCount = 0;
      const text = stringField(payload, 'text', 'preview');
      if (text) {
        mirror.rows.push({
          id: eventId(mirror, event, 'user'),
          kind: 'message',
          role: 'user',
          text:
            typeof payload.text === 'string' || payload.chars === text.length ? text : `${text}…`,
          ...(typeof event.ts === 'number' ? { timestampMs: event.ts } : {}),
        });
      }
      break;
    }
    case 'assistant_token':
      mirror.liveText += stringField(payload, 'text');
      break;
    // The controller owns the ephemeral reasoning buffer/modal. Keep these
    // explicit here so the daemon lane recognizes them without persisting
    // private reasoning into transcript rows.
    case 'assistant_thinking_token':
    case 'assistant_thinking_done':
      break;
    case 'assistant_done':
      if (mirror.liveText.trim()) {
        visibleEmission = true;
        mirror.rows.push({
          id: eventId(mirror, event, 'assistant'),
          kind: 'message',
          role: 'assistant',
          text: mirror.liveText,
          ...(typeof event.ts === 'number' ? { timestampMs: event.ts } : {}),
        });
      }
      mirror.liveText = '';
      break;
    case 'assistant_citations': {
      const text = formatCitationsRow(payload);
      visibleEmission = Boolean(text);
      if (text) {
        mirror.rows.push({
          id: eventId(mirror, event, 'citations'),
          kind: 'status',
          role: 'status',
          text,
        });
      }
      break;
    }
    case 'assistant.tool_prose': {
      const text = stringField(payload, 'text').trim();
      if (!text) break;
      const previous = mirror.rows.at(-1);
      if (
        previous?.kind === 'message' &&
        previous.role === 'assistant' &&
        stripToolCallPayload(previous.text).trim() === text
      ) {
        mirror.rows.pop();
      }
      mirror.rows.push({
        id: eventId(mirror, event, 'tool-prose'),
        kind: 'tool_prose',
        role: 'assistant',
        text,
        ...(typeof event.ts === 'number' ? { timestampMs: event.ts } : {}),
      });
      break;
    }
    case 'tool_call':
    case 'tool.execution_start': {
      const toolName = stringField(payload, 'toolName') || 'work';
      const executionId = stringField(payload, 'executionId');
      mirror.rows.push({
        id: eventId(mirror, event, 'tool'),
        kind: 'tool',
        role: activityRole(payload),
        text: toolName,
        toolName,
        args: payload.args,
        pending: true,
        ...(executionId ? { executionId } : {}),
      });
      break;
    }
    case 'tool_result':
    case 'tool.execution_complete': {
      const toolName = stringField(payload, 'toolName') || 'work';
      const executionId = stringField(payload, 'executionId');
      const nameScan = () =>
        [...mirror.rows]
          .reverse()
          .find(
            (candidate) =>
              candidate.kind === 'tool' && candidate.toolName === toolName && candidate.pending,
          );
      // Pair the result to its call by executionId (kernel-minted, with
      // start/complete parity) so parallel calls of the same tool never
      // cross-attribute output/diff/card onto the wrong row. Fall back to the
      // name+pending reverse-scan when there is no id — OR when the id matches
      // no pending row, which covers legacy sessions recorded before id parity
      // whose start rows still carry a stale `${runId}_lead_*` id (else the
      // pending row is stranded and the result duplicates). Codex P2, #1493.
      const row =
        (executionId
          ? mirror.rows.find(
              (candidate) =>
                candidate.kind === 'tool' &&
                candidate.pending &&
                candidate.executionId === executionId,
            )
          : undefined) ?? nameScan();
      const resultPreview = stringField(payload, 'text', 'preview').slice(0, 500);
      const target = stringField(payload, 'target');
      if (row) {
        row.pending = false;
        row.isError = payload.isError === true;
        if (typeof payload.durationMs === 'number') row.durationMs = payload.durationMs;
        if (resultPreview) row.resultPreview = resultPreview;
        if (target) row.target = target;
        if (isEditDiff(payload.diff)) row.diff = payload.diff;
        if (isToolCardPayload(payload.card)) row.card = payload.card;
      } else {
        mirror.rows.push({
          id: eventId(mirror, event, 'tool-result'),
          kind: 'tool',
          role: activityRole(payload),
          text: toolName,
          toolName,
          pending: false,
          isError: payload.isError === true,
          resultPreview,
          ...(executionId ? { executionId } : {}),
          ...(target ? { target } : {}),
          ...(typeof payload.durationMs === 'number' ? { durationMs: payload.durationMs } : {}),
          ...(isEditDiff(payload.diff) ? { diff: payload.diff } : {}),
          ...(isToolCardPayload(payload.card) ? { card: payload.card } : {}),
        });
      }
      break;
    }
    case 'subagent.started':
    case 'subagent.completed':
    case 'subagent.failed': {
      const subagent = stringField(payload, 'role', 'agent', 'subagent');
      const display = getSubagentDisplay(subagent);
      const label = display.name ?? display.phase ?? 'Working';
      const outcome = event.type === 'subagent.started' ? 'started' : event.type.split('.')[1];
      const isReview = subagent.includes('reviewer') || payload.role === 'reviewer';
      const fallback = `${label} ${outcome}${stringField(payload, 'summary', 'task', 'error') ? ` · ${stringField(payload, 'summary', 'task', 'error')}` : ''}`;
      mirror.rows.push({
        id: eventId(mirror, event, 'subagent'),
        kind: isReview ? 'review' : 'status',
        role: isReview
          ? 'reviewer'
          : subagent === 'explorer' || payload.role === 'explorer'
            ? 'explorer'
            : 'coder',
        text:
          isReview && event.type !== 'subagent.started' ? reviewText(payload, fallback) : fallback,
        isError: event.type === 'subagent.failed',
      });
      break;
    }
    case 'task_graph.task_ready':
    case 'task_graph.task_started':
    case 'task_graph.task_completed':
    case 'task_graph.task_failed':
    case 'task_graph.task_cancelled':
    case 'task_graph.graph_completed':
      mirror.rows.push({
        id: eventId(mirror, event, 'task-graph'),
        kind: 'status',
        role: 'status',
        text: stringField(payload, 'summary', 'task', 'taskId') || event.type,
        isError: event.type.endsWith('failed'),
      });
      break;
    case 'warning':
    case 'error':
    case 'status':
    case 'tool.call_malformed':
      mirror.rows.push({
        id: eventId(mirror, event, 'status'),
        kind: 'status',
        role: 'status',
        text: stringField(payload, 'message', 'detail', 'phase', 'reason') || event.type,
        isError: event.type === 'error',
      });
      break;
    case 'run_complete':
      if (mirror.runVisibleEmissionCount === 0) {
        mirror.rows.push({
          id: eventId(mirror, event, 'empty-run'),
          kind: 'status',
          role: 'status',
          text: formatEmptyRunWarning(),
        });
      }
      mirror.runVisibleEmissionCount = 0;
      break;
    default:
      if (
        shouldWarnAboutUnknownSilveryEvent(mirror.warnedUnknownEventTypes, event.type, 'daemon')
      ) {
        visibleEmission = true;
        mirror.rows.push({
          id: eventId(mirror, event, 'unknown-event'),
          kind: 'status',
          role: 'status',
          text: formatUnknownEventWarning(event.type),
        });
      }
  }
  if (visibleEmission) mirror.runVisibleEmissionCount += 1;
  return mirror;
}

export function rebuildDaemonTranscriptMirror(
  messages: readonly unknown[],
  events: readonly SessionEvent[],
): DaemonTranscriptMirror {
  const dialogue = sessionMessagesToTranscriptRows(messages);
  const users = dialogue.filter((row) => row.role === 'user');
  const assistantSlots = messages
    .filter(
      (message) =>
        message !== null &&
        typeof message === 'object' &&
        (message as { role?: unknown }).role === 'assistant',
    )
    .map(
      (message) =>
        sessionMessagesToTranscriptRows([message]).find((row) => row.role === 'assistant') ?? null,
    );
  let userIndex = 0;
  let assistantSlotIndex = 0;
  let assistantConsumedCount = 0;
  const mirror = createDaemonTranscriptMirror();

  // Event journal is append-only across compact/revert/unrevert while
  // `state.messages` is rewritten. Replaying pre-mutation events resurrects
  // dropped turns and mis-pairs current dialogue with stale tool cards.
  // Start after the latest transcript-mutation marker (shared contract in
  // lib/session-transcript-events.ts); messages are the post-mutation truth.
  let replayFrom = 0;
  let maxSeq = 0;
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!;
    if (typeof event.seq === 'number') maxSeq = Math.max(maxSeq, event.seq);
    if (isTranscriptMutationEvent(event.type)) replayFrom = index + 1;
  }
  const replayEvents = events.slice(replayFrom);
  const toolRoundByAssistantDone = assistantDoneToolRounds(replayEvents);
  let assistantDoneIndex = 0;

  // Post-mutation events describe only activity *after* the rewrite. Pair them
  // with the *tail* of rewritten dialogue (not the head, which is summary /
  // surviving turns that have no matching post-mutation journal entries).
  if (replayFrom > 0) {
    const postUserEvents = replayEvents.filter((event) => event.type === 'user_message').length;
    const postAssistantDones = replayEvents.filter(
      (event) => event.type === 'assistant_done',
    ).length;
    const prefixUserCount = Math.max(0, users.length - postUserEvents);
    const prefixAssistantCount = Math.max(0, assistantSlots.length - postAssistantDones);
    let seededUsers = 0;
    let seededAssistants = 0;
    for (let index = 0; index < dialogue.length; index++) {
      const row = dialogue[index]!;
      if (row.role === 'user') {
        if (seededUsers >= prefixUserCount) continue;
        seededUsers += 1;
      } else if (row.role === 'assistant') {
        if (seededAssistants >= prefixAssistantCount) continue;
        seededAssistants += 1;
      } else {
        continue;
      }
      mirror.rows.push({
        id: `daemon-history-${row.role}-${index}`,
        kind: 'message',
        role: row.role,
        text: row.text,
        ...(row.timestampMs === undefined ? {} : { timestampMs: row.timestampMs }),
      });
    }
    userIndex = prefixUserCount;
    assistantSlotIndex = prefixAssistantCount;
    assistantConsumedCount = prefixAssistantCount;
  }

  for (const event of replayEvents) {
    if (event.type === 'user_message') {
      const row = users[userIndex++];
      applyDaemonTranscriptEvent(mirror, {
        ...event,
        payload: { ...payloadOf(event), ...(row ? { text: row.text } : {}) },
      });
      continue;
    }
    if (event.type === 'assistant_done') {
      const row = assistantSlots[assistantSlotIndex++];
      const toolRound = toolRoundByAssistantDone[assistantDoneIndex++] === true;
      if (row) {
        assistantConsumedCount += 1;
        if (toolRound) mirror.liveText = '';
        else if (!mirror.liveText) mirror.liveText = row.text;
      }
    }
    applyDaemonTranscriptEvent(mirror, event);
  }
  mirror.lastSeq = Math.max(mirror.lastSeq, maxSeq);

  // Legacy sessions can have dialogue without a matching event journal. Keep
  // it visible rather than pretending an incomplete journal is authoritative.
  // After a mutation with no post-mutation events, the seeded prefix above
  // already covered rewritten messages; any leftover still lands here.
  let skippedUsers = 0;
  let skippedAssistants = 0;
  for (let index = 0; index < dialogue.length; index++) {
    const row = dialogue[index]!;
    if (row.role === 'user' && skippedUsers++ < userIndex) continue;
    if (row.role === 'assistant' && skippedAssistants++ < assistantConsumedCount) continue;
    mirror.rows.push({
      id: `daemon-history-${row.role}-${index}`,
      kind: 'message',
      role: row.role,
      text: row.text,
      ...(row.timestampMs === undefined ? {} : { timestampMs: row.timestampMs }),
    });
  }
  return mirror;
}
