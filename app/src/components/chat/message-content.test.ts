import { describe, expect, it } from 'vitest';

import { looksLikeToolCall, stripToolCallPayload } from './message-content';

describe('looksLikeToolCall', () => {
  it('detects braced tool objects during streaming', () => {
    expect(
      looksLikeToolCall('Explanation first.\n{"tool":"sandbox_read_file","args":{"path":"src/main.ts"}}'),
    ).toBe(true);
  });

  it('detects truncated braced tool objects before args finish streaming', () => {
    expect(looksLikeToolCall('{"tool":"sandbox_exec"')).toBe(true);
  });

  it('does not flag schema-like prose with unquoted tool shorthand', () => {
    expect(looksLikeToolCall('tool: read_file, args: path=README.md')).toBe(false);
    expect(looksLikeToolCall('Config:\ntool: read_file, args: path=README.md')).toBe(false);
  });
});

describe('stripToolCallPayload', () => {
  it('strips braced tool JSON while preserving preceding prose', () => {
    expect(
      stripToolCallPayload('Before\n{"tool":"sandbox_exec","args":{"command":"ls"}}'),
    ).toBe('Before');
  });

  it('strips brace-less quoted tool JSON while preserving preceding prose', () => {
    expect(
      stripToolCallPayload('Before\n"tool": "list_commits", "args": {"repo": "a/b", "count": 10}}'),
    ).toBe('Before');
  });

  it('leaves schema-like prose untouched when args are not object-shaped', () => {
    expect(stripToolCallPayload('tool: read_file, args: path=README.md')).toBe(
      'tool: read_file, args: path=README.md',
    );
    expect(stripToolCallPayload('Config:\ntool: "read_file", args: path=README.md')).toBe(
      'Config:\ntool: "read_file", args: path=README.md',
    );
  });

  it('strips truncated brace-less quoted tool payloads once args start as an object', () => {
    expect(stripToolCallPayload('Before\n"tool": "sandbox_exec", "args": {')).toBe('Before');
  });
});
