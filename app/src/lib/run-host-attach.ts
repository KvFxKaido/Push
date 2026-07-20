/**
 * run-host-attach.ts — Durable Runs Phase 3 attach/viewer client.
 *
 * The reopened-client half of adopt-on-silence: probe the RunHost ledger for
 * a run that lived on (or finished) server-side while this device was away,
 * hydrate the chat transcript from the host's stored `RunCheckpointV1`, and
 * drive the attach controls (approve/deny the paused gate, stop,
 * pull-back-local via release).
 *
 * Auth note: every call here rides `/api/runhost/run/*`, which sits behind
 * the universal GitHub-identity session gate — that IS the bearer for the
 * same-origin web surface (no tokenless class; the track's "bearer-
 * authenticated attach" requirement). The DO instance is derived server-side
 * from the durable scope, so the only thing this client supplies is the
 * scope it already owns.
 *
 * This module is fetch + pure hydration planning; the polling lifecycle and
 * conversation mutation live in `app/src/hooks/useRunHostAttach.ts` (the
 * owning coordinator — new-feature checklist #2).
 */

import {
  RUN_LIFECYCLE_STATES,
  isCompleteScope,
  type RunHostAttachSnapshot,
  type RunHostScope,
  type RunHostWatchServerFrame,
  type RunLifecycleState,
} from '@push/lib/run-host-adoption';
import {
  ADOPTION_APPROVAL_RESOLVED_NOTE_MARKER,
  ADOPTION_RESUME_NOTE_MARKER,
} from '@push/lib/run-adoption-loop';
import {
  validateRunCheckpoint,
  type RunCheckpointMessage,
  type RunCheckpointV1,
} from '@push/lib/run-checkpoint';
import { createId } from '@push/lib/id-utils';
import type { AttachmentData, ChatMessage } from '@/types';
import { resolveApiUrl } from './api-url';

const ATTACH_PATH = '/api/runhost/run/attach';
const WATCH_PATH = '/api/runhost/run/watch';
const APPROVAL_PATH = '/api/runhost/run/approval';
const STOP_PATH = '/api/runhost/run/stop';
const RELEASE_PATH = '/api/runhost/run/release';

function log(level: 'info' | 'warn', event: string, ctx: Record<string, unknown>): void {
  const line = JSON.stringify({ level, event, ...ctx });
  if (level === 'warn') console.warn(line);
  else console.log(line);
}

// ---------------------------------------------------------------------------
// Attach fetch
// ---------------------------------------------------------------------------

export type RunHostAttachResult =
  /** No run on the host for this scope (or the deployment has no RUN_HOST
   * binding) — nothing to attach to. */
  | { kind: 'none'; reason: 'not_found' | 'not_configured' | 'incomplete_scope' }
  | { kind: 'error'; status?: number; message: string }
  | { kind: 'snapshot'; snapshot: RunHostAttachSnapshot };

const LIFECYCLE: ReadonlySet<string> = new Set(RUN_LIFECYCLE_STATES);

/** Defensive parse of the attach response — the shape is ours, but a proxy
 * error page or a partial deploy must degrade to 'error', not a crash. */
function parseAttachSnapshot(raw: unknown): RunHostAttachSnapshot | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const body = raw as Record<string, unknown>;
  if (
    typeof body.runId !== 'string' ||
    body.runId.length === 0 ||
    typeof body.state !== 'string' ||
    !LIFECYCLE.has(body.state) ||
    typeof body.round !== 'number' ||
    typeof body.midFlight !== 'boolean'
  ) {
    return null;
  }
  if (body.checkpoint !== undefined && validateRunCheckpoint(body.checkpoint).length > 0) {
    return null;
  }
  return body as unknown as RunHostAttachSnapshot;
}

