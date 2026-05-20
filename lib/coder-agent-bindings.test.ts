import { describe, expect, it } from 'vitest';
import {
  buildCoderDetectors,
  CODER_INTERNAL_TOOL_NAMES,
  isCoderInternalToolName,
} from './coder-agent-bindings.js';

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
