import { describe, expect, it } from 'vitest';
import {
  buildCoderDetectors,
  buildCoderEvaluateAfterModel,
  buildCoderToolExec,
  CODER_INTERNAL_TOOL_NAMES,
  isCoderInternalToolName,
} from './coder-agent-bindings.js';
import { getEffectiveCapabilities, getToolCapabilities } from './capabilities.js';
import { ANNOUNCED_NO_ACTION_POLICY_MARKER } from './tool-call-recovery.js';

// Pins the contract from PR #605: Coder-internal tool names — handled
// outside the source-detector pipeline by detectUpdateStateCall /
// detectCheckpointCall in the Coder loop — must not be reported as
// dropped candidates by the bindings. Otherwise the Coder's parse-
// error guard from PR #599 bails on the whole batch every time the
// model emits a state-update alongside a real edit (visible in the
// 2026-05-20 session log, round 1 of every Coder delegation).

describe('CODER_INTERNAL_TOOL_NAMES', () => {
  it('contains coder_update_state and coder_checkpoint', () => {
    expect(CODER_INTERNAL_TOOL_NAMES.has('coder_update_state')).toBe(true);
    expect(CODER_INTERNAL_TOOL_NAMES.has('coder_checkpoint')).toBe(true);
  });

  it('is a closed allowlist — sandbox tool names are not coder-internal', () => {
    expect(isCoderInternalToolName('sandbox_read_file')).toBe(false);
    expect(isCoderInternalToolName('sandbox_edit_range')).toBe(false);
    expect(isCoderInternalToolName('sandbox_diff')).toBe(false);
    expect(isCoderInternalToolName('delegate_coder')).toBe(false);
  });
});

describe('buildCoderDetectors — droppedCandidates filtering', () => {
  // Use a minimal services stub so we can hand-craft the raw
  // detectAllToolCalls return and assert what the bindings layer
  // forwards. The Coder loop only consumes the returned shape; nothing
  // in this test exercises the real dispatcher.
  function makeServices(
    rawDropped: Array<{ rawToolName: string; resolvedToolName: string | null; sample: string }>,
  ) {
    return {
      policy: {} as never,
      capabilityLedger: {} as never,
      turnCtx: {} as never,
      onStatus: () => {},
      activeProvider: 'openrouter',
      activeModel: undefined,
      sandboxId: 'sbx',
      tracing: {} as never,
      executeSandboxToolCall: async () => ({}) as never,
      executeWebSearch: async () => ({}) as never,
      sandboxStatus: async () => ({}) as never,
      detectSandboxToolCall: () => null,
      detectWebSearchToolCall: () => null,
      detectAnyToolCall: () => null,
      detectAllToolCalls: () => ({
        readOnly: [],
        fileMutations: [],
        mutating: null,
        extraMutations: [],
        droppedCandidates: rawDropped,
      }),
      tagSandboxCall: (call: unknown) => ({ source: 'sandbox', call }) as never,
      tagWebSearchCall: (call: unknown) => ({ source: 'web-search', call }) as never,
    } as never;
  }

  it('drops coder_update_state from droppedCandidates so the parse-error guard does not bail', () => {
    const { detectAllToolCalls } = buildCoderDetectors(
      makeServices([
        {
          rawToolName: 'coder_update_state',
          resolvedToolName: null,
          sample: '{"tool":"coder_update_state","args":{"plan":"..."}}',
        },
      ]),
    );
    const result = detectAllToolCalls('anything');
    expect(result.droppedCandidates).toEqual([]);
  });

  it('drops coder_checkpoint from droppedCandidates too', () => {
    const { detectAllToolCalls } = buildCoderDetectors(
      makeServices([
        {
          rawToolName: 'coder_checkpoint',
          resolvedToolName: null,
          sample: '{"tool":"coder_checkpoint","args":{"question":"x"}}',
        },
      ]),
    );
    const result = detectAllToolCalls('anything');
    expect(result.droppedCandidates).toEqual([]);
  });

  it('preserves genuinely malformed sandbox candidates so PR #599 still surfaces them', () => {
    const { detectAllToolCalls } = buildCoderDetectors(
      makeServices([
        {
          rawToolName: 'read',
          resolvedToolName: 'sandbox_read_file',
          sample: '{"tool":"read","path":"/foo"}',
        },
        {
          rawToolName: 'coder_update_state',
          resolvedToolName: null,
          sample: '{"tool":"coder_update_state","args":{}}',
        },
      ]),
    );
    const result = detectAllToolCalls('anything');
    expect(result.droppedCandidates).toHaveLength(1);
    expect(result.droppedCandidates[0].rawToolName).toBe('read');
  });
});