export async function fetchRunHostAttach(
  scope: RunHostScope,
  sinceSavedAt: number | null,
): Promise<RunHostAttachResult> {
  if (!isCompleteScope(scope)) {
    return { kind: 'none', reason: 'incomplete_scope' };
  }
  const params = new URLSearchParams({
    repoFullName: scope.repoFullName,
    branch: scope.branch,
    chatId: scope.chatId,
  });
  if (sinceSavedAt !== null) params.set('sinceSavedAt', String(sinceSavedAt));
  let res: Response;
  try {
    res = await fetch(resolveApiUrl(`${ATTACH_PATH}?${params.toString()}`));
  } catch (err: unknown) {
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }
  if (res.status === 404) return { kind: 'none', reason: 'not_found' };
  if (res.status === 503) return { kind: 'none', reason: 'not_configured' };
  if (!res.ok) {
    return { kind: 'error', status: res.status, message: `attach failed (${res.status})` };
  }
  const raw: unknown = await res.json().catch(() => null);
  const snapshot = parseAttachSnapshot(raw);
  if (!snapshot) {
    log('warn', 'run_host_attach_parse_failed', { chatId: scope.chatId });
    return { kind: 'error', status: res.status, message: 'attach response malformed' };
  }
  return { kind: 'snapshot', snapshot };
}

// ---------------------------------------------------------------------------
// Watch (WS push) — low-latency counterpart of the attach poll
// ---------------------------------------------------------------------------

/** Resolve the WebSocket URL for a same-origin (web) or native (Capacitor)
 * deployment. `resolveApiUrl` yields a relative path on web and an absolute
 * `https://…` base on native; map either to `ws(s)://`. */
