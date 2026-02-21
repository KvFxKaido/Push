import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDER_CONFIGS, resolveNativeFC } from '../provider.mjs';
import { CLI_TOOL_SCHEMAS } from '../tool-schemas.mjs';
import { detectAllToolCalls } from '../tools.mjs';

// ─── Provider capability flags ─────────────────────────────────────

describe('provider supportsNativeFC flags', () => {
  it('Ollama does NOT support native FC', () => {
    assert.equal(PROVIDER_CONFIGS.ollama.supportsNativeFC, false);
  });

  it('Mistral supports native FC', () => {
    assert.equal(PROVIDER_CONFIGS.mistral.supportsNativeFC, true);
  });

  it('OpenRouter supports native FC', () => {
    assert.equal(PROVIDER_CONFIGS.openrouter.supportsNativeFC, true);
  });

  it('Mistral uses tool_choice "any"', () => {
    assert.equal(PROVIDER_CONFIGS.mistral.toolChoice, 'any');
  });

  it('OpenRouter uses tool_choice "auto"', () => {
    assert.equal(PROVIDER_CONFIGS.openrouter.toolChoice, 'auto');
  });
});

// ─── Request body construction ─────────────────────────────────────

describe('request body with native FC', () => {
  it('includes tools when provider supports native FC', () => {
    const config = PROVIDER_CONFIGS.mistral;
    const body = {
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
      temperature: 0.1,
    };

    // Simulate the logic from provider.mjs streamCompletion
    const options = { tools: CLI_TOOL_SCHEMAS, toolChoice: 'auto' };
    if (options?.tools && config.supportsNativeFC) {
      body.tools = options.tools;
      body.tool_choice = options.toolChoice || config.toolChoice || 'auto';
    }

    assert.ok(body.tools, 'tools should be set');
    assert.equal(body.tools.length, 12);
    assert.equal(body.tool_choice, 'auto');
  });

  it('does NOT include tools when provider does not support native FC', () => {
    const config = PROVIDER_CONFIGS.ollama;
    const body = {
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
      temperature: 0.1,
    };

    const options = { tools: CLI_TOOL_SCHEMAS, toolChoice: 'auto' };
    if (options?.tools && config.supportsNativeFC) {
      body.tools = options.tools;
      body.tool_choice = options.toolChoice || config.toolChoice || 'auto';
    }

    assert.equal(body.tools, undefined, 'tools should NOT be set for Ollama');
    assert.equal(body.tool_choice, undefined);
  });
});

// ─── Bridge round-trip: native tool call → fenced JSON → detect ───

describe('native FC bridge round-trip', () => {
  // Simulate what bridgeNativeToolCalls produces
  function simulateBridge(toolCalls) {
    let bridged = '';
    for (const tc of toolCalls) {
      if (!tc.name) continue;
      try {
        const parsedArgs = tc.args ? JSON.parse(tc.args) : {};
        const toolJson = JSON.stringify({ tool: tc.name, args: parsedArgs });
        bridged += '\n```json\n' + toolJson + '\n```\n';
      } catch {
        bridged += '\n```json\n' + JSON.stringify({ tool: tc.name, args: {} }) + '\n```\n';
      }
    }
    return bridged;
  }

  it('bridges a single tool call and detectAllToolCalls finds it', () => {
    const nativeCalls = [
      { name: 'read_file', args: '{"path":"package.json"}' },
    ];

    const bridged = simulateBridge(nativeCalls);
    const detected = detectAllToolCalls(bridged);

    assert.equal(detected.calls.length, 1);
    assert.equal(detected.malformed.length, 0);
    assert.deepEqual(detected.calls[0], {
      tool: 'read_file',
      args: { path: 'package.json' },
    });
  });

  it('bridges multiple tool calls in sequence', () => {
    const nativeCalls = [
      { name: 'read_file', args: '{"path":"src/index.ts"}' },
      { name: 'list_dir', args: '{"path":"src"}' },
    ];

    const bridged = simulateBridge(nativeCalls);
    const detected = detectAllToolCalls(bridged);

    assert.equal(detected.calls.length, 2);
    assert.equal(detected.calls[0].tool, 'read_file');
    assert.equal(detected.calls[1].tool, 'list_dir');
  });

  it('handles tool call with no args', () => {
    const nativeCalls = [
      { name: 'git_status', args: '' },
    ];

    const bridged = simulateBridge(nativeCalls);
    const detected = detectAllToolCalls(bridged);

    assert.equal(detected.calls.length, 1);
    assert.deepEqual(detected.calls[0], {
      tool: 'git_status',
      args: {},
    });
  });

  it('handles mixed text + bridged tool calls', () => {
    const text = 'Let me check the file structure.';
    const nativeCalls = [
      { name: 'list_dir', args: '{}' },
    ];

    const full = text + simulateBridge(nativeCalls);
    const detected = detectAllToolCalls(full);

    assert.equal(detected.calls.length, 1);
    assert.equal(detected.calls[0].tool, 'list_dir');
  });

  it('handles malformed args gracefully', () => {
    const nativeCalls = [
      { name: 'exec', args: '{invalid json' },
    ];

    const bridged = simulateBridge(nativeCalls);
    const detected = detectAllToolCalls(bridged);

    // Bridge falls back to empty args
    assert.equal(detected.calls.length, 1);
    assert.equal(detected.calls[0].tool, 'exec');
    assert.deepEqual(detected.calls[0].args, {});
  });

  it('ignores entries with no name', () => {
    const nativeCalls = [
      { name: '', args: '{"path":"foo"}' },
    ];

    const bridged = simulateBridge(nativeCalls);
    assert.equal(bridged, '', 'entries without name should produce no output');
  });
});

