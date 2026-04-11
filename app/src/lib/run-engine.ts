/**
 * run-engine.ts
 *
 * Serializable run-engine state model and pure reducer for Track A of the
 * Harness Runtime Evolution Plan.
 *
 * CURRENT STATUS: Track A — authoritative
 * - Defines the RunEngineState shape and event types.
 * - Reducer is pure: no side effects, no React dependencies, no I/O.
 * - The engine is authoritative: phase, round, accumulated, chatId, provider,
 *   model, baseMessageCount, tabLockId, queue, and steer state are all
 *   read from RunEngineState. Only apiMessages remains as a separate ref.
 *
 * This module is the invariants document in executable form:
 *   - Every phase transition the sendMessage loop can take is a RunEngineEvent.
 *   - The reducer is the single source of truth for what those transitions mean.
 *   - Tests in run-engine.test.ts replay full loop scenarios without mounting UI.
 *
 * Side effects (React state updates, IndexedDB writes, provider streaming,
 * sandbox calls, delegation execution) stay in thin adapters in hooks/.
 */

import type { QueuedFollowUp } from '@/types';
import {
  isLoopPhase,
  isTerminalRunEnginePhase,
  phaseForDelegationAgent,
  type RunEngineEvent as SharedRunEngineEvent,
  type RunEnginePhase,
} from '@push/lib/run-engine-contract';

export type RunEngineEvent = SharedRunEngineEvent<QueuedFollowUp>;
export type { RunEnginePhase } from '@push/lib/run-engine-contract';

