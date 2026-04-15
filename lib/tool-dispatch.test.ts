import { describe, it, expect } from 'vitest';
import { PASS_THROUGH_CLI_SOURCE, createToolDispatcher, type ToolSource } from './tool-dispatch';

// ---------------------------------------------------------------------------
// Convergence-gap regression: the parser MUST detect tool-call JSON that
// lacks the opening fence. This is the exact failure mode reported in
// docs/decisions/Tool-Call Parser Convergence Gap.md.
// ---------------------------------------------------------------------------

describe('createToolDispatcher — missing-fence tolerance (the bug)', () => {
  const dispatcher = createToolDispatcher([PASS_THROUGH_CLI_SOURCE]);

  it('detects a bare tool-call JSON object with no fence at all', () => {
    const text = '{"tool":"read_file","args":{"path":"ROADMAP.md"}}';
    const result = dispatcher.detectAllToolCalls(text);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toEqual({
      tool: 'read_file',
      args: { path: 'ROADMAP.md' },
    });
    expect(result.malformed).toEqual([]);
  });

  it('detects tool-call JSON preceded by a stray `json` language hint without fences (Gemini-3-flash case)', () => {
    // The exact failure mode: the model emitted the `json` language tag on
    // its own line, followed by a tool-call JSON object, with no opening
    // triple-backtick. The CLI's old fence-only parser dropped this
    // silently; the TUI rendered nothing.
    const text = [
      'json',
      '{"tool":"list_dir","args":{"path":"."}}',
      '{"tool":"read_file","args":{"path":"ROADMAP.md"}}',
      '{"tool":"git_status","args":{}}',
    ].join('\n');

    const result = dispatcher.detectAllToolCalls(text);
    expect(result.calls.map((c) => c.tool)).toEqual(['list_dir', 'read_file', 'git_status']);
  });

  it('detects tool-call JSON mixed into prose', () => {
    const text =
      'Let me read that file for you.\n\n{"tool":"read_file","args":{"path":"foo.txt"}}\n\nThat\'s the content.';
    const result = dispatcher.detectAllToolCalls(text);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].tool).toBe('read_file');
  });
});

// ---------------------------------------------------------------------------
// Fenced-block parsing — preserves the CLI's existing behavior.
// ---------------------------------------------------------------------------

describe('createToolDispatcher — fenced blocks', () => {
  const dispatcher = createToolDispatcher([PASS_THROUGH_CLI_SOURCE]);

  it('parses a fenced JSON tool call with language tag', () => {
    const text = '```json\n{"tool":"read_file","args":{"path":"foo.txt"}}\n```';
    const result = dispatcher.detectAllToolCalls(text);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toEqual({ tool: 'read_file', args: { path: 'foo.txt' } });
    expect(result.malformed).toEqual([]);
  });

  it('parses a fence without a language tag', () => {
    const text = '```\n{"tool":"list_dir","args":{"path":"."}}\n```';
    const result = dispatcher.detectAllToolCalls(text);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].tool).toBe('list_dir');
  });

  it('parses multiple fenced tool calls in order', () => {
    const text = [
      '```json',
      '{"tool":"read_file","args":{"path":"a.txt"}}',
      '```',
      'Some prose in between.',
      '```json',
      '{"tool":"search_files","args":{"pattern":"TODO"}}',
      '```',
    ].join('\n');

    const result = dispatcher.detectAllToolCalls(text);
    expect(result.calls.map((c) => c.tool)).toEqual(['read_file', 'search_files']);
    expect(result.malformed).toEqual([]);
  });

  it('reports a fenced candidate with a missing_args_object shape error', () => {
    const text = '```json\n{"tool":"read_file","args":"oops"}\n```';
    const result = dispatcher.detectAllToolCalls(text);
    expect(result.calls).toEqual([]);
    expect(result.malformed).toHaveLength(1);
    expect(result.malformed[0].reason).toBe('missing_args_object');
  });

  it('ignores non-tool code fences without reporting malformed', () => {
    const text = '```ts\nconst x = 1;\n```\n\n```json\n{"name":"test","version":"1.0"}\n```';
    const result = dispatcher.detectAllToolCalls(text);
    expect(result.calls).toEqual([]);
    // The JSON block has no "tool" key so it's not a candidate at all.
    expect(result.malformed).toEqual([]);
  });

  it('repairs common LLM garbling inside a fence', () => {
    // Trailing comma — the canonical LLM JSON foot-gun.
    const text = '```json\n{"tool": "read_file", "args": {"path": "foo.txt",}}\n```';
    const result = dispatcher.detectAllToolCalls(text);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].tool).toBe('read_file');
  });
});

// ---------------------------------------------------------------------------
// Dedup across fenced + bare phases.
// ---------------------------------------------------------------------------