describe('buildCoderDetectors — memory source (LCM)', () => {
  const memCall = { source: 'memory', call: { tool: 'memory_grep', args: { pattern: 'x' } } };
  const sbCall = { source: 'sandbox', call: { tool: 'sandbox_read_file', args: { path: '/a' } } };

  function makeServices(opts: { readOnly?: unknown[]; anyCall?: unknown }) {
    return {
      policy: {} as never,
      capabilityLedger: {} as never,
      turnCtx: {} as never,
      onStatus: () => {},
      activeProvider: 'openrouter',
      activeModel: undefined,
      sandboxId: 'sbx',
      tracing: {} as never,
      executeSandboxToolCall: async () => ({}) as never,
      executeWebSearch: async () => ({}) as never,
      sandboxStatus: async () => ({}) as never,
      detectSandboxToolCall: () => null,
      detectWebSearchToolCall: () => null,
      detectAnyToolCall: () => opts.anyCall ?? null,
      detectAllToolCalls: () => ({
        readOnly: opts.readOnly ?? [],
        fileMutations: [],
        mutating: null,
        extraMutations: [],
        droppedCandidates: [],
      }),
      tagSandboxCall: (call: unknown) => ({ source: 'sandbox', call }),
      tagWebSearchCall: (call: unknown) => ({ source: 'web-search', call }),
    } as never;
  }

  it('keeps memory reads in the parallel-reads bucket (not filtered like other non-sandbox sources)', () => {
    const { detectAllToolCalls } = buildCoderDetectors(
      makeServices({ readOnly: [sbCall, memCall] }),
    );
    const result = detectAllToolCalls('anything');
    // Both the sandbox read AND the memory read survive — memory is read-only.
    expect(result.readOnly).toContainEqual(sbCall);
    expect(result.readOnly).toContainEqual(memCall);
  });

  it('detectAnyToolCall recovers a memory-source call (single-call path)', () => {
    const { detectAnyToolCall } = buildCoderDetectors(makeServices({ anyCall: memCall }));
    expect(detectAnyToolCall('anything')).toEqual(memCall);
  });
});

describe('buildCoderToolExec — role-capability denial observability', () => {
  // A delegated Coder that hits a capability denial must leave an ops-greppable
  // trail, not only a `reason` the model consumes. This is the exact
  // subagent-layer blind spot the OpenCode silent-failure audit called out:
  // returning the block only to the model lets a misconfigured grant burn
  // tokens with no `role_capability_denied` signal for operators to see.
  function makeExecServices() {
    return {
      policy: { evaluateBeforeTool: async () => null },
      capabilityLedger: { recordToolUse: () => {} },
      turnCtx: { round: 0, phase: undefined },
      onStatus: () => {},
      activeProvider: 'openrouter',
      activeModel: undefined,
      sandboxId: 'sbx',
      tracing: {} as never,
      executeSandboxToolCall: async () => ({}) as never,
      executeWebSearch: async () => ({}) as never,
      sandboxStatus: async () => ({}) as never,
    } as never;
  }

  it('emits a role_capability_denied structured log on stderr when Coder lacks a capability', async () => {
    const toolExec = buildCoderToolExec(makeExecServices());
    // `plan_tasks` requires delegate:coder + delegate:explorer; the Coder grant
    // has delegate:explorer but NOT delegate:coder, so it is denied. Tagged as
    // a sandbox-source call so it clears the source gate and reaches the
    // kernel role check.
    const call = { source: 'sandbox', call: { tool: 'plan_tasks', args: {} } } as never;

    const errCalls: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errCalls.push(args);
    };
    let result: { kind: string; reason?: string };
    try {
      result = (await toolExec(call, { round: 1 })) as { kind: string; reason?: string };
    } finally {
      console.error = originalError;
    }

    expect(result.kind).toBe('denied');

    const denialLog = errCalls
      .map(([m]) => {
        try {
          return JSON.parse(m as string);
        } catch {
          return null;
        }
      })
      .find((p) => p && p.event === 'role_capability_denied');
    expect(denialLog, 'expected a role_capability_denied log on stderr').toBeTruthy();
    expect(denialLog.type).toBe('ROLE_CAPABILITY_DENIED');
    expect(denialLog.role).toBe('coder');
    expect(denialLog.tool).toBe('plan_tasks');
    expect(denialLog.required).toEqual([...getToolCapabilities('plan_tasks')]);
    expect(new Set(denialLog.granted)).toEqual(new Set(getEffectiveCapabilities('coder')));
  });
});

