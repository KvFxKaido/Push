import { describe, expect, it } from 'vitest';
import {
  isLoopPhase,
  isTerminalRunEnginePhase,
  phaseForDelegationAgent,
} from '@push/lib/run-engine-contract';

describe('run-engine-contract', () => {
  it('maps delegation agents onto canonical engine phases', () => {
    expect(phaseForDelegationAgent('explorer')).toBe('delegating_explorer');
    expect(phaseForDelegationAgent('task_graph')).toBe('executing_task_graph');
    expect(phaseForDelegationAgent('coder')).toBe('delegating_coder');
    expect(phaseForDelegationAgent('planner')).toBe('delegating_coder');
    expect(phaseForDelegationAgent('auditor')).toBe('delegating_coder');
  });

  it('recognizes active loop phases only', () => {
    expect(isLoopPhase('streaming_llm')).toBe(true);
    expect(isLoopPhase('executing_tools')).toBe(true);
    expect(isLoopPhase('starting')).toBe(false);
    expect(isLoopPhase('completed')).toBe(false);
  });

  it('recognizes terminal engine phases only', () => {
    expect(isTerminalRunEnginePhase('idle')).toBe(true);
    expect(isTerminalRunEnginePhase('completed')).toBe(true);
    expect(isTerminalRunEnginePhase('aborted')).toBe(true);
    expect(isTerminalRunEnginePhase('failed')).toBe(true);
    expect(isTerminalRunEnginePhase('streaming_llm')).toBe(false);
    expect(isTerminalRunEnginePhase('starting')).toBe(false);
  });
});