describe('createToolDispatcher — dedup', () => {
  const dispatcher = createToolDispatcher([PASS_THROUGH_CLI_SOURCE]);

  it('collapses duplicate calls across fenced and bare phases', () => {
    const text = [
      '```json',
      '{"tool":"read_file","args":{"path":"foo.txt"}}',
      '```',
      '',
      '{"tool":"read_file","args":{"path":"foo.txt"}}',
    ].join('\n');

    const result = dispatcher.detectAllToolCalls(text);
    expect(result.calls).toHaveLength(1);
  });

  it('treats arg-order differences as the same canonical invocation', () => {
    const text = [
      '```json',
      '{"tool":"edit_file","args":{"path":"a.ts","edits":[]}}',
      '```',
      '```json',
      '{"tool":"edit_file","args":{"edits":[],"path":"a.ts"}}',
      '```',
    ].join('\n');

    const result = dispatcher.detectAllToolCalls(text);
    expect(result.calls).toHaveLength(1);
  });

  it('keeps distinct calls with different args as separate entries', () => {
    const text = [
      '```json',
      '{"tool":"read_file","args":{"path":"a.txt"}}',
      '```',
      '```json',
      '{"tool":"read_file","args":{"path":"b.txt"}}',
      '```',
    ].join('\n');

    const result = dispatcher.detectAllToolCalls(text);
    expect(result.calls).toHaveLength(2);
    expect(result.calls.map((c) => c.args.path)).toEqual(['a.txt', 'b.txt']);
  });
});

// ---------------------------------------------------------------------------
// Source registration — sources are tried in order, first match wins.
// ---------------------------------------------------------------------------

describe('createToolDispatcher — source registration', () => {
  it('delegates to the first source that claims the tool', () => {
    type TypedCall =
      | { kind: 'github'; tool: string; args: Record<string, unknown> }
      | { kind: 'sandbox'; tool: string; args: Record<string, unknown> };

    const githubSource: ToolSource<TypedCall> = {
      name: 'github',
      detect: (parsed) =>
        parsed.tool.startsWith('repo_')
          ? { kind: 'github', tool: parsed.tool, args: parsed.args }
          : null,
    };
    const sandboxSource: ToolSource<TypedCall> = {
      name: 'sandbox',
      detect: (parsed) =>
        parsed.tool.startsWith('sandbox_')
          ? { kind: 'sandbox', tool: parsed.tool, args: parsed.args }
          : null,
    };

    const dispatcher = createToolDispatcher<TypedCall>([githubSource, sandboxSource]);
    const text = [
      '```json',
      '{"tool":"repo_read","args":{"path":"a.txt"}}',
      '```',
      '```json',
      '{"tool":"sandbox_run_tests","args":{"cmd":"npm test"}}',
      '```',
    ].join('\n');

    const result = dispatcher.detectAllToolCalls(text);
    expect(result.calls).toHaveLength(2);
    expect(result.calls[0].kind).toBe('github');
    expect(result.calls[1].kind).toBe('sandbox');
  });

  it('reports unknown_tool when a fenced candidate matches no source', () => {
    const rejectAllSource: ToolSource<unknown> = {
      name: 'reject-all',
      detect: () => null,
    };
    const dispatcher = createToolDispatcher([rejectAllSource]);
    const text = '```json\n{"tool":"mystery_tool","args":{}}\n```';
    const result = dispatcher.detectAllToolCalls(text);
    expect(result.calls).toEqual([]);
    expect(result.malformed).toHaveLength(1);
    expect(result.malformed[0].reason).toBe('unknown_tool');
  });

  it('silently skips bare-object candidates that match no source', () => {
    const rejectAllSource: ToolSource<unknown> = {
      name: 'reject-all',
      detect: () => null,
    };
    const dispatcher = createToolDispatcher([rejectAllSource]);
    // Bare object outside a fence — should not generate a malformed
    // report even though no source claims it, to avoid noise from
    // prose-embedded `{...}` objects.
    const text = '{"tool":"mystery_tool","args":{}}';
    const result = dispatcher.detectAllToolCalls(text);
    expect(result.calls).toEqual([]);
    expect(result.malformed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Shape validation.
// ---------------------------------------------------------------------------

describe('createToolDispatcher — shape validation', () => {
  const dispatcher = createToolDispatcher([PASS_THROUGH_CLI_SOURCE]);

  it('rejects tool as non-string', () => {
    const text = '```json\n{"tool":42,"args":{}}\n```';
    const result = dispatcher.detectAllToolCalls(text);
    expect(result.calls).toEqual([]);
    // json_parse_error because repairToolJson runs on the parsed object
    // and its tool-key regex check fails — then the shape check fires
    // as missing_tool on the second attempt. Either is an acceptable
    // rejection; assert it's present in `malformed`.
    expect(result.malformed.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects args as non-object', () => {
    const text = '```json\n{"tool":"read_file","args":"oops"}\n```';
    const result = dispatcher.detectAllToolCalls(text);
    expect(result.calls).toEqual([]);
    expect(result.malformed[0]?.reason).toBe('missing_args_object');
  });

  it('rejects empty tool name', () => {
    const text = '```json\n{"tool":"","args":{}}\n```';
    const result = dispatcher.detectAllToolCalls(text);
    expect(result.calls).toEqual([]);
    expect(result.malformed[0]?.reason).toBe('missing_tool');
  });

  it('returns empty result for plain text', () => {
    const result = dispatcher.detectAllToolCalls('Hello, world!');
    expect(result.calls).toEqual([]);
    expect(result.malformed).toEqual([]);
  });

  it('returns empty result for empty input', () => {
    const result = dispatcher.detectAllToolCalls('');
    expect(result.calls).toEqual([]);
    expect(result.malformed).toEqual([]);
  });
});
