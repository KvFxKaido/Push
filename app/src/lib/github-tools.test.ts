import { describe, expect, it } from 'vitest';
import { detectToolCall } from './github-tools';

describe('detectToolCall delegation validation', () => {
  it('trims delegation strings and drops blank entries', () => {
    const result = detectToolCall('```json\n{"tool":"delegate_coder","args":{"task":"   ","tasks":["  inspect auth  ","   "],"files":[" src/auth.ts ",""],"intent":" tighten handoff flow ","deliverable":" a concise summary ","knownContext":[" existing note ","   "],"constraints":[" keep the API stable "," "]}}\n```');

    expect(result).toEqual({
      tool: 'delegate_coder',
      args: {
        task: undefined,
        tasks: ['inspect auth'],
        files: ['src/auth.ts'],
        intent: 'tighten handoff flow',
        deliverable: 'a concise summary',
        knownContext: ['existing note'],
        constraints: ['keep the API stable'],
      },
    });
  });
});
