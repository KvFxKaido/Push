import { describe, expect, it } from 'vitest';

import {
  createAuditorDeliveryBlock,
  createAuditorEvaluationIntervention,
} from './auditor-intervention.js';

describe('auditor interventions', () => {
  it('steers incomplete work and permits complete work', () => {
    expect(
      createAuditorEvaluationIntervention({
        verdict: 'complete',
        summary: 'Done.',
        gaps: [],
        confidence: 'high',
      }),
    ).toBeNull();
    expect(
      createAuditorEvaluationIntervention({
        verdict: 'incomplete',
        summary: 'Tests did not pass.',
        gaps: ['Fix the failing test'],
        confidence: 'high',
      }),
    ).toMatchObject({
      mode: 'steer',
      point: 'delivery_gate',
      source: 'auditor_evaluation',
      reason: 'work_incomplete',
    });
  });

  it('blocks unsafe and unavailable deliveries with distinct retryability', () => {
    expect(
      createAuditorDeliveryBlock({ reason: 'auditor_unsafe', message: 'Unsafe.' }),
    ).toMatchObject({ mode: 'block', reason: 'auditor_unsafe', context: { retryable: false } });
    expect(
      createAuditorDeliveryBlock({
        reason: 'auditor_unavailable',
        message: 'Unavailable.',
        retryable: true,
      }),
    ).toMatchObject({
      mode: 'block',
      reason: 'auditor_unavailable',
      context: { retryable: true },
    });
  });
});