// ─── Incremental accumulation simulation ───────────────────────────

describe('incremental tool call accumulation', () => {
  it('simulates chunked delta.tool_calls assembly', () => {
    // Simulate how SSE chunks arrive: name in first chunk, args spread across several
    const pendingNativeToolCalls = new Map();

    // Chunk 1: name arrives
    const chunk1 = { index: 0, function: { name: 'edit_file', arguments: '' } };
    if (!pendingNativeToolCalls.has(chunk1.index)) {
      pendingNativeToolCalls.set(chunk1.index, { name: '', args: '' });
    }
    const entry1 = pendingNativeToolCalls.get(chunk1.index);
    if (chunk1.function.name) entry1.name = chunk1.function.name;
    if (chunk1.function.arguments) entry1.args += chunk1.function.arguments;

    // Chunk 2: partial args
    const chunk2 = { index: 0, function: { arguments: '{"path":"foo' } };
    const entry2 = pendingNativeToolCalls.get(chunk2.index);
    if (chunk2.function.name) entry2.name = chunk2.function.name;
    if (chunk2.function.arguments) entry2.args += chunk2.function.arguments;

    // Chunk 3: rest of args
    const chunk3 = { index: 0, function: { arguments: '.ts","edits":[]}' } };
    const entry3 = pendingNativeToolCalls.get(chunk3.index);
    if (chunk3.function.name) entry3.name = chunk3.function.name;
    if (chunk3.function.arguments) entry3.args += chunk3.function.arguments;

    // Verify accumulated result
    const accumulated = pendingNativeToolCalls.get(0);
    assert.equal(accumulated.name, 'edit_file');
    assert.equal(accumulated.args, '{"path":"foo.ts","edits":[]}');

    // Verify it parses
    const parsed = JSON.parse(accumulated.args);
    assert.equal(parsed.path, 'foo.ts');
    assert.deepEqual(parsed.edits, []);
  });
});

// ─── resolveNativeFC env override ──────────────────────────────────

describe('resolveNativeFC', () => {
  const savedEnv = process.env.PUSH_NATIVE_FC;

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.PUSH_NATIVE_FC;
    } else {
      process.env.PUSH_NATIVE_FC = savedEnv;
    }
  });

  it('returns provider default when PUSH_NATIVE_FC is unset', () => {
    delete process.env.PUSH_NATIVE_FC;
    assert.equal(resolveNativeFC(PROVIDER_CONFIGS.ollama), false);
    assert.equal(resolveNativeFC(PROVIDER_CONFIGS.mistral), true);
    assert.equal(resolveNativeFC(PROVIDER_CONFIGS.openrouter), true);
  });

  it('PUSH_NATIVE_FC=0 forces off even for mistral', () => {
    process.env.PUSH_NATIVE_FC = '0';
    assert.equal(resolveNativeFC(PROVIDER_CONFIGS.mistral), false);
    assert.equal(resolveNativeFC(PROVIDER_CONFIGS.openrouter), false);
  });

  it('PUSH_NATIVE_FC=false forces off', () => {
    process.env.PUSH_NATIVE_FC = 'false';
    assert.equal(resolveNativeFC(PROVIDER_CONFIGS.mistral), false);
  });

  it('PUSH_NATIVE_FC=1 forces on even for ollama', () => {
    process.env.PUSH_NATIVE_FC = '1';
    assert.equal(resolveNativeFC(PROVIDER_CONFIGS.ollama), true);
  });

  it('PUSH_NATIVE_FC=true forces on', () => {
    process.env.PUSH_NATIVE_FC = 'true';
    assert.equal(resolveNativeFC(PROVIDER_CONFIGS.ollama), true);
  });
});
