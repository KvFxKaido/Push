import { describe, expect, it, vi } from 'vitest';
import {
  BACKPRESSURE_MUTATION_THRESHOLD,
  createCoderPolicy,
  detectCognitiveDrift,
  formatCoderPolicyEvent,
  isVerificationPhase,
  resolveCoderCompletionGuard,
  VERIFICATION_COMMAND_PATTERN,
  type CoderPolicyContext,
  type CoderRuntimePolicy,
} from './coder-policy.js';

function makeCtx(overrides: Partial<CoderPolicyContext> = {}): CoderPolicyContext {
  return {
    round: 0,
    maxRounds: 30,
    allowedRepo: 'owner/repo',
    taskInFlight: true,
    ...overrides,
  };
}

async function mutate(
  policy: CoderRuntimePolicy,
  count: number,
  tool = 'sandbox_write_file',
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await policy.evaluateAfterTool(
      tool,
      { path: `/workspace/file-${index}.ts` },
      'ok',
      false,
      makeCtx({ round: index }),
    );
  }
}

describe('detectCognitiveDrift', () => {
  it('preserves normal, short, and code-shaped output', () => {
    expect(detectCognitiveDrift('')).toBeNull();
    expect(detectCognitiveDrift('ok')).toBeNull();
    expect(
      detectCognitiveDrift('```json\n{"tool":"sandbox_exec","args":{"command":"npm test"}}\n```'),
    ).toBeNull();
  });

  it('detects a repeated pattern once it is severe enough', () => {
    expect(detectCognitiveDrift('太平'.repeat(120))).toContain('Repeated token pattern');
  });

  it('requires converging signals for moderate non-ASCII output', () => {
    const cjkWithCode =
      '这是一个测试 ```json {"tool": "sandbox_read_file"} ``` 更多中文内容'.repeat(5);
    expect(detectCognitiveDrift(cjkWithCode)).toBeNull();
  });
});

describe('Coder policy drift guard', () => {
  const drifted = '太平'.repeat(25) + '\n'.repeat(25) + 'Unrelated.'.repeat(30);

  it('steers the first drift round and blocks the second', async () => {
    const policy = createCoderPolicy();
    const first = await policy.evaluateAfterModel(drifted, [], makeCtx());
    const second = await policy.evaluateAfterModel(drifted, [], makeCtx({ round: 1 }));

    expect(first).toMatchObject({
      action: 'inject',
      code: 'cognitive_drift',
      runtimeIntervention: { mode: 'steer' },
    });
    expect(second).toMatchObject({
      action: 'halt',
      code: 'cognitive_drift_exhausted',
      runtimeIntervention: { mode: 'block' },
    });
  });

  it('resets the consecutive counter after a valid tool call', async () => {
    const policy = createCoderPolicy();
    await policy.evaluateAfterModel(drifted, [], makeCtx());
    await policy.evaluateAfterModel(
      '{"tool":"sandbox_exec","args":{"command":"ls"}}',
      [],
      makeCtx({ round: 1 }),
    );

    expect(await policy.evaluateAfterModel(drifted, [], makeCtx({ round: 2 }))).toMatchObject({
      action: 'inject',
      code: 'cognitive_drift',
    });
  });

  it('stays quiet and clears drift state on conversational turns', async () => {
    const policy = createCoderPolicy();
    await policy.evaluateAfterModel(drifted, [], makeCtx());
    expect(
      await policy.evaluateAfterModel(drifted, [], makeCtx({ round: 1, taskInFlight: false })),
    ).toBeNull();
    expect(await policy.evaluateAfterModel(drifted, [], makeCtx({ round: 2 }))).toMatchObject({
      action: 'inject',
    });
  });
});