function resolveWatchWsUrl(pathWithQuery: string): string {
  const resolved = resolveApiUrl(pathWithQuery);
  if (/^https?:/i.test(resolved)) return resolved.replace(/^http/i, 'ws');
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${resolved}`;
}

export interface RunHostWatchHandlers {
  onOpen?: () => void;
  onSnapshot: (snapshot: RunHostAttachSnapshot) => void;
  onError?: (message: string) => void;
  /** Fired once when the socket closes (clean or not) — the caller owns
   * reconnect/backoff and the poll fallback. */
  onClose?: () => void;
}

export interface RunHostWatchHandle {
  close: () => void;
}

/**
 * Open a `/run/watch` WebSocket and surface each pushed snapshot. Thin by
 * design — single connection, no reconnect: the polling lifecycle, backoff,
 * and poll fallback live in `useRunHostAttach` (the owning coordinator), the
 * same lib/hook split the attach poll uses. The DO advances the cursor
 * server-side per socket, so the client sends nothing in steady state; the
 * initial cursor rides the upgrade query like the poll's `sinceSavedAt`.
 *
 * Auth rides the same-origin session cookie on the WS upgrade (browsers can't
 * set upgrade headers) — the universal GitHub-identity gate, same bearer as
 * the poll. Returns a handle whose `close()` is idempotent and suppresses the
 * `onClose` callback (a caller-initiated teardown isn't a reconnect trigger).
 */
export function watchRunHost(
  scope: RunHostScope,
  sinceSavedAt: number | null,
  handlers: RunHostWatchHandlers,
): RunHostWatchHandle {
  const params = new URLSearchParams({
    repoFullName: scope.repoFullName,
    branch: scope.branch,
    chatId: scope.chatId,
  });
  if (sinceSavedAt !== null) params.set('sinceSavedAt', String(sinceSavedAt));

  let closedByCaller = false;
  let ws: WebSocket | null = null;
  try {
    ws = new WebSocket(resolveWatchWsUrl(`${WATCH_PATH}?${params.toString()}`));
  } catch (err) {
    // `new WebSocket` throws synchronously on a malformed URL — report and let
    // the caller fall back to the poll.
    handlers.onError?.(err instanceof Error ? err.message : String(err));
    handlers.onClose?.();
    return { close: () => {} };
  }

  ws.addEventListener('open', () => handlers.onOpen?.());
  ws.addEventListener('message', (event: MessageEvent) => {
    if (typeof event.data !== 'string') return;
    let frame: RunHostWatchServerFrame;
    try {
      frame = JSON.parse(event.data) as RunHostWatchServerFrame;
    } catch {
      return; // non-JSON control frame — ignore.
    }
    if (frame.t === 'snapshot') {
      const snapshot = parseAttachSnapshot(frame.snapshot);
      if (snapshot) handlers.onSnapshot(snapshot);
      else log('warn', 'run_host_watch_parse_failed', { chatId: scope.chatId });
    } else if (frame.t === 'error') {
      handlers.onError?.(frame.message);
    }
  });
  ws.addEventListener('error', () => {
    if (!closedByCaller) handlers.onError?.('watch socket error');
  });
  ws.addEventListener('close', () => {
    if (!closedByCaller) handlers.onClose?.();
  });

  return {
    close: () => {
      closedByCaller = true;
      try {
        ws?.close();
      } catch {
        // already closed.
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

export interface RunHostControlResult {
  ok: boolean;
  status?: number;
  state?: RunLifecycleState;
  message?: string;
}

async function postControl(
  path: string,
  body: Record<string, unknown>,
): Promise<RunHostControlResult> {
  let res: Response;
  try {
    res = await fetch(resolveApiUrl(path), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err: unknown) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      message: typeof parsed.error === 'string' ? parsed.error : `request failed (${res.status})`,
    };
  }
  return {
    ok: true,
    status: res.status,
    state:
      typeof parsed.state === 'string' && LIFECYCLE.has(parsed.state)
        ? (parsed.state as RunLifecycleState)
        : undefined,
  };
}

export function submitRunHostApproval(
  scope: RunHostScope,
  runId: string,
  approvalId: string,
  decision: 'approve' | 'deny',
): Promise<RunHostControlResult> {
  return postControl(APPROVAL_PATH, { scope, runId, approvalId, decision });
}

export function stopRunHostRun(scope: RunHostScope, runId: string): Promise<RunHostControlResult> {
  return postControl(STOP_PATH, { scope, runId });
}

export function releaseRunHostRun(
  scope: RunHostScope,
  runId: string,
): Promise<RunHostControlResult> {
  return postControl(RELEASE_PATH, { scope, runId });
}

// ---------------------------------------------------------------------------
// Transcript hydration (pure planning — the hook applies the plan)
// ---------------------------------------------------------------------------

/** Friendlier display text for the runtime scaffolding notes the adoption
 * loop writes into the transcript — the model needs the full note verbatim
 * (it stays in `content`, which is what the next send replays); the human
 * reading the chat needs one line. */
function displayLabelForNote(content: string): string | null {
  if (content.startsWith(ADOPTION_RESUME_NOTE_MARKER)) {
    return 'Run continued server-side while you were away.';
  }
  if (content.startsWith(ADOPTION_APPROVAL_RESOLVED_NOTE_MARKER)) {
    return 'Approval decision delivered to the server-side run.';
  }
  return null;
}

/** The capture side encodes non-image attachments as fenced text blocks
 * (`run-checkpoint-capture.ts` toRunCheckpointMessages) — this is the exact
 * inverse, so hydrated messages re-capture identically. */
const ATTACHED_FILE_PART = /^\[Attached file: (.+)\]\n```\n([\s\S]*)\n```$/;

function dataUrlMime(url: string): string | null {
  const match = /^data:([^;,]+)[;,]/.exec(url);
  return match ? match[1] : null;
}

/**
 * Rebuild a checkpoint message's multimodal payload as ChatMessage
 * attachments — the representation the wire builder converts BACK into
 * contentBlocks on the next send, so images and attached files survive
 * hydration instead of degrading to the text fallback. Anything that doesn't
 * round-trip cleanly is folded into `content` verbatim: lossy formatting
 * beats lost context.
 */
function rebuildAttachments(msg: RunCheckpointMessage): {
  content: string;
  attachments?: AttachmentData[];
} {
  if (
    (!msg.contentBlocks || msg.contentBlocks.length === 0) &&
    (!msg.contentParts || msg.contentParts.length === 0)
  ) {
    return { content: msg.content };
  }
  const attachments: AttachmentData[] = [];
  const extraText: string[] = [];

  function pushImage(url: string, mimeType = dataUrlMime(url) ?? 'image/*'): void {
    attachments.push({
      id: createId(),
      type: 'image',
      filename: `attachment-${attachments.length + 1}`,
      mimeType,
      sizeBytes: url.length,
      content: url,
    });
  }

  function pushText(text: string): void {
    // The message's own text rides in `content` already.
    if (text === msg.content) return;
    const fileMatch = ATTACHED_FILE_PART.exec(text);
    if (fileMatch) {
      attachments.push({
        id: createId(),
        type: 'document',
        filename: fileMatch[1],
        mimeType: 'text/plain',
        sizeBytes: fileMatch[2].length,
        content: fileMatch[2],
      });
      return;
    }
    extraText.push(text);
  }

  if (msg.contentBlocks && msg.contentBlocks.length > 0) {
    for (const block of msg.contentBlocks) {
      if (block.type === 'image') {
        const source = block.source;
        if (source.type === 'base64') {
          pushImage(`data:${source.media_type};base64,${source.data}`, source.media_type);
        } else {
          pushImage(source.url);
        }
      } else if (block.type === 'text') {
        pushText(block.text);
      }
    }
  } else {
    for (const part of msg.contentParts ?? []) {
      if (part.type === 'image_url') {
        pushImage(part.image_url.url);
      } else {
        pushText(part.text);
      }
    }
  }
  const content =
    extraText.length > 0 ? [msg.content, ...extraText].filter(Boolean).join('\n\n') : msg.content;
  return { content, ...(attachments.length > 0 ? { attachments } : {}) };
}

/** Convert a slice of host checkpoint messages into displayable (and
 * replayable — the next send seeds its wire history from the conversation)
 * ChatMessages. System turns never enter the conversation (the wire builder
 * re-derives them); tool turns become the synthetic tool-result user
 * messages the transcript renderer already collapses; multimodal
 * contentParts are rebuilt as attachments so they re-capture identically. */
export function checkpointMessagesToChatMessages(
  messages: readonly RunCheckpointMessage[],
): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') continue;
    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    const displayContent =
      role === 'user' ? (displayLabelForNote(msg.content) ?? undefined) : undefined;
    const { content, attachments } = rebuildAttachments(msg);
    out.push({
      id: createId(),
      role,
      content,
      ...(displayContent ? { displayContent } : {}),
      ...(attachments ? { attachments } : {}),
      timestamp: Date.now(),
      status: 'done',
      ...(msg.reasoningBlocks && role === 'assistant'
        ? { reasoningBlocks: msg.reasoningBlocks }
        : {}),
      ...(msg.responsesReasoningItems && role === 'assistant'
        ? { responsesReasoningItems: msg.responsesReasoningItems }
        : {}),
      ...(msg.isToolCall ? { isToolCall: true } : {}),
      ...(msg.isToolResult || msg.role === 'tool' ? { isToolResult: true } : {}),
    });
  }
  return out;
}

export interface TranscriptHydrationPlan {
  /** `append` adds the gap suffix to the existing conversation; `replace`
   * swaps the whole transcript in (no safe alignment anchor). */
  mode: 'append' | 'replace';
  messages: ChatMessage[];
  /** Host message count this plan brings the client up to — becomes the next
   * hydration anchor. */
  hostMessageCount: number;
}

/**
 * Decide how to fold the host transcript into the local conversation.
 *
 * `anchorCount` is the number of host-side checkpoint messages already
 * represented locally — the message count of the client's own last mirrored
 * V1 checkpoint for the same run (0 when there isn't one). The host
 * transcript's prefix up to that anchor is, by construction, the transcript
 * this client mirrored up before going silent, so everything past it is the
 * server-side gap.
 *
 * Fallbacks are deliberate:
 *   - anchor 0 + empty conversation → append everything (fresh client).
 *   - anchor 0 + non-empty conversation → replace (no safe alignment).
 *   - host shorter than the anchor → replace (server-side context
 *     compaction rewrote the prefix; counts no longer align).
 *   - nothing past the anchor → null (nothing new to hydrate).
 */
export function planTranscriptHydration(args: {
  hostCheckpoint: RunCheckpointV1;
  anchorCount: number;
  localMessageCount: number;
}): TranscriptHydrationPlan | null {
  const host = args.hostCheckpoint.messages;
  if (args.anchorCount > 0) {
    if (host.length === args.anchorCount) return null;
    if (host.length < args.anchorCount) {
      return {
        mode: 'replace',
        messages: checkpointMessagesToChatMessages(host),
        hostMessageCount: host.length,
      };
    }
    return {
      mode: 'append',
      messages: checkpointMessagesToChatMessages(host.slice(args.anchorCount)),
      hostMessageCount: host.length,
    };
  }
  if (host.length === 0) return null;
  return {
    mode: args.localMessageCount === 0 ? 'append' : 'replace',
    messages: checkpointMessagesToChatMessages(host),
    hostMessageCount: host.length,
  };
}
