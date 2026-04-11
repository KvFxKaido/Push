import type { LoopPhase, RunEventSubagent } from './runtime-contract';

/** All phases a run can be in, including lifecycle bookends beyond LoopPhase. */
export type RunEnginePhase = 'idle' | 'starting' | LoopPhase | 'completed' | 'aborted' | 'failed';

/**
 * Every state transition the web/CLI run loop can take, expressed as a
 * discriminated union of typed event objects.
 */
export type RunEngineEvent<FollowUp = unknown> =
  | {
      type: 'RUN_STARTED';
      timestamp: number;
      runId: string;
      chatId: string;
      provider: string;
      model: string;
      baseMessageCount: number;
    }
  | { type: 'TAB_LOCK_ACQUIRED'; timestamp: number; tabLockId: string }
  | { type: 'TAB_LOCK_DENIED'; timestamp: number }
  | { type: 'ROUND_STARTED'; timestamp: number; round: number }
  | { type: 'STREAMING_COMPLETED'; timestamp: number; accumulated: string; thinking: string }
  | { type: 'STEER_CONSUMED'; timestamp: number }
  | { type: 'TOOLS_STARTED'; timestamp: number }
  | {
      type: 'DELEGATION_STARTED';
      timestamp: number;
      agent: RunEventSubagent;
    }
  | {
      type: 'DELEGATION_COMPLETED';
      timestamp: number;
      agent: RunEventSubagent;
    }
  | { type: 'TURN_STEERED'; timestamp: number }
  | { type: 'TURN_CONTINUED'; timestamp: number }
  | { type: 'LOOP_COMPLETED'; timestamp: number }
  | { type: 'LOOP_ABORTED'; timestamp: number }
  | { type: 'LOOP_FAILED'; timestamp: number; reason: string }
  | { type: 'FOLLOW_UP_ENQUEUED'; timestamp: number; followUp: FollowUp }
  | { type: 'FOLLOW_UP_DEQUEUED'; timestamp: number }
  | { type: 'FOLLOW_UP_QUEUE_CLEARED'; timestamp: number }
  | { type: 'STEER_SET'; timestamp: number; preview: string }
  | { type: 'STEER_CLEARED'; timestamp: number }
  | { type: 'ACCUMULATED_UPDATED'; timestamp: number; text: string; thinking: string };

export function phaseForDelegationAgent(agent: RunEventSubagent): RunEnginePhase {
  if (agent === 'task_graph') {
    return 'executing_task_graph';
  }
  if (agent === 'explorer') {
    return 'delegating_explorer';
  }
  return 'delegating_coder';
}

export function isLoopPhase(phase: RunEnginePhase): phase is LoopPhase {
  return (
    phase === 'streaming_llm' ||
    phase === 'executing_tools' ||
    phase === 'delegating_coder' ||
    phase === 'delegating_explorer' ||
    phase === 'executing_task_graph'
  );
}

export function isTerminalRunEnginePhase(phase: RunEnginePhase): boolean {
  return phase === 'idle' || phase === 'completed' || phase === 'aborted' || phase === 'failed';
}
