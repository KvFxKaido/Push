/**
 * useBackgroundCoderJob — owns the client side of background Coder
 * delegation jobs (PR #3b).
 *
 * Responsibilities, all behind a narrow hook surface so the
 * `AGENTS.md` §"new feature checklist #2" rule holds — this lives in
 * its own module, not in `useChat.ts`:
 *
 *   - `startJob(...)`  POST `/api/jobs/start`, persist a
 *                      `BackgroundJobPersistenceEntry`, append a
 *                      `coder-job` ChatCard to the transcript, and
 *                      open an SSE connection to `/api/jobs/:id/events`.
 *                      Returns a discriminated result the caller folds
 *                      into the `ToolExecutionResult` the orchestrator
 *                      loop consumes.
 *   - `cancelJob(id)`  POST `/api/jobs/:id/cancel`. Best-effort.
 *   - SSE dispatch     Each server event is re-stamped through
 *                      `appendRunEvent` (so the run-event journal sees
 *                      it) and folded into the JobCard's mutable data
 *                      via `setConversations`. The server-stamped id
 *                      is preserved only in `pendingJobIds` so it can
 *                      be sent as `Last-Event-ID` on reconnect — the
 *                      journal path keeps its own id allocation.
 *   - Reconnect        On `visibilitychange → visible`, every
 *                      non-terminal entry in every chat's
 *                      `pendingJobIds` opens a fresh SSE stream with
 *                      `Last-Event-ID: <latest seen>` — matches the
 *                      header-only replay contract the server ships.
 *
 * Orchestrator semantics (locked in PR #3b): the `delegate_coder` turn
 * in background mode returns a real placeholder ToolExecutionResult
 * worded as *accepted and queued*, not *completed*. The background
 * job's final summary never enters `apiMessages` — it flows to the
 * JobCard + run timeline only.
 */

import type React from 'react';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { appendCardsToLatestToolCall } from '@/lib/chat-tool-messages';
import { createId } from './chat-persistence';
import type {
  AgentStatus,
  AgentStatusSource,
  AIProviderType,
  BackgroundJobPersistenceEntry,
  BackgroundJobStatus,
  ChatCard,
  ChatMessage,
  CoderJobCardData,
  Conversation,
  DelegationEnvelope,
  RunEvent,
  RunEventInput,
  UserProfile,
} from '@/types';
import type { Capability } from '@/lib/capabilities';
import type { VerificationPolicy } from '@/lib/verification-policy';
import type { CorrelationContext } from '@push/lib/correlation-context';
import type { ChatRef } from '@/worker/coder-job-do';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface StartBackgroundJobInput {
  chatId: string;
  repoFullName: string;
  branch: string;
  sandboxId: string;
  ownerToken: string;
  envelope: DelegationEnvelope;
  provider: AIProviderType;
  model: string | undefined;
  userProfile: UserProfile | null;
  verificationPolicy?: VerificationPolicy;
  declaredCapabilities?: Capability[];
  correlation?: CorrelationContext;
  taskPreview?: string;
  /** Reference to durable chat/session state. PR 2 forwards this to
   *  the DO unchanged; PR 3 wires the loader. */
  chatRef?: ChatRef;
}

export type StartBackgroundJobResult = { ok: true; jobId: string } | { ok: false; error: string };

export interface UseBackgroundCoderJobParams {
  setConversations: React.Dispatch<React.SetStateAction<Record<string, Conversation>>>;
  conversationsRef: React.MutableRefObject<Record<string, Conversation>>;
  appendRunEvent: (chatId: string, event: RunEventInput) => void;
  updateAgentStatus: (
    status: AgentStatus,
    meta?: { chatId?: string; source?: AgentStatusSource; log?: boolean },
  ) => void;
}

