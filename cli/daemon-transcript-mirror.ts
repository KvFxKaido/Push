import { isEditDiff, type EditDiff } from '../lib/edit-diff.ts';
import { getSubagentDisplay } from '../lib/role-display.ts';
import { isTranscriptMutationEvent } from '../lib/session-transcript-events.ts';
import { isToolCardPayload, type ToolCardPayload } from '../lib/tool-cards.ts';
import type { SessionEvent } from './session-store.ts';
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
  kind: 'message' | 'tool' | 'status' | 'review';
  role: DaemonTranscriptRole;
  text: string;
  live?: boolean;
  toolName?: string;
  args?: unknown;
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
}

export interface DaemonTranscriptMirror extends DaemonTranscriptSnapshot {
  nextLocalId: number;
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

export function createDaemonTranscriptMirror(
  snapshot?: Partial<DaemonTranscriptSnapshot> | null,
): DaemonTranscriptMirror {
  return {
    rows: Array.isArray(snapshot?.rows) ? snapshot.rows.map((row) => ({ ...row })) : [],
    liveText: typeof snapshot?.liveText === 'string' ? snapshot.liveText : '',
    lastSeq: typeof snapshot?.lastSeq === 'number' ? snapshot.lastSeq : 0,
    nextLocalId: 0,
  };
}

export function snapshotDaemonTranscript(mirror: DaemonTranscriptMirror): DaemonTranscriptSnapshot {
  return {
    rows: mirror.rows.map((row) => ({ ...row })),
    liveText: mirror.liveText,
    lastSeq: mirror.lastSeq,
  };
}

export function applyDaemonTranscriptEvent(
  mirror: DaemonTranscriptMirror,
  event: EventLike,
): DaemonTranscriptMirror {
  if (typeof event.seq === 'number') mirror.lastSeq = Math.max(mirror.lastSeq, event.seq);
  const payload = payloadOf(event);

  switch (event.type) {
    case 'user_message': {
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
    case 'assistant_done':
      if (mirror.liveText.trim()) {
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
    case 'tool_call':
    case 'tool.execution_start': {
      const toolName = stringField(payload, 'toolName') || 'work';
      mirror.rows.push({
        id: eventId(mirror, event, 'tool'),
        kind: 'tool',
        role: activityRole(payload),
        text: toolName,
        toolName,
        args: payload.args,
        pending: true,
      });
      break;
    }
    case 'tool_result':
    case 'tool.execution_complete': {
      const toolName = stringField(payload, 'toolName') || 'work';
      const row = [...mirror.rows]
        .reverse()
        .find(
          (candidate) =>
            candidate.kind === 'tool' && candidate.toolName === toolName && candidate.pending,
        );
      const resultPreview = stringField(payload, 'text', 'preview').slice(0, 500);
      if (row) {
        row.pending = false;
        row.isError = payload.isError === true;
        if (typeof payload.durationMs === 'number') row.durationMs = payload.durationMs;
        if (resultPreview) row.resultPreview = resultPreview;
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
  }
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
  let assistantVisibleCount = 0;
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
    assistantVisibleCount = prefixAssistantCount;
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
      if (row) {
        assistantVisibleCount += 1;
        if (!mirror.liveText) mirror.liveText = row.text;
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
    if (row.role === 'assistant' && skippedAssistants++ < assistantVisibleCount) continue;
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
