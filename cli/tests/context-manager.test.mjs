import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateTokens,
  estimateMessageTokens,
  estimateContextTokens,
  getContextBudget,
  isToolResultMessage,
  isParseErrorMessage,
  compactContext,
  distillContext,
} from '../context-manager.ts';

// ─── Helpers ─────────────────────────────────────────────────────

function makeSystemMsg(chars = 500) {
  return { role: 'system', content: 'S'.repeat(chars) };
}

function makeUserMsg(text = 'Hello') {
  return { role: 'user', content: text };
}

function makeAssistantMsg(text = 'Sure, let me help.') {
  return { role: 'assistant', content: text };
}

function makeToolResult(toolName, chars = 200) {
  const payload = JSON.stringify(
    {
      tool: toolName,
      ok: true,
      output: 'X'.repeat(Math.max(0, chars - 80)),
      meta: null,
      structuredError: null,
    },
    null,
    2,
  );
  return { role: 'user', content: `[TOOL_RESULT]\n${payload}\n[/TOOL_RESULT]` };
}

/**
 * Assistant message followed by a tool-result — simulates one tool-loop round.
 */
function makeToolPair(toolName, chars = 200) {
  return [makeAssistantMsg(`Let me use ${toolName}.`), makeToolResult(toolName, chars)];
}

/**
 * Build a message array that exceeds the given token target.
 * System + first user + N tool pairs.
 */
function buildOverBudgetMessages(targetTokens, pairCount = 20, charsPerResult = 2000) {
  const msgs = [makeSystemMsg(1000), makeUserMsg('Please fix the bug.')];
  for (let i = 0; i < pairCount; i++) {
    msgs.push(...makeToolPair(`tool_${i}`, charsPerResult));
  }
  // Pad until over target
  while (estimateContextTokens(msgs) <= targetTokens) {
    msgs.push(...makeToolPair('read_file', charsPerResult));
  }
  return msgs;
}

// ─── estimateTokens ──────────────────────────────────────────────

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    assert.equal(estimateTokens(''), 0);
  });

  it('estimates tokens for typical text', () => {
    // Short text (< 200 chars) uses a tighter 3.2 chars/token rate
    // because the content-aware sampler isn't worth running on tiny inputs.
    const text = 'Hello, world!'; // 13 chars → ceil(13/3.2) = 5
    assert.equal(estimateTokens(text), Math.ceil(13 / 3.2));
  });

  it('returns 0 for non-string input', () => {
    assert.equal(estimateTokens(null), 0);
    assert.equal(estimateTokens(undefined), 0);
    assert.equal(estimateTokens(12345), 0);
  });

  it('handles long text proportionally', () => {
    const text = 'a'.repeat(3500);
    assert.equal(estimateTokens(text), 1000);
  });
});

// ─── estimateMessageTokens ──────────────────────────────────────

describe('estimateMessageTokens', () => {
  it('adds 4-token overhead to content estimate', () => {
    const msg = { role: 'user', content: 'Hi' }; // ceil(2/3.5) + 4 = 5
    assert.equal(estimateMessageTokens(msg), Math.ceil(2 / 3.5) + 4);
  });

  it('handles empty content', () => {
    const msg = { role: 'user', content: '' };
    assert.equal(estimateMessageTokens(msg), 4); // 0 + 4 overhead
  });
});

// ─── getContextBudget ───────────────────────────────────────────

