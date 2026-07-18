import { describe, expect, it } from 'vitest';
import {
  buildDetectedToolLedger,
  detectAllToolCalls,
  detectNativeToolCalls,
  diagnoseToolCallFailure,
  detectAnyToolCall,
} from './tool-dispatch';
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
    expect(detected.sideEffects).toEqual([]);
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
    expect(detected.sideEffects).toHaveLength(1);
    expect(detected.sideEffects[0]?.source).toBe('todo');
    expect(detected.sideEffects[0]?.call.tool).toBe('todo_write');
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
  it('classifies structured native tool calls without fenced text', () => {
    const detected = detectNativeToolCalls([
      { id: 'call_1', name: 'sandbox_read_file', args: { path: 'README.md' } },
    ]);

    expect(detected.readOnly).toHaveLength(1);
    expect(detected.readOnly[0]).toMatchObject({
      source: 'sandbox',
      call: { tool: 'sandbox_read_file', args: { path: '/workspace/README.md' } },
    });
    expect(detected.droppedCandidates).toHaveLength(0);
  });

  it('reports malformed structured native tool calls through dropped candidates', () => {
    const detected = detectNativeToolCalls([
      { id: 'call_1', name: 'not_a_tool', args: { path: 'README.md' } },
    ]);

    expect(detected.readOnly).toHaveLength(0);
    expect(detected.droppedCandidates).toEqual([
      {
        rawToolName: 'not_a_tool',
        resolvedToolName: null,
        sample: '{"id":"call_1","tool":"not_a_tool","args":{"path":"README.md"}}',
      },
    ]);
  });

  // Regression: the web lead's single-call TEXT path must use detectAnyToolCall,
  // not a call derived from detectAllToolCalls. The two diverge on bare-args
  // recovery — a non-cooperating model emitting just the args object (no
  // {"tool","args"} wrapper) is recovered by detectAnyToolCall's
  // tryRecoverBareToolArgs, while detectAllToolCalls deliberately gates bare-args
  // inference on hasExplicitWrappers (to avoid firing on prose JSON examples), so
  // its grouped result surfaces no call. Swapping the detector silently drops the
  // call into the no-tool path. (#1162 review, Codex P1.)
  it('recovers a bare-args single call via detectAnyToolCall that detectAllToolCalls gates off', () => {
    const bareArgs = 'Let me read it.\n{"path": "README.md"}';

    const recovered = detectAnyToolCall(bareArgs);
    expect(recovered).not.toBeNull();
    expect(recovered?.source).toBe('sandbox');

    const grouped = detectAllToolCalls(bareArgs);
    const singleFromGrouped = [
      ...grouped.readOnly,
      ...(grouped.parallelDelegations ?? []),
      ...grouped.fileMutations,
      ...grouped.sideEffects,
    ];
    expect(singleFromGrouped).toHaveLength(0);
  });

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
    expect(detected.sideEffects).toEqual([]);
  });

  it('a full-budget turn (6 reads + 8 mutations + 3-chain) survives the pre-group scan cap', () => {
    // Codex P2 on #1536: the merge-loop soft cap reserved a single trailing
    // slot, so call 17 of a maximal valid turn was dropped before grouping.
    const reads = Array.from({ length: 6 }, (_, i) =>
      JSON.stringify({ tool: 'sandbox_read_file', args: { path: `/workspace/r${i}.ts` } }),
    );
    const writes = Array.from({ length: 8 }, (_, i) =>
      JSON.stringify({
        tool: 'sandbox_write_file',
        args: { path: `/workspace/w${i}.ts`, content: `${i}` },
      }),
    );
    const execs = ['npm test', 'npm run build', 'echo done'].map((command) =>
      JSON.stringify({ tool: 'sandbox_exec', args: { command } }),
    );
    const detected = detectAllToolCalls([...reads, ...writes, ...execs].join('\n'));
    expect(detected.readOnly).toHaveLength(6);
    expect(detected.fileMutations).toHaveLength(8);
    expect(
      detected.sideEffects.map((c) =>
        c.source === 'sandbox' && c.call.tool === 'sandbox_exec' ? c.call.args.command : null,
      ),
    ).toEqual(['npm test', 'npm run build', 'echo done']);
    expect(detected.batchOverflow).toEqual([]);
    expect(detected.extraMutations).toEqual([]);
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
    expect(detected.sideEffects[0]?.source).toBe('sandbox');
    expect(detected.sideEffects[0]?.call.tool).toBe('sandbox_exec');
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
    expect(detected.sideEffects[0]?.source).toBe('sandbox');
    expect(detected.sideEffects[0]?.call.tool).toBe('sandbox_exec');
  });

  it('keeps trailing mutating call when there is exactly one read call', () => {
    const text = [
      '{"tool":"search_files","args":{"repo":"KvFxKaido/Push","query":"runConfigInit"}}',
      '{"message":"chore: update config command"}',
    ].join('\n');

    const detected = detectAllToolCalls(text);
    expect(detected.readOnly).toHaveLength(1);
    expect(detected.readOnly[0].source).toBe('github');
    expect(detected.sideEffects[0]?.source).toBe('sandbox');
    expect(detected.sideEffects[0]?.call.tool).toBe('sandbox_commit');
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
    expect(detected.sideEffects[0]?.source).toBe('delegate');
    expect(detected.sideEffects[0]?.call.tool).toBe('delegate_explorer');
  });

  it('deduplicates wrapper and bare forms of the same call', () => {
    const text = [
      '{"tool":"read_file","args":{"repo":"KvFxKaido/Push","path":"scripts/push/cli.mjs","start_line":279,"end_line":349}}',
      '{"repo":"KvFxKaido/Push","path":"scripts/push/cli.mjs","start_line":279,"end_line":349}',
    ].join('\n');

    const detected = detectAllToolCalls(text);
    expect(detected.readOnly).toHaveLength(1);
    expect(detected.sideEffects).toEqual([]);
  });

  it('deduplicates identical wrapper calls with reordered args keys', () => {
    const text = [
      '{"tool":"fetch_pr","args":{"repo":"KvFxKaido/Push","pr":105}}',
      '{"tool":"fetch_pr","args":{"pr":105,"repo":"KvFxKaido/Push"}}',
    ].join('\n');

    const detected = detectAllToolCalls(text);
    expect(detected.readOnly).toHaveLength(1);
    expect(detected.sideEffects).toEqual([]);
  });

  it('deduplicates nested args regardless of key order', () => {
    const text = [
      '{"tool":"sandbox_exec","args":{"command":"npm test","cwd":"/workspace","timeout":120000}}',
      '{"tool":"sandbox_exec","args":{"timeout":120000,"cwd":"/workspace","command":"npm test"}}',
    ].join('\n');

    const detected = detectAllToolCalls(text);
    expect(detected.readOnly).toHaveLength(0);
    expect(detected.sideEffects[0]?.source).toBe('sandbox');
    expect(detected.sideEffects[0]?.call.tool).toBe('sandbox_exec');
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
    expect(detected.sideEffects).toEqual([]);
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
    expect(detected.sideEffects).toHaveLength(1);
    expect(detected.sideEffects[0]?.source).toBe('sandbox');
    expect(detected.sideEffects[0]?.call.tool).toBe('sandbox_exec');
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
    expect(detected.sideEffects).toHaveLength(1);
    expect(detected.extraMutations).toHaveLength(1);
    expect(detected.sideEffects[0]?.source).toBe('sandbox');
    expect(detected.sideEffects[0]?.call.tool).toBe('sandbox_exec');
    if (detected.extraMutations[0]?.source === 'sandbox') {
      expect(detected.extraMutations[0].call.tool).toBe('sandbox_write_file');
    }

    const ledger = buildDetectedToolLedger(detected);
    expect(ledger.counts).toMatchObject({ total: 3, accepted: 2, rejected: 1 });
    expect(ledger.entries.map((entry) => [entry.phase, entry.disposition, entry.toolName])).toEqual(
      [
        ['read', 'accepted', 'sandbox_read_file'],
        ['trailing_side_effect', 'accepted', 'sandbox_exec'],
        ['tool_order_violation', 'rejected', 'sandbox_write_file'],
      ],
    );
    expect(ledger.rejected[0]?.rejectionReason).toBe('tool_order_violation');
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
    expect(detected.sideEffects).toEqual([]);
    expect(detected.extraMutations).toHaveLength(0);
    if (detected.fileMutations[0]?.source === 'sandbox') {
      expect(detected.fileMutations[0].call.tool).toBe('sandbox_write_file');
    }
  });

  it('rejects overlapping file mutations for the same path in one turn', () => {
    const text = [
      '{"tool":"sandbox_edit_file","args":{"path":"/workspace/src/api.ts","edits":[{"op":"replace_line","ref":"1:abcdef0","content":"one"}]}}',
      '{"tool":"sandbox_search_replace","args":{"path":"src/api.ts","search":"old","replace":"new"}}',
    ].join('\n');

    const detected = detectAllToolCalls(text);
    expect(detected.fileMutations).toHaveLength(1);
    expect(detected.extraMutations).toHaveLength(1);
    if (detected.extraMutations[0]?.source === 'sandbox') {
      expect(detected.extraMutations[0].call.tool).toBe('sandbox_search_replace');
    }
  });

  it('rejects an edit that overlaps a patchset path in the same turn', () => {
    const text = [
      '{"tool":"sandbox_apply_patchset","args":{"edits":[{"path":"/workspace/src/api.ts","ops":[{"op":"replace_line","ref":"1:abcdef0","content":"one"}]}]}}',
      '{"tool":"sandbox_edit_range","args":{"path":"src/api.ts","start_line":1,"end_line":1,"content":"two"}}',
    ].join('\n');

    const detected = detectAllToolCalls(text);
    expect(detected.fileMutations).toHaveLength(1);
    expect(detected.extraMutations).toHaveLength(1);
    if (detected.extraMutations[0]?.source === 'sandbox') {
      expect(detected.extraMutations[0].call.tool).toBe('sandbox_edit_range');
    }
  });

  it('treats dot-segment aliases as the same file path', () => {
    const text = [
      '{"tool":"sandbox_edit_file","args":{"path":"/workspace/src/../api.ts","edits":[{"op":"replace_line","ref":"1:abcdef0","content":"one"}]}}',
      '{"tool":"sandbox_search_replace","args":{"path":"/workspace/api.ts","search":"old","replace":"new"}}',
    ].join('\n');

    const detected = detectAllToolCalls(text);
    expect(detected.fileMutations).toHaveLength(1);
    expect(detected.extraMutations).toHaveLength(1);
    if (detected.extraMutations[0]?.source === 'sandbox') {
      expect(detected.extraMutations[0].call.tool).toBe('sandbox_search_replace');
    }
  });

  it('does not collide absolute non-workspace paths with workspace-relative ones', () => {
    // /tmp/out.txt and workspace-relative tmp/out.txt are different targets
    const text = [
      '{"tool":"sandbox_write_file","args":{"path":"/tmp/out.txt","content":"one"}}',
      '{"tool":"sandbox_write_file","args":{"path":"tmp/out.txt","content":"two"}}',
    ].join('\n');

    const detected = detectAllToolCalls(text);
    expect(detected.fileMutations).toHaveLength(2);
    expect(detected.extraMutations).toHaveLength(0);
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
    expect(detected.sideEffects[0]?.source).toBe('sandbox');
    expect(detected.sideEffects[0]?.call.tool).toBe('sandbox_exec');
    expect(detected.extraMutations).toHaveLength(0);
  });

  it('captures reads + file mutation batch + trailing side-effect in order', () => {
    // [read, read, write, write, commit] — all three slots populated
    const text = [
      '{"tool":"sandbox_read_file","args":{"path":"/workspace/a.ts"}}',
      '{"tool":"sandbox_read_file","args":{"path":"/workspace/b.ts"}}',
      '{"tool":"sandbox_write_file","args":{"path":"/workspace/c.md","content":"one"}}',
      '{"tool":"sandbox_write_file","args":{"path":"/workspace/d.md","content":"two"}}',
      '{"tool":"sandbox_commit","args":{"message":"chore: add docs"}}',
    ].join('\n');

    const detected = detectAllToolCalls(text);
    expect(detected.readOnly).toHaveLength(2);
    expect(detected.fileMutations).toHaveLength(2);
    expect(detected.sideEffects[0]?.source).toBe('sandbox');
    expect(detected.sideEffects[0]?.call.tool).toBe('sandbox_commit');
    expect(detected.extraMutations).toHaveLength(0);
  });

  it('accepts a side-effect chain after a file mutation batch, up to the cap', () => {
    // [write, exec, exec] — both execs join the trailing chain (cap 3),
    // in emission order; nothing overflows.
    const text = [
      '{"tool":"sandbox_write_file","args":{"path":"/workspace/a.md","content":"one"}}',
      '{"tool":"sandbox_exec","args":{"command":"npm test"}}',
      '{"tool":"sandbox_exec","args":{"command":"npm run build"}}',
    ].join('\n');

    const detected = detectAllToolCalls(text);
    expect(detected.fileMutations).toHaveLength(1);
    expect(detected.sideEffects).toHaveLength(2);
    expect(detected.sideEffects[0]?.source).toBe('sandbox');
    expect(detected.sideEffects.map((c) => c.call.tool)).toEqual(['sandbox_exec', 'sandbox_exec']);
    if (
      detected.sideEffects[0]?.source === 'sandbox' &&
      detected.sideEffects[0].call.tool === 'sandbox_exec'
    ) {
      expect(detected.sideEffects[0].call.args.command).toBe('npm test');
    }
    expect(detected.extraMutations).toHaveLength(0);
  });

  it('overflows side-effects beyond MAX_SIDE_EFFECT_CHAIN into extraMutations', () => {
    // [write, exec ×4] — first 3 execs fill the chain (MAX_SIDE_EFFECT_CHAIN = 3),
    // the 4th lands in extraMutations as an ordering-violation-class reject.
    const execs = Array.from(
      { length: 4 },
      (_, i) => `{"tool":"sandbox_exec","args":{"command":"step ${i}"}}`,
    );
    const text = [
      '{"tool":"sandbox_write_file","args":{"path":"/workspace/a.md","content":"one"}}',
      ...execs,
    ].join('\n');

    const detected = detectAllToolCalls(text);
    expect(detected.fileMutations).toHaveLength(1);
    expect(detected.sideEffects).toHaveLength(3);
    detected.sideEffects.forEach((call, i) => {
      if (call.source === 'sandbox' && call.call.tool === 'sandbox_exec') {
        expect(call.call.args.command).toBe(`step ${i}`);
      }
    });
    expect(detected.extraMutations).toHaveLength(1);
    if (
      detected.extraMutations[0]?.source === 'sandbox' &&
      detected.extraMutations[0].call.tool === 'sandbox_exec'
    ) {
      expect(detected.extraMutations[0].call.args.command).toBe('step 3');
    }
  });

  it('classifies a single file mutation into fileMutations, not sideEffects', () => {
    const text = '{"tool":"sandbox_write_file","args":{"path":"/workspace/a.md","content":"one"}}';
    const detected = detectAllToolCalls(text);
    expect(detected.readOnly).toHaveLength(0);
    expect(detected.fileMutations).toHaveLength(1);
    expect(detected.sideEffects).toEqual([]);
    expect(detected.extraMutations).toHaveLength(0);
  });

  it('caps the file-mutation batch at MAX_FILE_MUTATION_BATCH and routes overflow into batchOverflow', () => {
    // 10 distinct file writes (MAX_FILE_MUTATION_BATCH = 8) — first 8
    // should land in fileMutations (in order), last 2 in batchOverflow
    // (NOT extraMutations — those are now reserved for ordering
    // violations only). Copilot review on PR #680.
    const calls = Array.from(
      { length: 10 },
      (_, i) =>
        `{"tool":"sandbox_write_file","args":{"path":"/workspace/file${i}.md","content":"v${i}"}}`,
    );
    const text = calls.join('\n');

    const detected = detectAllToolCalls(text);
    expect(detected.readOnly).toHaveLength(0);
    expect(detected.fileMutations).toHaveLength(8);
    expect(detected.sideEffects).toEqual([]);
    expect(detected.batchOverflow).toHaveLength(2);
    expect(detected.extraMutations).toHaveLength(0);

    // Order preserved inside fileMutations
    detected.fileMutations.forEach((call, i) => {
      if (call.source === 'sandbox' && call.call.tool === 'sandbox_write_file') {
        expect(call.call.args.path).toBe(`/workspace/file${i}.md`);
      }
    });
    // Overflow appears in emission order
    if (
      detected.batchOverflow[0]?.source === 'sandbox' &&
      detected.batchOverflow[0].call.tool === 'sandbox_write_file'
    ) {
      expect(detected.batchOverflow[0].call.args.path).toBe('/workspace/file8.md');
    }
    if (
      detected.batchOverflow[1]?.source === 'sandbox' &&
      detected.batchOverflow[1].call.tool === 'sandbox_write_file'
    ) {
      expect(detected.batchOverflow[1].call.args.path).toBe('/workspace/file9.md');
    }

    const ledger = buildDetectedToolLedger(detected);
    expect(ledger.counts).toMatchObject({ total: 10, accepted: 8, rejected: 2 });
    expect(ledger.counts.byPhase.file_mutation).toBe(8);
    expect(ledger.counts.byPhase.file_mutation_batch_overflow).toBe(2);
    expect(ledger.rejected.map((entry) => [entry.rejectionReason, entry.toolName])).toEqual([
      ['file_mutation_batch_overflow', 'sandbox_write_file'],
      ['file_mutation_batch_overflow', 'sandbox_write_file'],
    ]);
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
    expect(detected.sideEffects).toEqual([]);
    expect(detected.extraMutations).toHaveLength(2);
    if (detected.extraMutations[0]?.source === 'sandbox') {
      expect(detected.extraMutations[0].call.tool).toBe('sandbox_read_file');
    }
    if (detected.extraMutations[1]?.source === 'sandbox') {
      expect(detected.extraMutations[1].call.tool).toBe('sandbox_exec');
    }
  });

  it('chains multiple delegate_coder calls into the side-effect chain up to the cap', () => {
    const text = [
      '{"tool":"delegate_coder","args":{"task":"refactor the auth module to use tokens"}}',
      '{"tool":"delegate_coder","args":{"task":"add unit tests for the session handler"}}',
    ].join('\n');

    const detected = detectAllToolCalls(text);
    expect(detected.readOnly).toHaveLength(0);
    expect(detected.sideEffects.map((c) => [c.source, c.call.tool])).toEqual([
      ['delegate', 'delegate_coder'],
      ['delegate', 'delegate_coder'],
    ]);
    expect(detected.extraMutations).toHaveLength(0);
  });

  it('chains multiple delegate_explorer calls into the side-effect chain up to the cap', () => {
    const text = [
      '{"tool":"delegate_explorer","args":{"task":"trace the auth flow across files"}}',
      '{"tool":"delegate_explorer","args":{"task":"find all session refresh triggers"}}',
    ].join('\n');

    const detected = detectAllToolCalls(text);
    expect(detected.readOnly).toHaveLength(0);
    expect(detected.sideEffects.map((c) => [c.source, c.call.tool])).toEqual([
      ['delegate', 'delegate_explorer'],
      ['delegate', 'delegate_explorer'],
    ]);
    expect(detected.extraMutations).toHaveLength(0);
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
    allCalls.push(...result.sideEffects);

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

// ---------------------------------------------------------------------------
// detectAllToolCalls / detectAnyToolCall — XML-wrapper recovery on the
// web/mobile dispatcher. Mirrors the namespaced suite above so the
// mobile-app `<tool_call>` failure mode that motivated PR #558 is
// pinned end-to-end through the web routing layer (which differs from
// the shared CLI dispatcher kernel — it groups calls by execution
// phase and resolves tool names through `inferToolFromArgs`).
// ---------------------------------------------------------------------------

describe('detectAllToolCalls — XML-wrapper recovery', () => {
  const SHAPE_B_CAPTURE = [
    '<tool_call>read_file',
    '<arg_key>path</arg_key>',
    '<arg_value>TODO.md</arg_value>',
    '</tool_call>',
  ].join('\n');

  const SHAPE_A_CAPTURE =
    '<tool_call>{"name": "read_file", "arguments": {"path": "ROADMAP.md"}}</tool_call>';

  it('recovers a Shape B `<tool_call>` block via detectAllToolCalls', () => {
    const result = detectAllToolCalls(SHAPE_B_CAPTURE);
    const allCalls = [...result.readOnly, ...result.fileMutations];
    allCalls.push(...result.sideEffects);
    expect(allCalls).toHaveLength(1);
    // The web runtime resolves the bare `read_file` + `{path}` shape to
    // the sandbox variant via inferToolFromArgs.
    expect(allCalls[0].call.tool).toBe('sandbox_read_file');
  });

  it('recovers a Shape A `<tool_call>` block via detectAllToolCalls', () => {
    const result = detectAllToolCalls(SHAPE_A_CAPTURE);
    const allCalls = [...result.readOnly, ...result.fileMutations];
    allCalls.push(...result.sideEffects);
    expect(allCalls).toHaveLength(1);
    expect(allCalls[0].call.tool).toBe('sandbox_read_file');
  });

  it('detectAnyToolCall returns the XML-recovered call when no canonical wrapper exists', () => {
    const recovered = detectAnyToolCall(SHAPE_B_CAPTURE);
    expect(recovered).not.toBeNull();
    expect(recovered!.call.tool).toBe('sandbox_read_file');
  });

  it('detectAllToolCalls merges + sorts namespaced and XML recoveries by textual offset', () => {
    // XML appears before the namespaced prefix in the text. Before
    // the merge-and-sort fix, namespaced recoveries always ran first
    // regardless of textual order, so the namespaced call landed at
    // result.readOnly[0] and the XML one at [1] — the opposite of
    // what the model intended. Pinning the corrected order here.
    // Codex/Copilot review on PR #558.
    const text = [
      '<tool_call>read_file',
      '<arg_key>path</arg_key>',
      '<arg_value>FIRST.md</arg_value>',
      '</tool_call>',
      'functions.read_file:1 {"path": "SECOND.md"}',
    ].join('\n');
    const result = detectAllToolCalls(text);
    expect(result.readOnly).toHaveLength(2);
    const paths = result.readOnly.map((c) =>
      c.source === 'sandbox' && c.call.tool === 'sandbox_read_file'
        ? (c.call.args as Record<string, unknown>).path
        : null,
    );
    expect(paths).toEqual(['/workspace/FIRST.md', '/workspace/SECOND.md']);
  });

  it('does not let XML recovery override canonical tool calls in the same message', () => {
    // Canonical fenced block + an XML wrapper in the surrounding text.
    // The XML recovery branch is gated on having NO explicit wrappers
    // (same gate as the namespaced branch), so only the canonical call
    // executes and the XML one is ignored — preventing the prose-shape
    // `<tool_call>exec ...</tool_call>` false-positive from hijacking a
    // run that already has a real fenced call.
    const text = [
      '```json',
      '{"tool": "sandbox_read_file", "args": {"path": "REAL.md"}}',
      '```',
      '<tool_call>exec<arg_key>command</arg_key><arg_value>rm -rf /</arg_value></tool_call>',
    ].join('\n');
    const result = detectAllToolCalls(text);
    expect(result.readOnly).toHaveLength(1);
    expect(result.readOnly[0].call.tool).toBe('sandbox_read_file');
  });

  it('recognizes Anthropic `<function_calls>` wrappers and dispatches the invoke as a real read', () => {
    // End-to-end: the Explorer in the original bug log emitted a
    // `<function_calls>` wrapper that the regex-based detector did not
    // recognize, so the round terminated with zero tool execution. With
    // Shape C recovery the inner `<invoke name="read">` resolves to
    // `sandbox_read_file` and runs.
    const text = [
      '<function_calls>',
      '<invoke name="read">',
      '<parameter name="path">/workspace/README.md</parameter>',
      '</invoke>',
      '</function_calls>',
    ].join('\n');
    const result = detectAllToolCalls(text);
    expect(result.readOnly).toHaveLength(1);
    expect(result.readOnly[0].call.tool).toBe('sandbox_read_file');
    if (result.readOnly[0].source === 'sandbox') {
      expect(result.readOnly[0].call).toMatchObject({
        tool: 'sandbox_read_file',
        args: { path: '/workspace/README.md' },
      });
    }
  });

  it('emits one call per `<invoke>` child when a `<function_calls>` block contains multiple invokes', () => {
    const text = [
      '<function_calls>',
      '<invoke name="read"><parameter name="path">/a</parameter></invoke>',
      '<invoke name="diff"></invoke>',
      '</function_calls>',
    ].join('\n');
    const result = detectAllToolCalls(text);
    // read is a parallel-read; diff is also a read-only tool, so both
    // land in readOnly and execute together.
    expect(result.readOnly).toHaveLength(2);
    expect(result.readOnly.map((c) => c.call.tool)).toEqual(['sandbox_read_file', 'sandbox_diff']);
  });

  it('dispatches doubled DeepSeek DSML issue batches after an assistant preamble', () => {
    const text = [
      "Let me pull up the open issues so I can give you a real read on what's ripe.",
      '',
      '<｜｜DSML｜｜tool_calls>',
      '<｜｜DSML｜｜invoke name="issue">',
      '<｜｜DSML｜｜parameter name="repo" string="true">KvFxKaido/Push</｜｜DSML｜｜parameter>',
      '<｜｜DSML｜｜parameter name="issue_number" string="true">1260</｜｜DSML｜｜parameter>',
      '</｜｜DSML｜｜invoke>',
      '<｜｜DSML｜｜invoke name="issue">',
      '<｜｜DSML｜｜parameter name="repo" string="true">KvFxKaido/Push</｜｜DSML｜｜parameter>',
      '<｜｜DSML｜｜parameter name="issue_number" string="true">1226</｜｜DSML｜｜parameter>',
      '</｜｜DSML｜｜invoke>',
      '<｜｜DSML｜｜invoke name="issue">',
      '<｜｜DSML｜｜parameter name="repo" string="true">KvFxKaido/Push</｜｜DSML｜｜parameter>',
      '<｜｜DSML｜｜parameter name="issue_number" string="true">1190</｜｜DSML｜｜parameter>',
      '</｜｜DSML｜｜invoke>',
      '<｜｜DSML｜｜invoke name="issue">',
      '<｜｜DSML｜｜parameter name="repo" string="true">KvFxKaido/Push</｜｜DSML｜｜parameter>',
      '<｜｜DSML｜｜parameter name="issue_number" string="true">1169</｜｜DSML｜｜parameter>',
      '</｜｜DSML｜｜invoke>',
      '<｜｜DSML｜｜invoke name="issue">',
      '<｜｜DSML｜｜parameter name="repo" string="true">KvFxKaido/Push</｜｜DSML｜｜parameter>',
      '<｜｜DSML｜｜parameter name="issue_number" string="true">1048</｜｜DSML｜｜parameter>',
      '</｜｜DSML｜｜invoke>',
      '</｜｜DSML｜｜tool_calls>',
    ].join('\n');

    const result = detectAllToolCalls(text);
    expect(result.readOnly).toHaveLength(5);
    const githubCalls = result.readOnly.map((c) => {
      expect(c.source).toBe('github');
      return c.source === 'github' ? c.call : null;
    });
    expect(githubCalls.map((c) => c?.tool)).toEqual([
      'get_issue',
      'get_issue',
      'get_issue',
      'get_issue',
      'get_issue',
    ]);
    expect(githubCalls.map((c) => c?.args)).toEqual([
      { repo: 'KvFxKaido/Push', issue_number: 1260 },
      { repo: 'KvFxKaido/Push', issue_number: 1226 },
      { repo: 'KvFxKaido/Push', issue_number: 1190 },
      { repo: 'KvFxKaido/Push', issue_number: 1169 },
      { repo: 'KvFxKaido/Push', issue_number: 1048 },
    ]);
    expect(result.droppedCandidates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Recovery vs droppedCandidates reconciliation. The web dispatcher runs the
// shared kernel with `enableInternalRecovery: false`, so the kernel reports
// every recovery shape as an `unknown_tool` malformed and defers the actual
// recovery to the web layer's own pass. Without reconciliation those reports
// land in `droppedCandidates`, which trips the dropped-candidate guard in
// `chat-send` and short-circuits the turn into a parse-error correction —
// so a recovered call would parse but never execute. These pin that a
// successfully-recovered shape leaves `droppedCandidates` empty, while a
// genuinely-unknown recovered tool still surfaces as dropped.
// ---------------------------------------------------------------------------
describe('detectAllToolCalls — recovery clears its own droppedCandidates', () => {
  it('leaves droppedCandidates empty for a recovered standalone <invoke> (Shape E)', () => {
    const text =
      '<invoke name="read"><parameter name="path">/workspace/README.md</parameter></invoke>';
    const result = detectAllToolCalls(text);
    expect(result.readOnly.map((c) => c.call.tool)).toEqual(['sandbox_read_file']);
    expect(result.droppedCandidates).toHaveLength(0);
  });

  it('leaves droppedCandidates empty for a recovered <function_calls> wrapper (Shape C)', () => {
    const text =
      '<function_calls><invoke name="read"><parameter name="path">/a</parameter></invoke></function_calls>';
    const result = detectAllToolCalls(text);
    expect(result.readOnly.map((c) => c.call.tool)).toEqual(['sandbox_read_file']);
    expect(result.droppedCandidates).toHaveLength(0);
  });

  it('leaves droppedCandidates empty for a recovered <tool_call> block (Shape A)', () => {
    const text = '<tool_call>{"name":"read_file","arguments":{"path":"a"}}</tool_call>';
    const result = detectAllToolCalls(text);
    expect(result.readOnly.map((c) => c.call.tool)).toEqual(['sandbox_read_file']);
    expect(result.droppedCandidates).toHaveLength(0);
  });

  it('still reports a genuinely-unknown recovered tool as dropped', () => {
    // wrapRecoveredCallToAny can't claim this name, so it stays a real
    // dropped candidate — the reconciliation only clears shapes this pass
    // actually turned into calls.
    const text = '<invoke name="totally_unknown_tool"><parameter name="x">1</parameter></invoke>';
    const result = detectAllToolCalls(text);
    expect(result.readOnly).toHaveLength(0);
    expect(result.droppedCandidates).toHaveLength(1);
    expect(result.droppedCandidates[0].rawToolName).toBe('totally_unknown_tool');
  });

  it('keeps a malformed same-name recovered sibling dropped', () => {
    const text = [
      '<invoke name="read"><parameter name="path">/workspace/README.md</parameter></invoke>',
      '<invoke name="read"><parameter name="bad">x</parameter></invoke>',
    ].join('\n');
    const result = detectAllToolCalls(text);

    expect(result.readOnly.map((c) => c.call.tool)).toEqual(['sandbox_read_file']);
    expect(result.droppedCandidates).toHaveLength(1);
    expect(result.droppedCandidates[0]).toMatchObject({
      rawToolName: 'read',
      resolvedToolName: 'sandbox_read_file',
    });
  });
});

// ---------------------------------------------------------------------------
// Dropped-candidate tracking — the Coder "loops on sandbox_diff" bug.
// Before this surface existed, a malformed edit_range emitted alongside a
// valid diff would let the diff execute alone (the only sandbox tool with no
// args check), leaving the Coder to infer from a clean diff that "the edit
// somehow didn't apply" and try again. The candidates array surfaces both
// calls so callers can refuse execution and force a retry.
// ---------------------------------------------------------------------------
describe('detectAllToolCalls — droppedCandidates tracking', () => {
  it('captures a malformed edit_range emitted alongside a valid diff so neither runs silently', () => {
    const text = [
      '```json',
      // edit_range with missing start_line / end_line — fails source validation
      '{"tool": "edit_range", "args": {"path": "/workspace/README.md", "content": "x"}}',
      '```',
      'Let me also check the diff:',
      '```json',
      '{"tool": "diff", "args": {}}',
      '```',
    ].join('\n');
    const result = detectAllToolCalls(text);
    // The valid diff is still classified — the *caller* refuses to run it
    // when droppedCandidates is non-empty. Detection here just exposes both.
    expect(result.readOnly).toHaveLength(1);
    expect(result.readOnly[0].call.tool).toBe('sandbox_diff');
    expect(result.droppedCandidates).toHaveLength(1);
    expect(result.droppedCandidates[0].rawToolName).toBe('edit_range');
    expect(result.droppedCandidates[0].resolvedToolName).toBe('sandbox_edit_range');
  });

  it('captures top-level-args malformations (model emits path/command outside args wrapper)', () => {
    const text = [
      '```json',
      '{"tool": "read", "path": "/workspace/README.md"}',
      '```',
      '```json',
      '{"tool": "diff", "args": {}}',
      '```',
    ].join('\n');
    const result = detectAllToolCalls(text);
    expect(result.droppedCandidates).toHaveLength(1);
    expect(result.droppedCandidates[0].rawToolName).toBe('read');
    expect(result.droppedCandidates[0].resolvedToolName).toBe('sandbox_read_file');
  });

  it('captures unrecognized tool names so the model gets a parse error instead of a silent drop', () => {
    const text = [
      '```json',
      '{"tool": "sandbox", "args": {"command": "read", "path": "/workspace/app/src/lib"}}',
      '```',
    ].join('\n');
    const result = detectAllToolCalls(text);
    expect(result.readOnly).toHaveLength(0);
    expect(result.sideEffects).toEqual([]);
    expect(result.droppedCandidates).toHaveLength(1);
    expect(result.droppedCandidates[0].rawToolName).toBe('sandbox');
    expect(result.droppedCandidates[0].resolvedToolName).toBeNull();
  });

  it('leaves droppedCandidates empty when every emitted call validates', () => {
    const text = [
      '```json',
      '{"tool": "read", "args": {"path": "/workspace/README.md"}}',
      '```',
      '```json',
      '{"tool": "diff", "args": {}}',
      '```',
    ].join('\n');
    const result = detectAllToolCalls(text);
    expect(result.readOnly).toHaveLength(2);
    expect(result.droppedCandidates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Textual-order merging across kernel + legacy fallback. Regression cases
// flagged by Codex P1 / Copilot on PR #679: the kernel-claimed-vs-legacy
// merge must preserve the model's intended emit order so the grouping
// state machine sees side-effects in the right slot. Before the fix, all
// legacy calls were appended after every kernel call regardless of their
// textual position.
// ---------------------------------------------------------------------------
describe('detectAllToolCalls — textual-order merging', () => {
  it('flat-form scratchpad emitted before a wrapped sandbox_exec lands first in the merged order', () => {
    // Scratchpad flat-form has no `args` wrapper, so the kernel rejects it
    // as `missing_args_object` and the legacy fallback claims it. Wrapped
    // sandbox_exec is a clean kernel claim. The flat-form appears FIRST
    // textually, so the merged ordering must put scratchpad before exec —
    // otherwise the grouping state machine flips the order in which the
    // side-effect chain executes them.
    const text = [
      '```json',
      '{"tool": "set_scratchpad", "content": "remember this"}',
      '```',
      '```json',
      '{"tool": "sandbox_exec", "args": {"command": "echo hi"}}',
      '```',
    ].join('\n');
    const result = detectAllToolCalls(text);
    // Both are side-effecting (scratchpad mutates session state, exec is
    // a shell side-effect), so both join the trailing chain — in the
    // model's textual emission order: scratchpad first, exec second.
    expect(result.sideEffects).toHaveLength(2);
    expect(result.sideEffects[0]?.source).toBe('scratchpad');
    expect(result.sideEffects[1]?.source).toBe('sandbox');
    expect(result.sideEffects[1]?.call.tool).toBe('sandbox_exec');
    expect(result.extraMutations).toHaveLength(0);
  });

  it('wrapped read followed by flat-form scratchpad keeps the read in readOnly', () => {
    const text = [
      '```json',
      '{"tool": "sandbox_read_file", "args": {"path": "/workspace/README.md"}}',
      '```',
      '```json',
      '{"tool": "set_scratchpad", "content": "noted"}',
      '```',
    ].join('\n');
    const result = detectAllToolCalls(text);
    expect(result.readOnly).toHaveLength(1);
    expect(result.readOnly[0].source).toBe('sandbox');
    expect(result.sideEffects[0]?.source).toBe('scratchpad');
    expect(result.extraMutations).toHaveLength(0);
  });

  it('namespaced recovery does not unlock bare-args inference over prose JSON examples', () => {
    // Pre-fix: when a namespaced recovery (e.g. `functions.read_file:...`)
    // promoted a call into `allCalls`, the legacy-fallback gate was
    // `allCalls.length > 0 || hasExplicitWrappers`, which let bare-args
    // inference run over a prose `{ path, content }` example and
    // mis-detect it as a `sandbox_write_file`. The fix tightens the gate
    // to `hasExplicitWrappers` alone so a recovered non-canonical call
    // no longer unlocks the inference path.
    //
    // Namespaced-shape recovery is used here rather than XML because the
    // XML form embeds an inner `{tool: ...}` JSON object that brace
    // counting WOULD find — making `hasExplicitWrappers` true. The
    // namespaced shape has no `{tool: ...}` shape to find.
    const text = [
      'Here is how the read tool works:',
      '```',
      '{ "path": "/workspace/foo.md", "content": "example content here" }',
      '```',
      'And here is the actual call:',
      'functions.read_file:abc {"repo": "o/r", "path": "x"}',
    ].join('\n');
    const result = detectAllToolCalls(text);
    // The namespaced-recovered read_file should land. The prose example
    // must NOT become a sandbox_write_file via bare-args inference.
    const tools = [
      ...result.readOnly.map((c) => c.call.tool),
      ...result.fileMutations.map((c) => c.call.tool),
      ...result.sideEffects.map((c) => c.call.tool),
    ];
    expect(tools).not.toContain('sandbox_write_file');
  });

  it('does not infer the args portion of a namespaced trace as a separate bare-args call', () => {
    // Codex P2 regression on PR #681. Scenario: a canonical wrapper
    // that the kernel rejects (e.g. flat-form scratchpad) sets
    // hasExplicitWrappers=true, so Phase 3 (legacy fallback) runs.
    // The legacy scan would then extract the JSON args object of a
    // `functions.<tool>:<id> {<args>}` namespaced trace as a bare
    // JSON object and run it through bare-args inference, claiming
    // the args as a separate tool call even though the recovery
    // functions already model that namespaced call themselves.
    const text = [
      '{"tool": "set_scratchpad", "content": "flat-form claim"}',
      'functions.read_file:1 {"path":"a.txt"}',
    ].join('\n');
    const result = detectAllToolCalls(text);
    // scratchpad still lands via Phase 3 cascade (flat-form has a
    // tool field, so it's not in a recovery args region). The
    // namespaced args object MUST NOT also land as a bare-args read.
    const allTools = [
      ...result.readOnly.map((c) => c.call.tool),
      ...result.fileMutations.map((c) => c.call.tool),
      ...result.sideEffects.map((c) => c.call.tool),
    ];
    expect(allTools).toContain('set_scratchpad');
    expect(allTools).not.toContain('read_file');
    expect(allTools).not.toContain('sandbox_read_file');
  });

  it('does not infer the args portion of an XML <tool_call> as a separate bare-args call', () => {
    // Same shape as above but with XML recovery: a flat-form
    // canonical wrapper rejected by the kernel + an XML tool_call
    // block whose inner args object would otherwise be picked up by
    // bare-args inference. The XML recovery already models the call
    // (and is correctly suppressed when the canonical wrapper exists
    // — see the !hasExplicitWrappers gate), so the bare-args path
    // must also skip it.
    const text = [
      '{"tool": "set_scratchpad", "content": "flat-form claim"}',
      '<tool_call>{"name": "read_file", "arguments": {"path": "a.txt"}}</tool_call>',
    ].join('\n');
    const result = detectAllToolCalls(text);
    const allTools = [
      ...result.readOnly.map((c) => c.call.tool),
      ...result.fileMutations.map((c) => c.call.tool),
      ...result.sideEffects.map((c) => c.call.tool),
    ];
    expect(allTools).toContain('set_scratchpad');
    expect(allTools).not.toContain('read_file');
    expect(allTools).not.toContain('sandbox_read_file');
  });

  it('does NOT execute a prose `functions.exec:0 {...}` mention alongside a real fenced call', () => {
    // Codex P1 on PR #683. Pre-fix: my "precise regions" check only
    // skipped bare-args inference for objects inside ranges that
    // `recoverNamespacedToolCalls` actually claimed. But that
    // function's `hasRecoverableTrailingContext` gate REJECTS prose
    // mentions — meaning a sentence like
    // `Note: ignore functions.exec:0 {"command":"rm -rf /"} mention`
    // produces no recovery entry, so the precise-regions list misses
    // it. The args object survives `scanBareObjectsWithOffsets` and
    // `tryRecoverBareToolArgs` infers `sandbox_exec` from its shape.
    // Catastrophic execution from prose. The shape-based regex
    // lookback closes this even when recovery rejected the mention.
    const text = [
      '```json',
      '{"tool": "sandbox_read_file", "args": {"path": "/workspace/README.md"}}',
      '```',
      'Note: ignore functions.exec:0 {"command":"rm -rf /"} mention is just prose.',
    ].join('\n');
    const result = detectAllToolCalls(text);
    const allTools = [
      ...result.readOnly.map((c) => c.call.tool),
      ...result.fileMutations.map((c) => c.call.tool),
      ...result.sideEffects.map((c) => c.call.tool),
    ];
    // The fenced read should land.
    expect(allTools).toContain('sandbox_read_file');
    // The prose-mention exec MUST NOT execute.
    expect(allTools).not.toContain('sandbox_exec');
    expect(allTools).not.toContain('exec');
  });

  it('does NOT execute a prose `<invoke>` mention as a bare-args call', () => {
    // Same Codex P1 scenario, but for the XML invoke shape — a prose
    // `<invoke name="exec"><parameter name="command">rm -rf /...
    // </parameter></invoke>` reference inside a message with a real
    // fenced call. Recovery's gap-gate rejects this, but the
    // bare-object scan picks up nested JSON inside the parameter
    // value — the shape-based check still blocks it from inferring
    // as a tool call.
    const text = [
      '```json',
      '{"tool": "sandbox_read_file", "args": {"path": "/workspace/a.txt"}}',
      '```',
      'Earlier the model emitted: <invoke name="write">{"path":"/etc/passwd","content":"x"}</invoke> — but I am explaining, not executing.',
    ].join('\n');
    const result = detectAllToolCalls(text);
    const allTools = [
      ...result.readOnly.map((c) => c.call.tool),
      ...result.fileMutations.map((c) => c.call.tool),
      ...result.sideEffects.map((c) => c.call.tool),
    ];
    expect(allTools).toContain('sandbox_read_file');
    expect(allTools).not.toContain('sandbox_write_file');
    expect(allTools).not.toContain('write_file');
  });
});

// ---------------------------------------------------------------------------
// Cross-provider argument-type drift: the web dispatcher coerces the safe
// drift (string-quoted numbers/booleans) and enforces the non-coercible
// remainder by diverting it to `droppedCandidates` (→ validation_failed).
// Folds the web surface onto the shared `tool-arg-normalization` primitive.
// ---------------------------------------------------------------------------

describe('detectAllToolCalls — argument-type drift', () => {
  it('coerces a quoted integer on the text path (fetch_pr)', () => {
    const detected = detectAllToolCalls('{"tool":"fetch_pr","args":{"repo":"o/r","pr":"105"}}');
    const call = [...detected.readOnly, ...detected.sideEffects][0];
    expect(call?.call.tool).toBe('fetch_pr');
    expect((call?.call as { args: Record<string, unknown> }).args.pr).toBe(105);
    expect(detected.droppedCandidates).toHaveLength(0);
  });

  it('coerces a quoted integer on the native path (Kimi/GLM)', () => {
    const detected = detectNativeToolCalls([
      { name: 'sandbox_read_file', args: { path: 'README.md', start_line: '5', end_line: '20' } },
    ]);
    expect(detected.readOnly).toHaveLength(1);
    const args = (detected.readOnly[0].call as { args: Record<string, unknown> }).args;
    expect(args.start_line).toBe(5);
    expect(args.end_line).toBe(20);
    expect(detected.droppedCandidates).toHaveLength(0);
  });

  it('diverts a non-coercible type mismatch to droppedCandidates (text path)', () => {
    const detected = detectAllToolCalls(
      '{"tool":"fetch_pr","args":{"repo":"o/r","pr":"not-a-number"}}',
    );
    expect(detected.readOnly).toHaveLength(0);
    expect(detected.sideEffects).toEqual([]);
    expect(detected.droppedCandidates).toHaveLength(1);
    expect(detected.droppedCandidates[0]).toMatchObject({ resolvedToolName: 'fetch_pr' });
    // The github detector coerces the unparseable string to NaN before the
    // enforcement pass, so the value is a (non-integer) number by then — the
    // block still fires; assert on the stable part of the message.
    expect(detected.droppedCandidates[0].sample).toContain('pr: expected integer');
  });

  it('diverts a non-coercible type mismatch to droppedCandidates (native path)', () => {
    const detected = detectNativeToolCalls([
      { name: 'sandbox_read_file', args: { path: 'README.md', start_line: 'abc' } },
    ]);
    expect(detected.readOnly).toHaveLength(0);
    expect(detected.droppedCandidates).toHaveLength(1);
    expect(detected.droppedCandidates[0]).toMatchObject({ resolvedToolName: 'sandbox_read_file' });
  });

  it('keeps a correctly-typed call untouched', () => {
    const detected = detectNativeToolCalls([
      { name: 'sandbox_read_file', args: { path: 'README.md', start_line: 5 } },
    ]);
    expect(detected.readOnly).toHaveLength(1);
    expect(detected.droppedCandidates).toHaveLength(0);
  });

  // Regression (Codex P1 #1185): a valid guarded edit carries a string
  // `expected_version`; the derived schema used to mistype it `integer`, which
  // coerced/blocked valid calls. It must pass through untouched now.
  it('does not corrupt or reject a string expected_version', () => {
    const detected = detectNativeToolCalls([
      {
        name: 'sandbox_edit_range',
        args: {
          path: '/workspace/a.ts',
          start_line: 10,
          end_line: 12,
          content: 'x',
          expected_version: 'abc123',
        },
      },
    ]);
    expect(detected.droppedCandidates).toHaveLength(0);
    const call = detected.fileMutations[0] ?? detected.sideEffects[0];
    expect((call?.call as { args: Record<string, unknown> }).args.expected_version).toBe('abc123');
  });

  it('does not coerce a numeric-looking expected_version to a number', () => {
    const detected = detectNativeToolCalls([
      {
        name: 'sandbox_edit_range',
        args: {
          path: '/workspace/a.ts',
          start_line: 10,
          end_line: 12,
          content: 'x',
          expected_version: '42',
        },
      },
    ]);
    expect(detected.droppedCandidates).toHaveLength(0);
    const call = detected.fileMutations[0] ?? detected.sideEffects[0];
    expect((call?.call as { args: Record<string, unknown> }).args.expected_version).toBe('42');
  });

  // Regression (Codex P1 #1185): `checks` on patch is an object array, not a
  // boolean — a valid patch with post-write checks must not be diverted.
  it('does not reject a valid patch with a checks array', () => {
    const detected = detectNativeToolCalls([
      {
        name: 'sandbox_apply_patchset',
        args: {
          edits: [{ path: '/workspace/a.ts', start_line: 1, end_line: 1, content: 'x' }],
          checks: [{ command: 'npm test' }],
        },
      },
    ]);
    expect(detected.droppedCandidates).toHaveLength(0);
    expect(detected.fileMutations.length + detected.sideEffects.length).toBe(1);
  });
});
