import { describe, it, expect } from 'vitest';
import {
  createCoderPolicy,
  detectCognitiveDrift,
  BACKPRESSURE_MUTATION_THRESHOLD,
  VERIFICATION_COMMAND_PATTERN,
} from './coder-policy';
import { isVerificationPhase, TurnPolicyRegistry } from '../turn-policy';
import type { TurnContext } from '../turn-policy';

function makeCtx(round = 0, phase?: string): TurnContext {
  return {
    role: 'coder',
    round,
    maxRounds: 30,
    sandboxId: 'test',
    allowedRepo: 'test/repo',
    phase,
  };
}

// ---------------------------------------------------------------------------
// Drift detection (unit)
// ---------------------------------------------------------------------------

describe('detectCognitiveDrift', () => {
  it('returns null for normal code output', () => {
    const normal = '```json\n{"tool": "sandbox_exec", "args": {"command": "npm test"}}\n```';
    expect(detectCognitiveDrift(normal)).toBeNull();
  });

  it('returns null for short responses', () => {
    expect(detectCognitiveDrift('ok')).toBeNull();
    expect(detectCognitiveDrift('')).toBeNull();
  });

  it('detects repeated token patterns (20+ repeats)', () => {
    // Must exceed 200 chars minimum — pad with enough repeats
    const drift = '太平'.repeat(120);
    const result = detectCognitiveDrift(drift);
    expect(result).not.toBeNull();
    expect(result).toContain('Repeated token pattern');
  });

  it('requires 2+ signals for moderate drift', () => {
    // High non-ASCII alone is NOT drift (could be legit CJK code)
    const cjkWithCode =
      '这是一个测试 ```json {"tool": "sandbox_read_file"} ``` 更多中文内容'.repeat(5);
    expect(detectCognitiveDrift(cjkWithCode)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Coder policy — drift guard (integration)
// ---------------------------------------------------------------------------

describe('Coder Policy — drift guard', () => {
  it('injects correction on first drift round', async () => {
    const policy = createCoderPolicy();
    const driftHook = policy.afterModelCall![0];
    const ctx = makeCtx(5);

    // Generate drifted content: repeated pattern + extended prose + no code signals
    const drifted =
      '太平'.repeat(25) +
      '\n'.repeat(25) +
      'This is unrelated content about history and philosophy.'.repeat(5);

    const result = await driftHook(drifted, [], ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('inject');
  });

  it('halts after consecutive drift rounds', async () => {
    const policy = createCoderPolicy();
    const driftHook = policy.afterModelCall![0];

    const drifted =
      '太平'.repeat(25) + '\n'.repeat(25) + 'Unrelated rambling about nothing.'.repeat(10);

    // First drift → inject
    const r1 = await driftHook(drifted, [], makeCtx(0));
    expect(r1?.action).toBe('inject');

    // Second drift → halt
    const r2 = await driftHook(drifted, [], makeCtx(1));
    expect(r2?.action).toBe('halt');
  });

  it('resets drift counter on valid tool call', async () => {
    const policy = createCoderPolicy();
    const driftHook = policy.afterModelCall![0];

    const drifted = '太平'.repeat(25) + '\n'.repeat(25) + 'Unrelated.'.repeat(20);
    const toolCall = '{"tool": "sandbox_exec", "args": {"command": "ls"}}';

    // First drift
    await driftHook(drifted, [], makeCtx(0));
    // Tool call resets
    await driftHook(toolCall, [], makeCtx(1));
    // Next drift is again "first" → inject, not halt
    const result = await driftHook(drifted, [], makeCtx(2));
    expect(result?.action).toBe('inject');
  });
});

// ---------------------------------------------------------------------------
// Coder policy — no-fake-completion
// ---------------------------------------------------------------------------

describe('Coder Policy — no-fake-completion', () => {
  it('passes through responses with file change evidence', async () => {
    const policy = createCoderPolicy();
    const completionHook = policy.afterModelCall![1];
    const ctx = makeCtx();

    const withEvidence = 'I modified the auth.ts file to fix the token refresh logic.';
    expect(await completionHook(withEvidence, [], ctx)).toBeNull();
  });

  it('passes through blocked reports', async () => {
    const policy = createCoderPolicy();
    const completionHook = policy.afterModelCall![1];
    const ctx = makeCtx();

    const blocked =
      'I cannot complete this task because the sandbox is missing the required Python dependencies.';
    expect(await completionHook(blocked, [], ctx)).toBeNull();
  });

  it('passes through tool call responses', async () => {
    const policy = createCoderPolicy();
    const completionHook = policy.afterModelCall![1];
    const ctx = makeCtx();

    const toolCall = '{"tool": "sandbox_exec", "args": {"command": "npm test"}}';
    expect(await completionHook(toolCall, [], ctx)).toBeNull();
  });

  it('nudges on vague short completion', async () => {
    const policy = createCoderPolicy();
    const completionHook = policy.afterModelCall![1];
    const ctx = makeCtx();

    const vague = 'Task is done. Everything looks good.';
    const result = await completionHook(vague, [], ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('inject');
  });
});

// ---------------------------------------------------------------------------
// Coder policy — mutation failure tracking
// ---------------------------------------------------------------------------

describe('Coder Policy — mutation failure tracking', () => {
  it('clears failure tracking on success', async () => {
    const policy = createCoderPolicy();
    const hook = policy.afterToolExec![0];
    const ctx = makeCtx();

    // Fail once
    await hook('sandbox_write_file', { path: '/workspace/a.ts' }, 'error', true, ctx);
    // Succeed — should clear
    const result = await hook('sandbox_write_file', { path: '/workspace/a.ts' }, 'ok', false, ctx);
    expect(result).toBeNull();
  });

  it('injects warning after 3 consecutive failures on same tool+file', async () => {
    const policy = createCoderPolicy();
    const hook = policy.afterToolExec![0];
    const ctx = makeCtx();
    const args = { path: '/workspace/broken.ts' };

    // First two failures → no action
    expect(await hook('sandbox_edit_file', args, 'err', true, ctx)).toBeNull();
    expect(await hook('sandbox_edit_file', args, 'err', true, ctx)).toBeNull();

    // Third failure → inject hard failure warning
    const result = await hook('sandbox_edit_file', args, 'err', true, ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('inject');
    if (result!.action === 'inject') {
      expect(result!.message.content).toContain('MUTATION_HARD_FAILURE');
    }
  });

  it('tracks failures per tool+file independently', async () => {
    const policy = createCoderPolicy();
    const hook = policy.afterToolExec![0];
    const ctx = makeCtx();

    // 2 failures on file A
    await hook('sandbox_write_file', { path: '/workspace/a.ts' }, 'err', true, ctx);
    await hook('sandbox_write_file', { path: '/workspace/a.ts' }, 'err', true, ctx);

    // 1 failure on file B — should NOT trigger hard failure
    const resultB = await hook('sandbox_write_file', { path: '/workspace/b.ts' }, 'err', true, ctx);
    expect(resultB).toBeNull();

    // 3rd failure on file A — should trigger
    const resultA = await hook('sandbox_write_file', { path: '/workspace/a.ts' }, 'err', true, ctx);
    expect(resultA).not.toBeNull();
  });

  it('failure cleanup runs even when backpressure would inject', async () => {
    // Regression test: with separate hooks, evaluateAfterTool short-circuits
    // on backpressure inject and never clears stale failure state.
    const policy = createCoderPolicy();
    const hook = policy.afterToolExec![0];
    const ctx = makeCtx();

    // Accumulate 2 failures on a file
    await hook('sandbox_write_file', { path: '/workspace/a.ts' }, 'err', true, ctx);
    await hook('sandbox_write_file', { path: '/workspace/a.ts' }, 'err', true, ctx);

    // Now make (threshold) successful mutations to trigger backpressure
    for (let i = 0; i < BACKPRESSURE_MUTATION_THRESHOLD; i++) {
      await hook('sandbox_write_file', { path: `/workspace/f${i}.ts` }, 'ok', false, ctx);
    }

    // The success on f0..fN should not have left stale failure state.
    // A single failure on a.ts should NOT trigger hard failure (was cleared on success path).
    // First we need a fresh policy to test this properly — use registry integration test below.
  });
});

// ---------------------------------------------------------------------------
// Coder policy — mechanical backpressure
// ---------------------------------------------------------------------------

describe('Coder Policy — mechanical backpressure', () => {
  it('does not trigger below the mutation threshold', async () => {
    const policy = createCoderPolicy();
    const backpressureHook = policy.afterToolExec![0];
    const ctx = makeCtx();

    // Mutate (threshold - 1) times — should all pass through
    for (let i = 0; i < BACKPRESSURE_MUTATION_THRESHOLD - 1; i++) {
      const result = await backpressureHook(
        'sandbox_write_file',
        { path: `/workspace/file${i}.ts` },
        'ok',
        false,
        ctx,
      );
      expect(result).toBeNull();
    }
  });

  it('injects verification nudge at the mutation threshold', async () => {
    const policy = createCoderPolicy();
    const backpressureHook = policy.afterToolExec![0];
    const ctx = makeCtx();

    // Mutate exactly threshold times
    for (let i = 0; i < BACKPRESSURE_MUTATION_THRESHOLD - 1; i++) {
      await backpressureHook(
        'sandbox_edit_file',
        { path: `/workspace/f${i}.ts` },
        'ok',
        false,
        ctx,
      );
    }

    const result = await backpressureHook(
      'sandbox_edit_file',
      { path: '/workspace/last.ts' },
      'ok',
      false,
      ctx,
    );
    expect(result).not.toBeNull();
    expect(result!.action).toBe('inject');
    if (result!.action === 'inject') {
      expect(result!.message.content).toContain('VERIFY_BEFORE_CONTINUING');
      expect(result!.message.content).toContain(
        `${BACKPRESSURE_MUTATION_THRESHOLD} file mutations`,
      );
    }
  });

  it('resets counter when a verification command runs', async () => {
    const policy = createCoderPolicy();
    const backpressureHook = policy.afterToolExec![0];
    const ctx = makeCtx();

    // Mutate up to threshold - 1
    for (let i = 0; i < BACKPRESSURE_MUTATION_THRESHOLD - 1; i++) {
      await backpressureHook(
        'sandbox_write_file',
        { path: `/workspace/f${i}.ts` },
        'ok',
        false,
        ctx,
      );
    }

    // Run typecheck → resets counter
    await backpressureHook('sandbox_exec', { command: 'npx tsc --noEmit' }, 'ok', false, ctx);

    // Now another (threshold - 1) mutations should be fine
    for (let i = 0; i < BACKPRESSURE_MUTATION_THRESHOLD - 1; i++) {
      const result = await backpressureHook(
        'sandbox_write_file',
        { path: `/workspace/new${i}.ts` },
        'ok',
        false,
        ctx,
      );
      expect(result).toBeNull();
    }
  });

  it('does not count failed mutations toward backpressure', async () => {
    const policy = createCoderPolicy();
    const hook = policy.afterToolExec![0];
    const ctx = makeCtx();

    // Failed mutations on different files — should not trigger backpressure
    // (each file only fails once, so no hard-failure either)
    for (let i = 0; i < BACKPRESSURE_MUTATION_THRESHOLD + 2; i++) {
      const result = await hook(
        'sandbox_write_file',
        { path: `/workspace/fail${i}.ts` },
        'err',
        true,
        ctx,
      );
      expect(result).toBeNull();
    }
  });

  it('does not count non-mutation tools', async () => {
    const policy = createCoderPolicy();
    const backpressureHook = policy.afterToolExec![0];
    const ctx = makeCtx();

    // Read tools should not affect the counter
    for (let i = 0; i < BACKPRESSURE_MUTATION_THRESHOLD + 2; i++) {
      const result = await backpressureHook(
        'sandbox_read_file',
        { path: '/workspace/a.ts' },
        'ok',
        false,
        ctx,
      );
      expect(result).toBeNull();
    }
  });

  it('repeats nudge if Coder ignores it', async () => {
    const policy = createCoderPolicy();
    const backpressureHook = policy.afterToolExec![0];
    const ctx = makeCtx();

    // Mutate past threshold
    for (let i = 0; i < BACKPRESSURE_MUTATION_THRESHOLD; i++) {
      await backpressureHook(
        'sandbox_write_file',
        { path: `/workspace/f${i}.ts` },
        'ok',
        false,
        ctx,
      );
    }

    // Next mutation still triggers (counter not reset because no verification ran)
    const result = await backpressureHook(
      'sandbox_edit_file',
      { path: '/workspace/extra.ts' },
      'ok',
      false,
      ctx,
    );
    expect(result).not.toBeNull();
    expect(result!.action).toBe('inject');
  });

  it('recognizes various verification commands', async () => {
    const verificationCommands = [
      'npx tsc --noEmit',
      'npm test',
      'npx vitest',
      'npm run lint',
      'npm run test',
      'npm run typecheck',
      'npm run build',
      'eslint src/',
      'pytest tests/',
      'cargo test',
      'go test ./...',
      'ruff check .',
      'pyright',
      'mypy src/',
    ];

    for (const cmd of verificationCommands) {
      expect(VERIFICATION_COMMAND_PATTERN.test(cmd)).toBe(true);
    }
  });

  it('does not treat arbitrary sandbox_exec as verification', async () => {
    const nonVerificationCommands = [
      'cat /workspace/src/index.ts',
      'ls -la',
      'git status',
      'echo "hello"',
      'mkdir -p src/lib',
    ];

    for (const cmd of nonVerificationCommands) {
      expect(VERIFICATION_COMMAND_PATTERN.test(cmd)).toBe(false);
    }
  });

  it('resets counter on sandbox_run_tests', async () => {
    const policy = createCoderPolicy();
    const hook = policy.afterToolExec![0];
    const ctx = makeCtx();

    // Mutate up to threshold - 1
    for (let i = 0; i < BACKPRESSURE_MUTATION_THRESHOLD - 1; i++) {
      await hook('sandbox_write_file', { path: `/workspace/f${i}.ts` }, 'ok', false, ctx);
    }

    // Built-in test tool resets counter
    await hook('sandbox_run_tests', { framework: 'vitest' }, 'ok', false, ctx);

    // Another (threshold - 1) mutations should be fine
    for (let i = 0; i < BACKPRESSURE_MUTATION_THRESHOLD - 1; i++) {
      const result = await hook(
        'sandbox_write_file',
        { path: `/workspace/new${i}.ts` },
        'ok',
        false,
        ctx,
      );
      expect(result).toBeNull();
    }
  });

  it('resets counter on sandbox_check_types', async () => {
    const policy = createCoderPolicy();
    const hook = policy.afterToolExec![0];
    const ctx = makeCtx();

    // Mutate up to threshold - 1
    for (let i = 0; i < BACKPRESSURE_MUTATION_THRESHOLD - 1; i++) {
      await hook('sandbox_write_file', { path: `/workspace/f${i}.ts` }, 'ok', false, ctx);
    }

    // Built-in typecheck tool resets counter
    await hook('sandbox_check_types', {}, 'ok', false, ctx);

    // Another (threshold - 1) mutations should be fine
    for (let i = 0; i < BACKPRESSURE_MUTATION_THRESHOLD - 1; i++) {
      const result = await hook(
        'sandbox_write_file',
        { path: `/workspace/new${i}.ts` },
        'ok',
        false,
        ctx,
      );
      expect(result).toBeNull();
    }
  });

  it('resets counter on sandbox_verify_workspace', async () => {
    const policy = createCoderPolicy();
    const hook = policy.afterToolExec![0];
    const ctx = makeCtx();

    for (let i = 0; i < BACKPRESSURE_MUTATION_THRESHOLD - 1; i++) {
      await hook('sandbox_write_file', { path: `/workspace/f${i}.ts` }, 'ok', false, ctx);
    }

    await hook('sandbox_verify_workspace', {}, 'ok', false, ctx);

    for (let i = 0; i < BACKPRESSURE_MUTATION_THRESHOLD - 1; i++) {
      const result = await hook(
        'sandbox_write_file',
        { path: `/workspace/new${i}.ts` },
        'ok',
        false,
        ctx,
      );
      expect(result).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Registry integration — verifies hooks work through evaluateAfterTool
// ---------------------------------------------------------------------------

describe('Coder Policy — registry integration', () => {
  it('backpressure triggers through evaluateAfterTool', async () => {
    const registry = new TurnPolicyRegistry();
    registry.register(createCoderPolicy());
    const ctx = makeCtx();

    for (let i = 0; i < BACKPRESSURE_MUTATION_THRESHOLD; i++) {
      await registry.evaluateAfterTool(
        'sandbox_write_file',
        { path: `/workspace/f${i}.ts` },
        'ok',
        false,
        ctx,
      );
    }

    const result = await registry.evaluateAfterTool(
      'sandbox_write_file',
      { path: '/workspace/extra.ts' },
      'ok',
      false,
      ctx,
    );
    expect(result).not.toBeNull();
    expect(result!.action).toBe('inject');
    if (result!.action === 'inject') {
      expect(result!.message.content).toContain('VERIFY_BEFORE_CONTINUING');
    }
  });

  it('failure tracking works alongside backpressure in single hook', async () => {
    const registry = new TurnPolicyRegistry();
    registry.register(createCoderPolicy());
    const ctx = makeCtx();

    // 3 consecutive failures → hard failure
    await registry.evaluateAfterTool(
      'sandbox_edit_file',
      { path: '/workspace/a.ts' },
      'err',
      true,
      ctx,
    );
    await registry.evaluateAfterTool(
      'sandbox_edit_file',
      { path: '/workspace/a.ts' },
      'err',
      true,
      ctx,
    );
    const result = await registry.evaluateAfterTool(
      'sandbox_edit_file',
      { path: '/workspace/a.ts' },
      'err',
      true,
      ctx,
    );
    expect(result).not.toBeNull();
    expect(result!.action).toBe('inject');
    if (result!.action === 'inject') {
      expect(result!.message.content).toContain('MUTATION_HARD_FAILURE');
    }
  });
});

// ---------------------------------------------------------------------------
// isVerificationPhase helper
// ---------------------------------------------------------------------------

describe('isVerificationPhase', () => {
  it('returns false for undefined/empty', () => {
    expect(isVerificationPhase(undefined)).toBe(false);
    expect(isVerificationPhase('')).toBe(false);
  });

  it('matches common verification phase names', () => {
    expect(isVerificationPhase('verifying')).toBe(true);
    expect(isVerificationPhase('verification')).toBe(true);
    expect(isVerificationPhase('testing')).toBe(true);
    expect(isVerificationPhase('running tests')).toBe(true);
    expect(isVerificationPhase('validation')).toBe(true);
    expect(isVerificationPhase('typecheck')).toBe(true);
    expect(isVerificationPhase('linting')).toBe(true);
  });

  it('does not match non-verification phases', () => {
    expect(isVerificationPhase('implementing')).toBe(false);
    expect(isVerificationPhase('planning')).toBe(false);
    expect(isVerificationPhase('exploring')).toBe(false);
    expect(isVerificationPhase('reporting')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Coder policy — phase-aware mutation gating
// ---------------------------------------------------------------------------

describe('Coder Policy — phase-aware mutation gating', () => {
  it('allows mutation tools when phase is not verification', async () => {
    const policy = createCoderPolicy();
    const gate = policy.beforeToolExec![0];

    expect(
      await gate('sandbox_write_file', { path: '/workspace/a.ts' }, makeCtx(0, 'implementing')),
    ).toBeNull();
    expect(
      await gate('sandbox_edit_file', { path: '/workspace/a.ts' }, makeCtx(0, 'planning')),
    ).toBeNull();
    expect(await gate('sandbox_edit_range', { path: '/workspace/a.ts' }, makeCtx(0))).toBeNull();
  });

  it('denies mutation tools during verification phase', async () => {
    const policy = createCoderPolicy();
    const gate = policy.beforeToolExec![0];
    const ctx = makeCtx(5, 'verifying');

    const result = await gate('sandbox_write_file', { path: '/workspace/a.ts' }, ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('deny');
    expect(result!.reason).toContain('verification-only');
  });

  it('denies all file-mutation tools during verification', async () => {
    const policy = createCoderPolicy();
    const gate = policy.beforeToolExec![0];
    const ctx = makeCtx(5, 'testing');

    for (const tool of [
      'sandbox_write_file',
      'sandbox_edit_file',
      'sandbox_edit_range',
      'sandbox_apply_patchset',
    ]) {
      const result = await gate(tool, {}, ctx);
      expect(result?.action).toBe('deny');
    }
  });

  it('allows sandbox_exec during verification (needed for running tests)', async () => {
    const policy = createCoderPolicy();
    const gate = policy.beforeToolExec![0];
    const ctx = makeCtx(5, 'verifying');

    expect(await gate('sandbox_exec', { command: 'npm test' }, ctx)).toBeNull();
  });

  it('allows sandbox_read_file during verification', async () => {
    const policy = createCoderPolicy();
    const gate = policy.beforeToolExec![0];
    const ctx = makeCtx(5, 'verifying');

    expect(await gate('sandbox_read_file', { path: '/workspace/a.ts' }, ctx)).toBeNull();
  });

  it('matches various verification phase names', async () => {
    const policy = createCoderPolicy();
    const gate = policy.beforeToolExec![0];

    for (const phase of [
      'verifying',
      'testing',
      'validation',
      'running tests',
      'typecheck',
      'linting',
    ]) {
      const result = await gate('sandbox_write_file', {}, makeCtx(0, phase));
      expect(result?.action).toBe('deny');
    }
  });
});