function assertNever(value: never): never {
  throw new Error(`Unhandled RunEngineEvent: ${JSON.stringify(value)}`);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * The serializable run-engine state.
 *
 * All fields are JSON-safe so this can be persisted to IndexedDB or replayed
 * in tests. Nothing in this interface holds React refs, AbortControllers,
 * callbacks, or DOM handles.
 *
 * Invariants captured here:
 *   - queuedFollowUps is FIFO; drained in the finally block after loop ends.
 *   - hasPendingSteer is at most one per run; last STEER_SET wins.
 *   - tabLockId is null before TAB_LOCK_ACQUIRED and after any terminal event.
 *   - loopCompletedNormally is only true after LOOP_COMPLETED; all other exits leave it false.
 */
export interface RunEngineState {
  // --- Run identity ---
  runId: string;
  chatId: string;
  provider: string;
  model: string;

  // --- Progress ---
  phase: RunEnginePhase;
  round: number;
  baseMessageCount: number;

  // --- In-flight content (mirrors checkpointRefs.accumulated / .thinking) ---
  accumulatedText: string;
  accumulatedThinking: string;

  // --- Queue / steer ---
  /** Follow-ups queued while the loop runs. Consumed sequentially after loop completes. */
  queuedFollowUps: QueuedFollowUp[];
  /** True while a steer is pending consumption before the next round. */
  hasPendingSteer: boolean;
  /** Human-readable preview of the pending steer, for diagnostics and console display. */
  pendingSteerPreview: string;

  // --- Outcome ---
  loopCompletedNormally: boolean;
  failureReason: string | null;

  // --- Tab lock ---
  tabLockId: string | null;

  // --- Timestamps ---
  startedAt: number;
  lastUpdatedAt: number;
}

export interface RunEngineObservedState {
  loopActive: boolean;
  checkpointPhase: string | null;
  round: number;
  accumulatedText: string;
  accumulatedThinking: string;
  queuedFollowUpCount: number;
  hasPendingSteer: boolean;
  tabLockId: string | null;
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

/**
 * Zero-value state representing no active run.
 * Use as the starting point for replayEvents() or as a safe default.
 */
export const IDLE_RUN_STATE: RunEngineState = {
  runId: '',
  chatId: '',
  provider: '',
  model: '',
  phase: 'idle',
  round: 0,
  baseMessageCount: 0,
  accumulatedText: '',
  accumulatedThinking: '',
  queuedFollowUps: [],
  hasPendingSteer: false,
  pendingSteerPreview: '',
  loopCompletedNormally: false,
  failureReason: null,
  tabLockId: null,
  startedAt: 0,
  lastUpdatedAt: 0,
};

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/**
 * Pure run-engine reducer.
 *
 * (state, event) → nextState with no side effects.
 *
 * Phase-transition notes:
 *   - STREAMING_COMPLETED is a content event; it does NOT advance phase.
 *     Phase moves to 'executing_tools' only on TOOLS_STARTED.
 *   - DELEGATION_COMPLETED returns to 'executing_tools', not 'streaming_llm'.
 *     TURN_CONTINUED or TURN_STEERED drives re-entry into streaming.
 *   - All three terminal events (LOOP_COMPLETED, LOOP_ABORTED, LOOP_FAILED)
 *     clear tabLockId — the lock is logically released as part of exit.
 *   - The reducer does NOT auto-clear hasPendingSteer on loop exit; the harness
 *     adapter is responsible for emitting STEER_CLEARED before the finally block.
 *     This keeps the reducer as a truth ledger, not a policy enforcer.
 */
export function runEngineReducer(state: RunEngineState, event: RunEngineEvent): RunEngineState {
  const now = event.timestamp;

  switch (event.type) {
    case 'RUN_STARTED':
      return {
        runId: event.runId,
        chatId: event.chatId,
        provider: event.provider,
        model: event.model,
        phase: 'starting',
        round: 0,
        baseMessageCount: event.baseMessageCount,
        accumulatedText: '',
        accumulatedThinking: '',
        queuedFollowUps: state.chatId === event.chatId ? state.queuedFollowUps : [],
        hasPendingSteer: false,
        pendingSteerPreview: '',
        loopCompletedNormally: false,
        failureReason: null,
        tabLockId: null,
        startedAt: now,
        lastUpdatedAt: now,
      };

    case 'TAB_LOCK_ACQUIRED':
      return { ...state, tabLockId: event.tabLockId, lastUpdatedAt: now };

    case 'TAB_LOCK_DENIED':
      return {
        ...state,
        phase: 'failed',
        failureReason: 'tab_lock_denied',
        tabLockId: null,
        lastUpdatedAt: now,
      };

    case 'ROUND_STARTED':
      return {
        ...state,
        phase: 'streaming_llm',
        round: event.round,
        accumulatedText: '',
        accumulatedThinking: '',
        lastUpdatedAt: now,
      };

    case 'STREAMING_COMPLETED':
      // Content update only; phase stays at 'streaming_llm' until TOOLS_STARTED.
      return {
        ...state,
        accumulatedText: event.accumulated,
        accumulatedThinking: event.thinking,
        lastUpdatedAt: now,
      };

    case 'STEER_CONSUMED':
      return {
        ...state,
        hasPendingSteer: false,
        pendingSteerPreview: '',
        lastUpdatedAt: now,
      };

    case 'TOOLS_STARTED':
      return { ...state, phase: 'executing_tools', lastUpdatedAt: now };

    case 'DELEGATION_STARTED': {
      const delegationPhase = phaseForDelegationAgent(event.agent);
      return { ...state, phase: delegationPhase, lastUpdatedAt: now };
    }

    case 'DELEGATION_COMPLETED':
      // Planner/auditor are nested inside the delegate_coder flow, so their
      // completion keeps the coarse phase at delegating_coder. Top-level coder,
      // explorer, and task_graph completions return to tool execution.
      return {
        ...state,
        phase:
          event.agent === 'planner' || event.agent === 'auditor'
            ? 'delegating_coder'
            : 'executing_tools',
        lastUpdatedAt: now,
      };

    case 'TURN_STEERED':
    case 'TURN_CONTINUED':
      return { ...state, phase: 'streaming_llm', lastUpdatedAt: now };

    case 'LOOP_COMPLETED':
      return {
        ...state,
        phase: 'completed',
        loopCompletedNormally: true,
        tabLockId: null,
        lastUpdatedAt: now,
      };

    case 'LOOP_ABORTED':
      return {
        ...state,
        phase: 'aborted',
        loopCompletedNormally: false,
        tabLockId: null,
        lastUpdatedAt: now,
      };

    case 'LOOP_FAILED':
      return {
        ...state,
        phase: 'failed',
        loopCompletedNormally: false,
        failureReason: event.reason,
        tabLockId: null,
        lastUpdatedAt: now,
      };

    case 'FOLLOW_UP_ENQUEUED':
      return {
        ...state,
        queuedFollowUps: [...state.queuedFollowUps, event.followUp],
        lastUpdatedAt: now,
      };

    case 'FOLLOW_UP_DEQUEUED':
      return {
        ...state,
        queuedFollowUps: state.queuedFollowUps.slice(1),
        lastUpdatedAt: now,
      };

    case 'FOLLOW_UP_QUEUE_CLEARED':
      return { ...state, queuedFollowUps: [], lastUpdatedAt: now };

    case 'STEER_SET':
      return {
        ...state,
        hasPendingSteer: true,
        pendingSteerPreview: event.preview,
        lastUpdatedAt: now,
      };

    case 'STEER_CLEARED':
      return {
        ...state,
        hasPendingSteer: false,
        pendingSteerPreview: '',
        lastUpdatedAt: now,
      };

    case 'ACCUMULATED_UPDATED':
      return {
        ...state,
        accumulatedText: event.text,
        accumulatedThinking: event.thinking,
        lastUpdatedAt: now,
      };

    default: {
      // Exhaustiveness check: adding a new event variant without a case here
      // will cause a TypeScript compile error.
      return assertNever(event);
    }
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * True when the engine has an active run that can accept queue/steer input.
 *
 * 'starting' counts as active — loopActiveRef.current is set to true before
 * tab lock acquisition in the live loop, so external input can arrive in that
 * window.
 */
export function isRunActive(state: RunEngineState): boolean {
  return (
    state.phase !== 'idle' &&
    state.phase !== 'completed' &&
    state.phase !== 'aborted' &&
    state.phase !== 'failed'
  );
}

/**
 * Replay a sequence of events from an initial state.
 *
 * Deterministic: same (initial, events) always produces the same final state.
 * Takes `initial` (not hardcoded to IDLE_RUN_STATE) so partial histories and
 * mid-stream resumption scenarios can be replayed in tests and diagnostics.
 */
export function replayEvents(initial: RunEngineState, events: RunEngineEvent[]): RunEngineState {
  return events.reduce(runEngineReducer, initial);
}

export function collectRunEngineParityIssues(
  state: RunEngineState,
  observed: RunEngineObservedState,
): string[] {
  const issues: string[] = [];
  const phase = state.phase;
  const activeLoopPhase = isLoopPhase(phase);
  const terminalPhase = isTerminalRunEnginePhase(phase);

  if (phase === 'starting' || activeLoopPhase) {
    if (!observed.loopActive) {
      issues.push(`engine phase=${phase} but loopActive=false`);
    }
  }

  if (phase === 'idle' && observed.loopActive) {
    issues.push('engine phase=idle but loopActive=true');
  }

  if (activeLoopPhase && observed.checkpointPhase && phase !== observed.checkpointPhase) {
    issues.push(`phase mismatch: engine=${phase} observed=${observed.checkpointPhase}`);
  }

  if (activeLoopPhase && state.round !== observed.round) {
    issues.push(`round mismatch: engine=${state.round} observed=${observed.round}`);
  }

  if (phase === 'streaming_llm' && state.accumulatedText !== observed.accumulatedText) {
    issues.push('accumulatedText mismatch');
  }

  if (phase === 'streaming_llm' && state.accumulatedThinking !== observed.accumulatedThinking) {
    issues.push('accumulatedThinking mismatch');
  }

  if (!terminalPhase) {
    if (state.queuedFollowUps.length !== observed.queuedFollowUpCount) {
      issues.push(
        `queue length mismatch: engine=${state.queuedFollowUps.length} observed=${observed.queuedFollowUpCount}`,
      );
    }

    if (state.hasPendingSteer !== observed.hasPendingSteer) {
      issues.push(
        `pending steer mismatch: engine=${state.hasPendingSteer} observed=${observed.hasPendingSteer}`,
      );
    }
  }

  if (activeLoopPhase && state.tabLockId !== observed.tabLockId) {
    issues.push(
      `tab lock mismatch: engine=${state.tabLockId ?? 'null'} observed=${observed.tabLockId ?? 'null'}`,
    );
  }

  return issues;
}
