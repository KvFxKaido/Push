import { describe, expect, it, vi } from 'vitest';
import type { CoderTurnContext } from '@push/lib/coder-agent-bindings';
import { buildCoderJobServices } from './coder-job-services';

function makeServices() {
  const turnCtx: CoderTurnContext = {
    role: 'coder',
    round: 0,
    maxRounds: 30,
    sandboxId: 'sandbox-1',
    allowedRepo: 'owner/repo',
    taskInFlight: true,
  };

  return {
    turnCtx,
    services: buildCoderJobServices({
      detectors: {} as never,
      executor: {} as never,
      capabilityLedger: {} as never,
      turnCtx,
      onStatus: () => {},
      activeProvider: 'openrouter',
      activeModel: 'model-1',
      sandboxId: 'sandbox-1',
      policyEventHost: 'worker_background',
    }),
  };
}

describe('buildCoderJobServices policy', () => {
  it('uses the shared stateful Coder policy instead of a permissive no-op', async () => {
    const { services, turnCtx } = makeServices();
    const result = await services.policy.evaluateAfterModel(
      'I will inspect the runtime implementation now.',
      [],
      turnCtx,
    );

    expect(result).toMatchObject({ action: 'inject', code: 'announced_no_action' });
  });

  it('emits structured policy events with the Worker host identity', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const { services, turnCtx } = makeServices();
      await services.policy.evaluateAfterModel(
        'I will inspect the runtime implementation now.',
        [],
        turnCtx,
      );

      expect(log).toHaveBeenCalledOnce();
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
        event: 'coder_trailing_intent_nudged',
        level: 'info',
        runtimeHost: 'worker_background',
      });
    } finally {
      log.mockRestore();
    }
  });

  it('enforces verification-phase mutation denial', async () => {
    const { services, turnCtx } = makeServices();
    turnCtx.phase = 'verification';

    const result = await services.policy.evaluateBeforeTool(
      'sandbox_edit_file',
      { path: '/workspace/src/a.ts' },
      turnCtx,
    );

    expect(result).toMatchObject({ action: 'deny', code: 'verification_phase_mutation' });
  });
});
