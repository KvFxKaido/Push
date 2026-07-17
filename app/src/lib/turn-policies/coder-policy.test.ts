import { describe, expect, it } from 'vitest';
import {
  BACKPRESSURE_MUTATION_THRESHOLD,
  createCoderPolicy as createSharedCoderPolicy,
  detectCognitiveDrift,
} from '@push/lib/coder-policy';
import { createCoderPolicy } from './coder-policy';
import { TurnPolicyRegistry, type TurnContext } from '../turn-policy';

function makeCtx(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    role: 'coder',
    round: 0,
    maxRounds: 30,
    sandboxId: 'test',
    allowedRepo: 'test/repo',
    ...overrides,
  };
}

describe('shared Coder policy', () => {
  it('detects drift while preserving code-shaped output', () => {
    expect(detectCognitiveDrift('```json\n{"tool":"sandbox_exec"}\n```')).toBeNull();
    const drifted = '太平'.repeat(25) + '\n'.repeat(25) + 'Unrelated.'.repeat(30);
    expect(detectCognitiveDrift(drifted)).toContain('Repeated token pattern');
  });

  it('emits steer then block interventions for consecutive drift', async () => {
    const policy = createSharedCoderPolicy();
    const drifted = '太平'.repeat(25) + '\n'.repeat(25) + 'Unrelated.'.repeat(30);
    const first = await policy.evaluateAfterModel(drifted, [], makeCtx());
    expect(first?.action).toBe('inject');
    expect(first?.runtimeIntervention.mode).toBe('steer');
    const second = await policy.evaluateAfterModel(drifted, [], makeCtx({ round: 1 }));
    expect(second?.action).toBe('halt');
    expect(second?.runtimeIntervention.mode).toBe('block');
  });

  it('does not apply task-only drift/completion guards to conversation', async () => {
    const policy = createSharedCoderPolicy();
    const result = await policy.evaluateAfterModel(
      "I wasn't looping — want me to continue the explanation?",
      [],
      makeCtx({ taskInFlight: false }),
    );
    expect(result).toBeNull();
  });

  it('accepts grounded read-only completion reports from the conversational lead', async () => {
    const policy = createSharedCoderPolicy();
    expect(await policy.evaluateAfterModel('Finished reading the file.', [], makeCtx())).toBeNull();
  });

  it('nudges announced actions on both task and conversational turns', async () => {
    for (const taskInFlight of [true, false]) {
      const policy = createSharedCoderPolicy();
      const result = await policy.evaluateAfterModel("I'll read README.md next.", [], {
        ...makeCtx(),
        taskInFlight,
      });
      expect(result?.action).toBe('inject');
      expect(result?.code).toBe('announced_no_action');
    }
  });

  it('blocks both web and CLI mutation names during verification', async () => {
    const policy = createSharedCoderPolicy();
    for (const tool of ['sandbox_write_file', 'sandbox_edit_file', 'write_file', 'edit_file']) {
      const result = await policy.evaluateBeforeTool(tool, {}, makeCtx({ phase: 'verifying' }));
      expect(result?.action).toBe('deny');
      expect(result?.runtimeIntervention.mode).toBe('block');
    }
  });

  it('tracks mutation failures and verification backpressure', async () => {
    const policy = createSharedCoderPolicy();
    const ctx = makeCtx();
    for (let i = 0; i < 2; i += 1) {
      expect(
        await policy.evaluateAfterTool(
          'sandbox_edit_file',
          { path: 'broken.ts' },
          'error',
          true,
          ctx,
        ),
      ).toBeNull();
    }
    const failed = await policy.evaluateAfterTool(
      'sandbox_edit_file',
      { path: 'broken.ts' },
      'error',
      true,
      ctx,
    );
    expect(failed?.code).toBe('mutation_hard_failure');

    const fresh = createSharedCoderPolicy();
    for (let i = 0; i < BACKPRESSURE_MUTATION_THRESHOLD - 1; i += 1) {
      expect(
        await fresh.evaluateAfterTool('sandbox_write_file', { path: `f${i}.ts` }, 'ok', false, ctx),
      ).toBeNull();
    }
    const backpressure = await fresh.evaluateAfterTool(
      'sandbox_write_file',
      { path: 'last.ts' },
      'ok',
      false,
      ctx,
    );
    expect(backpressure?.code).toBe('verification_backpressure');
  });
});

describe('web Coder policy adapter', () => {
  it('converts shared content into ChatMessage results', async () => {
    const registry = new TurnPolicyRegistry();
    registry.register(createCoderPolicy());
    const result = await registry.evaluateAfterModel(
      'Task is done. Everything looks good.',
      [],
      makeCtx({ taskInFlight: true }),
    );
    expect(result?.action).toBe('inject');
    if (result?.action === 'inject') {
      expect(result.message.content).toContain('INCOMPLETE_COMPLETION');
    }
  });
});