describe('Coder policy completion grounding', () => {
  it('selects completion grounding from turn intent', () => {
    expect(resolveCoderCompletionGuard(undefined)).toBe('strict');
    expect(resolveCoderCompletionGuard(true)).toBe('strict');
    expect(resolveCoderCompletionGuard(false)).toBe('claims_only');
  });

  it.each([
    'I modified the auth.ts file to fix token refresh.',
    'Finished reading the file.',
    'Review complete. Findings are in lib/coder-policy.ts.',
    'Task complete. I ran `pnpm test` and the test suite passed.',
    'Acceptance criteria: all required checks passed.',
  ])('accepts a short report with concrete evidence: %s', async (response) => {
    expect(await createCoderPolicy().evaluateAfterModel(response, [], makeCtx())).toBeNull();
  });

  it('accepts a specific blocked report', async () => {
    const response =
      'I cannot complete this task because the sandbox is missing the required Python dependencies.';
    expect(await createCoderPolicy().evaluateAfterModel(response, [], makeCtx())).toBeNull();
  });

  it.each([
    'Task is done. Everything looks good.',
    'Task is done. I verified everything works.',
    'I tested everything and the work is complete.',
    'No changes were necessary.',
  ])('nudges a short task response without concrete evidence: %s', async (response) => {
    const result = await createCoderPolicy().evaluateAfterModel(response, [], makeCtx());
    expect(result).toMatchObject({
      action: 'inject',
      code: 'incomplete_completion',
      runtimeIntervention: { mode: 'steer', reason: 'incomplete_completion' },
    });
  });

  it('does not trust a verification verb as its own evidence', async () => {
    const result = await createCoderPolicy().evaluateAfterModel(
      'Task is done. I verified everything works.',
      [],
      makeCtx(),
    );
    expect(result?.code).toBe('incomplete_completion');
  });

  it('skips task-only grounding on conversational turns', async () => {
    expect(
      await createCoderPolicy().evaluateAfterModel(
        "I wasn't looping — want me to continue the explanation?",
        [],
        makeCtx({ taskInFlight: false }),
      ),
    ).toBeNull();
  });

  it('lets lead hosts answer directly without a completion claim', async () => {
    expect(
      await createCoderPolicy().evaluateAfterModel(
        'Recovered after adaptation.',
        [],
        makeCtx({ completionGuard: 'claims_only' }),
      ),
    ).toBeNull();
  });

  it('allows lead investigation summaries while keeping delegated evidence strict', async () => {
    const response = 'Both flows traced. All done.';
    expect(
      await createCoderPolicy().evaluateAfterModel(
        response,
        [],
        makeCtx({ completionGuard: 'claims_only' }),
      ),
    ).toBeNull();
    expect(await createCoderPolicy().evaluateAfterModel(response, [], makeCtx())).toMatchObject({
      code: 'incomplete_completion',
    });
  });

  it.each([
    '{"tool":"sandbox_exec","args":{"command":"npm test"}}',
    '{"tool":"coder_checkpoint","args":{"question":"Which API?"}}',
    '{"tool":"coder_update_state","args":{"plan":"verify"}}',
  ])('does not treat a tool-shaped response as completion: %s', async (response) => {
    expect(await createCoderPolicy().evaluateAfterModel(response, [], makeCtx())).toBeNull();
  });

  it('preserves the original length boundary for substantive reports', async () => {
    const response = `The implementation requires additional analysis. ${'Detailed context. '.repeat(20)}`;
    expect(response.length).toBeGreaterThan(200);
    expect(await createCoderPolicy().evaluateAfterModel(response, [], makeCtx())).toBeNull();
  });
});

describe('Coder policy announced-action guard', () => {
  it.each([true, false])('nudges announced actions when taskInFlight=%s', async (taskInFlight) => {
    const result = await createCoderPolicy().evaluateAfterModel(
      "I'll read README.md next.",
      [],
      makeCtx({ taskInFlight }),
    );
    expect(result).toMatchObject({ action: 'inject', code: 'announced_no_action' });
  });

  it('wins over generic short-response grounding and forces the actionable recovery', async () => {
    const result = await createCoderPolicy().evaluateAfterModel(
      "Task is done. I'll run the tests next.",
      [],
      makeCtx(),
    );
    expect(result?.code).toBe('announced_no_action');
  });

  it('stays quiet for tool calls, questions, and user offers', async () => {
    const policy = createCoderPolicy();
    expect(
      await policy.evaluateAfterModel(
        '{"tool":"sandbox_read_file","args":{"path":"README.md"}}',
        [],
        makeCtx(),
      ),
    ).toBeNull();
    expect(
      await policy.evaluateAfterModel('Should I read README.md next?', [], makeCtx()),
    ).toBeNull();
    expect(
      await policy.evaluateAfterModel(
        'Let me know if you want me to read README.md.',
        [],
        makeCtx(),
      ),
    ).toBeNull();
  });

  it('caps nudges and emits symmetric nudge/exhaustion events', async () => {
    const onEvent = vi.fn();
    const policy = createCoderPolicy({ onEvent });
    for (let round = 0; round < 3; round += 1) {
      expect(
        await policy.evaluateAfterModel("I'll read README.md next.", [], makeCtx({ round })),
      ).not.toBeNull();
    }
    expect(
      await policy.evaluateAfterModel("I'll read README.md next.", [], makeCtx({ round: 3 })),
    ).toBeNull();

    expect(onEvent).toHaveBeenCalledTimes(4);
    expect(onEvent.mock.calls[0][0]).toMatchObject({
      event: 'coder_trailing_intent_nudged',
      nudgeCount: 1,
    });
    expect(onEvent.mock.calls[3][0]).toMatchObject({
      event: 'coder_trailing_intent_cap_exhausted',
      maxNudges: 3,
    });
  });

  it('formats the same structured event envelope for every host', () => {
    expect(
      JSON.parse(
        formatCoderPolicyEvent(
          { event: 'coder_trailing_intent_nudged', round: 2, nudgeCount: 1 },
          'cli_lead',
        ),
      ),
    ).toEqual({
      level: 'info',
      event: 'coder_trailing_intent_nudged',
      round: 2,
      nudgeCount: 1,
      runtimeHost: 'cli_lead',
    });
  });
});

