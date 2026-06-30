import { describe, expect, it } from 'vitest';
import type { ChatMessage, ReasoningBlock, ToolExecutionResult } from '@/types';
import type { ActiveProvider } from './orchestrator';
import type { AnyToolCall } from './tool-dispatch';
import {
  buildToolOutcome,
  handleDroppedCandidatesError,
  handleMultipleMutationsError,
  handleRecoveryResult,
} from './chat-tool-execution';
import { createBlockIntervention } from '@push/lib/runtime-intervention';

// Minimal AnyToolCall constructor for tests that need to populate the
// rejection lists. Tool name and source are the only fields the error
// surface reads; the rest of the args shape is incidental. Casting
// the whole object through `unknown` to bypass the discriminated-union
// exhaustive check — the production types are strict by design, but
// for these tests the inner `call` shape doesn't matter.
function sandboxCall(tool: string, args: Record<string, unknown> = {}): AnyToolCall {
  return { source: 'sandbox', call: { tool, args } } as unknown as AnyToolCall;
}

// These helpers cover the assistant-message stamping in `nextApiMessages`
// for the tool-path branches. Without `reasoningBlocks` threaded through,
// signed-thinking blocks captured during streaming would be dropped on
// the boundary into the next request — Anthropic 400s the chained turn.

describe('chat-tool-execution: apiMessages reasoningBlocks round-trip', () => {
  const blocks: ReasoningBlock[] = [{ type: 'thinking', text: 'plan', signature: 'sig-1' }];

  function userMessage(content: string): ChatMessage {
    return { id: 'u1', role: 'user', content, timestamp: 0 };
  }

  it('handleMultipleMutationsError stamps reasoningBlocks onto the assistant entry it appends', () => {
    const apiMessages: ChatMessage[] = [userMessage('do two mutations')];
    const action = handleMultipleMutationsError(
      { mutating: null, batchOverflow: [], extraMutations: [] },
      'assistant text',
      'thinking',
      blocks,
      apiMessages,
      'zen',
    );
    const assistantEntry = action.apiMessages.find(
      (m) => m.role === 'assistant' && m.content === 'assistant text',
    );
    expect(assistantEntry).toBeDefined();
    expect(assistantEntry?.reasoningBlocks).toEqual(blocks);
  });

  it('handleRecoveryResult feedback path stamps reasoningBlocks onto the assistant entry', () => {
    const apiMessages: ChatMessage[] = [userMessage('hi')];
    const recoveryResult = {
      kind: 'feedback' as const,
      feedback: {
        mode: 'unimplemented_tool' as const,
        toolName: 'mystery_tool',
        source: 'sandbox' as const,
        content: 'not implemented',
        markMalformed: false,
      },
      nextState: { diagnosisRetries: 0, recoveryAttempted: true },
    };

    const action = handleRecoveryResult(
      recoveryResult,
      'assistant text',
      'thinking',
      blocks,
      apiMessages,
      'zen',
      'minimax-m2.7',
    );
    const assistantEntry = action.apiMessages.find(
      (m) => m.role === 'assistant' && m.content === 'assistant text',
    );
    expect(assistantEntry).toBeDefined();
    expect(assistantEntry?.reasoningBlocks).toEqual(blocks);
  });

  it('omits the field when no reasoning blocks were captured', () => {
    const apiMessages: ChatMessage[] = [userMessage('do two mutations')];
    const action = handleMultipleMutationsError(
      { mutating: null, batchOverflow: [], extraMutations: [] },
      'plain',
      '',
      [],
      apiMessages,
      'zen',
    );
    const assistantEntry = action.apiMessages.find(
      (m) => m.role === 'assistant' && m.content === 'plain',
    );
    expect(assistantEntry).toBeDefined();
    expect(assistantEntry?.reasoningBlocks).toBeUndefined();
  });

  it('handleDroppedCandidatesError surfaces the malformed tool name and arg-shape hint', () => {
    const apiMessages: ChatMessage[] = [userMessage('edit it')];
    const action = handleDroppedCandidatesError(
      {
        droppedCandidates: [
          {
            rawToolName: 'edit_range',
            resolvedToolName: 'sandbox_edit_range',
            sample: '{"tool":"edit_range","args":{"path":"/workspace/README.md"}}',
          },
        ],
      },
      'assistant text',
      'thinking',
      blocks,
      apiMessages,
      'zen',
      'minimax-m2.7',
    );
    // Assistant text is preserved.
    const assistantEntry = action.apiMessages.find(
      (m) => m.role === 'assistant' && m.content === 'assistant text',
    );
    expect(assistantEntry).toBeDefined();
    expect(assistantEntry?.reasoningBlocks).toEqual(blocks);

    // The error message names the dropped tool and gives the model
    // actionable feedback about the args wrapper shape.
    expect(action.errorMessage.content).toContain('edit_range');
    expect(action.errorMessage.content).toContain('sandbox_edit_range');
    expect(action.errorMessage.content).toContain('args');
    expect(action.assistantUpdate.toolMeta.toolName).toBe('sandbox_edit_range');
    // Source derives from the resolved canonical name, not a hardcoded
    // 'sandbox' — Copilot review on PR #599. sandbox_edit_range is a
    // sandbox tool so the value happens to match, but the test asserts
    // through the resolved-name route to lock in the behavior.
    expect(action.assistantUpdate.toolMeta.source).toBe('sandbox');
  });

  it('handleDroppedCandidatesError flags unknown tool names without a resolved canonical', () => {
    const apiMessages: ChatMessage[] = [userMessage('do something')];
    const action = handleDroppedCandidatesError(
      {
        droppedCandidates: [
          {
            rawToolName: 'sandbox',
            resolvedToolName: null,
            sample: '{"tool":"sandbox","args":{"command":"read","path":"/workspace"}}',
          },
        ],
      },
      'assistant',
      '',
      [],
      apiMessages,
      'zen',
      'minimax-m2.7',
    );
    expect(action.errorMessage.content).toContain('sandbox (unknown)');
  });

  // -------------------------------------------------------------------------
  // batchOverflow vs extraMutations — distinct error codes per failure
  // shape. Mirrors the CLI split that landed in PR #680; web was lumping
  // both into a single MULTI_MUTATION_NOT_ALLOWED hint with vague
  // wording. This test pins the per-code distinction.
  // -------------------------------------------------------------------------

  it('handleMultipleMutationsError emits FILE_MUTATION_BATCH_OVERFLOW when only batch overflow', () => {
    const apiMessages: ChatMessage[] = [userMessage('write 9 files')];
    const action = handleMultipleMutationsError(
      {
        mutating: null,
        batchOverflow: [
          sandboxCall('sandbox_write_file', { path: '/9.md' }),
          sandboxCall('sandbox_write_file', { path: '/10.md' }),
        ],
        extraMutations: [],
      },
      'assistant',
      '',
      [],
      apiMessages,
      'zen',
    );
    expect(action.errorMessage.content).toContain('FILE_MUTATION_BATCH_OVERFLOW');
    expect(action.errorMessage.content).toContain('continue the batch on the next turn');
    // The ordering-violation hint shouldn't fire when ordering is fine.
    expect(action.errorMessage.content).not.toContain('MULTI_MUTATION_NOT_ALLOWED');
  });

  it('handleMultipleMutationsError emits MULTI_MUTATION_NOT_ALLOWED when only ordering violations', () => {
    const apiMessages: ChatMessage[] = [userMessage('write then read')];
    const action = handleMultipleMutationsError(
      {
        // mutating is set → the rejection list includes it as a "the
        // model emitted multiple mutations and we rejected all" signal.
        mutating: sandboxCall('sandbox_exec', { command: 'echo hi' }),
        batchOverflow: [],
        extraMutations: [sandboxCall('sandbox_write_file', { path: '/after-exec.md' })],
      },
      'assistant',
      '',
      [],
      apiMessages,
      'zen',
    );
    expect(action.errorMessage.content).toContain('MULTI_MUTATION_NOT_ALLOWED');
    expect(action.errorMessage.content).toContain('Reorder or split');
    expect(action.errorMessage.content).not.toContain('FILE_MUTATION_BATCH_OVERFLOW');
  });

  it('handleMultipleMutationsError carries the runtime intervention metadata', () => {
    const apiMessages: ChatMessage[] = [userMessage('write then exec then exec')];
    const intervention = createBlockIntervention({
      point: 'before_tool',
      source: 'tool_budget',
      reason: 'multiple_mutating_calls',
    });

    const action = handleMultipleMutationsError(
      {
        mutating: sandboxCall('sandbox_exec', { command: 'npm test' }),
        batchOverflow: [],
        extraMutations: [sandboxCall('sandbox_exec', { command: 'npm run build' })],
      },
      'assistant',
      '',
      [],
      apiMessages,
      'zen',
      undefined,
      intervention,
    );

    expect(action.runtimeIntervention).toBe(intervention);
    expect(action.errorMessage.content).toContain('MULTI_MUTATION_NOT_ALLOWED');
  });

  it('handleMultipleMutationsError does NOT classify a valid trailing exec as ordering when only batch overflowed', () => {
    // Codex P2 / Copilot regression. Scenario: 9 file writes + valid
    // trailing sandbox_exec. Kernel returns:
    //   batchOverflow = [9th write], mutating = exec, extraMutations = []
    // Pre-fix, `hasOrderingViolations = mutating !== null` included the
    // exec as a per-call ordering violation and emitted
    // MULTI_MUTATION_NOT_ALLOWED for it — the exec was actually fine,
    // it just got aborted as collateral damage of the "reject whole
    // turn on overflow" policy. Now the ordering code only fires when
    // there ARE actual ordering extras.
    const apiMessages: ChatMessage[] = [userMessage('write 9 files then run tests')];
    const action = handleMultipleMutationsError(
      {
        mutating: sandboxCall('sandbox_exec', { command: 'npm test' }),
        batchOverflow: [sandboxCall('sandbox_write_file', { path: '/9.md' })],
        extraMutations: [],
      },
      'assistant',
      '',
      [],
      apiMessages,
      'zen',
    );
    expect(action.errorMessage.content).toContain('FILE_MUTATION_BATCH_OVERFLOW');
    expect(action.errorMessage.content).not.toContain('MULTI_MUTATION_NOT_ALLOWED');
    // The exec was legitimately the trailing side-effect; don't label
    // it as a violation in the per-call list.
    expect(action.errorMessage.content).not.toContain('sandbox_exec');
  });

  it('handleMultipleMutationsError emits BOTH codes when both shapes occur in one turn', () => {
    const apiMessages: ChatMessage[] = [userMessage('write 9 files then exec then write')];
    const action = handleMultipleMutationsError(
      {
        mutating: sandboxCall('sandbox_exec', { command: 'echo hi' }),
        batchOverflow: [sandboxCall('sandbox_write_file', { path: '/9.md' })],
        extraMutations: [sandboxCall('sandbox_write_file', { path: '/after-exec.md' })],
      },
      'assistant',
      '',
      [],
      apiMessages,
      'zen',
    );
    expect(action.errorMessage.content).toContain('FILE_MUTATION_BATCH_OVERFLOW');
    expect(action.errorMessage.content).toContain('MULTI_MUTATION_NOT_ALLOWED');
    // Both hints present.
    expect(action.errorMessage.content).toContain('continue the batch on the next turn');
    expect(action.errorMessage.content).toContain('Reorder or split');
  });

  it('handleDroppedCandidatesError routes a github-tool drop through the github source', () => {
    // Locks in the Copilot fix: source must derive from the resolved
    // canonical name, not be hardcoded 'sandbox'. A github tool dropped
    // for bad args was being mislabeled as sandbox in run-event
    // telemetry before this change.
    const apiMessages: ChatMessage[] = [userMessage('check pr')];
    const action = handleDroppedCandidatesError(
      {
        droppedCandidates: [
          {
            rawToolName: 'pr',
            resolvedToolName: 'fetch_pr',
            sample: '{"tool":"pr","args":{"repo":"a/b"}}',
          },
        ],
      },
      'assistant',
      '',
      [],
      apiMessages,
      'zen',
      'minimax-m2.7',
    );
    expect(action.assistantUpdate.toolMeta.source).toBe('github');
  });
});

