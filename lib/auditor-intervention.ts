import {
  createBlockIntervention,
  createSteerIntervention,
  type RuntimeIntervention,
} from './runtime-intervention.js';

export interface AuditorEvaluationVerdict {
  readonly verdict: 'complete' | 'incomplete';
  readonly summary: string;
  readonly gaps: readonly string[];
  readonly confidence: 'high' | 'medium' | 'low';
}

export function createAuditorEvaluationIntervention(
  verdict: AuditorEvaluationVerdict,
): RuntimeIntervention<{ readonly verdict: AuditorEvaluationVerdict }> | null {
  if (verdict.verdict === 'complete') return null;
  const gapGuidance = verdict.gaps.length ? ` Address these gaps: ${verdict.gaps.join('; ')}.` : '';
  return createSteerIntervention({
    point: 'delivery_gate',
    source: 'auditor_evaluation',
    reason: 'work_incomplete',
    message: verdict.summary,
    guidance: `${verdict.summary}${gapGuidance}`,
    context: { verdict },
  });
}

export function createAuditorDeliveryBlock(input: {
  readonly reason: 'auditor_unsafe' | 'auditor_unavailable';
  readonly message: string;
  readonly retryable?: boolean;
}): RuntimeIntervention<{ readonly retryable: boolean }> {
  return createBlockIntervention({
    point: 'delivery_gate',
    source: 'auditor_gate',
    reason: input.reason,
    message: input.message,
    guidance:
      input.reason === 'auditor_unavailable'
        ? 'Retry the delivery after the Auditor is available.'
        : 'Resolve the Auditor finding before attempting delivery again.',
    context: { retryable: input.retryable === true },
  });
}
