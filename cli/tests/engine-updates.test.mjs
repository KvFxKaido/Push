import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEmptySuccessFinalizationMessage,
  buildMaxRoundsFinalizationMessage,
  buildSystemPrompt,
  buildSystemPromptBase,
  buildToolResultMessage,
} from '../engine.ts';

// ─── buildToolResultMessage: working memory deduplication ────────

describe('buildToolResultMessage', () => {
  const call = { tool: 'read_file', args: { path: 'foo.txt' } };
  const result = { ok: true, text: 'file contents here', meta: null, structuredError: null };

  it('includes workingMemory when present in meta envelope', () => {
    const wm = {
      plan: 'do stuff',
      openTasks: [],
      filesTouched: [],
      assumptions: [],
      errorsEncountered: [],
    };
    const meta = { runId: 'r1', round: 1, contextChars: 100, ledger: {}, workingMemory: wm };
    const msg = buildToolResultMessage(call, result, meta);

    assert.ok(msg.includes('[TOOL_RESULT]'));
    assert.ok(msg.includes('[/TOOL_RESULT]'));
    assert.ok(msg.includes('"workingMemory"'));
    assert.ok(msg.includes('"do stuff"'));
  });

  it('omits workingMemory when not in meta envelope', () => {
    const meta = { runId: 'r1', round: 1, contextChars: 200, ledger: {} };
    const msg = buildToolResultMessage(call, result, meta);

    assert.ok(msg.includes('[meta]'));
    assert.ok(!msg.includes('"workingMemory"'));
    // Other fields should still be present
    assert.ok(msg.includes('"runId"'));
    assert.ok(msg.includes('"round"'));
    assert.ok(msg.includes('"contextChars"'));
  });

  it('returns valid message with no meta envelope', () => {
    const msg = buildToolResultMessage(call, result);
    assert.ok(msg.includes('[TOOL_RESULT]'));
    assert.ok(msg.includes('[/TOOL_RESULT]'));
    assert.ok(!msg.includes('[meta]'));
  });

  it('includes contextChars in meta envelope', () => {
    const meta = { runId: 'r1', round: 1, contextChars: 42000, ledger: {} };
    const msg = buildToolResultMessage(call, result, meta);

    const metaMatch = msg.match(/\[meta\] (.+)/);
    assert.ok(metaMatch, 'should have a [meta] line');
    const parsed = JSON.parse(metaMatch[1]);
    assert.equal(parsed.contextChars, 42000);
  });
});

describe('buildMaxRoundsFinalizationMessage', () => {
  it('asks for a final no-tool summary instead of another tool round', () => {
    const message = buildMaxRoundsFinalizationMessage(8, ['web_search', 'exec']);

    assert.ok(message.includes('[MAX_ROUNDS_REACHED]'));
    assert.ok(message.includes('Do not call any more tools'));
    assert.ok(message.includes('web_search, exec'));
    assert.ok(message.includes('what may be incomplete'));
  });
});

describe('buildEmptySuccessFinalizationMessage', () => {
  it('asks for a self-contained summary when the model exited empty', () => {
    const message = buildEmptySuccessFinalizationMessage(['read_file', 'list_dir']);

    assert.ok(message.includes('[FINAL_SUMMARY_REQUEST]'));
    assert.ok(message.includes('Do not call any more tools'));
    assert.ok(message.includes('read_file, list_dir'));
    // Mentions persistence so the model knows the summary is not
    // ephemeral — small models tend to write more substantively
    // when they're told the output will be reused.
    assert.ok(message.includes('persisted for retrieval'));
    assert.ok(message.includes('self-contained'));
  });

  it('handles the no-tools-used case', () => {
    const message = buildEmptySuccessFinalizationMessage([]);
    assert.ok(message.includes('Tools used during this run: none'));
  });
});

// ─── buildSystemPrompt: async, contains TOOL_PROTOCOL ───────────

describe('buildSystemPrompt', () => {
  it('preserves the workspace-pending sentinel in the base prompt', () => {
    const prompt = buildSystemPromptBase('/tmp/test-workspace');
    assert.ok(prompt.includes('[WORKSPACE_PENDING]'));
    assert.ok(prompt.includes('TOOL PROTOCOL'));
  });

  it('returns a string containing TOOL PROTOCOL', async () => {
    const prompt = await buildSystemPrompt('/tmp/test-workspace');
    assert.equal(typeof prompt, 'string');
    assert.ok(prompt.includes('TOOL PROTOCOL'), 'should contain TOOL PROTOCOL header');
    assert.ok(!prompt.includes('[WORKSPACE_PENDING]'));
  });

  it('includes workspace root in prompt', async () => {
    const prompt = await buildSystemPrompt('/home/user/myproject');
    assert.ok(prompt.includes('/home/user/myproject'));
  });

  it('includes core instructions', async () => {
    const prompt = await buildSystemPrompt('/tmp/test');
    assert.ok(prompt.includes('Use tools for facts'));
    assert.ok(prompt.includes('coder_update_state'));
  });
});

// ─── contextChars calculation ───────────────────────────────────

describe('contextChars calculation', () => {
  it('sums character lengths of string message content', () => {
    const messages = [
      { role: 'system', content: 'You are a helper.' }, // 17
      { role: 'user', content: 'Hello' }, // 5
      { role: 'assistant', content: 'Hi there!' }, // 9
    ];

    const contextChars = messages.reduce(
      (sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0),
      0,
    );

    assert.equal(contextChars, 31);
  });

  it('ignores non-string content', () => {
    const messages = [
      { role: 'system', content: 'abc' },
      { role: 'user', content: null },
      { role: 'assistant', content: undefined },
      { role: 'user', content: 12345 },
      { role: 'user', content: 'de' },
    ];

    const contextChars = messages.reduce(
      (sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0),
      0,
    );

    assert.equal(contextChars, 5);
  });

  it('returns 0 for empty messages array', () => {
    const messages = [];

    const contextChars = messages.reduce(
      (sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0),
      0,
    );

    assert.equal(contextChars, 0);
  });
});
