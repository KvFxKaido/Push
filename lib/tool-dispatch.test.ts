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

  it('REJECTS a single bare tool-call JSON object embedded in prose (documentation-example guard)', () => {
    // Prose-embedded single bare objects look identical to a
    // documentation example. The dispatcher rejects them so
    // describing a tool call in prose doesn't accidentally execute it.
    // A real missing-fence invocation either (a) is the whole
    // trimmed message, or (b) contains multiple sequential bare
    // objects — the two shapes the contiguity gate accepts.
    const text =
      'Let me read that file for you.\n\n{"tool":"read_file","args":{"path":"foo.txt"}}\n\nThat\'s the content.';
    const result = dispatcher.detectAllToolCalls(text);
    expect(result.calls).toEqual([]);
    expect(result.malformed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Codex P1 regressions: textual-order preservation and constrained
// bare-object fallback. These tests codify the review feedback from PR #303.
// ---------------------------------------------------------------------------

describe('createToolDispatcher — textual-order preservation', () => {
  const dispatcher = createToolDispatcher([PASS_THROUGH_CLI_SOURCE]);

  it('preserves the order of a bare object followed by a fenced object', () => {
    // A bare object appears first, a fenced object second. The old
    // two-phase dispatcher processed fenced first and emitted the
    // fenced call BEFORE the bare one, inverting the model's intent.
    // cli/engine.ts groups reads → mutations → side-effects based on
    // textual order, so the inversion could bucket calls into the
    // wrong phase.
    const text = [
      'json',
      '{"tool":"read_file","args":{"path":"first.txt"}}',
      '',
      '```json',
      '{"tool":"search_files","args":{"pattern":"TODO"}}',
      '```',
    ].join('\n');

    const result = dispatcher.detectAllToolCalls(text);
    expect(result.calls.map((c) => c.tool)).toEqual(['read_file', 'search_files']);
  });

  it('preserves the order of a fenced object followed by a bare object', () => {
    // Mirror case: fenced first, then two bare objects after the
    // fence closes. The dispatcher must keep the fenced call at
    // position 0 and the bare calls after it.
    const text = [
      '```json',
      '{"tool":"read_file","args":{"path":"alpha.txt"}}',
      '```',
      '',
      'json',
      '{"tool":"list_dir","args":{"path":"."}}',
      '{"tool":"git_status","args":{}}',
    ].join('\n');

    const result = dispatcher.detectAllToolCalls(text);
    expect(result.calls.map((c) => c.tool)).toEqual(['read_file', 'list_dir', 'git_status']);
  });
});

describe('createToolDispatcher — bare-object fallback is constrained', () => {
  const dispatcher = createToolDispatcher([PASS_THROUGH_CLI_SOURCE]);

  it('ignores tool-call-shaped JSON inside a non-tool fenced block (ts code example)', () => {
    // A `ts` fenced block contains an array literal whose elements
    // look like tool calls. The dispatcher must not mine the fence
    // interior for bare objects — phase 2 excludes every fenced
    // region regardless of language tag.
    const text = [
      "Here's how you'd batch-read files:",
      '',
      '```ts',
      'const examples = [',
      '  {"tool": "read_file", "args": {"path": "a.txt"}},',
      '  {"tool": "read_file", "args": {"path": "b.txt"}},',
      '];',
      '```',
      '',
      'That is the pattern.',
    ].join('\n');

    const result = dispatcher.detectAllToolCalls(text);
    expect(result.calls).toEqual([]);
    expect(result.malformed).toEqual([]);
  });

  it('ignores tool-call-shaped JSON inside a ```python fenced block', () => {
    const text = [
      '```python',
      'tool_call = {"tool": "write_file", "args": {"path": "out.txt", "content": "hi"}}',
      '```',
    ].join('\n');

    const result = dispatcher.detectAllToolCalls(text);
    expect(result.calls).toEqual([]);
  });

  it('ignores a single bare tool call surrounded by prose paragraphs', () => {
    const text = [
      'You can invoke the read_file tool like this:',
      '',
      '{"tool":"read_file","args":{"path":"foo.txt"}}',
      '',
      'The result will include the file contents.',
    ].join('\n');

    const result = dispatcher.detectAllToolCalls(text);
    expect(result.calls).toEqual([]);
  });

  it('ignores multiple bare tool calls separated by inline prose', () => {
    const text =
      'You can use {"tool":"read_file","args":{"path":"a"}} or {"tool":"write_file","args":{"path":"b","content":"x"}} here.';
    const result = dispatcher.detectAllToolCalls(text);
    expect(result.calls).toEqual([]);
  });

  it('still accepts the whole-message single-object case (old CLI fallback)', () => {
    const text = '{"tool":"exec","args":{"command":"ls"}}';
    const result = dispatcher.detectAllToolCalls(text);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].tool).toBe('exec');
  });

  it('still accepts multiple sequential bare objects with the missing-fence marker', () => {
    // The Gemini-3-flash failure mode, captured as a pinning test.
    const text = [
      'json',
      '{"tool":"list_dir","args":{"path":"."}}',
      '{"tool":"read_file","args":{"path":"ROADMAP.md"}}',
      '{"tool":"git_status","args":{}}',
    ].join('\n');

    const result = dispatcher.detectAllToolCalls(text);
    expect(result.calls.map((c) => c.tool)).toEqual(['list_dir', 'read_file', 'git_status']);
  });
});

// ---------------------------------------------------------------------------
// Copilot review: case-insensitive fence language tags.
// ---------------------------------------------------------------------------

describe('createToolDispatcher — case-insensitive fence tags', () => {
  const dispatcher = createToolDispatcher([PASS_THROUGH_CLI_SOURCE]);

  it('accepts an uppercase `JSON` language tag', () => {
    const text = '```JSON\n{"tool":"read_file","args":{"path":"foo.txt"}}\n```';
    const result = dispatcher.detectAllToolCalls(text);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].tool).toBe('read_file');
  });

  it('accepts a mixed-case `Json` language tag', () => {
    const text = '```Json\n{"tool":"exec","args":{"command":"pwd"}}\n```';
    const result = dispatcher.detectAllToolCalls(text);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].tool).toBe('exec');
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
    // `JSON.parse` succeeds on `{"tool":42,"args":{}}`, then
    // `shapeParsedObject` rejects it because `parsed.tool` is a
    // number, not a non-empty string. The malformed reason is
    // therefore `missing_tool`.
    expect(result.malformed[0]?.reason).toBe('missing_tool');
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