describe('Coder policy mutation failure tracking', () => {
  it('injects after three consecutive failures on one tool and target', async () => {
    const policy = createCoderPolicy();
    const args = { path: '/workspace/broken.ts' };
    expect(
      await policy.evaluateAfterTool('sandbox_edit_file', args, 'err', true, makeCtx()),
    ).toBeNull();
    expect(
      await policy.evaluateAfterTool('sandbox_edit_file', args, 'err', true, makeCtx()),
    ).toBeNull();
    expect(
      await policy.evaluateAfterTool('sandbox_edit_file', args, 'err', true, makeCtx()),
    ).toMatchObject({ action: 'inject', code: 'mutation_hard_failure' });
  });

  it('tracks failures independently by tool and file', async () => {
    const policy = createCoderPolicy();
    await policy.evaluateAfterTool('sandbox_write_file', { path: 'a.ts' }, 'err', true, makeCtx());
    await policy.evaluateAfterTool('sandbox_write_file', { path: 'a.ts' }, 'err', true, makeCtx());
    expect(
      await policy.evaluateAfterTool(
        'sandbox_write_file',
        { path: 'b.ts' },
        'err',
        true,
        makeCtx(),
      ),
    ).toBeNull();
    expect(
      await policy.evaluateAfterTool(
        'sandbox_write_file',
        { path: 'a.ts' },
        'err',
        true,
        makeCtx(),
      ),
    ).toMatchObject({ code: 'mutation_hard_failure' });
  });

  it('clears the matching failure streak after success', async () => {
    const policy = createCoderPolicy();
    const args = { path: 'a.ts' };
    await policy.evaluateAfterTool('sandbox_write_file', args, 'err', true, makeCtx());
    await policy.evaluateAfterTool('sandbox_write_file', args, 'err', true, makeCtx());
    await policy.evaluateAfterTool('sandbox_write_file', args, 'ok', false, makeCtx());
    expect(
      await policy.evaluateAfterTool('sandbox_write_file', args, 'err', true, makeCtx()),
    ).toBeNull();
  });

  it('applies the same tracking to CLI mutation names', async () => {
    const policy = createCoderPolicy();
    const args = { path: 'a.ts' };
    await policy.evaluateAfterTool('edit_file', args, 'err', true, makeCtx());
    await policy.evaluateAfterTool('edit_file', args, 'err', true, makeCtx());
    expect(await policy.evaluateAfterTool('edit_file', args, 'err', true, makeCtx())).toMatchObject(
      {
        code: 'mutation_hard_failure',
      },
    );
  });
});

