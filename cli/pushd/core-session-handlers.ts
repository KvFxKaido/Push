/**
 * core-session-handlers.ts — core daemon session/run request handlers.
 *
 * Phase 4 extraction: handlers consume the typed SessionRuntime owner and
 * relay status service. Delegation cancellation and later-phase addressable
 * session verbs remain composed by pushd.ts.
 */
import { execFile } from 'node:child_process';
import os from 'node:os';
import process from 'node:process';
import { promisify } from 'node:util';

import { DAEMON_CAPABILITIES } from '../../lib/daemon-capabilities.js';
import { PROTOCOL_VERSION } from '../../lib/protocol-schema.js';
import { appendAuditEvent } from '../pushd-audit-log.js';
import { auditProvenance } from './audit-provenance.js';
import { validateAttachToken } from './attach-token.js';
import { makeErrorResponse, makeResponse } from './envelopes.js';
import type {
  DaemonEmitEvent,
  DaemonHandler,
  DaemonHandlerContext,
  DaemonRequest,
} from './handler-types.js';
import { normalizeProviderInput } from './provider-input.js';
import type { RelayCoordinator } from './relay-coordinator.js';
import { DEFAULT_RESTART_POLICY, VALID_RESTART_POLICIES } from './restart-policy.js';
import type {
  SessionRuntime,
  SessionRuntimeEntry,
  WorkspaceStateEmitMode,
} from './session-runtime.js';
import { getBuildStamp, peekBuildStamp } from '../build-stamp.js';
import { rebuildDaemonTranscriptMirror } from '../daemon-transcript-mirror.js';
import { buildSystemPrompt, DEFAULT_MAX_ROUNDS, runAssistantTurn } from '../engine.js';
import { appendUserMessageWithFileReferences } from '../file-references.js';
import { PROVIDER_CONFIGS, redirectDeprecatedProvider, resolveApiKey } from '../provider.js';
import {
  appendSessionEvent,
  clearRunMarker,
  createSessionState,
  listSessions,
  loadSessionEvents,
  loadSessionState,
  makeAttachToken,
  makeRunId,
  saveSessionState,
  writeRunMarker,
} from '../session-store.js';
import type { SessionEvent, SessionState } from '../session-store.js';

const execFileAsync = promisify(execFile);

type CoreRequest = Omit<DaemonRequest, 'payload'> & { payload?: any };
type CoreContext = DaemonHandlerContext | null | undefined;

export const VALID_AGENT_ROLES = new Set([
  'orchestrator',
  'explorer',
  'coder',
  'reviewer',
  'auditor',
]);

export interface CoreSessionHandlerDependencies {
  runtime: SessionRuntime;
  relay: RelayCoordinator;
  runtimeVersion: string;
  startedAtMs: number;
  capabilities?: readonly string[];
  loadAndAuthSession(request: any, type: string): Promise<any>;
}

export interface CoreSessionHandlers {
  handleHello: DaemonHandler;
  handlePing: DaemonHandler;
  handleListSessions: DaemonHandler;
  handleStartSession: DaemonHandler;
  handleSendUserMessage: DaemonHandler;
  handleAttachSession: DaemonHandler;
  handleGetSessionMessages: DaemonHandler;
  handleGetSessionSnapshot: DaemonHandler;
  handleSubmitApproval: DaemonHandler;
  handleCancelRun: DaemonHandler;
  handleConfigureRoleRouting: DaemonHandler;
  handleUpdateSession: DaemonHandler;
}

