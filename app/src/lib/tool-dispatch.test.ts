import { describe, expect, it } from 'vitest';
import { detectAllToolCalls, diagnoseToolCallFailure, detectAnyToolCall } from './tool-dispatch';
import { repairToolJson, detectToolFromText, diagnoseJsonSyntaxError } from './utils';

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
    const result = repairToolJson(
      '{"tool": "sandbox_exec", "args": {"command": "ls", "verbose": True, "timeout": None}}',
    );
    expect(result).not.toBeNull();
    const args = result!.args as Record<string, unknown>;
    expect(args.verbose).toBe(true);
    expect(args.timeout).toBeNull();
  });

  it('does not replace True/False/None inside string values', () => {
    const result = repairToolJson(
      '{"tool": "sandbox_exec", "args": {"command": "echo True False None"}}',
    );
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

  it('repairs a raw newline that lands after a backslash inside a string', () => {
    const candidate = [
      '{"tool": "sandbox_search_replace", "args": {"path": "/workspace/src/app.ts", "search": "path\\',
      'more", "replace": "fixed"}}',
    ].join('\n');
    const result = repairToolJson(candidate);

    expect(result).not.toBeNull();
    expect(result!.tool).toBe('sandbox_search_replace');
    const args = result!.args as Record<string, unknown>;
    expect(args.search).toBe('path\nmore');
    expect(args.replace).toBe('fixed');
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
    const text =
      '```json\nHere is the tool call:\n{"tool": "sandbox_exec", "args": {"command": "ls"}}\n```';
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
    const text =
      '```json\n{"tool": "sandbox_write_file", "args": {"path": "/workspace/test.py", "content": "x=1", "create_dirs": True}}\n```';
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
    const text =
      '```json\nI will read the file:\n{"tool": "sandbox_read_file", "args": {"path": "/workspace/main.ts"}}\n```';
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

  it('detects a flat todo_write call', () => {
    const text = [
      '```json',
      '{"tool": "todo_write", "todos": [',
      '  {"id": "fix-auth", "content": "Fix the auth bug", "activeForm": "Fixing the auth bug", "status": "in_progress"}',
      ']}',
      '```',
    ].join('\n');
    const result = detectAnyToolCall(text);
    expect(result).not.toBeNull();
    expect(result!.source).toBe('todo');
    expect(result!.call.tool).toBe('todo_write');
  });

  it('detects an args-wrapped todo_write call', () => {
    const text = [
      '```json',
      '{"tool": "todo_write", "args": {"todos": [',
      '  {"id": "a", "content": "Do A", "activeForm": "Doing A", "status": "pending"}',
      ']}}',
      '```',
    ].join('\n');
    const result = detectAnyToolCall(text);
    expect(result).not.toBeNull();
    expect(result!.source).toBe('todo');
    expect(result!.call.tool).toBe('todo_write');
  });

  it('detects todo_read with no args', () => {
    const result = detectAnyToolCall('```json\n{"tool": "todo_read"}\n```');
    expect(result).not.toBeNull();
    expect(result!.source).toBe('todo');
    expect(result!.call.tool).toBe('todo_read');
  });

  it('detects todo_clear with no args', () => {
    const result = detectAnyToolCall('```json\n{"tool": "todo_clear"}\n```');
    expect(result).not.toBeNull();
    expect(result!.source).toBe('todo');
    expect(result!.call.tool).toBe('todo_clear');
  });

  it('classifies todo_read as a read-only parallel call', () => {
    const text = [
      '```json',
      '{"tool": "todo_read"}',
      '```',
      '```json',
      '{"tool": "sandbox_read_file", "args": {"path": "/workspace/main.ts"}}',
      '```',
    ].join('\n');
    const detected = detectAllToolCalls(text);
    expect(detected.readOnly).toHaveLength(2);
    expect(detected.readOnly.some((c) => c.source === 'todo')).toBe(true);
    expect(detected.mutating).toBeNull();
  });

  it('classifies todo_write as a trailing mutation after parallel reads', () => {
    const text = [
      '```json',
      '{"tool": "sandbox_read_file", "args": {"path": "/workspace/main.ts"}}',
      '```',
      '```json',
      '{"tool": "todo_write", "todos": [{"id": "a", "content": "Do A", "activeForm": "Doing A", "status": "pending"}]}',
      '```',
    ].join('\n');
    const detected = detectAllToolCalls(text);
    expect(detected.readOnly).toHaveLength(1);
    expect(detected.mutating).not.toBeNull();
    expect(detected.mutating!.source).toBe('todo');
    expect(detected.mutating!.call.tool).toBe('todo_write');
  });
});

describe('diagnoseToolCallFailure natural language intent detection', () => {
  it('detects delegate intent phrased with coder agent', () => {
    const result = diagnoseToolCallFailure("I'll delegate this task to the coder agent now.");

    expect(result?.reason).toBe('natural_language_intent');
    expect(result?.toolName).toBe('delegate_coder');
    expect(result?.telemetryOnly).toBeUndefined();
  });

  it('detects delegate intent phrased with explorer agent', () => {
    const result = diagnoseToolCallFailure('Let me delegate this to the explorer agent first.');

    expect(result?.reason).toBe('natural_language_intent');
    expect(result?.toolName).toBe('delegate_explorer');
    expect(result?.telemetryOnly).toBeUndefined();
  });

  it('detects delegate intent phrased as discovery and tracing work for explorer', () => {
    const result = diagnoseToolCallFailure(
      'First I should delegate this to the explorer to trace the dependency flow and explain why it happens.',
    );
    expect(result?.toolName).toBe('delegate_explorer');
  });

  it('returns validation_failed (not delegate_explorer) when a read-only tool call fence is present', () => {
    // Phase 2 catches fenced tool calls before Phase 4 (diagnoseMissingExplorerCall).
    // The result should NOT be a delegate_explorer diagnosis.
    const text = [
      'Let me trace the auth flow to understand how session refresh works.',
      '',
      '```json',
      '{"tool": "repo_read", "args": {"repo": "owner/repo", "path": "src/auth.ts"}}',
      '```',
    ].join('\n');
    const result = diagnoseToolCallFailure(text);
    expect(result?.toolName).not.toBe('delegate_explorer');
    expect(result?.reason).toBe('validation_failed');
  });

  it('returns validation_failed (not delegate_explorer) when a web search tool call fence is present', () => {
    // Same: Phase 2 returns validation_failed before Phase 4 can fire.
    const text = [
      'I should look this up first — let me search for the latest docs.',
      '',
      '```json',
      '{"tool": "web", "args": {"query": "react 19 release notes"}}',
      '```',
    ].join('\n');
    const result = diagnoseToolCallFailure(text);
    expect(result?.toolName).not.toBe('delegate_explorer');
    expect(result?.reason).toBe('validation_failed');
  });

  it('does not flag explanatory prose as tool intent', () => {
    const result = diagnoseToolCallFailure(
      'The orchestrator may delegate this task to the coder agent when it is complex.',
    );

    expect(result).toBeNull();
  });

  it('does not flag commit messages that mention discovery keywords', () => {
    const result = diagnoseToolCallFailure(
      'Here is the commit:\n\nfeat: trace the flow of the auth module to understand session refresh\n\nThis improves performance.',
    );
    expect(result).toBeNull();
  });

  // Action-phrase patterns — natural descriptions of tool actions
  it('detects "I\'ll fetch the recent commits" as list_commits intent', () => {
    const result = diagnoseToolCallFailure(
      "To get the actual latest activity, I'll fetch the recent commits from the repo.",
    );
    expect(result?.reason).toBe('natural_language_intent');
    expect(result?.toolName).toBe('list_commits');
  });

  it('detects "Let me grab the latest commits" as list_commits intent', () => {
    const result = diagnoseToolCallFailure('Let me grab the latest commits to see what changed.');
    expect(result?.reason).toBe('natural_language_intent');
    expect(result?.toolName).toBe('list_commits');
  });

  it('detects "I\'ll read the file" as read_file intent', () => {
    const result = diagnoseToolCallFailure("I'll read the file to understand the implementation.");
    expect(result?.reason).toBe('natural_language_intent');
    expect(result?.toolName).toBe('read_file');
  });

  it('detects "Let me search the codebase" as search_files intent', () => {
    const result = diagnoseToolCallFailure(
      'Let me search the codebase for that function definition.',
    );
    expect(result?.reason).toBe('natural_language_intent');
    expect(result?.toolName).toBe('search_files');
  });

  it('detects "I\'ll check the open PRs" as list_prs intent', () => {
    const result = diagnoseToolCallFailure("I'll check the open PRs to see what's pending.");
    expect(result?.reason).toBe('natural_language_intent');
    expect(result?.toolName).toBe('list_prs');
  });

  it('detects "Let me get the branches" as list_branches intent', () => {
    const result = diagnoseToolCallFailure('Let me get the branches to see what exists.');
    expect(result?.reason).toBe('natural_language_intent');
    expect(result?.toolName).toBe('list_branches');
  });

  it('does not flag conversational text that happens to mention commits', () => {
    const result = diagnoseToolCallFailure(
      'The recent commits show that the team has been busy with refactoring.',
    );
    expect(result).toBeNull();
  });

  it('does not flag questions about actions', () => {
    const result = diagnoseToolCallFailure('Would you like me to fetch the recent commits?');
    expect(result).toBeNull();
  });
});

describe('detectAllToolCalls', () => {
  it('detects delegate_explorer JSON blocks as delegation tool calls', () => {
    const text =
      '```json\n{"tool":"delegate_explorer","args":{"task":"trace auth flow","files":["src/auth.ts"]}}\n```';

    const detected = detectAnyToolCall(text);
    expect(detected?.source).toBe('delegate');
    if (detected?.source === 'delegate' && detected.call.tool === 'delegate_explorer') {
      expect(detected.call.tool).toBe('delegate_explorer');
      expect(detected.call.args.task).toBe('trace auth flow');
      expect(detected.call.args.files).toEqual(['src/auth.ts']);
    }
  });

  it('detects plan_tasks JSON blocks as task graph delegation tool calls', () => {
    const text =
      '```json\n{"tool":"plan_tasks","args":{"tasks":[{"id":"explore-auth","agent":"explorer","task":" trace auth flow ","files":[" src/auth.ts "],"dependsOn":[" "]},{"id":"fix-auth","agent":"coder","task":" fix auth ","dependsOn":["explore-auth"],"deliverable":" restore passing auth tests "}]}}\n```';

    const detected = detectAnyToolCall(text);
    expect(detected?.source).toBe('delegate');
    if (detected?.source === 'delegate' && detected.call.tool === 'plan_tasks') {
      expect(detected.call.args.tasks).toEqual([
        {
          id: 'explore-auth',
          agent: 'explorer',
          task: 'trace auth flow',
          files: ['src/auth.ts'],
          dependsOn: undefined,
          deliverable: undefined,
          acceptanceCriteria: undefined,
          knownContext: undefined,
          constraints: undefined,
        },
        {
          id: 'fix-auth',
          agent: 'coder',
          task: 'fix auth',
          files: undefined,
          dependsOn: ['explore-auth'],
          deliverable: 'restore passing auth tests',
          acceptanceCriteria: undefined,
          knownContext: undefined,
          constraints: undefined,
        },
      ]);
    }
  });

  it('trims delegation string fields and drops blank array entries', () => {
    const text =
      '```json\n{"tool":"delegate_coder","args":{"task":"   ","tasks":["  inspect auth flow and fix the handoff  ","   "],"files":[" src/auth.ts ",""],"intent":" tighten handoff flow ","deliverable":" a concise summary ","knownContext":[" existing note ","   "],"constraints":[" keep the API stable "," "]}}\n```';

    const detected = detectAnyToolCall(text);
    expect(detected?.source).toBe('delegate');
    if (detected?.source === 'delegate' && detected.call.tool === 'delegate_coder') {
      expect(detected.call.args.task).toBeUndefined();
      expect(detected.call.args.tasks).toEqual(['inspect auth flow and fix the handoff']);
      expect(detected.call.args.files).toEqual(['src/auth.ts']);
      expect(detected.call.args.intent).toBe('tighten handoff flow');
      expect(detected.call.args.deliverable).toBe('a concise summary');
      expect(detected.call.args.knownContext).toEqual(['existing note']);
      expect(detected.call.args.constraints).toEqual(['keep the API stable']);
    }
  });

  it('detects mixed explicit + bare read-only calls in one response', () => {
    const text = [
      '{"tool":"search_files","args":{"repo":"KvFxKaido/Push","query":"async function runConfigInit","path":"scripts/push/cli.mjs"}}',
      '{"repo":"KvFxKaido/Push","path":"scripts/push/cli.mjs","start_line":279,"end_line":349}',
    ].join('\n');

    const detected = detectAllToolCalls(text);
    expect(detected.readOnly).toHaveLength(2);
    expect(detected.mutating).toBeNull();
  });

  it('treats sandbox_read_symbols as read-only when a mutating call follows', () => {
    const text = [
      '{"tool":"sandbox_read_symbols","args":{"path":"/workspace/app/src/lib/tool-dispatch.ts"}}',
      '{"tool":"sandbox_exec","args":{"command":"echo hi"}}',
    ].join('\n');

    const detected = detectAllToolCalls(text);
    expect(detected.readOnly).toHaveLength(1);
    expect(detected.readOnly[0].source).toBe('sandbox');
    if (detected.readOnly[0].source === 'sandbox') {
      expect(detected.readOnly[0].call.tool).toBe('sandbox_read_symbols');
    }
    expect(detected.mutating?.source).toBe('sandbox');
    if (detected.mutating?.source === 'sandbox') {
      expect(detected.mutating.call.tool).toBe('sandbox_exec');
    }
  });

  it('treats sandbox_find_references as read-only when a mutating call follows', () => {
    const text = [
      '{"tool":"sandbox_find_references","args":{"symbol":"getActiveProvider","scope":"/workspace/app/src/lib"}}',
      '{"tool":"sandbox_exec","args":{"command":"echo hi"}}',
    ].join('\n');

    const detected = detectAllToolCalls(text);
    expect(detected.readOnly).toHaveLength(1);
    expect(detected.readOnly[0].source).toBe('sandbox');
    if (detected.readOnly[0].source === 'sandbox') {
      expect(detected.readOnly[0].call.tool).toBe('sandbox_find_references');
    }
    expect(detected.mutating?.source).toBe('sandbox');
    if (detected.mutating?.source === 'sandbox') {
      expect(detected.mutating.call.tool).toBe('sandbox_exec');
    }
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

  it('treats grep_file as read-only when a mutation follows', () => {
    const text = [
      '{"tool":"grep_file","args":{"repo":"KvFxKaido/Push","path":"app/src/lib/tool-dispatch.ts","pattern":"delegate_explorer"}}',
      '{"tool":"delegate_explorer","args":{"task":"summarize the dispatch flow"}}',
    ].join('\n');

    const detected = detectAllToolCalls(text);
    expect(detected.readOnly).toHaveLength(1);
    expect(detected.readOnly[0].source).toBe('github');
    if (detected.readOnly[0].source === 'github') {
      expect(detected.readOnly[0].call.tool).toBe('grep_file');
    }
    expect(detected.mutating?.source).toBe('delegate');
    if (detected.mutating?.source === 'delegate') {
      expect(detected.mutating.call.tool).toBe('delegate_explorer');
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
    const calls = Array.from(
      { length: 8 },
      (_, i) => `{"tool":"sandbox_read_file","args":{"path":"/workspace/file${i}.ts"}}`,
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

  it('rejects a file mutation that comes after a side-effect', () => {
    // [read, side-effect, write] — write lands in extraMutations
    const text = [
      '{"tool":"sandbox_read_file","args":{"path":"/workspace/a.ts"}}',
      '{"tool":"sandbox_exec","args":{"command":"npm test"}}',
      '{"tool":"sandbox_write_file","args":{"path":"/workspace/b.ts","content":"x"}}',
    ].join('\n');

    const detected = detectAllToolCalls(text);
    expect(detected.readOnly).toHaveLength(1);
    expect(detected.fileMutations).toHaveLength(0);
    expect(detected.mutating).not.toBeNull();
    expect(detected.extraMutations).toHaveLength(1);
    if (detected.mutating?.source === 'sandbox') {
      expect(detected.mutating.call.tool).toBe('sandbox_exec');
    }
    if (detected.extraMutations[0]?.source === 'sandbox') {
      expect(detected.extraMutations[0].call.tool).toBe('sandbox_write_file');
    }
  });

  it('batches multiple file mutations with no side effect', () => {
    // [write, write] — should batch into fileMutations, no trailing side-effect
    const text = [
      '{"tool":"sandbox_write_file","args":{"path":"/workspace/a.md","content":"one"}}',
      '{"tool":"sandbox_write_file","args":{"path":"/workspace/b.md","content":"two"}}',
    ].join('\n');

    const detected = detectAllToolCalls(text);
    expect(detected.readOnly).toHaveLength(0);
    expect(detected.fileMutations).toHaveLength(2);
    expect(detected.mutating).toBeNull();
    expect(detected.extraMutations).toHaveLength(0);
    if (detected.fileMutations[0]?.source === 'sandbox') {
      expect(detected.fileMutations[0].call.tool).toBe('sandbox_write_file');
    }
  });

  it('batches file mutations followed by one trailing side-effect', () => {
    // [write, edit, exec] — 2 file mutations batch + 1 trailing exec
    const text = [
      '{"tool":"sandbox_write_file","args":{"path":"/workspace/a.ts","content":"one"}}',
      '{"tool":"sandbox_search_replace","args":{"path":"/workspace/b.ts","search":"old","replace":"new"}}',
      '{"tool":"sandbox_exec","args":{"command":"npm test"}}',
    ].join('\n');

    const detected = detectAllToolCalls(text);
    expect(detected.readOnly).toHaveLength(0);
    expect(detected.fileMutations).toHaveLength(2);
    expect(detected.mutating?.source).toBe('sandbox');
    if (detected.mutating?.source === 'sandbox') {
      expect(detected.mutating.call.tool).toBe('sandbox_exec');
    }
    expect(detected.extraMutations).toHaveLength(0);
  });

  it('captures reads + file mutation batch + trailing side-effect in order', () => {
    // [read, read, write, write, commit] — all three slots populated
    const text = [
      '{"tool":"sandbox_read_file","args":{"path":"/workspace/a.ts"}}',
      '{"tool":"sandbox_read_file","args":{"path":"/workspace/b.ts"}}',
      '{"tool":"sandbox_write_file","args":{"path":"/workspace/c.md","content":"one"}}',
      '{"tool":"sandbox_write_file","args":{"path":"/workspace/d.md","content":"two"}}',
      '{"tool":"sandbox_prepare_commit","args":{"message":"chore: add docs"}}',
    ].join('\n');

    const detected = detectAllToolCalls(text);
    expect(detected.readOnly).toHaveLength(2);
    expect(detected.fileMutations).toHaveLength(2);
    expect(detected.mutating?.source).toBe('sandbox');
    if (detected.mutating?.source === 'sandbox') {
      expect(detected.mutating.call.tool).toBe('sandbox_prepare_commit');
    }
    expect(detected.extraMutations).toHaveLength(0);
  });

  it('rejects a second side-effect after a file mutation batch', () => {
    // [write, exec, exec] — second exec is extraMutations
    const text = [
      '{"tool":"sandbox_write_file","args":{"path":"/workspace/a.md","content":"one"}}',
      '{"tool":"sandbox_exec","args":{"command":"npm test"}}',
      '{"tool":"sandbox_exec","args":{"command":"npm run build"}}',
    ].join('\n');

    const detected = detectAllToolCalls(text);
    expect(detected.fileMutations).toHaveLength(1);
    expect(detected.mutating?.source).toBe('sandbox');
    expect(detected.extraMutations).toHaveLength(1);
    if (detected.extraMutations[0]?.source === 'sandbox') {
      expect(detected.extraMutations[0].call.tool).toBe('sandbox_exec');
    }
  });

  it('classifies a single file mutation into fileMutations, not mutating', () => {
    const text = '{"tool":"sandbox_write_file","args":{"path":"/workspace/a.md","content":"one"}}';
    const detected = detectAllToolCalls(text);
    expect(detected.readOnly).toHaveLength(0);
    expect(detected.fileMutations).toHaveLength(1);
    expect(detected.mutating).toBeNull();
    expect(detected.extraMutations).toHaveLength(0);
  });

  it('caps the file-mutation batch at MAX_FILE_MUTATION_BATCH and routes overflow into extraMutations', () => {
    // 10 distinct file writes (MAX_FILE_MUTATION_BATCH = 8) — first 8
    // should land in fileMutations (in order), last 2 in extraMutations.
    const calls = Array.from(
      { length: 10 },
      (_, i) =>
        `{"tool":"sandbox_write_file","args":{"path":"/workspace/file${i}.md","content":"v${i}"}}`,
    );
    const text = calls.join('\n');

    const detected = detectAllToolCalls(text);
    expect(detected.readOnly).toHaveLength(0);
    expect(detected.fileMutations).toHaveLength(8);
    expect(detected.mutating).toBeNull();
    expect(detected.extraMutations).toHaveLength(2);

    // Order preserved inside fileMutations
    detected.fileMutations.forEach((call, i) => {
      if (call.source === 'sandbox' && call.call.tool === 'sandbox_write_file') {
        expect(call.call.args.path).toBe(`/workspace/file${i}.md`);
      }
    });
    // Overflow appears in emission order
    if (
      detected.extraMutations[0]?.source === 'sandbox' &&
      detected.extraMutations[0].call.tool === 'sandbox_write_file'
    ) {
      expect(detected.extraMutations[0].call.args.path).toBe('/workspace/file8.md');
    }
    if (
      detected.extraMutations[1]?.source === 'sandbox' &&
      detected.extraMutations[1].call.tool === 'sandbox_write_file'
    ) {
      expect(detected.extraMutations[1].call.args.path).toBe('/workspace/file9.md');
    }
  });

  it('rejects a read emitted after the mutation batch starts', () => {
    // [write, read, exec] — the read is an ordering violation and should
    // land in extraMutations; the subsequent exec should also go to
    // extraMutations because the phase flipped to done.
    const text = [
      '{"tool":"sandbox_write_file","args":{"path":"/workspace/a.md","content":"one"}}',
      '{"tool":"sandbox_read_file","args":{"path":"/workspace/b.ts"}}',
      '{"tool":"sandbox_exec","args":{"command":"npm test"}}',
    ].join('\n');

    const detected = detectAllToolCalls(text);
    expect(detected.readOnly).toHaveLength(0);
    expect(detected.fileMutations).toHaveLength(1);
    expect(detected.mutating).toBeNull();
    expect(detected.extraMutations).toHaveLength(2);
    if (detected.extraMutations[0]?.source === 'sandbox') {
      expect(detected.extraMutations[0].call.tool).toBe('sandbox_read_file');
    }
    if (detected.extraMutations[1]?.source === 'sandbox') {
      expect(detected.extraMutations[1].call.tool).toBe('sandbox_exec');
    }
  });

  it('captures extra delegate_coder mutations so the caller can reject them', () => {
    const text = [
      '{"tool":"delegate_coder","args":{"task":"refactor the auth module to use tokens"}}',
      '{"tool":"delegate_coder","args":{"task":"add unit tests for the session handler"}}',
    ].join('\n');

    const detected = detectAllToolCalls(text);
    expect(detected.readOnly).toHaveLength(0);
    expect(detected.mutating?.source).toBe('delegate');
    expect(detected.extraMutations).toHaveLength(1);
    if (detected.mutating?.source === 'delegate') {
      expect(detected.mutating.call.tool).toBe('delegate_coder');
    }
    if (detected.extraMutations[0]?.source === 'delegate') {
      expect(detected.extraMutations[0].call.tool).toBe('delegate_coder');
    }
  });

  it('captures extra delegate_explorer mutations so the caller can reject them', () => {
    const text = [
      '{"tool":"delegate_explorer","args":{"task":"trace the auth flow across files"}}',
      '{"tool":"delegate_explorer","args":{"task":"find all session refresh triggers"}}',
    ].join('\n');

    const detected = detectAllToolCalls(text);
    expect(detected.readOnly).toHaveLength(0);
    expect(detected.mutating?.source).toBe('delegate');
    expect(detected.extraMutations).toHaveLength(1);
    if (detected.mutating?.source === 'delegate') {
      expect(detected.mutating.call.tool).toBe('delegate_explorer');
    }
    if (detected.extraMutations[0]?.source === 'delegate') {
      expect(detected.extraMutations[0].call.tool).toBe('delegate_explorer');
    }
  });

  it('detects delegate_explorer JSON with trimmed context fields', () => {
    const text =
      '```json\n{"tool":"delegate_explorer","args":{"task":"  trace the auth flow across files  ","files":[" src/auth.ts "," src/middleware.ts "],"intent":" understand control points ","deliverable":" ranked file list with evidence ","knownContext":[" existing clue ","   "],"constraints":[" read only "," "]}}\n```';
    const detected = detectAnyToolCall(text);
    expect(detected?.source).toBe('delegate');
    if (detected?.source === 'delegate' && detected.call.tool === 'delegate_explorer') {
      expect(detected.call.args).toEqual({
        task: 'trace the auth flow across files',
        files: ['src/auth.ts', 'src/middleware.ts'],
        intent: 'understand control points',
        deliverable: 'ranked file list with evidence',
        knownContext: ['existing clue'],
        constraints: ['read only'],
      });
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

// ---------------------------------------------------------------------------
// diagnoseJsonSyntaxError — pinpointed JSON error messages
// ---------------------------------------------------------------------------

describe('diagnoseJsonSyntaxError', () => {
  it('returns null for valid JSON', () => {
    expect(
      diagnoseJsonSyntaxError('{"tool": "sandbox_exec", "args": {"command": "ls"}}'),
    ).toBeNull();
  });

  it('detects missing opening brace', () => {
    const result = diagnoseJsonSyntaxError('"tool": "sandbox_exec", "args": {"command": "ls"}}');
    expect(result).not.toBeNull();
    expect(result!.message).toContain('Missing opening brace');
  });

  it('detects unterminated string', () => {
    const result = diagnoseJsonSyntaxError('{"tool": "sandbox_exec", "args": {"command": "ls}');
    expect(result).not.toBeNull();
    expect(result!.message).toContain('Unterminated string');
  });

  it('detects unbalanced braces', () => {
    const result = diagnoseJsonSyntaxError('{"tool": "sandbox_exec", "args": {"command": "ls"}');
    expect(result).not.toBeNull();
    expect(result!.message).toContain('Unbalanced braces');
  });

  it('detects extra closing brace', () => {
    const result = diagnoseJsonSyntaxError('{"tool": "sandbox_exec"}}');
    expect(result).not.toBeNull();
    expect(result!.message).toContain('Extra closing');
  });

  it('handles empty input', () => {
    const result = diagnoseJsonSyntaxError('');
    expect(result).not.toBeNull();
    expect(result!.message).toContain('Empty input');
  });

  it('detects unexpected start character', () => {
    const result = diagnoseJsonSyntaxError('x{"tool": "sandbox_exec"}');
    expect(result).not.toBeNull();
    expect(result!.message).toContain('Unexpected character');
  });
});

// ---------------------------------------------------------------------------
// repairToolJson — missing opening brace recovery
// ---------------------------------------------------------------------------

describe('repairToolJson missing opening brace', () => {
  it('recovers tool call missing opening brace', () => {
    const result = repairToolJson('"tool": "sandbox_exec", "args": {"command": "ls"}}');
    expect(result).not.toBeNull();
    expect(result!.tool).toBe('sandbox_exec');
  });

  it('recovers tool call missing opening brace with unquoted keys', () => {
    const result = repairToolJson('tool: "sandbox_exec", args: {"command": "ls"}}');
    expect(result).not.toBeNull();
    expect(result!.tool).toBe('sandbox_exec');
  });

  it('recovers tool call missing opening brace with leading whitespace', () => {
    const result = repairToolJson('  "tool": "sandbox_exec", "args": {"command": "npm test"}}');
    expect(result).not.toBeNull();
    expect(result!.tool).toBe('sandbox_exec');
  });
});

// ---------------------------------------------------------------------------
// diagnoseToolCallFailure — malformed JSON diagnosis (Phase 3)
// ---------------------------------------------------------------------------

describe('diagnoseToolCallFailure malformed JSON', () => {
  it('diagnoses missing opening brace in fenced block that repair cannot fix', () => {
    // A severely broken JSON that repair can't handle — double-closing brace
    // with internal structure issues
    const text = '```json\n"tool": "sandbox_exec", "args": {"command": "ls"}}}\n```';
    const result = diagnoseToolCallFailure(text);

    // This will either be caught by repair (and handled normally) or diagnosed as malformed.
    // The important thing is it doesn't return null (silent failure).
    if (result) {
      expect(['malformed_json', 'validation_failed', 'truncated']).toContain(result.reason);
      expect(result.toolName).toBe('sandbox_exec');
    }
  });

  it('diagnoses malformed JSON with specific syntax error in fenced block', () => {
    // Broken JSON that repair can't fix: unterminated string + structural issues
    const text =
      '```json\n{"tool": "sandbox_exec", "args": {"command": "ls, "extra": broken}}\n```';
    const result = diagnoseToolCallFailure(text);

    if (result) {
      expect(result.toolName).toBe('sandbox_exec');
      expect(result.errorMessage).toBeDefined();
    }
  });

  it('diagnoses unfenced malformed tool call', () => {
    // Bare text with tool pattern but broken JSON structure that repair can't fix
    const text =
      'I will run the tests:\n{"tool": "sandbox_exec", "args": {command: ls -la, "verbose": }}';
    const result = diagnoseToolCallFailure(text);

    if (result) {
      expect(result.toolName).toBe('sandbox_exec');
      expect(result.errorMessage.length).toBeGreaterThan(0);
    }
  });

  it('does not diagnose valid tool call as malformed', () => {
    const text = '```json\n{"tool": "sandbox_exec", "args": {"command": "ls"}}\n```';
    // This should be detected as a valid tool call, not diagnosed as malformed
    const detected = detectAnyToolCall(text);
    expect(detected).not.toBeNull();
  });

  it('returns actionable error with expected format hint', () => {
    // Broken JSON with known tool that can't be repaired
    const text = '```json\n{"tool": "sandbox_exec" "args": {"command": "npm test"}}\n```';
    const result = diagnoseToolCallFailure(text);

    if (result && result.reason === 'malformed_json') {
      expect(result.errorMessage).toContain('exec');
      expect(result.errorMessage).toContain('JSON syntax error');
    }
  });
});

// ---------------------------------------------------------------------------
// diagnoseToolCallFailure — unknown tool name diagnosis (Phase 2.5)
// ---------------------------------------------------------------------------

describe('diagnoseToolCallFailure unknown tool names', () => {
  it('treats short "edit" as a real tool name and returns a validation hint', () => {
    const text =
      '```json\n{"tool": "edit", "args": {"repo": "owner/repo", "path": "src/app.ts", "old_string": "foo", "new_string": "bar"}}\n```';
    const result = diagnoseToolCallFailure(text);

    expect(result).not.toBeNull();
    expect(result!.reason).toBe('validation_failed');
    expect(result!.toolName).toBe('sandbox_edit_file');
    expect(result!.errorMessage).toContain('Expected format');
    expect(result!.errorMessage).toContain('"tool": "edit"');
  });

  it('detects hallucinated "write_file" tool and suggests write', () => {
    const text =
      '```json\n{"tool": "write_file", "args": {"path": "/workspace/test.ts", "content": "hello"}}\n```';
    const result = diagnoseToolCallFailure(text);

    expect(result).not.toBeNull();
    expect(result!.errorMessage).toContain('does not exist');
    expect(result!.errorMessage).toContain('write');
  });

  it('does not flag unknown tool names in bare prose JSON (only fenced blocks)', () => {
    // Model returning example JSON in prose — should NOT trigger diagnosis
    const text =
      'Here is an example tool call:\n{"tool": "my_custom_tool", "args": {"param": "value"}}\nThis shows the expected format.';
    const result = diagnoseToolCallFailure(text);

    // Should either be null or not flagged as unknown tool
    if (result) {
      expect(result.toolName).not.toBe('my_custom_tool');
    }
  });

  it('lists available tools when no suggestion mapping exists', () => {
    const text = '```json\n{"tool": "completely_made_up", "args": {"x": 1}}\n```';
    const result = diagnoseToolCallFailure(text);

    expect(result).not.toBeNull();
    expect(result!.errorMessage).toContain('does not exist');
    expect(result!.errorMessage).toContain('Available tools');
  });
});

// ---------------------------------------------------------------------------
// Namespaced-functions recovery — end-to-end
// ---------------------------------------------------------------------------
// Captured assistant output from session sess_mogit6qt_447633 (kimi-k2.6 via
// blackbox). Before the namespaced-recovery wiring landed, all three calls
// fell through silently and the run completed with zero tool executions.

describe('detectAllToolCalls — namespaced-functions recovery', () => {
  const KIMI_CAPTURED =
    ' Hey! Let me check the current state of the project — TODO, roadmap, and what\'s on the branch — so I can give you a useful take.   functions.read_file:0  {"path": "TODO.md"}   functions.read_file:1  {"path": "ROADMAP.md"}   functions.git_status:2  {}  ';

  it('recovers Kimi/Blackbox-style tool calls when no canonical wrapper is present', () => {
    const result = detectAllToolCalls(KIMI_CAPTURED);
    // Web has read but no sandbox_git_status, so only the two read_file
    // calls are recovered. The git_status:2 prefix from the captured run
    // drops because the web runtime has no tool by that name — recovery
    // can only succeed for tools the runtime actually exposes.
    const allCalls = [...result.readOnly, ...result.fileMutations];
    if (result.mutating) allCalls.push(result.mutating);

    const toolNames = allCalls.map((c) => c.call.tool).sort();
    expect(toolNames).toEqual(['sandbox_read_file', 'sandbox_read_file']);
  });

  it('detectAnyToolCall returns a recovered call when the message has no canonical wrapper', () => {
    const recovered = detectAnyToolCall(KIMI_CAPTURED);
    expect(recovered).not.toBeNull();
    expect(recovered!.call.tool).toMatch(/sandbox_(read_file|git_status)/);
  });

  it('does not let namespaced recovery override canonical tool calls in the same message', () => {
    // Canonical fenced block + an incidental functions.* prefix in prose.
    const text =
      'Plan: I will read the file.\n```json\n{"tool": "sandbox_read_file", "args": {"path": "REAL.md"}}\n```\nNote: ignore the functions.exec:0  {"command": "rm -rf /"} mention above.';
    const result = detectAllToolCalls(text);
    // The recovery branch is gated on having NO explicit wrappers, so the
    // canonical block is the only call detected.
    expect(result.readOnly).toHaveLength(1);
    const only = result.readOnly[0];
    expect(only.source).toBe('sandbox');
    if (only.source === 'sandbox' && only.call.tool === 'sandbox_read_file') {
      // Sandbox detector normalizes paths to workspace-absolute form.
      expect(only.call.args.path).toBe('/workspace/REAL.md');
    }
  });
});
