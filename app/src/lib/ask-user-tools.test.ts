import { describe, expect, it } from 'vitest';
import { detectAskUserToolCall } from './ask-user-tools';

describe('detectAskUserToolCall', () => {
  it('rejects blank questions and empty option labels', () => {
    const result = detectAskUserToolCall(`{
      "tool": "ask_user",
      "args": {
        "question": "   ",
        "options": [
          { "id": "one", "label": "   " }
        ]
      }
    }`);

    expect(result).toBeNull();
  });

  it('normalizes valid ask_user payloads', () => {
    const result = detectAskUserToolCall(`{
      "tool": "ask_user",
      "args": {
        "question": " Pick a path ",
        "options": [
          { "label": "Use OAuth" },
          { "id": "apikey", "label": "API Key", "description": "Header-based auth" }
        ],
        "multiSelect": true
      }
    }`);

    expect(result).toEqual({
      tool: 'ask_user',
      args: {
        question: 'Pick a path',
        options: [
          { id: 'option-1', label: 'Use OAuth' },
          { id: 'apikey', label: 'API Key', description: 'Header-based auth' },
        ],
        multiSelect: true,
      },
    });
  });
});