describe('getContextBudget', () => {
  // The CLI consumes the shared lib/context-budget resolver, which derives a
  // budget from the guessed window (TARGET_RATIO = 0.85, MAX_RATIO = 0.92) and
  // caps summarizeTokens at the 88K default target.

  it('returns default budget when no name pattern matches', () => {
    const budget = getContextBudget('fireworks', 'totally-unknown-model');
    assert.equal(budget.targetTokens, 88_000);
    assert.equal(budget.maxTokens, 100_000);
    assert.equal(budget.summarizeTokens, 88_000);
  });

  it('derives a 1M-class budget for Gemini regardless of provider', () => {
    const expected = {
      maxTokens: Math.floor(1_048_576 * 0.92),
      targetTokens: Math.floor(1_048_576 * 0.85),
      summarizeTokens: 88_000,
      // Patient handoff trigger: clamp(0.7·1,048,576, 88K, 400K ceiling) = 400K (§14).
      handoffTokens: 400_000,
    };
    assert.deepEqual(getContextBudget('ollama', 'gemini-3-flash-preview'), expected);
    assert.deepEqual(getContextBudget('openrouter', 'google/gemini-3.1-pro-preview'), expected);
    assert.deepEqual(getContextBudget('zen', 'gemini-3-flash'), expected);
    // Provider doesn't gate Gemini detection — the name match wins.
    assert.deepEqual(getContextBudget('fireworks', 'gemini-3-flash-preview'), expected);
  });

  it('matches gemini variants case-insensitively', () => {
    const budget = getContextBudget('ollama', 'Gemini-3-Flash-Preview');
    assert.equal(budget.targetTokens, Math.floor(1_000_000 * 0.85));
  });

  it('matches model names containing gemini', () => {
    const budget = getContextBudget('ollama', 'my-gemini-3-flash-custom');
    assert.equal(budget.targetTokens, Math.floor(1_000_000 * 0.85));
  });

  it('strips OpenRouter routing suffixes (:nitro, :free, :beta) before matching', () => {
    const budget = getContextBudget('openrouter', 'google/gemini-3.1-pro-preview:nitro');
    assert.equal(budget.targetTokens, Math.floor(1_048_576 * 0.85));
  });

  it('uses declared metadata for provider-private ids that have no name fallback', () => {
    const budget = getContextBudget('zen', 'big-pickle');
    assert.equal(budget.targetTokens, Math.floor(200_000 * 0.85));
    assert.equal(budget.maxTokens, Math.floor(200_000 * 0.92));
  });

  it('uses declared metadata before broad name-pattern fallbacks', () => {
    const budget = getContextBudget('openai', 'gpt-5.4-mini');
    assert.equal(budget.targetTokens, Math.floor(400_000 * 0.85));
    assert.equal(budget.maxTokens, Math.floor(400_000 * 0.92));
  });

  it('returns default budget when model is undefined', () => {
    const budget = getContextBudget('ollama', undefined);
    assert.equal(budget.targetTokens, 88_000);
  });

  it('derives a 1M-class budget for non-Haiku Claude models', () => {
    const budget = getContextBudget('openrouter', 'anthropic/claude-sonnet-4.6');
    assert.equal(budget.targetTokens, Math.floor(1_000_000 * 0.85));
    assert.equal(budget.maxTokens, Math.floor(1_000_000 * 0.92));
  });

  it('derives a 200K budget for Claude Haiku', () => {
    const budget = getContextBudget('openrouter', 'anthropic/claude-haiku-4.5');
    assert.equal(budget.targetTokens, Math.floor(200_000 * 0.85));
    assert.equal(budget.maxTokens, Math.floor(200_000 * 0.92));
  });

  it('derives a 256K budget for Kimi/Moonshot models', () => {
    // 262,144 = 256 KiB — the window Workers AI serves and Moonshot's native
    // size (was previously the 256,000 decimal approximation).
    const budget = getContextBudget('openrouter', 'moonshotai/kimi-k2');
    assert.equal(budget.targetTokens, Math.floor(262_144 * 0.85));
    assert.equal(budget.maxTokens, Math.floor(262_144 * 0.92));
  });

  it('derives a 2M-class budget for Grok models', () => {
    const budget = getContextBudget('openrouter', 'x-ai/grok-4.20');
    assert.equal(budget.targetTokens, Math.floor(2_000_000 * 0.85));
    assert.equal(budget.maxTokens, Math.floor(2_000_000 * 0.92));
  });

  it('derives a 1M-class budget for GPT-5 models', () => {
    const budget = getContextBudget('openrouter', 'openai/gpt-5.4');
    assert.equal(budget.targetTokens, Math.floor(1_050_000 * 0.85));
    assert.equal(budget.maxTokens, Math.floor(1_050_000 * 0.92));
  });

  it('derives a 1M-class budget for DeepSeek v4 family', () => {
    const budget = getContextBudget('ollama', 'deepseek-v4-pro');
    assert.equal(budget.targetTokens, Math.floor(1_000_000 * 0.85));
  });

  it('derives a 128K budget for older DeepSeek models', () => {
    const budget = getContextBudget('ollama', 'deepseek-v3.2');
    assert.equal(budget.targetTokens, Math.floor(128_000 * 0.85));
  });

  it('returns a new object each call (no shared mutation)', () => {
    const a = getContextBudget('ollama', 'test');
    const b = getContextBudget('ollama', 'test');
    assert.notEqual(a, b);
    a.targetTokens = 0;
    assert.equal(b.targetTokens, 88_000);
  });
});