// buildToolOutcome mints the structured tool_result sidecar (Structured
// Tool-Call Sourcing, Slice 1). The block content must carry the SAME body the
// text envelope wraps — the runtime metaLine ([meta]/[pulse]) prepended to the
// result — so the Slice 2 block path replays the context the text arm shows
// today instead of a bare result frozen without it.
describe('chat-tool-execution: tool_result sidecar preserves runtime meta', () => {
  function rawResult(text: string) {
    return {
      call: sandboxCall('sandbox_read_file', { path: 'a.ts' }),
      raw: { text } as unknown as ToolExecutionResult,
      cards: [],
      durationMs: 5,
    };
  }

  it('persists metaLine + result in the structured tool_result block', () => {
    const metaLine = '[meta] round=2 ctx=3kb tok=1k/200k pressure=low pct=0';
    const outcome = buildToolOutcome(
      rawResult('file contents'),
      metaLine,
      'cloudflare' as ActiveProvider,
      { toolUseId: 'toolu_a' },
    );
    expect(outcome.resultMessage.toolResults).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_a', content: `${metaLine}\nfile contents` },
    ]);
  });

  it('omits the sidecar when no toolUseId is supplied (legacy text arm)', () => {
    const outcome = buildToolOutcome(
      rawResult('x'),
      '[meta] round=1',
      'cloudflare' as ActiveProvider,
    );
    expect(outcome.resultMessage.toolResults).toBeUndefined();
  });

  it('stamps regular tool results with the current write branch', () => {
    const outcome = buildToolOutcome(
      rawResult('x'),
      '[meta] round=1',
      'cloudflare' as ActiveProvider,
      { currentBranch: 'feature/current' },
    );

    expect(outcome.resultMessage.branch).toBe('feature/current');
  });

  it('stamps branch-switch tool results with the target branch', () => {
    const raw = rawResult('switched');
    raw.raw.branchSwitch = {
      name: 'feature/next',
      kind: 'switched',
      previous: 'main',
      source: 'sandbox_switch_branch',
    };

    const outcome = buildToolOutcome(raw, '[meta] round=1', 'cloudflare' as ActiveProvider, {
      currentBranch: 'main',
    });

    expect(outcome.resultMessage.branch).toBe('feature/next');
  });
});
