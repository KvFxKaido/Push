import { describe, expect, it } from 'vitest';
import type { ChatMessage, ReasoningBlock } from '@/types';
import { handleMultipleMutationsError, handleRecoveryResult } from './chat-tool-execution';

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
});