// ─── isToolResultMessage / isParseErrorMessage ──────────────────

describe('message detection', () => {
  it('detects tool result messages', () => {
    assert.equal(isToolResultMessage(makeToolResult('read_file')), true);
    assert.equal(isToolResultMessage(makeUserMsg('Hello')), false);
    assert.equal(isToolResultMessage(makeAssistantMsg('[TOOL_RESULT]')), false); // wrong role
  });

  it('detects parse error messages', () => {
    const parseErr = {
      role: 'user',
      content: '[TOOL_CALL_PARSE_ERROR]\n{"reason":"bad"}\n[/TOOL_CALL_PARSE_ERROR]',
    };
    assert.equal(isParseErrorMessage(parseErr), true);
    assert.equal(isParseErrorMessage(makeUserMsg('Hello')), false);
  });
});

// ─── compactContext: user-triggered compaction ─────────────────────

describe('compactContext', () => {
  it('compacts older messages into a single digest while preserving last N turns', () => {
    const msgs = [
      makeSystemMsg(200),
      makeUserMsg('Turn 1 user'),
      makeAssistantMsg('Turn 1 assistant'),
      makeToolResult('read_file', 1200),
      makeUserMsg('Turn 2 user'),
      makeAssistantMsg('Turn 2 assistant'),
      makeToolResult('search_files', 1200),
      makeUserMsg('Turn 3 user'),
      makeAssistantMsg('Turn 3 assistant'),
    ];

    const result = compactContext(msgs, { preserveTurns: 1 });

    assert.equal(result.compacted, true);
    assert.equal(result.totalTurns, 3);
    assert.equal(result.preserveTurns, 1);
    assert.equal(result.compactedCount, 5);
    assert.ok(result.afterTokens < result.beforeTokens, 'token count should decrease');

    const digestIdx = result.messages.findIndex((m) => m.content.includes('[CONTEXT DIGEST]'));
    assert.ok(digestIdx >= 0, 'should include a context digest message');
    assert.equal(result.messages[0].role, 'system');
    assert.equal(
      result.messages[1].content,
      'Turn 1 user',
      'first user message should be preserved',
    );
    assert.ok(
      result.messages.some((m) => m.content === 'Turn 3 user'),
      'latest user turn should be preserved',
    );
    assert.ok(
      result.messages.some((m) => m.content === 'Turn 3 assistant'),
      'latest assistant reply should be preserved',
    );
    assert.ok(
      !result.messages.some((m) => m.content === 'Turn 2 user'),
      'older middle turn should be compacted',
    );
  });

  it('returns a no-op copy when there are not enough turns to compact', () => {
    const msgs = [makeSystemMsg(100), makeUserMsg('Only turn'), makeAssistantMsg('Reply')];
    const result = compactContext(msgs, { preserveTurns: 3 });

    assert.equal(result.compacted, false);
    assert.equal(result.totalTurns, 1);
    assert.equal(result.messages.length, msgs.length);
    assert.notEqual(result.messages, msgs);
  });

  it('does not mutate original messages', () => {
    const msgs = [
      makeSystemMsg(100),
      makeUserMsg('Turn 1 user'),
      makeAssistantMsg('Turn 1 assistant'),
      makeUserMsg('Turn 2 user'),
      makeAssistantMsg('Turn 2 assistant'),
      makeUserMsg('Turn 3 user'),
      makeAssistantMsg('Turn 3 assistant'),
    ];
    const original = msgs.map((m) => ({ ...m }));

    compactContext(msgs, { preserveTurns: 1 });

    assert.deepEqual(msgs, original);
  });
});

// ─── distillContext ──────────────────────────────────────────────

