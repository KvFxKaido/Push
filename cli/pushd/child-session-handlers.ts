/**
 * child-session-handlers.ts — delegation replay and addressable child reads.
 *
 * A child is a filtered view over its parent session log, not an independent
 * persisted session. This module owns the membership predicate, descriptor
 * reconstruction, replay handler, and bearer-gated list/read verbs.
 */
import { loadSessionEvents, loadSessionState } from '../session-store.js';
import { validateAttachToken } from './attach-token.js';
import { makeErrorResponse, makeResponse } from './envelopes.js';
import type { DaemonHandler } from './handler-types.js';
import type { SessionRuntime } from './session-runtime.js';

export interface ChildSessionHandlerDependencies {
  runtime: SessionRuntime;
  loadAndAuthSession(request: any, type: string): Promise<any>;
}

export interface ChildSessionHandlers {
  handleFetchDelegationEvents: DaemonHandler;
  handleListChildren: DaemonHandler;
  handleGetChildSession: DaemonHandler;
}

export function createChildSessionHandlers(
  dependencies: ChildSessionHandlerDependencies,
): ChildSessionHandlers {
  const sessionRuntime = dependencies.runtime;
  const activeSessions = sessionRuntime.sessions;
  const ensureRuntimeState = (entry: any) => sessionRuntime.ensureRuntimeState(entry);
  const loadAndAuthSession = dependencies.loadAndAuthSession;

  // ─── Delegation event replay ────────────────────────────────────

  async function handleFetchDelegationEvents(req: any) {
    const sessionId = req.sessionId || req.payload?.sessionId;
    const providedToken = req.payload?.attachToken;
    const subagentId = req.payload?.subagentId;
    const childRunId = req.payload?.childRunId;
    const sinceSeq = req.payload?.sinceSeq;
    const limit = req.payload?.limit;

    if (!sessionId) {
      return makeErrorResponse(
        req.requestId,
        'fetch_delegation_events',
        'INVALID_REQUEST',
        'sessionId is required',
      );
    }

    if (!subagentId && !childRunId) {
      return makeErrorResponse(
        req.requestId,
        'fetch_delegation_events',
        'INVALID_REQUEST',
        'At least one of subagentId or childRunId is required',
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
          'fetch_delegation_events',
          'SESSION_NOT_FOUND',
          `Session not found: ${sessionId}`,
        );
      }
    }

    if (!validateAttachToken(entry, providedToken)) {
      return makeErrorResponse(
        req.requestId,
        'fetch_delegation_events',
        'INVALID_TOKEN',
        'Invalid or missing attach token',
      );
    }

    const allEvents = await loadSessionEvents(sessionId);

    let filtered = allEvents.filter((event) =>
      eventBelongsToChild(event, { subagentId, childRunId }),
    );

    if (typeof sinceSeq === 'number' && Number.isFinite(sinceSeq)) {
      filtered = filtered.filter((event) => event.seq > sinceSeq);
    }

    const fromSeq = filtered.length > 0 ? filtered[0].seq : 0;

    if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
      filtered = filtered.slice(0, limit);
    }

    const toSeq = filtered.length > 0 ? filtered[filtered.length - 1].seq : fromSeq;

    return makeResponse(req.requestId, 'fetch_delegation_events', sessionId, true, {
      events: filtered,
      replay: {
        fromSeq,
        toSeq,
        completed: true,
      },
    });
  }

  // ─── Addressable child sessions (Addressable Session Verbs phase 3) ──
  //
  // A delegated Coder/Explorer run is addressed by its `subagentId` — the stable
  // id minted at delegation time. It is NOT a separate session on disk: a child
  // is a *view* over the parent session (its events filtered by childRunId).
  // `list_children` enumerates them; `get_child_session` returns one as a
  // structured descriptor + an event summary. Both are bearer-gated reads over
  // the PARENT session's attach token. Live streaming (`attach_child_session`)
  // is deferred; child abort already exists as `cancel_delegation`.

  /**
   * Does this event belong to the given child run? Membership is by subagentId
   * (`payload.subagentId` / `payload.executionId`) or childRunId
   * (`payload.childRunId` / envelope `runId`). Single source of truth shared by
   * replay, list, and get so the three can't drift on child membership.
   */
  function eventBelongsToChild(
    event: any,
    { subagentId, childRunId }: { subagentId?: string | null; childRunId?: string | null },
  ) {
    const payload =
      event && event.payload && typeof event.payload === 'object' ? event.payload : {};
    if (subagentId && payload.subagentId === subagentId) return true;
    if (subagentId && payload.executionId === subagentId) return true;
    if (childRunId && payload.childRunId === childRunId) return true;
    if (childRunId && event?.runId === childRunId) return true;
    return false;
  }

  function buildActiveChildDescriptor(subagentId: string, record: any) {
    return {
      subagentId,
      status: 'active',
      role: record.role || record.agent || 'subagent',
      agent: record.agent || record.role || 'subagent',
      task: typeof record.task === 'string' ? record.task : '',
      childRunId: typeof record.childRunId === 'string' ? record.childRunId : null,
      parentRunId: typeof record.parentRunId === 'string' ? record.parentRunId : null,
      startedAt: typeof record.startedAt === 'number' ? record.startedAt : null,
    };
  }

  function buildCompletedChildDescriptor(subagentId: string, outcome: any) {
    const value = outcome && typeof outcome === 'object' ? outcome : {};
    return {
      subagentId,
      status: 'completed',
      role: value.agent || 'subagent',
      agent: value.agent || 'subagent',
      outcomeStatus: typeof value.status === 'string' ? value.status : null,
      summary: typeof value.summary === 'string' ? value.summary : '',
      rounds: typeof value.rounds === 'number' ? value.rounds : null,
      checkpoints: typeof value.checkpoints === 'number' ? value.checkpoints : null,
      elapsedMs: typeof value.elapsedMs === 'number' ? value.elapsedMs : null,
    };
  }

  function buildEventDerivedChildDescriptor(subagentId: string, events: any[]) {
    const started = events.find((event) => event.type === 'subagent.started');
    const payload = started?.payload && typeof started.payload === 'object' ? started.payload : {};
    const terminal = events.find(
      (event) => event.type === 'subagent.completed' || event.type === 'subagent.failed',
    );
    return {
      subagentId,
      status: 'completed',
      source: 'events',
      role: payload.role || payload.agent || 'subagent',
      agent: payload.agent || payload.role || 'subagent',
      task: typeof payload.detail === 'string' ? payload.detail : '',
      childRunId:
        typeof payload.childRunId === 'string'
          ? payload.childRunId
          : typeof started?.runId === 'string'
            ? started.runId
            : null,
      parentRunId: typeof payload.parentRunId === 'string' ? payload.parentRunId : null,
      startedAt: typeof started?.ts === 'number' ? started.ts : null,
      terminalType: terminal ? terminal.type : null,
    };
  }

  /**
   * Enumerate delegated child runs. Active children come from the in-memory
   * map; completed coder/explorer children come from persisted outcomes.
   * Event-derived reviewer children are opt-in because that path scans the log.
   */
  async function handleListChildren(req: any) {
    const auth = await loadAndAuthSession(req, 'list_children');
    if (auth.error) return auth.error;
    const { entry, sessionId } = auth;
    ensureRuntimeState(entry);
    const includeEventDerived = req.payload?.includeEventDerived === true;

    const active: any[] = [];
    for (const [subagentId, record] of entry.activeDelegations) {
      active.push(buildActiveChildDescriptor(subagentId, record));
    }
    const activeIds = new Set<string>(active.map((child) => child.subagentId));

    const completed: any[] = [];
    const seenCompleted = new Set<string>();
    const outcomes = Array.isArray(entry.state?.delegationOutcomes)
      ? entry.state.delegationOutcomes
      : [];
    for (const record of outcomes) {
      if (!record || typeof record.subagentId !== 'string') continue;
      if (activeIds.has(record.subagentId)) continue;
      if (seenCompleted.has(record.subagentId)) continue;
      seenCompleted.add(record.subagentId);
      completed.push(buildCompletedChildDescriptor(record.subagentId, record.outcome));
    }

    const eventDerived: any[] = [];
    if (includeEventDerived) {
      const known = new Set<string>([...activeIds, ...seenCompleted]);
      const byChild = new Map<string, any[]>();
      const allEvents = await loadSessionEvents(sessionId);
      for (const event of allEvents) {
        const payload =
          event.payload && typeof event.payload === 'object' ? event.payload : ({} as any);
        // Use the real delegation id only. Task-graph executions are keyed by
        // executionId and are deliberately not addressable children.
        const subagentId = typeof payload.subagentId === 'string' ? payload.subagentId : null;
        if (!subagentId || known.has(subagentId)) continue;
        const events = byChild.get(subagentId) ?? [];
        events.push(event);
        byChild.set(subagentId, events);
      }
      for (const [subagentId, events] of byChild) {
        if (!events.some((event) => event.type === 'subagent.started')) continue;
        eventDerived.push(buildEventDerivedChildDescriptor(subagentId, events));
      }
    }

    return makeResponse(req.requestId, 'list_children', sessionId, true, {
      children: [...active, ...completed, ...eventDerived],
      activeCount: active.length,
      completedCount: completed.length,
      eventDerivedCount: eventDerived.length,
    });
  }

  /**
   * Return one delegated child as a descriptor plus an event-stream summary.
   * The full transcript remains available through fetch_delegation_events.
   */
  async function handleGetChildSession(req: any) {
    const subagentId = req.payload?.subagentId;
    if (!subagentId || typeof subagentId !== 'string') {
      return makeErrorResponse(
        req.requestId,
        'get_child_session',
        'INVALID_REQUEST',
        'subagentId is required',
      );
    }
    const auth = await loadAndAuthSession(req, 'get_child_session');
    if (auth.error) return auth.error;
    const { entry, sessionId } = auth;
    ensureRuntimeState(entry);

    const activeRecord = entry.activeDelegations.get(subagentId);
    const outcomes = Array.isArray(entry.state?.delegationOutcomes)
      ? entry.state.delegationOutcomes
      : [];
    const outcomeRecord = activeRecord
      ? null
      : outcomes.find((outcome: any) => outcome && outcome.subagentId === subagentId);

    // Scan once to recover metadata and support children represented only by
    // subagent events (notably reviewer and deep_reviewer runs).
    const allEvents = await loadSessionEvents(sessionId);
    let childRunId =
      activeRecord && typeof activeRecord.childRunId === 'string' ? activeRecord.childRunId : null;
    if (!childRunId) {
      const startedEvent = allEvents.find(
        (event) =>
          event.type === 'subagent.started' &&
          eventBelongsToChild(event, { subagentId, childRunId: null }),
      );
      if (startedEvent?.payload && typeof startedEvent.payload === 'object') {
        const payload = startedEvent.payload as any;
        if (typeof payload.childRunId === 'string') childRunId = payload.childRunId;
      }
    }
    const events = allEvents.filter((event) =>
      eventBelongsToChild(event, { subagentId, childRunId }),
    );
    const started = events.find((event) => event.type === 'subagent.started');

    let descriptor: any;
    if (activeRecord) {
      descriptor = buildActiveChildDescriptor(subagentId, activeRecord);
    } else if (outcomeRecord) {
      descriptor = buildCompletedChildDescriptor(subagentId, outcomeRecord.outcome);
    } else if (started) {
      descriptor = buildEventDerivedChildDescriptor(subagentId, events);
    } else {
      return makeErrorResponse(
        req.requestId,
        'get_child_session',
        'CHILD_NOT_FOUND',
        `No child delegation with subagentId: ${subagentId}`,
      );
    }

    if (descriptor.source !== 'events' && started?.payload && typeof started.payload === 'object') {
      const payload = started.payload as any;
      if (descriptor.childRunId == null && typeof payload.childRunId === 'string') {
        descriptor.childRunId = payload.childRunId;
      }
      if (descriptor.parentRunId == null && typeof payload.parentRunId === 'string') {
        descriptor.parentRunId = payload.parentRunId;
      }
      if (descriptor.startedAt == null && typeof started.ts === 'number') {
        descriptor.startedAt = started.ts;
      }
      if (
        (!descriptor.task || descriptor.task.length === 0) &&
        typeof payload.detail === 'string'
      ) {
        descriptor.task = payload.detail;
      }
    }

    const eventSummary = {
      eventCount: events.length,
      firstSeq: events.length > 0 ? events[0].seq : null,
      lastSeq: events.length > 0 ? events[events.length - 1].seq : null,
      lastType: events.length > 0 ? events[events.length - 1].type : null,
    };

    return makeResponse(req.requestId, 'get_child_session', sessionId, true, {
      child: descriptor,
      eventSummary,
    });
  }

  return {
    handleFetchDelegationEvents,
    handleListChildren,
    handleGetChildSession,
  };
}
