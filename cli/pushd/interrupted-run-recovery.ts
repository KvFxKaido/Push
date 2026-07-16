/** Semantic parent-run recovery after an unclean daemon shutdown. */
import process from 'node:process';

import { runAssistantTurn, DEFAULT_MAX_ROUNDS } from '../engine.js';
import { PROVIDER_CONFIGS, resolveApiKey } from '../provider.js';
import {
  appendSessionEvent,
  clearRunMarker,
  loadSessionEvents,
  loadSessionState,
  makeRunId,
  PROTOCOL_VERSION,
  saveSessionState,
  scanInterruptedSessions,
  writeRunMarker,
} from '../session-store.js';
import {
  collectOrphanedDelegations,
  formatDelegationInterruptedNote,
  type OrphanedDelegations,
} from './recovery-reconciliation.js';
import { getRestartPolicy, shouldRecover } from './restart-policy.js';
import type { SessionRuntime, SessionRuntimeEntry } from './session-runtime.js';

export interface InterruptedRunRecovery {
  recoverInterruptedRuns(): Promise<void>;
}

export function createInterruptedRunRecovery(runtime: SessionRuntime): InterruptedRunRecovery {
  const activeSessions = runtime.sessions;
  const buildApprovalFn = (sessionId: string, entry: SessionRuntimeEntry, runId: string) =>
    runtime.buildApprovalFn(sessionId, entry, runId);
  const broadcastEvent = (sessionId: string, event: any) => runtime.broadcast(sessionId, event);

  async function recoverInterruptedRuns() {
    let interrupted;
    try {
      interrupted = await scanInterruptedSessions();
    } catch {
      return; // scan failure is non-fatal
    }

    if (interrupted.length === 0) return;
    process.stdout.write(`crash recovery: found ${interrupted.length} interrupted session(s)\n`);

    for (const { sessionId, marker } of interrupted) {
      let state;
      try {
        state = await loadSessionState(sessionId);
      } catch {
        // Can't load state — clear stale marker and skip
        await clearRunMarker(sessionId).catch(() => {});
        process.stdout.write(`  ${sessionId}: state unreadable, clearing marker\n`);
        continue;
      }

      const policy = getRestartPolicy(state as typeof state & { restartPolicy?: string | null });
      if (!shouldRecover(policy, marker)) {
        await clearRunMarker(sessionId).catch(() => {});
        const reason = policy === 'never' ? 'policy=never' : 'marker too old';
        process.stdout.write(`  ${sessionId}: skipped (${reason})\n`);

        // Log that we skipped recovery
        await appendSessionEvent(state, 'recovery_skipped', {
          originalRunId: marker.runId,
          reason,
          policy,
          markerAge: Date.now() - (marker.startedAt || 0),
        }).catch(() => {});
        await saveSessionState(state).catch(() => {});
        continue;
      }

      // Resolve provider + API key
      const providerConfig = PROVIDER_CONFIGS[state.provider];
      if (!providerConfig) {
        await clearRunMarker(sessionId).catch(() => {});
        process.stdout.write(
          `  ${sessionId}: unknown provider "${state.provider}", clearing marker\n`,
        );
        continue;
      }

      let apiKey;
      try {
        apiKey = resolveApiKey(providerConfig);
      } catch {
        await clearRunMarker(sessionId).catch(() => {});
        process.stdout.write(
          `  ${sessionId}: no API key for "${state.provider}", clearing marker\n`,
        );
        continue;
      }

      const recoveryRunId = makeRunId();
      const abortController = new AbortController();
      // Restore the persisted attach token so a client that had the session
      // open before the crash can successfully re-attach with the SAME token
      // they originally received from `start_session`. A legacy session with no
      // persisted token is claimed on its first `attach_session` (bootstrap
      // grace); the implicit tokenless bypass is gone (Universal Session Bearer).
      const attachToken = state.attachToken;

      // Register in-memory
      const entry: SessionRuntimeEntry = {
        state,
        attachToken,
        activeRunId: recoveryRunId,
        abortController,
      };
      activeSessions.set(sessionId, entry);

      // Crash recovery is narrow: we recover the parent only. Any sub-agents or
      // task graphs that were in-flight when the daemon died are lost. Detect
      // them from the event log and fold a DELEGATION_INTERRUPTED note into the
      // recovery turn so the recovered lead re-delegates rather than waiting on
      // ghost completions that will never arrive.
      let orphans: OrphanedDelegations = { subagents: [], graphs: [] };
      try {
        const events = await loadSessionEvents(sessionId);
        orphans = collectOrphanedDelegations(events, marker.runId);
      } catch {
        // Event-log scan is best-effort — if we can't read it, skip the note.
      }
      const interruptedNote = formatDelegationInterruptedNote(orphans);

      // Inject reconciliation as a SINGLE recovery turn — the kernel lane runs it
      // as the lead's `userText`, so the recovery note + the interrupted note must
      // be one message (a second would render as clipped "prior conversation"
      // rather than the task).
      const recoveryUserText = [
        `[SESSION_RECOVERED]\nThe previous run (${marker.runId}) was interrupted by a daemon crash.\nYou are resuming in a new run (${recoveryRunId}). Review your working memory and continue where you left off.\nDo NOT restart from scratch — pick up from the last completed step.\n[/SESSION_RECOVERED]`,
        interruptedNote,
      ]
        .filter(Boolean)
        .join('\n\n');
      state.messages.push({ role: 'user', content: recoveryUserText });
      if (interruptedNote) {
        await appendSessionEvent(state, 'delegation_interrupted', {
          originalRunId: marker.runId,
          recoveryRunId,
          subagents: orphans.subagents,
          graphs: orphans.graphs,
        }).catch(() => {});
      }

      await appendSessionEvent(state, 'run_recovered', {
        originalRunId: marker.runId,
        recoveryRunId,
        policy,
        markerAge: Date.now() - (marker.startedAt || 0),
      }).catch(() => {});

      process.stdout.write(`  ${sessionId}: recovering run ${marker.runId} → ${recoveryRunId}\n`);

      // Clear old marker and write new one for the recovery run
      await clearRunMarker(sessionId).catch(() => {});
      await writeRunMarker(sessionId, recoveryRunId, {
        provider: state.provider,
        model: state.model,
        cwd: state.cwd,
        recoveredFrom: marker.runId,
      }).catch(() => {});

      // Build approval gate so recovered runs can request client approvals
      const approvalFn = buildApprovalFn(sessionId, entry, recoveryRunId);

      // Launch recovery run in background (same pattern as handleSendUserMessage)
      (async () => {
        let sawError = false;
        let sawRunComplete = false;
        try {
          await runAssistantTurn(
            state,
            providerConfig,
            apiKey,
            recoveryUserText,
            DEFAULT_MAX_ROUNDS,
            {
              runId: recoveryRunId,
              // Fixed cap on daemon turns — see handleSendUserMessage; adaptation
              // stays off until the client cap is threaded through the daemon.
              explicitMaxRounds: true,
              approvalFn,
              signal: abortController.signal,
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
            },
          );
          await saveSessionState(state);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (!sawError) {
            await appendSessionEvent(
              state,
              'error',
              { code: 'RECOVERY_ERROR', message, retryable: false },
              recoveryRunId,
            ).catch(() => {});
            broadcastEvent(sessionId, {
              v: PROTOCOL_VERSION,
              kind: 'event',
              sessionId,
              runId: recoveryRunId,
              seq: state.eventSeq,
              ts: Date.now(),
              type: 'error',
              payload: { code: 'RECOVERY_ERROR', message, retryable: false },
            });
          }
          if (!sawRunComplete) {
            await appendSessionEvent(
              state,
              'run_complete',
              { runId: recoveryRunId, outcome: 'failed', summary: message.slice(0, 500) },
              recoveryRunId,
            ).catch(() => {});
            broadcastEvent(sessionId, {
              v: PROTOCOL_VERSION,
              kind: 'event',
              sessionId,
              runId: recoveryRunId,
              seq: state.eventSeq,
              ts: Date.now(),
              type: 'run_complete',
              payload: { outcome: 'failed', summary: message.slice(0, 500) },
            });
          }
          await saveSessionState(state).catch(() => {});
        } finally {
          entry.activeRunId = null;
          entry.abortController = null;
          if (entry.pendingApproval) {
            clearTimeout(entry.pendingApproval.timer);
            entry.pendingApproval = null;
          }
          clearRunMarker(sessionId).catch(() => {});
        }
      })();
    }
  }

  return { recoverInterruptedRuns };
}
