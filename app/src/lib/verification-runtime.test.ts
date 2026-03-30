import { describe, expect, it } from 'vitest';
import { VERIFICATION_PRESET_STANDARD, VERIFICATION_PRESET_STRICT } from './verification-policy';
import {
  activateVerificationGate,
  evaluateVerificationState,
  hydrateVerificationRuntimeState,
  recordVerificationArtifact,
  recordVerificationCommandResult,
  recordVerificationGateResult,
  recordVerificationMutation,
} from './verification-runtime';

describe('verification-runtime', () => {
  it('hydrates rules with backend commands inactive and gates not applicable by default', () => {
    const state = hydrateVerificationRuntimeState(VERIFICATION_PRESET_STRICT, undefined, 1000);

    expect(state.requirements.find((req) => req.id === 'typecheck')?.status).toBe('pending');
    expect(state.requirements.find((req) => req.id === 'test')?.status).toBe('not_applicable');
    expect(state.requirements.find((req) => req.id === 'auditor-gate')?.status).toBe('not_applicable');
  });

  it('marks coder mutations as evidence and invalidates checks while activating the auditor gate', () => {
    const initial = hydrateVerificationRuntimeState(VERIFICATION_PRESET_STRICT, undefined, 1000);
    const afterChecks = recordVerificationCommandResult(initial, 'npx tsc --noEmit', {
      exitCode: 0,
      detail: 'typecheck passed',
    }, 1100);

    const mutated = recordVerificationMutation(afterChecks, {
      source: 'coder',
      touchedPaths: ['app/src/lib/useChat.ts'],
      detail: 'Coder updated runtime files.',
    }, 1200);

    expect(mutated.backendTouched).toBe(true);
    expect(mutated.requirements.find((req) => req.id === 'diff-evidence')?.status).toBe('passed');
    expect(mutated.requirements.find((req) => req.id === 'typecheck')?.status).toBe('pending');
    expect(mutated.requirements.find((req) => req.id === 'test')?.status).toBe('pending');
    expect(mutated.requirements.find((req) => req.id === 'auditor-gate')?.status).toBe('pending');
  });

  it('records gate and command results as runtime satisfaction', () => {
    const state = activateVerificationGate(
      recordVerificationArtifact(
        hydrateVerificationRuntimeState(VERIFICATION_PRESET_STANDARD, undefined, 1000),
        'Diff evidence captured.',
        1100,
      ),
      'auditor',
      'Awaiting evaluator.',
      1200,
    );

    const completed = recordVerificationGateResult(state, 'auditor', 'passed', 'Auditor marked the work complete.', 1300);
    const evaluation = evaluateVerificationState(completed, 'completion');

    expect(evaluation.passed).toBe(true);
    expect(evaluation.missing).toEqual([]);
  });

  it('fails completion evaluation when applicable rules are still pending', () => {
    const state = recordVerificationArtifact(
      hydrateVerificationRuntimeState(VERIFICATION_PRESET_STRICT, undefined, 1000),
      'Diff evidence captured.',
      1100,
    );
    const evaluation = evaluateVerificationState(state, 'completion');

    expect(evaluation.passed).toBe(false);
    expect(evaluation.missing.map((req) => req.id)).toContain('typecheck');
    expect(evaluation.missing.map((req) => req.id)).not.toContain('auditor-gate');
  });
});
