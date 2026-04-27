import { describe, it, expect } from 'vitest';
import { assertReadyForAssistantTurn } from './llm-message-invariants';

describe('assertReadyForAssistantTurn', () => {
  it('accepts a history ending with a user message', () => {
    expect(() =>
      assertReadyForAssistantTurn(
        [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
          { role: 'user', content: 'do the thing' },
        ],
        'test',
      ),
    ).not.toThrow();
  });

  it('accepts a history whose tail is a tool result encoded as a user role', () => {
    expect(() =>
      assertReadyForAssistantTurn(
        [
          { role: 'user', content: 'do it' },
          { role: 'assistant', content: '<tool_call>...' },
          { role: 'user', content: '[TOOL_RESULT] ok' },
        ],
        'test',
      ),
    ).not.toThrow();
  });

  it('throws when the history is empty', () => {
    expect(() => assertReadyForAssistantTurn([], 'cli/runAssistantLoop')).toThrow(
      /message history is empty/,
    );
  });

  it('throws when the trailing message is an assistant turn', () => {
    expect(() =>
      assertReadyForAssistantTurn(
        [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
        ],
        'web/streamAssistantRound',
      ),
    ).toThrow(/last message has role 'assistant'/);
  });

  it('throws when the trailing message has any non-user role', () => {
    expect(() =>
      assertReadyForAssistantTurn(
        [
          { role: 'user', content: 'hi' },
          { role: 'system', content: 'hidden directive' },
        ],
        'cli/runAssistantLoop',
      ),
    ).toThrow(/last message has role 'system'/);
  });

  it('includes the caller context in the thrown message', () => {
    expect(() =>
      assertReadyForAssistantTurn([{ role: 'assistant', content: 'x' }], 'cli/runAssistantLoop'),
    ).toThrow(/^cli\/runAssistantLoop:/);
  });
});