export function createCoreSessionHandlers(
  dependencies: CoreSessionHandlerDependencies,
): CoreSessionHandlers {
  const sessionRuntime = dependencies.runtime;
  const relayCoordinator = dependencies.relay;
  const activeSessions = sessionRuntime.sessions;
  const VERSION = dependencies.runtimeVersion;
  const DAEMON_STARTED_AT_MS = dependencies.startedAtMs;
  const CAPABILITIES = dependencies.capabilities ?? DAEMON_CAPABILITIES;
  const loadAndAuthSession = dependencies.loadAndAuthSession;
  const broadcastEvent = (sessionId: string, event: any) =>
    sessionRuntime.broadcast(sessionId, event);
  const addSessionClient = (
    sessionId: string,
    emitEvent: (event: any) => void,
    capabilities: unknown = [],
  ) => sessionRuntime.addClient(sessionId, emitEvent, capabilities);
  const emitEventWithDowngrade = (
    event: any,
    emitEvent: (event: any) => void,
    capabilities: Set<string>,
  ) => sessionRuntime.emitWithDowngrade(event, emitEvent, capabilities);
  const transcriptSnapshotForClientCapabilities = (mirror: any, capabilities: Set<string>) =>
    sessionRuntime.transcriptSnapshotForCapabilities(mirror, capabilities);
  const eventForClientCapabilities = (event: any, capabilities: Set<string>) =>
    sessionRuntime.eventForCapabilities(event, capabilities);
  const buildApprovalFn = (sessionId: string, entry: any, runId?: string | null) =>
    sessionRuntime.buildApprovalFn(sessionId, entry, runId);
  const noteRunSettled = () => sessionRuntime.noteRunSettled();

  async function handleHello(req: CoreRequest) {
    return makeResponse(req.requestId, 'hello', null, true, {
      runtimeName: 'pushd',
      runtimeVersion: VERSION,
      // Code-freshness token frozen at this daemon's startup. `peekBuildStamp`
      // is non-null once `main()`'s eager capture resolves (well before the
      // first client connect); fall back to an await so a hello that somehow
      // races startup still advertises a real stamp instead of null.
      buildStamp: peekBuildStamp() ?? (await getBuildStamp()),
      protocolVersion: PROTOCOL_VERSION,
      capabilities: CAPABILITIES,
    });
  }

  async function handlePing(req: CoreRequest) {
    return makeResponse(req.requestId, 'ping', null, true, {
      pong: true,
      ts: Date.now(),
    });
  }

  async function handleListSessions(req: CoreRequest) {
    // Validate `limit` instead of accepting any truthy value via `|| 20`.
    // Sibling handlers (e.g. `handleFetchDelegationEvents`) already
    // type-check + bound the field; an unvalidated `limit: '50'` would
    // get passed to `slice()` here and produce surprising results
    // (string coercion + arithmetic vs the array index expectations).
    // Default to 20 (the previous fallback) when the field is missing or
    // malformed; cap at 1000 so a misbehaving client can't ask us to
    // emit megabytes of session metadata in a single response.
    // Floor before bounding so fractional inputs (e.g. `0.5`, which
    // would pass a naive `> 0` but floor to `0`) don't slip through as
    // an accidental empty-result request — anything that doesn't floor
    // to >= 1 falls back to the default.
    const rawLimit = req.payload?.limit;
    const flooredLimit =
      typeof rawLimit === 'number' && Number.isFinite(rawLimit) ? Math.floor(rawLimit) : NaN;
    const limit =
      Number.isFinite(flooredLimit) && flooredLimit >= 1 ? Math.min(flooredLimit, 1000) : 20;

    // Optional mode filter so consumers can ask the server to omit
    // sessions whose origin surface isn't useful in their context. The
    // mobile drawer passes `['headless']` because `./push run` jobs
    // aren't resumable as chats — without server-side filtering, a user
    // with 50 consecutive headless runs would see an empty CLI section
    // even though older interactive sessions exist. Each entry is
    // trimmed before comparison: `handleStartSession` trims the payload
    // before persisting and `listSessions()` trims again on read (see
    // its `stateObj.mode` coalesce), so the listing row always carries
    // a trimmed value. Trimming the filter entries matches that
    // normalization — without it a client sending `' headless '` would
    // silently fail to filter. Strings only; other values are dropped.
    const rawExclude = req.payload?.excludeModes;
    const excludeModes =
      Array.isArray(rawExclude) && rawExclude.length > 0
        ? new Set(
            rawExclude
              .filter((m) => typeof m === 'string')
              .map((m) => m.trim())
              .filter((m) => m.length > 0),
          )
        : null;

    const sessions = await listSessions();
    const filtered =
      excludeModes && excludeModes.size > 0
        ? sessions.filter((s) => !excludeModes.has(s.mode))
        : sessions;
    const limited = filtered.slice(0, limit);

    // Enrich with active run state
    const enriched = limited.map((s) => {
      const entry = activeSessions.get(s.sessionId);
      return {
        ...s,
        state: entry?.activeRunId ? 'running' : 'idle',
        activeRunId: entry?.activeRunId || null,
      };
    });

    return makeResponse(req.requestId, 'list_sessions', null, true, {
      sessions: enriched,
    });
  }

  async function handleStartSession(req: CoreRequest) {
    const payload = req.payload || {};
    // Same fallback chain as cli.ts/tui.ts (explicit → PUSH_PROVIDER →
    // 'ollama'): a caller that omits `provider` should land on the daemon's
    // configured default, not a hardcoded one unrelated to the user's setup.
    const requestedProvider =
      normalizeProviderInput(payload.provider) ||
      normalizeProviderInput(process.env.PUSH_PROVIDER) ||
      'ollama';
    // Retired providers redirect instead of failing the start — same treatment
    // as cli.ts parseProvider / the TUI startup chain (Codex P2, PR #1382).
    const redirectedProvider = redirectDeprecatedProvider(requestedProvider);
    if (redirectedProvider) {
      console.error(
        JSON.stringify({
          level: 'warn',
          event: 'start_session_provider_redirected',
          from: requestedProvider,
          to: redirectedProvider,
        }),
      );
    }
    const provider = redirectedProvider ?? requestedProvider;
    const providerConfig = PROVIDER_CONFIGS[provider];
    if (!providerConfig) {
      return makeErrorResponse(
        req.requestId,
        'start_session',
        'PROVIDER_NOT_CONFIGURED',
        `Unknown provider: ${provider}`,
      );
    }

    const cwd = payload.repo?.rootPath || process.cwd();
    const model = payload.model || PROVIDER_CONFIGS[provider].defaultModel;
    const restartPolicy = VALID_RESTART_POLICIES.has(payload.restartPolicy)
      ? payload.restartPolicy
      : DEFAULT_RESTART_POLICY;
    const now = Date.now();
    // Tag the session with its origin surface so `list_sessions` (and the
    // mobile drawer that consumes it) can bucket Remote / CLI without
    // re-deriving the mode from local UI state. Mirrors the value
    // that gets broadcast in the `session_started` event below; the two
    // must stay in sync so the live event and the persisted state.json
    // agree.
    const mode =
      typeof payload.mode === 'string' && payload.mode.trim() ? payload.mode.trim() : 'interactive';

    // Route through the shared factory so the attach token is minted at birth
    // by the same helper the TUI/CLI use (Universal Session Bearer). The
    // persisted token lets disk-reload paths (daemon restart, session eviction,
    // cross-handler lazy load) restore the SAME token the client received here
    // instead of minting a fresh one and rejecting the client's original.
    const state = {
      ...createSessionState({
        provider,
        model,
        cwd,
        mode,
        now,
        messages: [{ role: 'system', content: await buildSystemPrompt(cwd) }],
      }),
      restartPolicy,
      roleRouting: {},
      delegationOutcomes: [],
    } as unknown as SessionState;
    const { sessionId, attachToken } = state;

    await appendSessionEvent(state, 'session_started', {
      sessionId,
      state: 'idle',
      mode,
      provider,
      sandboxProvider: payload.sandboxProvider || 'local',
    });
    await saveSessionState(state);

    const sessionEntry = { state, attachToken };
    activeSessions.set(sessionId, sessionEntry);
    // Anchor the workspace-state timeline for this session (fire-and-forget: the
    // opener shouldn't block the start response on a git read).
    void emitWorkspaceState(sessionId, sessionEntry, 'snapshot');

    return makeResponse(req.requestId, 'start_session', sessionId, true, {
      sessionId,
      state: 'idle',
      attachToken,
      roleRouting: state.roleRouting,
    });
  }

  async function handleSendUserMessage(req: CoreRequest, emitEvent: DaemonEmitEvent) {
    const sessionId = req.sessionId || req.payload?.sessionId;
    const text = req.payload?.text;

    if (!sessionId || !text) {
      return makeErrorResponse(
        req.requestId,
        'send_user_message',
        'INVALID_REQUEST',
        'sessionId and text are required',
      );
    }

    let entry = activeSessions.get(sessionId);
    if (!entry) {
      try {
        const state = await loadSessionState(sessionId);
        // Restore the persisted attach token from session state instead of
        // minting a fresh one. Without this, clients lose their token on any
        // handler that lazy-loads a session from disk (including after a
        // daemon crash + restart), because `validateAttachToken` would
        // compare the caller's original token against a freshly minted one.
        // Legacy sessions without a persisted token load with attachToken
        // undefined; they are claimed on first `attach_session` (bootstrap
        // grace). A non-attach handler reached before that claim now rejects —
        // the implicit tokenless bypass is gone (Universal Session Bearer).
        entry = { state, attachToken: state.attachToken };
        activeSessions.set(sessionId, entry);
      } catch {
        return makeErrorResponse(
          req.requestId,
          'send_user_message',
          'SESSION_NOT_FOUND',
          `Session not found: ${sessionId}`,
        );
      }
    }

    // Reject if a run is already in progress
    if (entry.activeRunId) {
      return makeErrorResponse(
        req.requestId,
        'send_user_message',
        'RUN_IN_PROGRESS',
        `Run ${entry.activeRunId} is already active`,
      );
    }

    // Refuse new runs once draining: the daemon is on its way out for a runtime
    // refresh, so starting work here would run it on stale code. The client
    // routes around this by respawning a fresh daemon and retrying there.
    if (sessionRuntime.isDraining()) {
      return makeErrorResponse(
        req.requestId,
        'send_user_message',
        'DAEMON_DRAINING',
        'Daemon is draining for a runtime refresh; retry on the fresh daemon.',
      );
    }

    const providedToken = req.payload?.attachToken;
    if (!validateAttachToken(entry, providedToken)) {
      return makeErrorResponse(
        req.requestId,
        'send_user_message',
        'INVALID_TOKEN',
        'Invalid or missing attach token',
      );
    }

    const { state } = entry;

    if (!entry.transcriptMirror) {
      const priorEvents = await loadSessionEvents(sessionId).catch(() => []);
      entry.transcriptMirror = rebuildDaemonTranscriptMirror(state.messages ?? [], priorEvents);
    }

    // Session-scoped provider/model live in the daemon as the source of
    // truth. Clients mutate them via `update_session` (handler below);
    // we no longer adopt them from each `send_user_message` payload.
    // Per-role routing (`resolveRoleRouting`) still takes precedence
    // over the base provider/model when a role override is configured.

    const runId = makeRunId();
    const abortController = new AbortController();

    entry.activeRunId = runId;
    entry.abortController = abortController;
    // A new message commits any pending revert — the fork is taken, so the
    // stashed tail is no longer restorable via `session_unrevert`.
    entry.revertedTail = null;

    // Acknowledge immediately
    const ack = makeResponse(req.requestId, 'send_user_message', sessionId, true, {
      runId,
      accepted: true,
    });

    await appendUserMessageWithFileReferences(state, text, state.cwd);
    const userMessagePayload = { chars: text.length, preview: text.slice(0, 280) };
    // Capture the seq synchronously, right as the call starts — not after
    // awaiting it. appendSessionEvent increments state.eventSeq before its
    // first await, so this read is race-free (nothing else can run between
    // "call the function" and "read the field" in the same tick); reading
    // state.eventSeq only after the await could pick up a LATER event's seq if
    // a background delegation/task-graph run appends to the same session
    // concurrently (send_user_message only rejects on entry.activeRunId, not
    // background runs) — the broadcast envelope would then mismatch the
    // persisted journal entry (Codex P2 on #1321).
    const appendPromise = appendSessionEvent(state, 'user_message', userMessagePayload, runId);
    const userMessageSeq = state.eventSeq;
    await appendPromise;
    // Broadcast so another client attached to this session (e.g. the TUI that
    // originated it, watching a phone-driven turn) renders the prompt live —
    // previously only persisted, never fanned out, so the assistant's reply
    // would appear on other clients with no visible question above it.
    broadcastEvent(sessionId, {
      v: PROTOCOL_VERSION,
      kind: 'event',
      sessionId: state.sessionId,
      runId,
      seq: userMessageSeq,
      ts: Date.now(),
      type: 'user_message',
      // Full text is broadcast to bearer-authenticated mirrors, while the
      // durable event journal keeps its compact preview (state.messages remains
      // the persisted source for the full body).
      payload: { ...userMessagePayload, text },
    });

    const providerConfig = PROVIDER_CONFIGS[state.provider];
    let apiKey;
    try {
      apiKey = resolveApiKey(providerConfig);
    } catch (err) {
      entry.activeRunId = null;
      entry.abortController = null;
      noteRunSettled();
      return makeErrorResponse(
        req.requestId,
        'send_user_message',
        'PROVIDER_NOT_CONFIGURED',
        err instanceof Error ? err.message : String(err),
      );
    }

    const approvalFn = buildApprovalFn(sessionId, entry, runId);

    // Run in background — broadcast events to all attached clients
    (async () => {
      // Write run marker so crash recovery can detect interrupted runs.
      // Awaited inside the async IIFE so a crash right after launch is still detectable.
      try {
        await writeRunMarker(sessionId, runId, {
          provider: state.provider,
          model: state.model,
          cwd: state.cwd,
        });
      } catch (err) {
        process.stderr.write(
          `warning: failed to write run marker for ${sessionId}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
      let sawError = false;
      let sawRunComplete = false;
      try {
        await runAssistantTurn(state, providerConfig, apiKey, text, DEFAULT_MAX_ROUNDS, {
          runId,
          // Daemon turns run at a fixed DEFAULT_MAX_ROUNDS: the client's
          // `--max-rounds` isn't carried through `send_user_message`, so disable
          // the adaptive harness here rather than silently grow a cap the user
          // can't control. Threading the real cap (+ adaptation) through the
          // daemon protocol is a follow-up.
          explicitMaxRounds: true,
          signal: abortController.signal,
          approvalFn,
          emit: (event) => {
            const seq = state.eventSeq;
            if (event.type === 'error') sawError = true;
            if (event.type === 'run_complete') sawRunComplete = true;

            broadcastEvent(sessionId, {
              v: PROTOCOL_VERSION,
              kind: 'event',
              sessionId: event.sessionId,
              runId: event.runId,
              seq,
              ts: Date.now(),
              type: event.type,
              payload: event.payload,
            });
          },
        });
        await saveSessionState(state);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!sawError) {
          await appendSessionEvent(
            state,
            'error',
            {
              code: 'INTERNAL_ERROR',
              message,
              retryable: false,
            },
            runId,
          );
          broadcastEvent(sessionId, {
            v: PROTOCOL_VERSION,
            kind: 'event',
            sessionId,
            runId,
            seq: state.eventSeq,
            ts: Date.now(),
            type: 'error',
            payload: { code: 'INTERNAL_ERROR', message, retryable: false },
          });
        }
        if (!sawRunComplete) {
          await appendSessionEvent(
            state,
            'run_complete',
            {
              runId,
              outcome: 'failed',
              summary: message.slice(0, 500),
            },
            runId,
          );
          broadcastEvent(sessionId, {
            v: PROTOCOL_VERSION,
            kind: 'event',
            sessionId,
            runId,
            seq: state.eventSeq,
            ts: Date.now(),
            type: 'run_complete',
            payload: { outcome: 'failed', summary: message.slice(0, 500) },
          });
        }
        await saveSessionState(state);
      } finally {
        entry.activeRunId = null;
        entry.abortController = null;
        if (entry.pendingApproval) {
          clearTimeout(entry.pendingApproval.timer);
          entry.pendingApproval = null;
        }
        // Clear run marker — this run is no longer active
        clearRunMarker(sessionId).catch(() => {});
        // The turn may have edited files / committed / switched branch — emit the
        // resulting workspace delta (fire-and-forget; no event when unchanged).
        void emitWorkspaceState(sessionId, entry, 'delta');
        // If a drain is pending, this run settling may be the transition to
        // idle that lets the daemon self-exit for a runtime refresh.
        noteRunSettled();
      }
    })();

    return ack;
  }

  async function handleAttachSession(req: CoreRequest, emitEvent: DaemonEmitEvent) {
    const {
      sessionId,
      lastSeenSeq,
      attachToken: providedToken,
      capabilities: clientCapabilities,
    } = req.payload || {};
    if (!sessionId) {
      return makeErrorResponse(
        req.requestId,
        'attach_session',
        'INVALID_REQUEST',
        'sessionId is required',
      );
    }

    let entry = activeSessions.get(sessionId);
    if (!entry) {
      try {
        const state = await loadSessionState(sessionId);
        // Restore the persisted attach token from session state instead of
        // minting a fresh one. Without this, clients lose their token on any
        // handler that lazy-loads a session from disk (including after a
        // daemon crash + restart), because `validateAttachToken` would
        // compare the caller's original token against a freshly minted one.
        // Legacy sessions without a persisted token are claimed by the
        // bootstrap-grace block below on their first tokenless attach.
        entry = { state, attachToken: state.attachToken };
        activeSessions.set(sessionId, entry);
      } catch {
        return makeErrorResponse(
          req.requestId,
          'attach_session',
          'SESSION_NOT_FOUND',
          `Session not found: ${sessionId}`,
        );
      }
    }

    // Bootstrap grace (Universal Session Bearer legacy cutover): a session
    // created before the bearer factory existed is tokenless on disk. On its
    // FIRST attach where the client ALSO presents no token, claim it — mint +
    // persist + accept this one attach — and return the token so the client
    // adopts it (see the response payload below + the TUI/CLI adopt paths).
    // Every subsequent attach then requires it: the session is tokened forever.
    // New sessions never reach here tokenless — the factory mints them at
    // birth. Rationale: the 0600 unix socket is already the local boundary, so
    // a single unauthenticated local claim-attach per legacy session is an
    // acceptable migration affordance (docs/decisions/Universal Session Bearer.md).
    // Any OTHER combination (token on disk, or client presented a token) flows
    // through `validateAttachToken` and enforces normally.
    const clientPresentedToken =
      typeof providedToken === 'string' && providedToken.trim().length > 0;
    if (!entry.attachToken && !clientPresentedToken) {
      const claimedToken = makeAttachToken();
      entry.attachToken = claimedToken;
      entry.state.attachToken = claimedToken;
      let persisted = true;
      try {
        await saveSessionState(entry.state);
      } catch (err) {
        // The in-memory claim still authorizes this run, but a daemon restart
        // would lose it and re-trigger the grace on the next attach. Surface it
        // rather than failing the attach — the session is already usable live.
        persisted = false;
        process.stderr.write(
          `${JSON.stringify({ level: 'warn', event: 'legacy_claim_persist_failed', sessionId, error: err instanceof Error ? err.message : String(err) })}\n`,
        );
      }
      // The claim IS the auth for this one attach — fall through (no validate).
      // A `legacy_claim` count trending to zero is the signal the migration is
      // complete; new sessions are born tokened and never emit it.
      process.stderr.write(
        `${JSON.stringify({ level: 'info', event: 'legacy_claim', sessionId, persisted })}\n`,
      );
    } else if (!validateAttachToken(entry, providedToken)) {
      return makeErrorResponse(
        req.requestId,
        'attach_session',
        'INVALID_TOKEN',
        'Invalid or missing attach token',
      );
    }

    // Register this client for multi-client fan-out. Capabilities drive
    // the v1 synthetic-downgrade path in `broadcastEvent` — clients that
    // include `'event_v2'` receive raw delegation envelopes, clients
    // that omit it (or pass `capabilities: []`, or don't include the
    // field at all) receive synthesized `assistant_token` shadows.
    const capabilitiesArray = Array.isArray(clientCapabilities) ? clientCapabilities : [];
    addSessionClient(sessionId, emitEvent, capabilitiesArray);
    // Same capability set is used to drive the replay path below so v1
    // clients see synthesized events for missed delegation rounds as
    // well as live ones (codex P1 on PR #281).
    const replayCapabilities = new Set(capabilitiesArray);

    const { state } = entry;
    const currentSeq = state.eventSeq;
    const fromSeq = (lastSeenSeq || 0) + 1;

    // Replay missed events from disk. Route each through
    // `emitEventWithDowngrade` so v1 clients don't silently drop raw
    // `subagent.*` / `task_graph.*` envelopes that landed on disk while
    // they were disconnected. The live fan-out path already does this
    // via `broadcastEvent`; the replay path has to do it too or
    // reconnects on `lastSeenSeq` reintroduce the gap this PR was meant
    // to close.
    try {
      const allEvents = await loadSessionEvents(sessionId);
      const missed = allEvents.filter((e) => e.seq >= fromSeq && e.seq <= currentSeq);
      for (const event of missed) {
        emitEventWithDowngrade(event, emitEvent, replayCapabilities);
      }
    } catch {
      // best-effort replay
    }

    // Re-anchor the workspace-state timeline for the (re)attached client: these
    // events are live-only, so a reconnecting client has none until a fresh
    // snapshot arrives. Fire-and-forget after replay.
    void emitWorkspaceState(sessionId, entry, 'resync');

    return makeResponse(req.requestId, 'attach_session', sessionId, true, {
      sessionId,
      state: entry.activeRunId ? 'running' : 'idle',
      activeRunId: entry.activeRunId || null,
      // Return the session's attach token so the client can ADOPT it into its
      // in-memory token (TUI `state.attachToken` / `daemonAttachToken`). This is
      // what closes the legacy-claim staleness loop: a TUI that attached with a
      // stale `undefined` (legacy tokenless session) gets the just-claimed token
      // here and presents it on the next reconnect instead of being locked out.
      // For an already-tokened session this just echoes the token the client
      // already holds (no new exposure — the caller already authenticated).
      attachToken: entry.attachToken,
      // Session-scoped truth: the daemon is the source. Clients (TUI, web)
      // hydrate from these on attach instead of loading state.json
      // directly, which keeps the two views in lock-step after a
      // mid-session switch from another client.
      provider: state.provider,
      model: state.model,
      roleRouting: state.roleRouting || {},
      replay: {
        fromSeq,
        toSeq: currentSeq,
        completed: true,
        gap: fromSeq > currentSeq + 1,
      },
    });
  }

  /**
   * handleGetSessionMessages — return the conversation transcript for an
   * existing session so a freshly attaching web client can hydrate its
   * chat surface from the daemon's source of truth.
   *
   * Why this exists (PR #687): `attach_session` returns session metadata
   * (provider/model/roleRouting) and replays missed events, but the
   * `user_message` event only carries `{ chars, preview: text.slice(0, 280) }`
   * — the full user message body lives in `state.messages`. So a
   * web-side hydrator built purely from replayed events would surface
   * truncated user messages. This RPC fills that gap by returning the
   * already-persisted user/assistant pairs from `state.messages`.
   *
   * Auth identical to `attach_session`: requires `attachToken` to match
   * the session's stored token. System + tool messages are filtered —
   * the web's `ChatContainer` renders only the human-visible dialogue.
   */
  async function handleGetSessionMessages(req: CoreRequest) {
    const { sessionId, attachToken: providedToken } = req.payload || {};
    if (!sessionId) {
      return makeErrorResponse(
        req.requestId,
        'get_session_messages',
        'INVALID_REQUEST',
        'sessionId is required',
      );
    }

    let entry = activeSessions.get(sessionId);
    if (!entry) {
      try {
        const state = await loadSessionState(sessionId);
        entry = { state, attachToken: state.attachToken };
        activeSessions.set(sessionId, entry);
      } catch {
        return makeErrorResponse(
          req.requestId,
          'get_session_messages',
          'SESSION_NOT_FOUND',
          `Session not found: ${sessionId}`,
        );
      }
    }

    if (!validateAttachToken(entry, providedToken)) {
      return makeErrorResponse(
        req.requestId,
        'get_session_messages',
        'INVALID_TOKEN',
        'Invalid or missing attach token',
      );
    }

    // Filter to user/assistant pairs and coerce content to string. Some
    // providers represent multimodal content as an array of blocks; for
    // hydration we only carry the text channel — `''` for messages we
    // can't render as plain text. Indices supply stable IDs so the
    // web's React lists are stable across re-fetches.
    const allMessages = Array.isArray(entry.state.messages) ? entry.state.messages : [];
    const messages = [];
    for (let i = 0; i < allMessages.length; i++) {
      const msg = allMessages[i];
      if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue;
      const content = typeof msg.content === 'string' ? msg.content : '';
      messages.push({
        id: `daemon-${sessionId}-${i}`,
        role: msg.role,
        content,
      });
    }

    return makeResponse(req.requestId, 'get_session_messages', sessionId, true, {
      sessionId,
      messages,
    });
  }

  async function readGitBranch(cwd: string) {
    try {
      // `branch --show-current` (not `rev-parse --abbrev-ref HEAD`) so a freshly
      // `git init`'d repo with no commits still reports its unborn branch instead
      // of erroring out; it prints empty only when detached. Mirrors the
      // normalized Git backend (`lib/git/backend.ts`). Copilot review on #743.
      const { stdout } = await execFileAsync('git', ['branch', '--show-current'], {
        cwd,
        timeout: 1_000,
        maxBuffer: 16_000,
      });
      const branch = stdout.trim();
      return branch ? branch : null;
    } catch {
      return null;
    }
  }

  function emitWorkspaceState(
    sessionId: string,
    entry: SessionRuntimeEntry,
    mode: WorkspaceStateEmitMode,
  ) {
    return sessionRuntime.emitWorkspaceState(sessionId, entry, mode);
  }

  function normalizeRecentEventLimit(rawLimit: unknown) {
    const floored =
      typeof rawLimit === 'number' && Number.isFinite(rawLimit) ? Math.floor(rawLimit) : NaN;
    return Number.isFinite(floored) && floored >= 1 ? Math.min(floored, 100) : 20;
  }

  /**
   * `get_session_snapshot` — one daemon-owned reconnect packet for clients that
   * need to render "what is happening now" before/instead of reconstructing it
   * from local state plus event replay. Read-only and bearer-gated; never returns
   * bearer plaintext.
   */
  async function handleGetSessionSnapshot(req: CoreRequest) {
    const auth = await loadAndAuthSession(req, 'get_session_snapshot');
    if (auth.error) return auth.error;
    const { entry, sessionId } = auth;
    const state = entry.state || {};
    const currentSeq = typeof state.eventSeq === 'number' ? state.eventSeq : 0;
    const recentEventLimit = normalizeRecentEventLimit(req.payload?.recentEventLimit);
    const clientCapabilities = new Set<string>(
      (Array.isArray(req.payload?.capabilities) ? req.payload.capabilities : []) as string[],
    );

    let recentEvents: SessionEvent[] = [];
    let allEvents: SessionEvent[] = [];
    try {
      allEvents = await loadSessionEvents(sessionId);
      recentEvents = allEvents.slice(-recentEventLimit);
    } catch {
      allEvents = [];
      recentEvents = [];
    }
    if (!entry.transcriptMirror) {
      entry.transcriptMirror = rebuildDaemonTranscriptMirror(state.messages ?? [], allEvents);
    }

    const activeRunId =
      typeof entry.activeRunId === 'string' && entry.activeRunId ? entry.activeRunId : null;
    // Background work (delegations / task graphs) keeps a session "running" even
    // when `activeRunId` is null — the orchestrator turn that kicked it off has
    // already returned, so the top-level run id is cleared while sub-agent work
    // is still in flight. `handleUpdateSession` blocks on the same non-empty
    // maps with RUN_IN_PROGRESS; the snapshot must agree or a reconnecting
    // client renders the session as idle during live delegation. Codex review
    // on #743.
    const activeDelegations = entry.activeDelegations?.size ?? 0;
    const activeGraphs = entry.activeGraphs?.size ?? 0;
    const hasBackgroundWork = activeDelegations > 0 || activeGraphs > 0;
    const isRunning = activeRunId !== null || hasBackgroundWork;
    const pendingApproval = entry.pendingApproval
      ? {
          approvalId: entry.pendingApproval.approvalId,
          runId:
            typeof entry.pendingApproval.runId === 'string' && entry.pendingApproval.runId
              ? entry.pendingApproval.runId
              : null,
          // Display context so a reconnecting client renders the same pane as the
          // live `approval_required` event, not a generic fallback (#746). Null
          // when absent (e.g. a pre-#746 daemon's in-memory entry); the client
          // falls back to a generic summary in that case.
          kind:
            typeof entry.pendingApproval.kind === 'string' && entry.pendingApproval.kind
              ? entry.pendingApproval.kind
              : null,
          title:
            typeof entry.pendingApproval.title === 'string' && entry.pendingApproval.title
              ? entry.pendingApproval.title
              : null,
          summary:
            typeof entry.pendingApproval.summary === 'string' && entry.pendingApproval.summary
              ? entry.pendingApproval.summary
              : null,
        }
      : null;

    return makeResponse(req.requestId, 'get_session_snapshot', sessionId, true, {
      host: {
        hostname: os.hostname(),
        daemonVersion: VERSION,
        protocolVersion: PROTOCOL_VERSION,
        startedAtMs: DAEMON_STARTED_AT_MS,
      },
      repo: {
        rootPath: state.cwd || process.cwd(),
        branch: await readGitBranch(state.cwd || process.cwd()),
      },
      relay: await relayCoordinator.buildStatusPayload(),
      session: {
        sessionId,
        state: isRunning ? 'running' : 'idle',
        activeRunId,
        // Count of in-flight sub-agent work with no top-level run id. Lets a
        // reconnecting client distinguish "running because of a foreground turn"
        // (activeRun set) from "running because of background delegation" — and
        // render progress without waiting for an event-tail to reveal it.
        backgroundWork: { delegations: activeDelegations, graphs: activeGraphs },
        provider: state.provider || null,
        model: state.model || null,
        mode:
          typeof state.mode === 'string' && state.mode.trim() ? state.mode.trim() : 'interactive',
        roleRouting: state.roleRouting || {},
        eventSeq: currentSeq,
        attachTokenPresent: Boolean(entry.attachToken),
      },
      // Foreground run descriptor. `type`/`cancellable` are fixed to the
      // assistant-turn model the top-level `activeRunId` represents today — when
      // a delegation or task graph is the in-flight work, `activeRunId` is null
      // (see `backgroundWork` above), so this stays null rather than describing a
      // child run with different cancel semantics. As the run model grows
      // (task_graph_v1 / delegation_* gaining cancellable child descriptors),
      // widen this shape in a later slice. Kilo review on #743.
      activeRun: activeRunId
        ? {
            runId: activeRunId,
            type: 'assistant_turn',
            cancellable: true,
          }
        : null,
      pendingApproval,
      transcript: {
        lastSeq: currentSeq,
        recentEvents: recentEvents.map((event) =>
          eventForClientCapabilities(event, clientCapabilities),
        ),
        mirror: transcriptSnapshotForClientCapabilities(entry.transcriptMirror, clientCapabilities),
      },
    });
  }

  async function handleSubmitApproval(
    req: CoreRequest,
    _emitEvent: DaemonEmitEvent,
    context?: CoreContext,
  ) {
    const { sessionId, approvalId, decision } = req.payload || {};
    if (!sessionId || !approvalId || !decision) {
      return makeErrorResponse(
        req.requestId,
        'submit_approval',
        'INVALID_REQUEST',
        'sessionId, approvalId, and decision are required',
      );
    }

    const entry = activeSessions.get(sessionId);
    if (!entry) {
      return makeErrorResponse(
        req.requestId,
        'submit_approval',
        'SESSION_NOT_FOUND',
        `Session not found: ${sessionId}`,
      );
    }

    // Bearer-gate the approval decision (Addressable Session Verbs follow-up —
    // the gap the cancel_run fix in #723 left open). An approval decision
    // executes or denies a paused tool call; without this any relay-authenticated
    // client that learns a live sessionId + approvalId could approve/deny a tool
    // run on a session whose bearer it does not hold. Placed AFTER the existence
    // check (mirroring handleCancelRun) so an unknown session still returns
    // SESSION_NOT_FOUND, and BEFORE the pending-approval lookup so a stolen
    // approvalId can't even probe whether one is outstanding.
    const providedToken = req.payload?.attachToken;
    if (!validateAttachToken(entry, providedToken)) {
      process.stderr.write(
        `${JSON.stringify({ level: 'warn', event: 'submit_approval_unauthenticated_rejected', sessionId, hadToken: typeof providedToken === 'string' && providedToken.length > 0 })}\n`,
      );
      return makeErrorResponse(
        req.requestId,
        'submit_approval',
        'INVALID_TOKEN',
        'Invalid or missing attach token',
      );
    }

    const pending = entry.pendingApproval;
    if (!pending || pending.approvalId !== approvalId) {
      return makeErrorResponse(
        req.requestId,
        'submit_approval',
        'APPROVAL_NOT_FOUND',
        `No pending approval with id: ${approvalId}`,
      );
    }

    clearTimeout(pending.timer);
    entry.pendingApproval = null;
    pending.resolve(decision);

    // Emit approval_received to all clients on the SAME runId we used
    // for `approval_required` (stored alongside in `buildApprovalFn`).
    // Falling back to `entry.activeRunId` — which is the parent run for
    // a main loop, but null for delegations and task-graph nodes —
    // caused the received event to mismatch the required event for
    // anything routed through `delegate_coder` /
    // `handleSubmitTaskGraph`, making client-side correlation
    // impossible.
    const approvalRunId = typeof pending.runId === 'string' ? pending.runId : entry.activeRunId;
    const eventPayload = { approvalId, decision, by: 'client' };
    await appendSessionEvent(entry.state, 'approval_received', eventPayload, approvalRunId);
    // Build envelope after appendSessionEvent so seq matches the persisted event.
    // Omit `runId` when falsy (protocol-schema strict mode rejects
    // `runId: null` on wire envelopes — see PR #276 review).
    const envelope: SessionEvent = {
      v: PROTOCOL_VERSION,
      kind: 'event',
      sessionId,
      seq: entry.state.eventSeq,
      ts: Date.now(),
      type: 'approval_received',
      payload: eventPayload,
    };
    if (typeof approvalRunId === 'string' && approvalRunId.length > 0) {
      envelope.runId = approvalRunId;
    }
    broadcastEvent(sessionId, envelope);

    // Phase 3 slice 4 audit. Records the decision alongside the
    // requesting device's provenance — closes the audit-log
    // "approval decisions identify surface/device" minimum-model item.
    void appendAuditEvent({
      type: 'approval.decision',
      ...auditProvenance(context),
      sessionId,
      runId: typeof approvalRunId === 'string' ? approvalRunId : undefined,
      payload: { approvalId, decision },
    });

    return makeResponse(req.requestId, 'submit_approval', sessionId, true, {
      accepted: true,
    });
  }

  async function handleCancelRun(
    req: CoreRequest,
    _emitEvent: DaemonEmitEvent,
    context?: CoreContext,
  ) {
    const { sessionId, runId } = req.payload || {};

    // Sessionless cancel path (Phase 1.f remote-sessions cancel): the
    // web side may issue `cancel_run` with only a runId to abort an
    // in-flight `sandbox_exec` registered against this connection's
    // wsState. We accept this ONLY when the runId matches a registration
    // on the same WS connection — that scoping keeps a stolen runId
    // from a different paired client out of reach on the loopback WS,
    // where each connection owns its own wsState.
    //
    // The relay transport defeats connection-scoping: every paired phone
    // shares the coordinator-owned relay wsState, so a guessed runId would
    // otherwise reach across phones. When a run was registered with an
    // `ownerId` (the relay DO's per-phone sender id), require the cancel to
    // arrive from the SAME phone — i.e. its DO-stamped `relaySenderId` must
    // match. Runs with a null ownerId (loopback callers, which don't ride the
    // relay) stay purely connection-scoped, unchanged. Closes Remote Control
    // Surface Audit #3.
    if (!sessionId) {
      if (!runId) {
        return makeErrorResponse(
          req.requestId,
          'cancel_run',
          'INVALID_REQUEST',
          'sessionId or runId is required',
        );
      }
      const wsState = context?.wsState;
      const run =
        wsState && wsState.activeRuns instanceof Map ? wsState.activeRuns.get(runId) : null;
      if (!run) {
        return makeErrorResponse(
          req.requestId,
          'cancel_run',
          'NO_ACTIVE_RUN',
          `No active run to cancel: ${runId}`,
        );
      }
      if (run.ownerId !== null) {
        // The cancel must come from the same phone that started the run. The
        // sender id is DO-stamped and trusted (a phone can't forge it). A
        // mismatch is reported as NO_ACTIVE_RUN (not a distinct auth error) so
        // the runId↔owner binding isn't oracle'd — a different phone can't
        // distinguish "runId exists, other owner" from "runId doesn't exist."
        const cancelSenderId =
          typeof context?.relaySenderId === 'string' ? context.relaySenderId : null;
        if (cancelSenderId !== run.ownerId) {
          process.stderr.write(
            `${JSON.stringify({ level: 'warn', event: 'cancel_run_runid_owner_mismatch', runId, hadSender: cancelSenderId !== null })}\n`,
          );
          return makeErrorResponse(
            req.requestId,
            'cancel_run',
            'NO_ACTIVE_RUN',
            `No active run to cancel: ${runId}`,
          );
        }
      }
      try {
        run.controller.abort();
      } catch {
        // ignore — handleSandboxExec's finally clears the map entry
      }
      return makeResponse(req.requestId, 'cancel_run', null, true, {
        accepted: true,
        runId,
      });
    }

    const entry = activeSessions.get(sessionId);
    if (!entry) {
      return makeErrorResponse(
        req.requestId,
        'cancel_run',
        'SESSION_NOT_FOUND',
        `Session not found: ${sessionId}`,
      );
    }

    // Bearer-gate the session-ful cancel (Addressable Session Verbs phase 2 —
    // the 12th enforcement site, missed by the Universal Session Bearer sweep).
    // Without this a relay-authenticated client could abort a run on a session it
    // does not hold the bearer for, just by knowing the sessionId. Placed AFTER
    // the existence check so a cancel for a session the daemon doesn't have still
    // returns SESSION_NOT_FOUND (the benign loopback best-effort path), not a
    // token error. The runId-only path above stays WS-connection-scoped and is
    // intentionally not token-gated.
    const providedToken = req.payload?.attachToken;
    if (!validateAttachToken(entry, providedToken)) {
      process.stderr.write(
        `${JSON.stringify({ level: 'warn', event: 'cancel_run_unauthenticated_rejected', sessionId, hadToken: typeof providedToken === 'string' && providedToken.length > 0 })}\n`,
      );
      return makeErrorResponse(
        req.requestId,
        'cancel_run',
        'INVALID_TOKEN',
        'Invalid or missing attach token',
      );
    }

    if (!entry.activeRunId) {
      return makeErrorResponse(
        req.requestId,
        'cancel_run',
        'NO_ACTIVE_RUN',
        'No active run to cancel',
      );
    }

    if (runId && entry.activeRunId !== runId) {
      return makeErrorResponse(
        req.requestId,
        'cancel_run',
        'NO_ACTIVE_RUN',
        `Run ${runId} is not the active run`,
      );
    }

    // Abort the run
    if (entry.abortController) {
      entry.abortController.abort();
    }

    // Also resolve any pending approval as denied
    if (entry.pendingApproval) {
      clearTimeout(entry.pendingApproval.timer);
      entry.pendingApproval.resolve('deny');
      entry.pendingApproval = null;
    }

    return makeResponse(req.requestId, 'cancel_run', sessionId, true, {
      accepted: true,
    });
  }

  // ─── Role routing ───────────────────────────────────────────────

  async function handleConfigureRoleRouting(req: CoreRequest) {
    const sessionId = req.sessionId || req.payload?.sessionId;
    const routing = req.payload?.routing;

    if (!sessionId) {
      return makeErrorResponse(
        req.requestId,
        'configure_role_routing',
        'INVALID_REQUEST',
        'sessionId is required',
      );
    }

    if (!routing || typeof routing !== 'object' || Array.isArray(routing)) {
      return makeErrorResponse(
        req.requestId,
        'configure_role_routing',
        'INVALID_REQUEST',
        'routing must be a non-null object mapping role → { provider, model? }',
      );
    }

    let entry = activeSessions.get(sessionId);
    if (!entry) {
      try {
        const state = await loadSessionState(sessionId);
        // Restore the persisted attach token from session state instead of
        // minting a fresh one. Without this, clients lose their token on any
        // handler that lazy-loads a session from disk (including after a
        // daemon crash + restart), because `validateAttachToken` would
        // compare the caller's original token against a freshly minted one.
        // Legacy sessions without a persisted token load with attachToken
        // undefined; they are claimed on first `attach_session` (bootstrap
        // grace). A non-attach handler reached before that claim now rejects —
        // the implicit tokenless bypass is gone (Universal Session Bearer).
        entry = { state, attachToken: state.attachToken };
        activeSessions.set(sessionId, entry);
      } catch {
        return makeErrorResponse(
          req.requestId,
          'configure_role_routing',
          'SESSION_NOT_FOUND',
          `Session not found: ${sessionId}`,
        );
      }
    }

    const providedToken = req.payload?.attachToken;
    if (!validateAttachToken(entry, providedToken)) {
      return makeErrorResponse(
        req.requestId,
        'configure_role_routing',
        'INVALID_TOKEN',
        'Invalid or missing attach token',
      );
    }

    const normalized: Record<string, { provider: string; model: string }> = {};
    for (const [role, spec] of Object.entries(routing)) {
      if (!VALID_AGENT_ROLES.has(role)) {
        return makeErrorResponse(
          req.requestId,
          'configure_role_routing',
          'INVALID_ROLE',
          `Unknown agent role: ${role}. Valid roles: ${[...VALID_AGENT_ROLES].join(', ')}`,
        );
      }

      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        return makeErrorResponse(
          req.requestId,
          'configure_role_routing',
          'INVALID_REQUEST',
          `Entry for role "${role}" must be an object with at least { provider }`,
        );
      }

      const candidate = spec as Record<string, unknown>;
      const provider =
        typeof candidate.provider === 'string' ? candidate.provider.trim() : candidate.provider;
      if (!provider || typeof provider !== 'string') {
        return makeErrorResponse(
          req.requestId,
          'configure_role_routing',
          'INVALID_REQUEST',
          `Entry for role "${role}" must specify a provider`,
        );
      }

      const providerConfig = PROVIDER_CONFIGS[provider];
      if (!providerConfig) {
        return makeErrorResponse(
          req.requestId,
          'configure_role_routing',
          'PROVIDER_NOT_CONFIGURED',
          `Unknown provider "${provider}" for role "${role}"`,
        );
      }

      normalized[role] = {
        provider,
        model:
          typeof candidate.model === 'string' && candidate.model.trim()
            ? candidate.model.trim()
            : providerConfig.defaultModel,
      };
    }

    const { state } = entry;
    state.roleRouting = { ...(state.roleRouting || {}), ...normalized };
    // `broadcastSessionStateChanged` appends the event AND saves the
    // state — calling `saveSessionState` first would persist a stale
    // `eventSeq` that filters this very event out of attach-replay
    // (codex / copilot review on PR #663). The helper owns the order.
    await broadcastSessionStateChanged(state);

    return makeResponse(req.requestId, 'configure_role_routing', sessionId, true, {
      roleRouting: state.roleRouting,
    });
  }

  /**
   * Patch session-scoped state (currently provider + model) from a client.
   *
   * This is the daemon-as-source-of-truth path: the TUI switches model/provider
   * by calling this RPC instead of writing the session file directly. The old
   * "carry the model on every send_user_message" workaround
   * (`adoptClientModelSelection`) is gone — the daemon now owns the truth and
   * every client reads it back via `attach_session` or the broadcast event.
   *
   * Atomicity rule: provider + model are treated as ONE selection. A patch with
   * provider but no model snaps the model to that provider's default — adopting
   * only the provider would strand the session's old model on the new provider.
   * A model-only patch is a same-provider model switch.
   *
   * Rejected during an active run: switching mid-run would race with the
   * already-streaming round (which has already captured the provider config
   * via `PROVIDER_CONFIGS[state.provider]`).
   */
  async function handleUpdateSession(req: CoreRequest) {
    const sessionId = req.sessionId || req.payload?.sessionId;
    if (!sessionId) {
      return makeErrorResponse(
        req.requestId,
        'update_session',
        'INVALID_REQUEST',
        'sessionId is required',
      );
    }
    const patch = req.payload?.patch;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return makeErrorResponse(
        req.requestId,
        'update_session',
        'INVALID_REQUEST',
        'patch must be a non-null object with optional { provider, model }',
      );
    }

    let entry = activeSessions.get(sessionId);
    if (!entry) {
      try {
        const state = await loadSessionState(sessionId);
        entry = { state, attachToken: state.attachToken };
        activeSessions.set(sessionId, entry);
      } catch {
        return makeErrorResponse(
          req.requestId,
          'update_session',
          'SESSION_NOT_FOUND',
          `Session not found: ${sessionId}`,
        );
      }
    }

    if (!validateAttachToken(entry, req.payload?.attachToken)) {
      return makeErrorResponse(
        req.requestId,
        'update_session',
        'INVALID_TOKEN',
        'Invalid or missing attach token',
      );
    }

    if (entry.activeRunId) {
      return makeErrorResponse(
        req.requestId,
        'update_session',
        'RUN_IN_PROGRESS',
        `Run ${entry.activeRunId} is active; cannot update session state mid-run`,
      );
    }

    // Delegations and task-graph executions read `state.provider` /
    // `state.model` (via `resolveRoleRouting`) for every sub-agent call
    // they make, so a mid-flight patch would silently swap the model
    // under the running work. The session entry tracks both via
    // `ensureRuntimeState`; non-empty Maps mean work is in flight even
    // though `activeRunId` is null (the orchestrator turn that kicked
    // them off has already returned). Block them with the same code
    // so clients have one path to surface (copilot review on PR #663).
    const activeDelegations = entry.activeDelegations?.size ?? 0;
    const activeGraphs = entry.activeGraphs?.size ?? 0;
    if (activeDelegations > 0 || activeGraphs > 0) {
      return makeErrorResponse(
        req.requestId,
        'update_session',
        'RUN_IN_PROGRESS',
        `Background work is active (${activeDelegations} delegation(s), ${activeGraphs} task graph(s)); cannot update session state until it completes`,
      );
    }

    const { state } = entry;
    let nextProvider = state.provider;
    let nextModel = state.model;
    let providerChanged = false;

    if (patch.provider !== undefined && patch.provider !== null) {
      const normalized = normalizeProviderInput(patch.provider);
      if (!normalized || !PROVIDER_CONFIGS[normalized]) {
        return makeErrorResponse(
          req.requestId,
          'update_session',
          'PROVIDER_NOT_CONFIGURED',
          `Unknown provider: ${JSON.stringify(patch.provider)}`,
        );
      }
      nextProvider = normalized;
      providerChanged = normalized !== state.provider;
    }

    if (patch.model !== undefined && patch.model !== null) {
      if (typeof patch.model !== 'string' || !patch.model.trim()) {
        return makeErrorResponse(
          req.requestId,
          'update_session',
          'INVALID_REQUEST',
          'model must be a non-empty string',
        );
      }
      nextModel = patch.model.trim();
    } else if (providerChanged) {
      // Atomic-selection rule: a provider change without an explicit model
      // snaps the model to the new provider's default. Adopting only the
      // provider would leave the old model name on a foreign provider and
      // the next run would fail at the provider call.
      nextModel = PROVIDER_CONFIGS[nextProvider].defaultModel;
    }

    state.provider = nextProvider;
    state.model = nextModel;
    // `broadcastSessionStateChanged` appends the event AND saves the
    // state. A pre-save would persist a stale `eventSeq` and the
    // attach-replay filter (`seq <= currentSeq`) would drop this very
    // event on the next disk-reload.
    await broadcastSessionStateChanged(state);

    return makeResponse(req.requestId, 'update_session', sessionId, true, {
      provider: state.provider,
      model: state.model,
      roleRouting: state.roleRouting || {},
    });
  }

  /**
   * Emit `session_state_changed` to every client attached to the session.
   *
   * Persisted via `appendSessionEvent` so reconnecting clients pick up the
   * change in their replay window (the attach response also carries the
   * current values, but persisting the event keeps the timeline honest
   * for any consumer that watches state transitions — and the seq stays
   * monotonic instead of broadcasting an envelope with a duplicated seq).
   *
   * Saves the slim session state *after* `appendSessionEvent` increments
   * `state.eventSeq`, otherwise a daemon restart loads the pre-increment
   * `eventSeq` from `state.json` and `attach_session` filters this very
   * event out of replay (its `seq` is `> currentSeq` from disk). Callers
   * therefore MUST NOT pre-save — they let this helper own the save
   * order, which keeps the persisted cursor monotonic across restarts.
   *
   * Not scoped to a runId: state changes are session-level and happen
   * between runs (an active run blocks `update_session`). The envelope
   * omits the `runId` field entirely — strict-mode rejects `runId: null`.
   */
  async function broadcastSessionStateChanged(state: SessionState) {
    const payload = {
      provider: state.provider,
      model: state.model,
      roleRouting: state.roleRouting || {},
    };
    await appendSessionEvent(state, 'session_state_changed', payload, null);
    await saveSessionState(state);
    broadcastEvent(state.sessionId, {
      v: PROTOCOL_VERSION,
      kind: 'event',
      sessionId: state.sessionId,
      seq: state.eventSeq,
      ts: Date.now(),
      type: 'session_state_changed',
      payload,
    });
  }

  return {
    handleHello,
    handlePing,
    handleListSessions,
    handleStartSession,
    handleSendUserMessage,
    handleAttachSession,
    handleGetSessionMessages,
    handleGetSessionSnapshot,
    handleSubmitApproval,
    handleCancelRun,
    handleConfigureRoleRouting,
    handleUpdateSession,
  };
}