describe('Coder policy verification backpressure', () => {
  it('stays quiet below the threshold and injects at the threshold', async () => {
    const policy = createCoderPolicy();
    await mutate(policy, BACKPRESSURE_MUTATION_THRESHOLD - 1);
    const result = await policy.evaluateAfterTool(
      'sandbox_write_file',
      { path: 'last.ts' },
      'ok',
      false,
      makeCtx(),
    );
    expect(result).toMatchObject({
      action: 'inject',
      code: 'verification_backpressure',
      runtimeIntervention: { mode: 'steer' },
    });
  });

  it('keeps nudging until successful verification resets the counter', async () => {
    const policy = createCoderPolicy();
    await mutate(policy, BACKPRESSURE_MUTATION_THRESHOLD);
    expect(
      await policy.evaluateAfterTool(
        'sandbox_edit_file',
        { path: 'extra.ts' },
        'ok',
        false,
        makeCtx(),
      ),
    ).toMatchObject({ code: 'verification_backpressure' });
  });

  it.each([
    'sandbox_run_tests',
    'sandbox_check_types',
    'sandbox_verify_workspace',
  ])('resets after successful built-in verification via %s', async (tool) => {
    const policy = createCoderPolicy();
    await mutate(policy, BACKPRESSURE_MUTATION_THRESHOLD - 1);
    await policy.evaluateAfterTool(tool, {}, 'ok', false, makeCtx());
    await mutate(policy, BACKPRESSURE_MUTATION_THRESHOLD - 1);
  });

  it('does not reset after failed verification', async () => {
    const policy = createCoderPolicy();
    await mutate(policy, BACKPRESSURE_MUTATION_THRESHOLD - 1);
    await policy.evaluateAfterTool('sandbox_run_tests', {}, 'failed', true, makeCtx());
    expect(
      await policy.evaluateAfterTool(
        'sandbox_write_file',
        { path: 'last.ts' },
        'ok',
        false,
        makeCtx(),
      ),
    ).toMatchObject({ code: 'verification_backpressure' });
  });

  it('does not treat single-file LSP diagnostics as repo-level verification', async () => {
    const policy = createCoderPolicy();
    await mutate(policy, BACKPRESSURE_MUTATION_THRESHOLD - 1);
    await policy.evaluateAfterTool('lsp_diagnostics', { path: 'one.ts' }, 'ok', false, makeCtx());
    expect(
      await policy.evaluateAfterTool(
        'sandbox_write_file',
        { path: 'last.ts' },
        'ok',
        false,
        makeCtx(),
      ),
    ).toMatchObject({ code: 'verification_backpressure' });
  });

  it.each([
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
  ])('recognizes verification command: %s', (command) => {
    expect(VERIFICATION_COMMAND_PATTERN.test(command)).toBe(true);
  });

  it.each([
    'cat src/index.ts',
    'ls -la',
    'git status',
    'echo hello',
    'mkdir -p src/lib',
  ])('does not recognize arbitrary exec command: %s', (command) => {
    expect(VERIFICATION_COMMAND_PATTERN.test(command)).toBe(false);
  });

  it.each([
    'sandbox_exec',
    'exec',
  ])('resets after a successful %s verification command', async (tool) => {
    const policy = createCoderPolicy();
    await mutate(
      policy,
      BACKPRESSURE_MUTATION_THRESHOLD - 1,
      tool === 'exec' ? 'write_file' : undefined,
    );
    await policy.evaluateAfterTool(tool, { command: 'npm test' }, 'ok', false, makeCtx());
    await mutate(
      policy,
      BACKPRESSURE_MUTATION_THRESHOLD - 1,
      tool === 'exec' ? 'write_file' : undefined,
    );
  });

  it('does not count failed mutations or successful reads', async () => {
    const policy = createCoderPolicy();
    for (let index = 0; index < BACKPRESSURE_MUTATION_THRESHOLD + 1; index += 1) {
      expect(
        await policy.evaluateAfterTool(
          'sandbox_write_file',
          { path: `failed-${index}.ts` },
          'err',
          true,
          makeCtx(),
        ),
      ).toBeNull();
      expect(
        await policy.evaluateAfterTool(
          'sandbox_read_file',
          { path: 'a.ts' },
          'ok',
          false,
          makeCtx(),
        ),
      ).toBeNull();
    }
  });
});

describe('Coder policy verification-phase gating', () => {
  it.each([
    'verifying',
    'verification',
    'testing',
    'running tests',
    'validation',
    'typecheck',
    'linting',
  ])('recognizes verification phase %s', (phase) => expect(isVerificationPhase(phase)).toBe(true));

  it.each([
    'implementing',
    'planning',
    'exploring',
    'reporting',
    '',
    undefined,
  ])('rejects non-verification phase %s', (phase) =>
    expect(isVerificationPhase(phase)).toBe(false));

  it.each([
    'sandbox_write_file',
    'sandbox_edit_file',
    'sandbox_edit_range',
    'sandbox_apply_patchset',
    'sandbox_search_replace',
    'write_file',
    'edit_file',
    'undo_edit',
  ])('blocks mutation tool %s during verification', async (tool) => {
    expect(
      await createCoderPolicy().evaluateBeforeTool(tool, {}, makeCtx({ phase: 'verifying' })),
    ).toMatchObject({
      action: 'deny',
      code: 'verification_phase_mutation',
      runtimeIntervention: { mode: 'block', point: 'before_tool' },
    });
  });

  it.each([
    'sandbox_exec',
    'exec',
    'sandbox_read_file',
    'read_file',
  ])('allows non-mutation tool %s during verification', async (tool) => {
    expect(
      await createCoderPolicy().evaluateBeforeTool(tool, {}, makeCtx({ phase: 'verifying' })),
    ).toBeNull();
  });
});
