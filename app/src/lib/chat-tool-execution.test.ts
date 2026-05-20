import { describe, expect, it } from 'vitest';
import type { ChatMessage, ReasoningBlock } from '@/types';
import {
  handleDroppedCandidatesError,
  handleMultipleMutationsError,
  handleRecoveryResult,
} from './chat-tool-execution';

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
      { mutating: null, extraMutations: [] },
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
      { mutating: null, extraMutations: [] },
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
