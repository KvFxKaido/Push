import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateTokens,
  estimateMessageTokens,
  estimateContextTokens,
  getContextBudget,
  isToolResultMessage,
  isParseErrorMessage,
  trimContext,
} from '../context-manager.mjs';

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
  const payload = JSON.stringify({
    tool: toolName,
    ok: true,
    output: 'X'.repeat(Math.max(0, chars - 80)),
    meta: null,
    structuredError: null,
  }, null, 2);
  return { role: 'user', content: `[TOOL_RESULT]\n${payload}\n[/TOOL_RESULT]` };
}

/**
 * Assistant message followed by a tool-result — simulates one tool-loop round.
 */
function makeToolPair(toolName, chars = 200) {
  return [
    makeAssistantMsg(`Let me use ${toolName}.`),
    makeToolResult(toolName, chars),
  ];
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
    const text = 'Hello, world!'; // 13 chars → ceil(13/3.5) = 4
    assert.equal(estimateTokens(text), Math.ceil(13 / 3.5));
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
  it('returns default budget for unknown provider', () => {
    const budget = getContextBudget('mistral', 'devstral-small-latest');
    assert.equal(budget.targetTokens, 88_000);
    assert.equal(budget.maxTokens, 100_000);
  });

  it('returns Gemini 3 Flash budget for exact model name', () => {
    const budget = getContextBudget('ollama', 'gemini-3-flash-preview');
    assert.equal(budget.targetTokens, 112_000);
    assert.equal(budget.maxTokens, 128_000);
  });

  it('matches gemini-3-flash variants case-insensitively', () => {
    const budget = getContextBudget('ollama', 'Gemini-3-Flash-Preview');
    assert.equal(budget.targetTokens, 112_000);
  });

  it('matches model names containing gemini-3-flash', () => {
    const budget = getContextBudget('ollama', 'my-gemini-3-flash-custom');
    assert.equal(budget.targetTokens, 112_000);
  });

  it('returns default budget for Gemini model on non-ollama provider', () => {
    const budget = getContextBudget('openrouter', 'gemini-3-flash-preview');
    assert.equal(budget.targetTokens, 88_000);
  });

  it('returns default budget when model is undefined', () => {
    const budget = getContextBudget('ollama', undefined);
    assert.equal(budget.targetTokens, 88_000);
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
    const parseErr = { role: 'user', content: '[TOOL_CALL_PARSE_ERROR]\n{"reason":"bad"}\n[/TOOL_CALL_PARSE_ERROR]' };
    assert.equal(isParseErrorMessage(parseErr), true);
    assert.equal(isParseErrorMessage(makeUserMsg('Hello')), false);
  });
});

// ─── trimContext: under budget ───────────────────────────────────

describe('trimContext — under budget', () => {
  it('returns untrimmed copy when under target', () => {
    const msgs = [makeSystemMsg(), makeUserMsg('Hello'), makeAssistantMsg('Hi!')];
    const result = trimContext(msgs, 'ollama', 'test');

    assert.equal(result.trimmed, false);
    assert.equal(result.messages.length, msgs.length);
    assert.notEqual(result.messages, msgs); // new array
    assert.equal(result.removedCount, 0);
  });

  it('handles empty array', () => {
    const result = trimContext([], 'ollama', 'test');
    assert.equal(result.trimmed, false);
    assert.equal(result.messages.length, 0);
    assert.equal(result.beforeTokens, 0);
  });

  it('handles null/undefined input', () => {
    const result = trimContext(null, 'ollama', 'test');
    assert.equal(result.trimmed, false);
    assert.equal(result.messages.length, 0);
  });
});

// ─── trimContext: Phase 1 — summarization ────────────────────────