export interface UseBackgroundCoderJobResult {
  /** Start a background Coder job for a `delegate_coder` tool call. The
   *  JobCard is appended to the latest assistant tool-call message; the
   *  caller is the delegation handler running inside an in-progress
   *  assistant turn. */
  startJob: (input: StartBackgroundJobInput) => Promise<StartBackgroundJobResult>;
  /** Start a background Coder job for a main-chat user message. The
   *  JobCard is rendered as a fresh assistant message because main chat
   *  has no in-progress tool-call message to attach to. PR 2 — see
   *  docs/runbooks/Background Coder Tasks Phase 2.md. */
  startMainChatJob: (input: StartBackgroundJobInput) => Promise<StartBackgroundJobResult>;
  cancelJob: (jobId: string) => Promise<void>;
  /** Exposed so the delegation branch point can render the placeholder
   * text with the real job id. */
  formatPlaceholderText: (jobId: string) => string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES: ReadonlySet<BackgroundJobStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

function isTerminalStatus(status: BackgroundJobStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

// ---------------------------------------------------------------------------
// Protocol adapter: minimal SSE parser
//
// Supports only what coder-job-do.ts emits:
//   id: <uuid>
//   event: <type>
//   data: <json>
//   <blank line>
//
// Not a general-purpose SSE client. If the server adds multi-line data
// blocks or comments, extend this — don't reach for an npm package.
// ---------------------------------------------------------------------------

interface ParsedSseEvent {
  id: string | null;
  event: string | null;
  data: string;
}

function parseSseBlock(block: string): ParsedSseEvent | null {
  let id: string | null = null;
  let event: string | null = null;
  let data = '';
  let hasData = false;

  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon);
    const value = line.slice(colon + 1).replace(/^ /, '');
    if (field === 'id') id = value;
    else if (field === 'event') event = value;
    else if (field === 'data') {
      data = hasData ? `${data}\n${value}` : value;
      hasData = true;
    }
  }

