import { describe, expect, it } from 'vitest';
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
