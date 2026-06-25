import { describe, expect, it } from 'vitest';

import { buildToolResultBlock, buildToolUseBlock, createToolUseBlockId } from './tool-blocks';

describe('tool block builders', () => {
  it('creates stable Anthropic-canonical tool_use ids from execution seeds', () => {
    expect(createToolUseBlockId('exec-1')).toBe('toolu_exec-1');
    expect(createToolUseBlockId('toolu_exec-1')).toBe('toolu_exec-1');
  });

  it('builds tool_use blocks from parsed tool names and object args', () => {
    expect(
      buildToolUseBlock({
        id: 'toolu_read',
        name: 'read_file',
        input: { path: 'src/app.ts' },
      }),
    ).toEqual({
      type: 'tool_use',
      id: 'toolu_read',
      name: 'read_file',
      input: { path: 'src/app.ts' },
    });
  });

  it('normalizes malformed/non-object args to an empty input object', () => {
    expect(buildToolUseBlock({ id: 'toolu_bad', name: 'read_file', input: 'nope' })).toEqual({
      type: 'tool_use',
      id: 'toolu_bad',
      name: 'read_file',
      input: {},
    });
  });

  it('builds tool_result blocks and preserves the error flag only when true', () => {
    expect(
      buildToolResultBlock({
        toolUseId: 'toolu_read',
        content: 'file contents',
      }),
    ).toEqual({
      type: 'tool_result',
      tool_use_id: 'toolu_read',
      content: 'file contents',
    });

    expect(
      buildToolResultBlock({
        toolUseId: 'toolu_read',
        content: '[Tool Error] missing',
        isError: true,
      }),
    ).toEqual({
      type: 'tool_result',
      tool_use_id: 'toolu_read',
      content: '[Tool Error] missing',
      is_error: true,
    });
  });
});