describe('distillContext', () => {
  it('returns empty result for empty input', () => {
    const result = distillContext([]);
    assert.deepEqual(result.messages, []);
    assert.equal(result.distilled, false);
  });

  it('preserves system prompt at index 0', () => {
    const msgs = [makeSystemMsg(100), makeUserMsg('Hello'), makeAssistantMsg('Hi!')];
    const result = distillContext(msgs);
    assert.equal(result.messages[0]?.role, 'system');
    assert.equal(result.messages[0]?.content, msgs[0].content);
  });

  it('preserves first user message', () => {
    const msgs = [
      makeSystemMsg(100),
      makeUserMsg('Original request'),
      makeAssistantMsg('Sure!'),
      makeUserMsg('Follow up'),
    ];
    const result = distillContext(msgs);
    const firstUser = result.messages.find(
      (m) => m.role === 'user' && m.content === 'Original request',
    );
    assert.ok(firstUser, 'first user message should be preserved');
  });

  it('preserves latest working memory update (coder_update_state tool call)', () => {
    const workingMemoryMsg = {
      role: 'user',
      content:
        '[TOOL_RESULT]\n{"tool": "coder_update_state", "ok": true, "output": "Memory updated", "meta": {"workingMemory": {"plan": "Test plan"}}, "structuredError": null}\n[/TOOL_RESULT]',
    };
    const msgs = [
      makeSystemMsg(100),
      makeUserMsg('Hello'),
      makeAssistantMsg('Hi!'),
      workingMemoryMsg,
      makeUserMsg('Follow up'),
    ];
    const result = distillContext(msgs);
    const found = result.messages.some((m) => m.content.includes('"tool": "coder_update_state"'));
    assert.ok(found, 'latest working memory update should be preserved');
  });

  it('preserves tail messages (default last 10)', () => {
    const msgs = [makeSystemMsg(100), makeUserMsg('Start')];
    for (let i = 0; i < 20; i++) {
      msgs.push(makeAssistantMsg(`Reply ${i}`));
      msgs.push(makeUserMsg(`User ${i}`));
    }
    const result = distillContext(msgs);
    // Should preserve last 10 messages from tail
    assert.ok(result.messages.length >= 10, 'should preserve at least tail messages');
    // Last message should be included
    const lastMsg = msgs[msgs.length - 1];
    const found = result.messages.some((m) => m.content === lastMsg.content);
    assert.ok(found, 'last message should be in result');
  });

  it('maintains original order of preserved messages', () => {
    const msgs = [
      makeSystemMsg(100),
      makeUserMsg('First'),
      makeAssistantMsg('A'),
      makeUserMsg('Second'),
      makeAssistantMsg('B'),
      makeUserMsg('Third'),
    ];
    const result = distillContext(msgs);
    // Check that indices are in ascending order
    for (let i = 1; i < result.messages.length; i++) {
      const prevIdx = msgs.findIndex((m) => m.content === result.messages[i - 1].content);
      const currIdx = msgs.findIndex((m) => m.content === result.messages[i].content);
      assert.ok(currIdx > prevIdx, 'messages should maintain original order');
    }
  });

  it('respects custom tailSize option', () => {
    const msgs = [makeSystemMsg(100), makeUserMsg('Start')];
    for (let i = 0; i < 20; i++) {
      msgs.push(makeAssistantMsg(`Reply ${i}`));
      msgs.push(makeUserMsg(`User ${i}`));
    }
    const resultSmallTail = distillContext(msgs, { tailSize: 2 });
    const resultLargeTail = distillContext(msgs, { tailSize: 15 });
    // Larger tail should preserve more messages
    assert.ok(
      resultLargeTail.messages.length >= resultSmallTail.messages.length,
      'larger tailSize should preserve at least as many messages',
    );
  });

  it('handles messages without working memory updates', () => {
    const msgs = [
      makeSystemMsg(100),
      makeUserMsg('Hello'),
      makeAssistantMsg('Hi!'),
      makeToolResult('read_file', 100),
    ];
    const result = distillContext(msgs);
    assert.ok(result.messages.length > 0, 'should return messages even without working memory');
    assert.equal(result.messages[0].role, 'system', 'system prompt should still be preserved');
  });

  it('reports distilled: false when no messages were dropped', () => {
    const msgs = [makeSystemMsg(100), makeUserMsg('Hello'), makeAssistantMsg('Hi!')];
    const result = distillContext(msgs);
    assert.equal(result.distilled, false);
    assert.equal(result.messages.length, msgs.length);
  });

  it('reports distilled: true when messages were dropped', () => {
    const msgs = [makeSystemMsg(100), makeUserMsg('Start')];
    for (let i = 0; i < 20; i++) {
      msgs.push(makeAssistantMsg(`Reply ${i}`));
      msgs.push(makeUserMsg(`User ${i}`));
    }
    const result = distillContext(msgs);
    assert.equal(result.distilled, true);
    assert.ok(result.messages.length < msgs.length);
  });
});
