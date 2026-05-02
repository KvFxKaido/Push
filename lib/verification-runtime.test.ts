import { describe, expect, it } from 'vitest';
import { VERIFICATION_PRESET_STANDARD, VERIFICATION_PRESET_STRICT } from './verification-policy.js';
import {
  activateVerificationGate,
  evaluateVerificationState,
  hydrateVerificationRuntimeState,
  recordVerificationArtifact,
  recordVerificationCommandResult,
  recordVerificationGateResult,
  recordVerificationMutation,
} from './verification-runtime.js';

describe('verification-runtime', () => {
  it('hydrates rules with backend commands inactive and gates not applicable by default', () => {
    const state = hydrateVerificationRuntimeState(VERIFICATION_PRESET_STRICT, undefined, 1000);

    expect(state.requirements.find((req) => req.id === 'typecheck')?.status).toBe('pending');
    expect(state.requirements.find((req) => req.id === 'test')?.status).toBe('not_applicable');
    expect(state.requirements.find((req) => req.id === 'auditor-gate')?.status).toBe(
      'not_applicable',
    );
  });

  it('marks coder mutations as evidence and invalidates checks while activating the auditor gate', () => {
    const initial = hydrateVerificationRuntimeState(VERIFICATION_PRESET_STRICT, undefined, 1000);
    const afterChecks = recordVerificationCommandResult(
      initial,
      'npx tsc --noEmit',
      {
        exitCode: 0,
        detail: 'typecheck passed',
      },
      1100,
    );

    const mutated = recordVerificationMutation(
      afterChecks,
      {
        source: 'coder',
        touchedPaths: ['app/src/lib/useChat.ts'],
        detail: 'Coder updated runtime files.',
      },
      1200,
    );

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

    const completed = recordVerificationGateResult(
      state,
      'auditor',
      'passed',
      'Auditor marked the work complete.',
      1300,
    );
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

  // Track C follow-up (PR #473): read-only sessions don't carry an
  // unsatisfiable diff-evidence obligation. Always-scoped evidence rules
  // start 'not_applicable' and only flip to 'pending' once a mutation
  // (Coder delegation, sandbox tool write, or artifact) actually occurs.
  it('initializes always-scoped evidence as not_applicable until a mutation occurs', () => {
    const state = hydrateVerificationRuntimeState(VERIFICATION_PRESET_STANDARD, undefined, 1000);

    expect(state.mutationOccurred).toBe(false);
    expect(state.requirements.find((req) => req.id === 'diff-evidence')?.status).toBe(
      'not_applicable',
    );
  });

  it('passes completion evaluation for a read-only session with no work claims', () => {
    // Standard preset: diff-evidence (always/evidence) + auditor-gate (always/gate).
    // Read-only session = mutationOccurred:false. Both rules should be
    // not_applicable so a "what does file X do?" turn does not loop.
    const state = hydrateVerificationRuntimeState(VERIFICATION_PRESET_STANDARD, undefined, 1000);
    const evaluation = evaluateVerificationState(state, 'completion');

    expect(evaluation.passed).toBe(true);
    expect(evaluation.missing).toEqual([]);
  });

  it('flips mutationOccurred and promotes evidence to passed on recordVerificationMutation', () => {
    const initial = hydrateVerificationRuntimeState(VERIFICATION_PRESET_STANDARD, undefined, 1000);
    const mutated = recordVerificationMutation(
      initial,
      { source: 'coder', touchedPaths: ['app/src/lib/foo.ts'], detail: 'Edit by Coder.' },
      1100,
    );

    expect(mutated.mutationOccurred).toBe(true);
    expect(mutated.requirements.find((req) => req.id === 'diff-evidence')?.status).toBe('passed');
  });

  it('does NOT flip mutationOccurred from artifact-only paths (Explorer, verification commands)', () => {
    // recordVerificationArtifact is called from read-only paths too:
    // Explorer summaries, verification command output (typecheck/test
    // runs), sandbox_diff reads. None of those are workspace mutations,
    // so the flag must stay false — otherwise read-only sessions would
    // be permanently marked as mutation-bearing and future evidence
    // rules would lose their not_applicable initialization.
    const initial = hydrateVerificationRuntimeState(VERIFICATION_PRESET_STANDARD, undefined, 1000);
    const withArtifact = recordVerificationArtifact(initial, 'Explorer summary captured.', 1100);

    expect(withArtifact.mutationOccurred).toBe(false);
    // Evidence still flips to 'passed' because the artifact is real
    // evidence; downstream gates won't loop on it.
    expect(withArtifact.requirements.find((req) => req.id === 'diff-evidence')?.status).toBe(
      'passed',
    );
  });

  it('preserves mutationOccurred across hydration so completion gate stays armed', () => {
    const initial = hydrateVerificationRuntimeState(VERIFICATION_PRESET_STANDARD, undefined, 1000);
    const mutated = recordVerificationMutation(
      initial,
      { source: 'coder', touchedPaths: ['app/src/lib/foo.ts'], detail: 'Edit.' },
      1100,
    );
    const rehydrated = hydrateVerificationRuntimeState(VERIFICATION_PRESET_STANDARD, mutated, 1200);

    expect(rehydrated.mutationOccurred).toBe(true);
  });
});