describe('buildCoderEvaluateAfterModel — forceToolChoiceNextRound escalation', () => {
  // A model that announces a tool action but never emits one keeps dead-ending
  // even after the text-only nudge (#1283 fixed detection, not compliance).
  // The bindings layer must flag the announce-without-act nudge specifically so
  // the round loop can force tool_choice: 'required' on the next request —
  // recognizing it purely from the injected message's marker prefix, with no
  // policy-internal coupling.
  function makeEvalServices(policyResult: unknown) {
    return {
      policy: { evaluateAfterModel: async () => policyResult },
      turnCtx: { round: 0 },
    } as never;
  }

  it('sets forceToolChoiceNextRound when the injected message is the announced-no-action nudge', async () => {
    const evaluateAfterModel = buildCoderEvaluateAfterModel(
      makeEvalServices({
        action: 'inject',
        message: { content: `${ANNOUNCED_NO_ACTION_POLICY_MARKER}\nEmit the tool call now.` },
      }),
    );
    const result = await evaluateAfterModel('let me actually run the tools now', 0);
    expect(result).toEqual({
      action: 'inject',
      content: `${ANNOUNCED_NO_ACTION_POLICY_MARKER}\nEmit the tool call now.`,
      forceToolChoiceNextRound: true,
    });
  });

  it('tolerates leading whitespace before the marker (isAnnouncedNoActionPolicyMessage trims)', async () => {
    const evaluateAfterModel = buildCoderEvaluateAfterModel(
      makeEvalServices({
        action: 'inject',
        message: { content: `  \n${ANNOUNCED_NO_ACTION_POLICY_MARKER}\nEmit the tool call now.` },
      }),
    );
    const result = await evaluateAfterModel('let me actually run the tools now', 0);
    expect(result).toMatchObject({ forceToolChoiceNextRound: true });
  });

  it('does not set forceToolChoiceNextRound for other inject nudges (e.g. drift correction)', async () => {
    const evaluateAfterModel = buildCoderEvaluateAfterModel(
      makeEvalServices({
        action: 'inject',
        message: { content: '[POLICY: DRIFT_DETECTED]\nRe-read your task.' },
      }),
    );
    const result = await evaluateAfterModel('unrelated drifting response', 0);
    expect(result).toEqual({
      action: 'inject',
      content: '[POLICY: DRIFT_DETECTED]\nRe-read your task.',
      forceToolChoiceNextRound: false,
    });
  });

  it('passes through halt and null unchanged', async () => {
    const haltEval = buildCoderEvaluateAfterModel(
      makeEvalServices({ action: 'halt', summary: 'stopped' }),
    );
    expect(await haltEval('anything', 0)).toEqual({ action: 'halt', summary: 'stopped' });

    const nullEval = buildCoderEvaluateAfterModel(makeEvalServices(null));
    expect(await nullEval('anything', 0)).toBeNull();
  });
});
