import { describe, expect, it, vi } from 'vitest';
import { createCoderPolicyKernelAdapter } from './coder-policy-kernel-adapter.js';

function makeAdapter(phase?: string) {
  const execute = vi.fn(async () => ({ kind: 'executed' as const, resultText: 'ok' }));
  return {
    execute,
    adapter: createCoderPolicyKernelAdapter({
      context: {
        round: 0,
        maxRounds: 30,
        phase,
        allowedRepo: 'owner/repo',
        taskInFlight: true,
      },
      execute,
    }),
  };
}

describe('createCoderPolicyKernelAdapter', () => {
  it('blocks mutations during verification before the host executor runs', async () => {
    const { adapter, execute } = makeAdapter('verification');
    const result = await adapter.toolExec(
      { source: 'sandbox', call: { tool: 'write_file', args: { path: 'src/a.ts' } } },
      { round: 2, phase: 'verification', executionId: 'exec-1' },
    );

    expect(result.kind).toBe('denied');
    expect(execute).not.toHaveBeenCalled();
  });

  it('attaches after-tool backpressure to the fourth unverified mutation', async () => {
    const { adapter } = makeAdapter('implementation');
    let result;
    for (let index = 0; index < 4; index += 1) {
      result = await adapter.toolExec(
        { source: 'sandbox', call: { tool: 'edit_file', args: { path: `src/${index}.ts` } } },
        { round: index, phase: 'implementation', executionId: `exec-${index}` },
      );
    }

    expect(result).toMatchObject({
      kind: 'executed',
      policyPost: { kind: 'inject' },
    });
    expect(result?.policyPost?.kind === 'inject' ? result.policyPost.content : '').toContain(
      'VERIFY_BEFORE_CONTINUING',
    );
  });

  it('forces a tool call after the model announces an action without taking it', async () => {
    const { adapter } = makeAdapter();
    const result = await adapter.evaluateAfterModel(
      'I will inspect the runtime implementation now.',
      3,
    );

    expect(result).toMatchObject({
      action: 'inject',
      forceToolChoiceNextRound: true,
    });
  });

  it('forwards shared policy events to the host', async () => {
    const onEvent = vi.fn();
    const execute = vi.fn(async () => ({ kind: 'executed' as const, resultText: 'ok' }));
    const adapter = createCoderPolicyKernelAdapter({
      context: makeAdapter().adapter.context,
      execute,
      onEvent,
    });

    await adapter.evaluateAfterModel("I'll inspect README.md now.", 1);

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'coder_trailing_intent_nudged', round: 1 }),
    );
  });
});