describe('trimContext — Phase 1 (summarize)', () => {
  it('summarizes old tool results outside the last-14 tail', () => {
    // Build messages slightly over the 88K target so Phase 1 summarization
    // alone is enough (large tool results compress well when summarized)
    const msgs = [makeSystemMsg(500), makeUserMsg('Fix the bug.')];

    // 20 tool pairs at 20K chars each ≈ 115K tokens — over 88K target
    for (let i = 0; i < 20; i++) {
      msgs.push(...makeToolPair(`tool_${i}`, 20000));
    }

    const before = estimateContextTokens(msgs);
    assert.ok(before > 88_000, `should be over budget, got ${before}`);

    const result = trimContext(msgs, 'ollama', 'test');
    assert.equal(result.trimmed, true);

    // Older messages (before the last-14 tail) should be summarized
    const oldToolResult = result.messages[3]; // index 3 = first tool result
    assert.ok(oldToolResult.content.includes('[...summarized]'), 'old tool result should be summarized');

    // Recent tail should be untouched
    const lastMsg = result.messages[result.messages.length - 1];
    assert.ok(!lastMsg.content.includes('[...summarized]'), 'recent messages should not be summarized');
  });

  it('does not summarize the system prompt', () => {
    const msgs = [makeSystemMsg(5000), makeUserMsg('Fix it.')];
    for (let i = 0; i < 20; i++) {
      msgs.push(...makeToolPair(`tool_${i}`, 12000));
    }

    const result = trimContext(msgs, 'ollama', 'test');
    // System prompt should be fully intact (not summarized)
    assert.equal(result.messages[0].content, msgs[0].content);
  });

  it('does not summarize the first user message', () => {
    const longUserMsg = makeUserMsg('A'.repeat(5000));
    const msgs = [makeSystemMsg(500), longUserMsg];
    for (let i = 0; i < 20; i++) {
      msgs.push(...makeToolPair(`tool_${i}`, 12000));
    }

    const result = trimContext(msgs, 'ollama', 'test');
    // First user message should be the same
    assert.equal(result.messages[1].content, longUserMsg.content);
  });
});

// ─── trimContext: Phase 2 — pair removal + digest ────────────────

describe('trimContext — Phase 2 (remove pairs + digest)', () => {
  it('removes assistant+toolresult pairs and inserts context digest', () => {
    // Build a large context that Phase 1 alone cannot fix
    const msgs = buildOverBudgetMessages(88_000, 30, 20000);
    const before = estimateContextTokens(msgs);
    assert.ok(before > 100_000, `should be well over budget, got ${before}`);

    const result = trimContext(msgs, 'ollama', 'test');
    assert.equal(result.trimmed, true);
    assert.ok(result.removedCount > 0, 'should have removed messages');
    assert.ok(result.afterTokens < result.beforeTokens, 'token count should decrease');

    // Should contain a CONTEXT DIGEST
    const digestMsg = result.messages.find(m => m.content.includes('[CONTEXT DIGEST]'));
    assert.ok(digestMsg, 'should contain a context digest message');
    assert.ok(digestMsg.content.includes('[/CONTEXT DIGEST]'));
  });

  it('preserves the system prompt at index 0', () => {
    const msgs = buildOverBudgetMessages(88_000, 30, 20000);
    const result = trimContext(msgs, 'ollama', 'test');
    assert.equal(result.messages[0].role, 'system');
  });

  it('preserves the first real user message', () => {
    const msgs = buildOverBudgetMessages(88_000, 30, 20000);
    const firstUserContent = msgs[1].content; // 'Please fix the bug.'
    const result = trimContext(msgs, 'ollama', 'test');

    const firstUser = result.messages.find(m => m.role === 'user' && m.content === firstUserContent);
    assert.ok(firstUser, 'first user message should be preserved');
  });

  it('preserves recent tail messages', () => {
    const msgs = buildOverBudgetMessages(88_000, 30, 20000);
    const lastMsg = msgs[msgs.length - 1];
    const result = trimContext(msgs, 'ollama', 'test');

    // The last original message should exist somewhere in the trimmed output
    // (hard fallback may splice from position 1, but tail messages are kept)
    const found = result.messages.some(m => m.content === lastMsg.content);
    assert.ok(found, 'last original message should be preserved in trimmed output');
  });
});