  if (!hasData) return null;
  return { id, event, data };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useBackgroundCoderJob({
  setConversations,
  conversationsRef,
  appendRunEvent,
  updateAgentStatus,
}: UseBackgroundCoderJobParams): UseBackgroundCoderJobResult {
  // Open SSE streams, keyed by jobId. Abort controllers drop the
  // connection on cancel / unmount / branch reconnect.
  const openStreamsRef = useRef<Map<string, AbortController>>(new Map());

  const formatPlaceholderText = useCallback((jobId: string): string => {
    return (
      `Coder delegation accepted and queued as background job ${jobId}. ` +
      `Progress will appear in the JobCard and run timeline — ` +
      `it will not continue this assistant turn.`
    );
  }, []);

  // -------------------------------------------------------------------------
  // Persistence helpers — all mutate Conversation through setConversations,
  // so the existing saveConversationToDB flush picks them up.
  // -------------------------------------------------------------------------

  const upsertJobEntry = useCallback(
    (chatId: string, jobId: string, patch: Partial<BackgroundJobPersistenceEntry>) => {
      setConversations((prev) => {
        const conv = prev[chatId];
        if (!conv) return prev;
        const existing = conv.pendingJobIds?.[jobId];
        const merged: BackgroundJobPersistenceEntry = {
          jobId,
          status: patch.status ?? existing?.status ?? 'queued',
          lastEventId: patch.lastEventId ?? existing?.lastEventId ?? null,
          startedAt: patch.startedAt ?? existing?.startedAt ?? Date.now(),
          updatedAt: Date.now(),
          taskPreview: patch.taskPreview ?? existing?.taskPreview,
        };
        return {
          ...prev,
          [chatId]: {
            ...conv,
            pendingJobIds: { ...(conv.pendingJobIds ?? {}), [jobId]: merged },
          },
        };
      });
    },
    [setConversations],
  );

  const upsertJobCardData = useCallback(
    (chatId: string, jobId: string, patch: Partial<CoderJobCardData>) => {
      setConversations((prev) => {
        const conv = prev[chatId];
        if (!conv) return prev;
        const messages = conv.messages;
        let found = false;
        const nextMessages: ChatMessage[] = messages.map((msg) => {
          if (found || !msg.cards || msg.cards.length === 0) return msg;
          const nextCards = msg.cards.map((card) => {
            if (card.type !== 'coder-job' || card.data.jobId !== jobId) return card;
            found = true;
            return { ...card, data: { ...card.data, ...patch } };
          });
          if (!found) return msg;
          return { ...msg, cards: nextCards };
        });
        if (!found) return prev;
        return { ...prev, [chatId]: { ...conv, messages: nextMessages } };
      });
    },
    [setConversations],
  );

  /** Delegation placement: the JobCard attaches to the latest in-progress
   *  tool-call message. Used by `startJob` (delegate_coder background
   *  flow) — the caller is the delegation handler, which guarantees an
   *  assistant tool-call message is the latest entry. Do NOT route
   *  through `filterDelegationCardsForInlineDisplay` — that helper's
   *  whitelist excludes `coder-job` and would drop the card silently. */
  const appendJobCardToToolCall = useCallback(
    (chatId: string, card: ChatCard) => {
      setConversations((prev) => {
        const conv = prev[chatId];
        if (!conv) return prev;
        const msgs = appendCardsToLatestToolCall(conv.messages, [card]);
        return { ...prev, [chatId]: { ...conv, messages: msgs } };
      });
    },
    [setConversations],
  );

  /** Main-chat placement: the JobCard goes onto a fresh assistant
   *  message. Used by `startMainChatJob` (PR 2's main-chat-on-server
   *  branch) — there's no in-progress tool-call message because the
   *  user just typed a message. The new assistant message has empty
   *  text content and carries the card as its only payload; SSE
   *  terminal events update the card data in place. */
  const appendJobCardAsNewAssistantMessage = useCallback(
    (chatId: string, card: ChatCard) => {
      setConversations((prev) => {
        const conv = prev[chatId];
        if (!conv) return prev;
        const newMessage: ChatMessage = {
          id: createId(),
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          cards: [card],
        };
        return {
          ...prev,
          [chatId]: {
            ...conv,
            messages: [...conv.messages, newMessage],
            lastMessageAt: Date.now(),
          },
        };
      });
    },
    [setConversations],
  );

  // -------------------------------------------------------------------------
  // SSE dispatch — translate server-stamped RunEvent into local events +
  // card + persistence updates. Server is authoritative for id + timestamp
  // (preserved in pendingJobIds.lastEventId for replay) but appendRunEvent
  // re-stamps for the journal because its contract takes RunEventInput.
  // -------------------------------------------------------------------------

  const dispatchServerEvent = useCallback(
    (chatId: string, jobId: string, parsed: ParsedSseEvent) => {
      let runEvent: RunEvent;
      try {
        runEvent = JSON.parse(parsed.data) as RunEvent;
      } catch (err) {
        console.warn('[useBackgroundCoderJob] Failed to parse SSE event', err);
        return;
      }

      // Feed the journal / timeline. appendRunEvent assigns its own
      // id/timestamp — the server id is preserved only for replay.
      const { id: _serverId, timestamp: _serverTs, ...eventInput } = runEvent;
      void _serverId;
      void _serverTs;
      appendRunEvent(chatId, eventInput as RunEventInput);

      // Every dispatched event counts as server activity; the JobCard
      // uses lastEventAt with status='running' to detect stalled runs.
      const eventAt = Date.now();

      // Card + persistence updates keyed off the event type. The DO's
      // SSE stream emits `job.*` events (role-aware AgentJob lifecycle);
      // the foreground delegation runtime emits `subagent.*` through a
      // different code path and never reaches this hook.
      //
      // The `subagent.*` arms in the switch are a deliberate
      // backward-compatibility shim, not a steady-state design: an
      // in-flight DO that started under the previous (subagent.*)
      // contract has those events persisted in its SQLite event log.
      // After a worker bundle redeploy, SSE replay sends the historical
      // `subagent.*` mixed with fresh `job.*`. Without these arms the
      // legacy terminals fall into the default and the job is stuck at
      // 'running' forever in the UI. Once any in-flight DO from the
      // pre-PR-1 contract has finished and its events have been
      // garbage-collected, these arms can be deleted (PR 2 cleanup).
      switch (runEvent.type) {
        case 'job.started':
        case 'subagent.started': {
          upsertJobEntry(chatId, jobId, {
            status: 'running',
            lastEventId: runEvent.id,
          });
          upsertJobCardData(chatId, jobId, {
            status: 'running',
            latestStatusLine: runEvent.detail ?? 'Running',
            lastEventAt: eventAt,
          });
          break;
        }
        case 'job.completed':
        case 'subagent.completed': {
          const finishedAt = Date.now();
          upsertJobEntry(chatId, jobId, {
            status: 'completed',
            lastEventId: runEvent.id,
          });
          upsertJobCardData(chatId, jobId, {
            status: 'completed',
            latestStatusLine: 'Completed',
            summary: runEvent.summary,
            finishedAt,
            lastEventAt: eventAt,
          });
          // Do NOT emit DELEGATION_COMPLETED here. The foreground
          // orchestrator already emitted it synchronously at
          // placeholder-return time (chat-send.ts after the
          // `executeDelegateCall` return for `source === 'delegate'`).
          // Re-emitting it from this async SSE terminal handler would
          // flip the run engine phase from 'completed' back to
          // 'executing_tools' after LOOP_COMPLETED, making
          // `isRunActive` true again and causing the user's next
          // `sendMessage` to be queued as a follow-up instead of
          // starting a fresh run. Background jobs are out-of-band —
          // the run engine tracks the foreground turn only.
          updateAgentStatus(
            { active: false, phase: 'Background Coder completed' },
            { chatId, log: false },
          );
          break;
        }
        case 'job.failed':
        case 'subagent.failed': {
          // Server uses status=cancelled on abort — distinguish by the
          // error text only as a hint; canonical status comes from the
          // /status snapshot path when we add it.
          const cancelled = /abort|cancel/i.test(runEvent.error);
          const finishedAt = Date.now();
          upsertJobEntry(chatId, jobId, {
            status: cancelled ? 'cancelled' : 'failed',
            lastEventId: runEvent.id,
          });
          upsertJobCardData(chatId, jobId, {
            status: cancelled ? 'cancelled' : 'failed',
            latestStatusLine: cancelled ? 'Cancelled' : 'Failed',
            error: runEvent.error,
            finishedAt,
            lastEventAt: eventAt,
          });
          // See job.completed above — same reason for omitting
          // `emitRunEngineEvent(DELEGATION_COMPLETED)`.
          updateAgentStatus(
            {
              active: false,
              phase: cancelled ? 'Background job cancelled' : 'Background job failed',
            },
            { chatId, log: false },
          );
          break;
        }
        default:
          // PR 1 only emits the three job.* events above. Anything
          // else is either a future event type (benign — appended to
          // the journal already, and still counted as activity so the
          // stall clock resets) or drift that a future PR will want
          // to handle explicitly.
          upsertJobEntry(chatId, jobId, { lastEventId: runEvent.id });
          upsertJobCardData(chatId, jobId, { lastEventAt: eventAt });
          break;
      }
    },
    [appendRunEvent, updateAgentStatus, upsertJobCardData, upsertJobEntry],
  );

  // -------------------------------------------------------------------------
  // SSE connection — fetch + ReadableStream + minimal block parser. No
  // retry loop; visibilitychange reconnect is the recovery path in
  // Phase 1.
  // -------------------------------------------------------------------------

  const openSseStream = useCallback(
    async (chatId: string, jobId: string, lastEventId: string | null) => {
      if (openStreamsRef.current.has(jobId)) return;
      const controller = new AbortController();
      openStreamsRef.current.set(jobId, controller);

      const headers: Record<string, string> = { Accept: 'text/event-stream' };
      if (lastEventId) headers['Last-Event-ID'] = lastEventId;

      try {
        const resp = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/events`, {
          method: 'GET',
          headers,
          signal: controller.signal,
        });
        if (!resp.ok || !resp.body) {
          console.warn(
            `[useBackgroundCoderJob] Failed to open SSE stream for ${jobId}: ${resp.status}`,
          );
          openStreamsRef.current.delete(jobId);
          return;
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            let blockEnd: number;
            while ((blockEnd = buffer.indexOf('\n\n')) !== -1) {
              const block = buffer.slice(0, blockEnd);
              buffer = buffer.slice(blockEnd + 2);
              if (!block) continue;
              const parsed = parseSseBlock(block);
              if (parsed) dispatchServerEvent(chatId, jobId, parsed);
            }
          }
        } finally {
          reader.releaseLock();
        }
      } catch (err) {
        if ((err as { name?: string })?.name !== 'AbortError') {
          console.warn(`[useBackgroundCoderJob] SSE stream for ${jobId} errored`, err);
        }
      } finally {
        openStreamsRef.current.delete(jobId);
      }
    },
    [dispatchServerEvent],
  );

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Shared start path: posts to /api/jobs/start, persists the
   *  pendingJobIds entry, places the JobCard via the supplied
   *  `placeCard` strategy, and opens the SSE stream. The two public
   *  start entry points (`startJob` / `startMainChatJob`) differ only
   *  in card placement, so they thread the same input through this
   *  core and pass different placement functions. */
  const persistAndStart = useCallback(
    async (
      input: StartBackgroundJobInput,
      placeCard: (chatId: string, card: ChatCard) => void,
    ): Promise<StartBackgroundJobResult> => {
      // Send exactly the fields the server contract expects. jobId +
      // origin are deliberately not passed — server fills them to
      // preserve the SSRF + id-guess hardening from PR #359. `role` is
      // sent explicitly: today only `'coder'` is valid, and the worker
      // route + DO both reject anything else with `UNSUPPORTED_ROLE`.
      // `chatRef` is forwarded as wire-shape only in PR 2; the DO
      // persists it but does not dereference yet (PR 3).
      const body = {
        role: 'coder' as const,
        chatId: input.chatId,
        repoFullName: input.repoFullName,
        branch: input.branch,
        sandboxId: input.sandboxId,
        ownerToken: input.ownerToken,
        envelope: input.envelope,
        provider: input.provider,
        model: input.model,
        userProfile: input.userProfile,
        verificationPolicy: input.verificationPolicy,
        declaredCapabilities: input.declaredCapabilities,
        correlation: input.correlation,
        acceptanceCriteria: input.envelope.acceptanceCriteria,
        projectInstructions: input.envelope.projectInstructions,
        instructionFilename: input.envelope.instructionFilename,
        chatRef: input.chatRef,
      };

      let resp: Response;
      try {
        resp = await fetch('/api/jobs/start', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (err) {
        return {
          ok: false,
          error: `Network error starting background job: ${(err as Error).message}`,
        };
      }

      if (!resp.ok) {
        let detail = `HTTP ${resp.status}`;
        try {
          const json = (await resp.json()) as { error?: string; message?: string };
          if (json?.error) detail = `${json.error}${json.message ? `: ${json.message}` : ''}`;
        } catch {
          // fall through with HTTP status
        }
        return { ok: false, error: detail };
      }

      const { jobId } = (await resp.json()) as { jobId: string };

      // Persist the job and drop an initial JobCard into the transcript.
      // Status starts at 'queued' because the DO's job.started event
      // will promote it to 'running' when the stream drains.
      const startedAt = Date.now();
      upsertJobEntry(input.chatId, jobId, {
        status: 'queued',
        lastEventId: null,
        startedAt,
        taskPreview: input.taskPreview,
      });

      const initialCard: ChatCard = {
        type: 'coder-job',
        data: {
          jobId,
          chatId: input.chatId,
          status: 'queued',
          startedAt,
          // Seed lastEventAt so stall detection has a baseline before
          // the first SSE event arrives. Without this, a run stuck
          // mid-queue would look "fresh" (undefined → null elapsed)
          // and never trigger the stall banner.
          lastEventAt: startedAt,
          taskPreview: input.taskPreview,
          latestStatusLine: 'Queued',
        },
      };
      placeCard(input.chatId, initialCard);

      // Fire the SSE stream — don't await; the orchestrator turn ends
      // immediately and the job progresses asynchronously.
      void openSseStream(input.chatId, jobId, null);

      return { ok: true, jobId };
    },
    [openSseStream, upsertJobEntry],
  );

  const startJob = useCallback(
    (input: StartBackgroundJobInput) => persistAndStart(input, appendJobCardToToolCall),
    [persistAndStart, appendJobCardToToolCall],
  );

  /** Resolves the latest completed background-job id for a chat. Used
   *  to auto-fill chatRef.checkpointId when the caller didn't supply
   *  one — keeps multi-turn continuity working without forcing every
   *  call site to know about pendingJobIds bookkeeping. Returns null
   *  for fresh chats. */
  const resolveLatestCompletedJobId = useCallback(
    (chatId: string): string | null => {
      const conv = conversationsRef.current[chatId];
      const pending = conv?.pendingJobIds;
      if (!pending) return null;
      let latest: { jobId: string; updatedAt: number } | null = null;
      for (const entry of Object.values(pending)) {
        if (entry.status !== 'completed') continue;
        if (!latest || entry.updatedAt > latest.updatedAt) {
          latest = { jobId: entry.jobId, updatedAt: entry.updatedAt };
        }
      }
      return latest?.jobId ?? null;
    },
    [conversationsRef],
  );

  const startMainChatJob = useCallback(
    (input: StartBackgroundJobInput) => {
      // PR 3: auto-fill chatRef.checkpointId from the latest completed
      // bg job for this chat unless the caller already set one. Caller
      // can pass an explicit checkpointId to fork from a specific turn,
      // or pass `chatRef: undefined` to opt out of continuity entirely
      // (rare; typically only relevant for tests).
      let chatRef = input.chatRef;
      if (chatRef && chatRef.checkpointId === undefined) {
        const latest = resolveLatestCompletedJobId(input.chatId);
        if (latest) chatRef = { ...chatRef, checkpointId: latest };
      }
      return persistAndStart({ ...input, chatRef }, appendJobCardAsNewAssistantMessage);
    },
    [persistAndStart, appendJobCardAsNewAssistantMessage, resolveLatestCompletedJobId],
  );

  const cancelJob = useCallback(async (jobId: string): Promise<void> => {
    try {
      await fetch(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
    } catch (err) {
      console.warn(`[useBackgroundCoderJob] Failed to cancel ${jobId}`, err);
    }
  }, []);

  // -------------------------------------------------------------------------
  // Reconnect on foreground — the third visibilitychange listener per
  // the runbook. Existing listeners are in useChat.ts (persistence
  // flush) and useChatCheckpoint.ts (run checkpoint flush); this one
  // owns *only* the background-job SSE replay.
  // -------------------------------------------------------------------------

  const resumeAllNonTerminalJobs = useCallback(() => {
    const conversations = conversationsRef.current;
    for (const chatId of Object.keys(conversations)) {
      const pending = conversations[chatId]?.pendingJobIds;
      if (!pending) continue;
      for (const entry of Object.values(pending)) {
        if (isTerminalStatus(entry.status)) continue;
        if (openStreamsRef.current.has(entry.jobId)) continue;
        void openSseStream(chatId, entry.jobId, entry.lastEventId);
      }
    }
  }, [conversationsRef, openSseStream]);

  useEffect(() => {
    // On mount, resume any non-terminal jobs immediately if the tab
    // is already foregrounded. The `visibilitychange` event only
    // fires on *changes*, so without this initial sweep a page load
    // with restored `pendingJobIds` would wait for the next
    // background/foreground cycle before reconnecting.
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      resumeAllNonTerminalJobs();
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        resumeAllNonTerminalJobs();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [resumeAllNonTerminalJobs]);

  // Abort every open stream on unmount. This stops the fetch loop; it
  // does not cancel the server-side job — for that the caller must
  // call cancelJob explicitly.
  useEffect(() => {
    const streams = openStreamsRef.current;
    return () => {
      for (const controller of streams.values()) {
        controller.abort();
      }
      streams.clear();
    };
  }, []);

  return useMemo(
    () => ({ startJob, startMainChatJob, cancelJob, formatPlaceholderText }),
    [startJob, startMainChatJob, cancelJob, formatPlaceholderText],
  );
}
