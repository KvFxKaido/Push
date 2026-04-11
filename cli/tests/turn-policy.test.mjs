import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isVerificationPhase, createCoderPolicy, TurnPolicyRegistry } from '../turn-policy.ts';

function makeCtx(round = 0, phase = undefined) {
  return { role: 'coder', round, maxRounds: 8, phase };
}

// ---------------------------------------------------------------------------
// isVerificationPhase
// ---------------------------------------------------------------------------

describe('isVerificationPhase', () => {
  it('returns false for undefined/empty', () => {
    assert.equal(isVerificationPhase(undefined), false);
    assert.equal(isVerificationPhase(''), false);
  });

  it('matches common verification phase names', () => {
    for (const phase of [
      'verifying',
      'verification',
      'testing',
      'running tests',
      'validation',
      'typecheck',
      'linting',
    ]) {
      assert.equal(isVerificationPhase(phase), true, `expected "${phase}" to match`);
    }
  });

  it('does not match non-verification phases', () => {
    for (const phase of ['implementing', 'planning', 'exploring', 'reporting']) {
      assert.equal(isVerificationPhase(phase), false, `expected "${phase}" not to match`);
    }
  });
});

// ---------------------------------------------------------------------------
// Coder policy — phase-aware mutation gating
// ---------------------------------------------------------------------------

describe('Coder policy — phase-aware mutation gating', () => {
  it('allows mutation tools when phase is not verification', () => {
    const policy = createCoderPolicy();
    const gate = policy.beforeToolExec[0];

    assert.equal(gate('write_file', {}, makeCtx(0, 'implementing')), null);
    assert.equal(gate('edit_file', {}, makeCtx(0, 'planning')), null);
    assert.equal(gate('write_file', {}, makeCtx(0)), null); // no phase
  });

  it('denies mutation tools during verification phase', () => {
    const policy = createCoderPolicy();
    const gate = policy.beforeToolExec[0];

    const result = gate('write_file', {}, makeCtx(5, 'verifying'));
    assert.notEqual(result, null);
    assert.equal(result.action, 'deny');
    assert.ok(result.reason.includes('verification-only'));
  });

  it('denies all file-mutation tools during verification', () => {
    const policy = createCoderPolicy();
    const gate = policy.beforeToolExec[0];
    const ctx = makeCtx(5, 'testing');

    for (const tool of ['write_file', 'edit_file', 'undo_edit']) {
      const result = gate(tool, {}, ctx);
      assert.equal(result?.action, 'deny', `expected ${tool} to be denied`);
    }
  });

  it('allows exec during verification (needed for tests)', () => {
    const policy = createCoderPolicy();
    const gate = policy.beforeToolExec[0];

    assert.equal(gate('exec', {}, makeCtx(5, 'verifying')), null);
  });

  it('allows read_file during verification', () => {
    const policy = createCoderPolicy();
    const gate = policy.beforeToolExec[0];

    assert.equal(gate('read_file', {}, makeCtx(5, 'verifying')), null);
  });
});

// ---------------------------------------------------------------------------
// Coder policy — drift detection (afterModelCall)
// ---------------------------------------------------------------------------

describe('Coder policy — drift detection', () => {
  it('passes through tool-call responses', () => {
    const policy = createCoderPolicy();
    const driftHook = policy.afterModelCall[0];

    const toolCall = '{"tool": "exec", "args": {"command": "npm test"}}';
    assert.equal(driftHook(toolCall, makeCtx(0)), null);
  });

  it('passes through short responses', () => {
    const policy = createCoderPolicy();
    const driftHook = policy.afterModelCall[0];

    assert.equal(driftHook('ok', makeCtx(0)), null);
    assert.equal(driftHook('', makeCtx(0)), null);
  });

  it('injects correction on first drift round', () => {
    const policy = createCoderPolicy();
    const driftHook = policy.afterModelCall[0];

    const drifted =
      '\u592A\u5E73'.repeat(25) + '\n'.repeat(25) + 'Unrelated rambling about nothing.'.repeat(10);
    const result = driftHook(drifted, makeCtx(5));
    assert.notEqual(result, null);
    assert.equal(result.action, 'inject');
  });

  it('halts after consecutive drift rounds', () => {
    const policy = createCoderPolicy();
    const driftHook = policy.afterModelCall[0];

    const drifted =
      '\u592A\u5E73'.repeat(25) + '\n'.repeat(25) + 'Unrelated rambling about nothing.'.repeat(10);

    // First drift -> inject
    const r1 = driftHook(drifted, makeCtx(0));
    assert.equal(r1?.action, 'inject');

    // Second drift -> halt
    const r2 = driftHook(drifted, makeCtx(1));
    assert.equal(r2?.action, 'halt');
  });

  it('resets drift counter on valid tool call', () => {
    const policy = createCoderPolicy();
    const driftHook = policy.afterModelCall[0];

    const drifted = '\u592A\u5E73'.repeat(25) + '\n'.repeat(25) + 'Unrelated.'.repeat(20);
    const toolCall = '{"tool": "exec", "args": {"command": "ls"}}';

    // First drift
    driftHook(drifted, makeCtx(0));
    // Tool call resets
    driftHook(toolCall, makeCtx(1));
    // Next drift is again "first" -> inject, not halt
    const result = driftHook(drifted, makeCtx(2));
    assert.equal(result?.action, 'inject');
  });
});

// ---------------------------------------------------------------------------
// TurnPolicyRegistry
// ---------------------------------------------------------------------------

describe('TurnPolicyRegistry', () => {
  it('evaluateBeforeTool returns first deny', () => {
    const registry = new TurnPolicyRegistry();
    registry.register(createCoderPolicy());

    const result = registry.evaluateBeforeTool('write_file', {}, makeCtx(0, 'verifying'));
    assert.equal(result?.action, 'deny');
  });

  it('evaluateBeforeTool returns null when allowed', () => {
    const registry = new TurnPolicyRegistry();
    registry.register(createCoderPolicy());

    const result = registry.evaluateBeforeTool('read_file', {}, makeCtx(0, 'verifying'));
    assert.equal(result, null);
  });

  it('evaluateAfterModel returns inject on drift', () => {
    const registry = new TurnPolicyRegistry();
    registry.register(createCoderPolicy());

    const drifted = '\u592A\u5E73'.repeat(25) + '\n'.repeat(25) + 'Unrelated.'.repeat(20);
    const result = registry.evaluateAfterModel(drifted, makeCtx(0));
    assert.equal(result?.action, 'inject');
  });

  it('evaluateAfterModel returns null for normal responses', () => {
    const registry = new TurnPolicyRegistry();
    registry.register(createCoderPolicy());

    const result = registry.evaluateAfterModel('Here is the fix for the bug.', makeCtx(0));
    assert.equal(result, null);
  });
});
