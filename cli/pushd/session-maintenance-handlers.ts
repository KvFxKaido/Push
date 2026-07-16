/** Addressable-session transcript maintenance verbs. */
import { compactContext, isFirstUserMessage } from '../context-manager.js';
import { appendSessionEvent, PROTOCOL_VERSION, rewriteMessagesLog } from '../session-store.js';
import { makeErrorResponse, makeResponse } from './envelopes.js';
import type { DaemonHandler } from './handler-types.js';
import type { LoadAndAuthSession } from './session-auth.js';
import type { SessionRuntime } from './session-runtime.js';

export interface SessionMaintenanceHandlerDependencies {
  runtime: SessionRuntime;
  loadAndAuthSession: LoadAndAuthSession;
}

export interface SessionMaintenanceHandlers {
  handleSessionSummarize: DaemonHandler;
  handleSessionRevert: DaemonHandler;
  handleSessionUnrevert: DaemonHandler;
}

export function createSessionMaintenanceHandlers(
  dependencies: SessionMaintenanceHandlerDependencies,
): SessionMaintenanceHandlers {
  const loadAndAuthSession = dependencies.loadAndAuthSession;
  const broadcastEvent = (sessionId: string, event: any) =>
    dependencies.runtime.broadcast(sessionId, event);

  /**
   * `session_summarize` — on-demand context compaction (Addressable Session Verbs
   * phase 4; opencode's `session.summarize`). Replaces the older turns with a
   * digest, keeping the system prompt, first user turn, and the last
   * `preserveTurns` turns — the same `compactContext` the CLI `/compact` command
   * uses, now reachable as a bearer-gated daemon verb. Persists the compacted
   * transcript (`rewriteMessagesLog`, since the length-only fast path can skip a
   * same-length swap) and emits `context_compacted`. Rejected while a run is
   * active (compacting mid-run would corrupt the in-flight context).
   */
  async function handleSessionSummarize(req: any, _emitEvent: any) {
    const auth = await loadAndAuthSession(req, 'session_summarize');
    if (auth.error) return auth.error;
    const { entry, sessionId } = auth;

    if (entry.activeRunId) {
      return makeErrorResponse(
        req.requestId,
        'session_summarize',
        'RUN_IN_PROGRESS',
        `Cannot summarize while run ${entry.activeRunId} is active`,
      );
    }

    // Strict, like the CLI `/compact`: a positive integer (or its exact digit
    // string), clamped to [1, 64]. Reject malformed input rather than coercing.
    const preserveTurns = parsePositiveIntField(req.payload?.preserveTurns, 6, 64);
    if (preserveTurns === null) {
      return makeErrorResponse(
        req.requestId,
        'session_summarize',
        'INVALID_REQUEST',
        'preserveTurns must be a positive integer',
      );
    }

    const messages = Array.isArray(entry.state?.messages) ? entry.state.messages : [];
    const result = compactContext(messages, { preserveTurns });

    // "Nothing to compact" is a valid no-op outcome, not an error.
    if (!result.compacted) {
      return makeResponse(req.requestId, 'session_summarize', sessionId, true, {
        compacted: false,
        preserveTurns: result.preserveTurns,
        totalTurns: result.totalTurns,
        beforeTokens: result.beforeTokens,
        afterTokens: result.afterTokens,
        removedCount: 0,
        compactedCount: 0,
      });
    }

    entry.state.messages = result.messages;
    const compactedPayload = {
      preserveTurns: result.preserveTurns,
      totalTurns: result.totalTurns,
      compactedMessages: result.compactedCount,
      removedCount: result.removedCount,
      beforeTokens: result.beforeTokens,
      afterTokens: result.afterTokens,
    };
    await appendSessionEvent(entry.state, 'context_compacted', compactedPayload);
    // Explicit rewrite: compaction can produce a same-length messages array
    // (drop one, insert digest), which `saveSessionState`'s length-only fast path
    // would skip — leaving the on-disk transcript out of sync with memory.
    await rewriteMessagesLog(entry.state);
    // Notify live clients so an attached transcript view doesn't go stale.
    broadcastEvent(sessionId, {
      v: PROTOCOL_VERSION,
      kind: 'event',
      sessionId,
      seq: entry.state.eventSeq,
      ts: Date.now(),
      type: 'context_compacted',
      payload: compactedPayload,
    });

    return makeResponse(req.requestId, 'session_summarize', sessionId, true, {
      compacted: true,
      preserveTurns: result.preserveTurns,
      totalTurns: result.totalTurns,
      compactedCount: result.compactedCount,
      removedCount: result.removedCount,
      beforeTokens: result.beforeTokens,
      afterTokens: result.afterTokens,
    });
  }

  /**
   * Parse a strict positive-integer payload field (a number or its exact digit
   * string), clamped to [1, max]. Returns `null` for anything malformed —
   * matches the CLI `/compact` strictness; the handler turns `null` into an
   * INVALID_REQUEST rather than coercing bad input.
   */
  function parsePositiveIntField(raw: unknown, fallback: number, max: number): number | null {
    if (raw === undefined) return fallback;
    let n: number;
    if (typeof raw === 'number') n = raw;
    else if (typeof raw === 'string' && /^\d+$/.test(raw.trim()))
      n = Number.parseInt(raw.trim(), 10);
    else n = Number.NaN;
    if (!Number.isInteger(n) || n < 1) return null;
    return Math.min(max, n);
  }

  /**
   * `session_revert` — undo the last N user turns of the conversation
   * (Addressable Session Verbs phase 5; opencode's `session.revert`). Transcript
   * only: it truncates `state.messages` (and persists via `rewriteMessagesLog`)
   * and stashes the removed tail on the entry so `session_unrevert` can restore
   * it. Sandbox / git state is deliberately untouched — code rollback is a
   * separate concern with its own typed branch tools. Turn boundaries use the
   * same `isFirstUserMessage` detector as compaction. The stash accumulates
   * across consecutive reverts and is cleared by the next `send_user_message`
   * (a new message commits the fork). Bearer-gated; rejected mid-run.
   */
  async function handleSessionRevert(req: any) {
    const auth = await loadAndAuthSession(req, 'session_revert');
    if (auth.error) return auth.error;
    const { entry, sessionId } = auth;

    if (entry.activeRunId) {
      return makeErrorResponse(
        req.requestId,
        'session_revert',
        'RUN_IN_PROGRESS',
        `Cannot revert while run ${entry.activeRunId} is active`,
      );
    }

    const turns = parsePositiveIntField(req.payload?.turns, 1, 1024);
    if (turns === null) {
      return makeErrorResponse(
        req.requestId,
        'session_revert',
        'INVALID_REQUEST',
        'turns must be a positive integer',
      );
    }

    const messages = Array.isArray(entry.state?.messages) ? entry.state.messages : [];
    const turnStarts = [];
    for (let i = 0; i < messages.length; i += 1) {
      if (isFirstUserMessage(messages[i])) turnStarts.push(i);
    }
    const totalTurns = turnStarts.length;

    if (totalTurns === 0) {
      return makeResponse(req.requestId, 'session_revert', sessionId, true, {
        reverted: false,
        removedCount: 0,
        totalTurns: 0,
        remainingTurns: 0,
      });
    }

    // Critical section: read `messages` → mutate `state.messages` + `revertedTail`
    // with NO `await` in between, so it runs atomically on Node's single-threaded
    // loop — a concurrent revert/unrevert can't interleave a read-modify-write
    // here (the first `await` below is the only yield point). Same concurrency
    // posture as every other session-mutating handler; no extra lock is taken.
    const effectiveTurns = Math.min(turns, totalTurns);
    const cutIndex = turnStarts[totalTurns - effectiveTurns];
    const removed = messages.slice(cutIndex);
    entry.state.messages = messages.slice(0, cutIndex);
    // Accumulate so `unrevert` can undo a run of consecutive reverts in order.
    entry.revertedTail = [
      ...removed,
      ...(Array.isArray(entry.revertedTail) ? entry.revertedTail : []),
    ];

    const payload = {
      turns: effectiveTurns,
      removedCount: removed.length,
      totalTurns,
      remainingTurns: totalTurns - effectiveTurns,
      remainingMessages: entry.state.messages.length,
    };
    await appendSessionEvent(entry.state, 'session_reverted', payload);
    await rewriteMessagesLog(entry.state);
    broadcastEvent(sessionId, {
      v: PROTOCOL_VERSION,
      kind: 'event',
      sessionId,
      seq: entry.state.eventSeq,
      ts: Date.now(),
      type: 'session_reverted',
      payload,
    });

    return makeResponse(req.requestId, 'session_revert', sessionId, true, {
      reverted: true,
      ...payload,
      canUnrevert: true,
    });
  }

  /**
   * `session_unrevert` — restore the messages removed by the most recent run of
   * `session_revert`(s) (opencode's `session.unrevert`). Appends the stashed tail
   * back, persists, and clears the stash. NOTHING_TO_UNREVERT if no revert is
   * pending (e.g. a `send_user_message` already committed the fork). Bearer-gated;
   * rejected mid-run.
   */
  async function handleSessionUnrevert(req: any) {
    const auth = await loadAndAuthSession(req, 'session_unrevert');
    if (auth.error) return auth.error;
    const { entry, sessionId } = auth;

    if (entry.activeRunId) {
      return makeErrorResponse(
        req.requestId,
        'session_unrevert',
        'RUN_IN_PROGRESS',
        `Cannot unrevert while run ${entry.activeRunId} is active`,
      );
    }

    const tail = Array.isArray(entry.revertedTail) ? entry.revertedTail : [];
    if (tail.length === 0) {
      return makeErrorResponse(
        req.requestId,
        'session_unrevert',
        'NOTHING_TO_UNREVERT',
        'No reverted messages to restore (a new message may have committed the fork)',
      );
    }

    // Await-free critical section (see the note in handleSessionRevert): the
    // read→restore→clear runs atomically before the first await below.
    const restoredCount = tail.length;
    const messages = Array.isArray(entry.state?.messages) ? entry.state.messages : [];
    entry.state.messages = [...messages, ...tail];
    entry.revertedTail = null;

    const payload = { restoredCount, totalMessages: entry.state.messages.length };
    await appendSessionEvent(entry.state, 'session_unreverted', payload);
    await rewriteMessagesLog(entry.state);
    broadcastEvent(sessionId, {
      v: PROTOCOL_VERSION,
      kind: 'event',
      sessionId,
      seq: entry.state.eventSeq,
      ts: Date.now(),
      type: 'session_unreverted',
      payload,
    });

    return makeResponse(req.requestId, 'session_unrevert', sessionId, true, {
      unreverted: true,
      ...payload,
    });
  }

  return {
    handleSessionSummarize,
    handleSessionRevert,
    handleSessionUnrevert,
  };
}