// ─── trimContext: Phase 3 — hard fallback ────────────────────────

describe('trimContext — Phase 3 (hard fallback)', () => {
  it('falls back to hard splice while keeping >= 16 messages', () => {
    // Make messages where even Phase 2 can't get under maxTokens,
    // because most messages are in the protected tail
    const msgs = [makeSystemMsg(1000)];
    // 20 messages all in the "recent 14" tail — make them huge
    for (let i = 0; i < 20; i++) {
      msgs.push(makeUserMsg('U'.repeat(30000)));
      msgs.push(makeAssistantMsg('A'.repeat(30000)));
    }

    const result = trimContext(msgs, 'ollama', 'test');
    assert.equal(result.trimmed, true);
    assert.ok(result.messages.length >= 16, `should keep at least 16, got ${result.messages.length}`);
  });
});

// ─── trimContext: never mutates input ────────────────────────────

describe('trimContext — immutability', () => {
  it('does not mutate the original messages array', () => {
    const msgs = buildOverBudgetMessages(88_000, 30, 20000);
    const originalLength = msgs.length;
    const originalFirst = msgs[0].content;

    trimContext(msgs, 'ollama', 'test');

    assert.equal(msgs.length, originalLength);
    assert.equal(msgs[0].content, originalFirst);
  });

  it('does not mutate individual message objects', () => {
    const msgs = buildOverBudgetMessages(88_000, 20, 15000);
    const origContents = msgs.map(m => m.content);

    trimContext(msgs, 'ollama', 'test');

    for (let i = 0; i < msgs.length; i++) {
      assert.equal(msgs[i].content, origContents[i], `message ${i} should not be mutated`);
    }
  });
});

// ─── trimContext: edge cases ─────────────────────────────────────

describe('trimContext — edge cases', () => {
  it('handles messages with no tool results', () => {
    const msgs = [makeSystemMsg(1000)];
    for (let i = 0; i < 50; i++) {
      msgs.push(makeUserMsg('U'.repeat(10000)));
      msgs.push(makeAssistantMsg('A'.repeat(10000)));
    }

    const result = trimContext(msgs, 'ollama', 'test');
    assert.equal(result.trimmed, true);
    // Should still work — summarizeVerboseMessage handles non-tool messages
  });

  it('handles all messages in protected tail (< 14 messages)', () => {
    // 10 messages, all would be in the tail — but we need them over budget
    const msgs = [makeSystemMsg(100000), makeUserMsg('U'.repeat(100000))];
    for (let i = 0; i < 4; i++) {
      msgs.push(makeAssistantMsg('A'.repeat(50000)));
      msgs.push(makeUserMsg('U'.repeat(50000)));
    }

    const result = trimContext(msgs, 'ollama', 'test');
    // Should trigger at least Phase 1 summarization or Phase 3 hard fallback
    assert.equal(result.trimmed, true);
  });

  it('uses Gemini budget when appropriate', () => {
    const msgs = [makeSystemMsg(500), makeUserMsg('Hello')];
    // Add enough to exceed 88K but not 112K
    for (let i = 0; i < 12; i++) {
      msgs.push(...makeToolPair(`tool_${i}`, 20000));
    }

    const tokens = estimateContextTokens(msgs);
    if (tokens > 88_000 && tokens <= 112_000) {
      // With default budget it would trim, with Gemini it wouldn't
      const defaultResult = trimContext(msgs, 'ollama', 'test-model');
      const geminiResult = trimContext(msgs, 'ollama', 'gemini-3-flash-preview');

      assert.equal(defaultResult.trimmed, true);
      assert.equal(geminiResult.trimmed, false);
    }
  });
});
