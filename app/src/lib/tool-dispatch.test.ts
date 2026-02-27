import { describe, expect, it } from 'vitest';
import { detectAllToolCalls, diagnoseToolCallFailure, detectAnyToolCall } from './tool-dispatch';
import { repairToolJson, detectToolFromText } from './utils';

// ---------------------------------------------------------------------------
// repairToolJson — enhanced JSON repair
// ---------------------------------------------------------------------------

describe('repairToolJson', () => {
  it('repairs trailing commas', () => {
    const result = repairToolJson('{"tool": "sandbox_exec", "args": {"command": "ls",},}');
    expect(result).not.toBeNull();
    expect(result!.tool).toBe('sandbox_exec');
  });

  it('repairs double commas (model stutter)', () => {
    const result = repairToolJson('{"tool": "sandbox_exec",, "args": {"command": "ls"}}');
    expect(result).not.toBeNull();
    expect(result!.tool).toBe('sandbox_exec');
  });

  it('repairs single quotes when no double quotes present', () => {
    const result = repairToolJson("{'tool': 'sandbox_exec', 'args': {'command': 'ls'}}");
    expect(result).not.toBeNull();
    expect(result!.tool).toBe('sandbox_exec');
  });

  it('repairs unquoted keys', () => {
    const result = repairToolJson('{tool: "sandbox_exec", args: {"command": "ls"}}');
    expect(result).not.toBeNull();
    expect(result!.tool).toBe('sandbox_exec');
  });

  it('repairs Python-style True/False/None', () => {
    const result = repairToolJson('{"tool": "sandbox_exec", "args": {"command": "ls", "verbose": True, "timeout": None}}');
    expect(result).not.toBeNull();
    const args = result!.args as Record<string, unknown>;
    expect(args.verbose).toBe(true);
    expect(args.timeout).toBeNull();
  });

  it('does not replace True/False/None inside string values', () => {
    const result = repairToolJson('{"tool": "sandbox_exec", "args": {"command": "echo True False None"}}');
    expect(result).not.toBeNull();
    const args = result!.args as Record<string, unknown>;
    expect(args.command).toBe('echo True False None');
  });

  it('strips raw control characters', () => {
    const result = repairToolJson('{"tool": "sandbox_exec", "args": {"command": "ls\x01\x02"}}');
    expect(result).not.toBeNull();
    expect(result!.tool).toBe('sandbox_exec');
  });

  it('auto-closes truncated JSON with missing closing braces', () => {
    const result = repairToolJson('{"tool": "sandbox_exec", "args": {"command": "ls"}');
    expect(result).not.toBeNull();
    expect(result!.tool).toBe('sandbox_exec');
  });

  it('auto-closes truncated JSON with missing string close and braces', () => {
    const result = repairToolJson('{"tool": "sandbox_exec", "args": {"command": "ls -la');
    expect(result).not.toBeNull();
    expect(result!.tool).toBe('sandbox_exec');
  });

  it('does not auto-close non-tool JSON', () => {
    const result = repairToolJson('{"name": "foo", "value": 42');
    expect(result).toBeNull();
  });

  it('does not auto-close deeply nested truncation (> 3 depth)', () => {
    const result = repairToolJson('{"tool": "x", "a": {"b": {"c": {"d": {"e": "');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectToolFromText — fence variants
// ---------------------------------------------------------------------------

describe('detectToolFromText fence variants', () => {
  const validate = (parsed: unknown) => {
    const obj = parsed as Record<string, unknown>;
    return typeof obj?.tool === 'string' ? obj : null;
  };

  it('detects tool in triple-backtick JSON fence', () => {
    const text = '```json\n{"tool": "sandbox_exec", "args": {"command": "ls"}}\n```';
    const result = detectToolFromText(text, validate);
    expect(result).not.toBeNull();
    expect(result!.tool).toBe('sandbox_exec');
  });

  it('detects tool in tilde fence', () => {
    const text = '~~~json\n{"tool": "sandbox_exec", "args": {"command": "ls"}}\n~~~';
    const result = detectToolFromText(text, validate);
    expect(result).not.toBeNull();
    expect(result!.tool).toBe('sandbox_exec');
  });

  it('detects tool in 4+ backtick fence', () => {
    const text = '````json\n{"tool": "sandbox_exec", "args": {"command": "ls"}}\n````';
    const result = detectToolFromText(text, validate);
    expect(result).not.toBeNull();
    expect(result!.tool).toBe('sandbox_exec');
  });

  it('detects tool in fence with jsonc language hint', () => {
    const text = '```jsonc\n{"tool": "sandbox_exec", "args": {"command": "ls"}}\n```';
    const result = detectToolFromText(text, validate);
    expect(result).not.toBeNull();
    expect(result!.tool).toBe('sandbox_exec');
  });

  it('recovers JSON from prose-surrounded fenced content', () => {
    const text = '```json\nHere is the tool call:\n{"tool": "sandbox_exec", "args": {"command": "ls"}}\n```';
    const result = detectToolFromText(text, validate);
    expect(result).not.toBeNull();
    expect(result!.tool).toBe('sandbox_exec');
  });

  it('repairs garbled JSON inside fence', () => {
    const text = "```json\n{tool: 'sandbox_exec', args: {command: 'ls'}}\n```";
    const result = detectToolFromText(text, validate);
    expect(result).not.toBeNull();
    expect(result!.tool).toBe('sandbox_exec');
  });
});

// ---------------------------------------------------------------------------
// detectAnyToolCall — end-to-end resilience
// ---------------------------------------------------------------------------

describe('detectAnyToolCall resilience', () => {
  it('recovers tool call with trailing comma garbling', () => {
    const text = '```json\n{"tool": "sandbox_exec", "args": {"command": "npm test",}}\n```';
    const result = detectAnyToolCall(text);
    expect(result).not.toBeNull();
    expect(result!.source).toBe('sandbox');
  });

  it('recovers tool call with double commas', () => {
    const text = '```json\n{"tool": "sandbox_exec",, "args": {"command": "npm test"}}\n```';
    const result = detectAnyToolCall(text);
    expect(result).not.toBeNull();
    expect(result!.source).toBe('sandbox');
  });

  it('recovers tool call with Python-style booleans', () => {
    const text = '```json\n{"tool": "sandbox_write_file", "args": {"path": "/workspace/test.py", "content": "x=1", "create_dirs": True}}\n```';
    const result = detectAnyToolCall(text);
    expect(result).not.toBeNull();
    expect(result!.source).toBe('sandbox');
  });

  it('recovers tool call in tilde fence', () => {
    const text = '~~~\n{"tool": "sandbox_read_file", "args": {"path": "/workspace/main.ts"}}\n~~~';
    const result = detectAnyToolCall(text);
    expect(result).not.toBeNull();
    expect(result!.source).toBe('sandbox');
  });

  it('recovers tool call from prose-polluted fence', () => {
    const text = '```json\nI will read the file:\n{"tool": "sandbox_read_file", "args": {"path": "/workspace/main.ts"}}\n```';
    const result = detectAnyToolCall(text);
    expect(result).not.toBeNull();
    expect(result!.source).toBe('sandbox');
  });

  it('recovers truncated tool call via auto-close', () => {
    // Bare JSON (not fenced) with missing closing brace — extractBareToolJsonObjects
    // uses brace counting so this will be seen as incomplete. But detectToolFromText
    // uses repairToolJson which now has auto-close. Test it via a fenced block.
    const text = '```json\n{"tool": "sandbox_exec", "args": {"command": "ls"}\n```';
    const result = detectAnyToolCall(text);
    expect(result).not.toBeNull();
    expect(result!.source).toBe('sandbox');
  });
});

describe('diagnoseToolCallFailure natural language intent detection', () => {
  it('detects delegate intent phrased with coder agent', () => {
    const result = diagnoseToolCallFailure("I'll delegate this task to the coder agent now.");

    expect(result?.reason).toBe('natural_language_intent');
    expect(result?.toolName).toBe('delegate_coder');
    expect(result?.telemetryOnly).toBeUndefined();
  });

  it('does not flag explanatory prose as tool intent', () => {
    const result = diagnoseToolCallFailure(
      'The orchestrator may delegate this task to the coder agent when it is complex.'
    );

    expect(result).toBeNull();
  });
});

describe('detectAllToolCalls', () => {
  it('detects mixed explicit + bare read-only calls in one response', () => {
    const text = [
      '{"tool":"search_files","args":{"repo":"KvFxKaido/Push","query":"async function runConfigInit","path":"scripts/push/cli.mjs"}}',
      '{"repo":"KvFxKaido/Push","path":"scripts/push/cli.mjs","start_line":279,"end_line":349}',
    ].join('\n');

    const detected = detectAllToolCalls(text);
    expect(detected.readOnly).toHaveLength(2);
    expect(detected.mutating).toBeNull();
  });

  it('keeps trailing mutating call when there is exactly one read call', () => {
    const text = [
      '{"tool":"search_files","args":{"repo":"KvFxKaido/Push","query":"runConfigInit"}}',
      '{"message":"chore: update config command"}',
    ].join('\n');

    const detected = detectAllToolCalls(text);
    expect(detected.readOnly).toHaveLength(1);
    expect(detected.readOnly[0].source).toBe('github');
    expect(detected.mutating?.source).toBe('sandbox');
    if (detected.mutating?.source === 'sandbox') {
      expect(detected.mutating.call.tool).toBe('sandbox_prepare_commit');
    }
  });

  it('deduplicates wrapper and bare forms of the same call', () => {
    const text = [
      '{"tool":"read_file","args":{"repo":"KvFxKaido/Push","path":"scripts/push/cli.mjs","start_line":279,"end_line":349}}',
      '{"repo":"KvFxKaido/Push","path":"scripts/push/cli.mjs","start_line":279,"end_line":349}',
    ].join('\n');

    const detected = detectAllToolCalls(text);
    expect(detected.readOnly).toHaveLength(1);
    expect(detected.mutating).toBeNull();
  });

  it('deduplicates identical wrapper calls with reordered args keys', () => {
    const text = [
      '{"tool":"fetch_pr","args":{"repo":"KvFxKaido/Push","pr":105}}',
      '{"tool":"fetch_pr","args":{"pr":105,"repo":"KvFxKaido/Push"}}',
    ].join('\n');

    const detected = detectAllToolCalls(text);
    expect(detected.readOnly).toHaveLength(1);
    expect(detected.mutating).toBeNull();
  });

  it('deduplicates nested args regardless of key order', () => {
    const text = [
      '{"tool":"sandbox_exec","args":{"command":"npm test","cwd":"/workspace","timeout":120000}}',
      '{"tool":"sandbox_exec","args":{"timeout":120000,"cwd":"/workspace","command":"npm test"}}',
    ].join('\n');

    const detected = detectAllToolCalls(text);
    expect(detected.readOnly).toHaveLength(0);
    expect(detected.mutating?.source).toBe('sandbox');
    if (detected.mutating?.source === 'sandbox') {
      expect(detected.mutating.call.tool).toBe('sandbox_exec');
    }
  });

  it('truncates parallel reads to MAX instead of bailing', () => {
    // 8 read-only calls — should keep first 6, not bail entirely
    const calls = Array.from({ length: 8 }, (_, i) =>
      `{"tool":"sandbox_read_file","args":{"path":"/workspace/file${i}.ts"}}`
    );
    const text = calls.join('\n');

    const detected = detectAllToolCalls(text);
    expect(detected.readOnly).toHaveLength(6); // MAX_PARALLEL_TOOL_CALLS
    expect(detected.mutating).toBeNull();
  });

  it('keeps read prefix when mutation appears mid-sequence', () => {
    // [read, read, mutate, read] — should run first 2 reads + the mutation
    const text = [
      '{"tool":"sandbox_read_file","args":{"path":"/workspace/a.ts"}}',
      '{"tool":"sandbox_read_file","args":{"path":"/workspace/b.ts"}}',
      '{"tool":"sandbox_exec","args":{"command":"npm test"}}',
      '{"tool":"sandbox_read_file","args":{"path":"/workspace/c.ts"}}',
    ].join('\n');

    const detected = detectAllToolCalls(text);
    expect(detected.readOnly).toHaveLength(2);
    expect(detected.mutating).not.toBeNull();
    if (detected.mutating?.source === 'sandbox') {
      expect(detected.mutating.call.tool).toBe('sandbox_exec');
    }
  });

  it('stops at second mutation, keeping first mutation + preceding reads', () => {
    // [read, mutate, mutate] — should keep 1 read + first mutation
    const text = [
      '{"tool":"sandbox_read_file","args":{"path":"/workspace/a.ts"}}',
      '{"tool":"sandbox_exec","args":{"command":"npm test"}}',
      '{"tool":"sandbox_write_file","args":{"path":"/workspace/b.ts","content":"x"}}',
    ].join('\n');

    const detected = detectAllToolCalls(text);
    expect(detected.readOnly).toHaveLength(1);
    expect(detected.mutating).not.toBeNull();
    if (detected.mutating?.source === 'sandbox') {
      expect(detected.mutating.call.tool).toBe('sandbox_exec');
    }
  });
});

describe('diagnoseToolCallFailure arg hints', () => {
  it('includes expected format hint for known tools', () => {
    // A sandbox_exec call with wrong args structure that fails validation
    const text = '```json\n{"tool": "sandbox_exec", "args": {}}\n```';
    const result = diagnoseToolCallFailure(text);

    expect(result).not.toBeNull();
    expect(result!.reason).toBe('validation_failed');
    expect(result!.toolName).toBe('sandbox_exec');
    expect(result!.errorMessage).toContain('Expected format');
    expect(result!.errorMessage).toContain('"command"');
  });

  it('includes expected format hint for read_file', () => {
    const text = '```json\n{"tool": "read_file", "args": {}}\n```';
    const result = diagnoseToolCallFailure(text);

    expect(result).not.toBeNull();
    expect(result!.reason).toBe('validation_failed');
    expect(result!.toolName).toBe('read_file');
    expect(result!.errorMessage).toContain('Expected format');
    expect(result!.errorMessage).toContain('"repo"');
    expect(result!.errorMessage).toContain('"path"');
  });
});
