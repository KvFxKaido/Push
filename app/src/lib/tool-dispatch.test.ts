import { describe, expect, it } from 'vitest';
import { detectAllToolCalls, diagnoseToolCallFailure } from './tool-dispatch';

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

describe('detectAllToolCalls', () => {
  it('detects mixed explicit + bare read-only calls in one response', () => {
    const text = [
      '{"tool":"search_files","args":{"repo":"KvFxKaido/Push","query":"async function runConfigInit","path":"scripts/push/cli.mjs"}}',
      '{"repo":"KvFxKaido/Push","path":"scripts/push/cli.mjs","start_line":279,"end_line":349}',
    ].join('\n');

    const detected = detectAllToolCalls(text);
    expect(detected.readOnly).toHaveLength(2);
    expect(detected.mutating).toBeNull();
  });

  it('keeps trailing mutating call when there is exactly one read call', () => {
    const text = [
      '{"tool":"search_files","args":{"repo":"KvFxKaido/Push","query":"runConfigInit"}}',
      '{"message":"chore: update config command"}',
    ].join('\n');

    const detected = detectAllToolCalls(text);
    expect(detected.readOnly).toHaveLength(1);
    expect(detected.readOnly[0].source).toBe('github');
    expect(detected.mutating?.source).toBe('sandbox');
    if (detected.mutating?.source === 'sandbox') {
      expect(detected.mutating.call.tool).toBe('sandbox_prepare_commit');
    }
  });

  it('deduplicates wrapper and bare forms of the same call', () => {
    const text = [
      '{"tool":"read_file","args":{"repo":"KvFxKaido/Push","path":"scripts/push/cli.mjs","start_line":279,"end_line":349}}',
      '{"repo":"KvFxKaido/Push","path":"scripts/push/cli.mjs","start_line":279,"end_line":349}',
    ].join('\n');

    const detected = detectAllToolCalls(text);
    expect(detected.readOnly).toHaveLength(1);
    expect(detected.mutating).toBeNull();
  });
});
