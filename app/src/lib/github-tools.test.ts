import { describe, expect, it } from 'vitest';
import { decodeGitHubBase64Utf8, detectToolCall } from './github-tools';

describe('detectToolCall delegation validation', () => {
  it('trims delegation strings and drops blank entries', () => {
    const result = detectToolCall('```json\n{"tool":"delegate_coder","args":{"task":"   ","tasks":["  inspect auth  ","   "],"files":[" src/auth.ts ",""],"intent":" tighten handoff flow ","deliverable":" a concise summary ","knownContext":[" existing note ","   "],"constraints":[" keep the API stable "," "],"declaredCapabilities":["repo:read","repo:write","not:a-real-capability"]}}\n```');

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
        declaredCapabilities: ['repo:read', 'repo:write'],
      },
    });
  });
});

describe('decodeGitHubBase64Utf8', () => {
  it('decodes UTF-8 GitHub file content without mojibake', () => {
    const utf8Base64 = 'Y2Fmw6kg8J+agA==';

    expect(decodeGitHubBase64Utf8(utf8Base64)).toBe('café 🚀');
  });
});
