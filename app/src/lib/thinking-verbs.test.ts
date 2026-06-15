import { describe, expect, it } from 'vitest';
import { THINKING_VERBS } from './thinking-verbs';

describe('THINKING_VERBS', () => {
  it('is the minimal thinking/reasoning pool the status bar rotates over', () => {
    expect(THINKING_VERBS).toEqual(['Thinking…', 'Reasoning…']);
  });
});
