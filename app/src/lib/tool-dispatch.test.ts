import { describe, expect, it } from 'vitest';
import { diagnoseToolCallFailure } from './tool-dispatch';

describe('diagnoseToolCallFailure natural language intent detection', () => {
  it('detects delegate intent phrased with coder agent', () => {
    const result = diagnoseToolCallFailure("I'll delegate this task to the coder agent now.");

    expect(result?.reason).toBe('natural_language_intent');
    expect(result?.toolName).toBe('delegate_coder');
  });

  it('does not flag explanatory prose as tool intent', () => {
    const result = diagnoseToolCallFailure(
      'The orchestrator may delegate this task to the coder agent when it is complex.'
    );

    expect(result).toBeNull();
  });
});
