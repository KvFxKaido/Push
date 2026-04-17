import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldDistillMidSession, buildParseErrorMessage } from '../engine.ts';

// ─── shouldDistillMidSession ────────────────────────────────────

describe('shouldDistillMidSession', () => {
  // Default budget: targetTokens = 60_000, half = 30_000.
  // Token estimate: ceil(text.length / 3.5) + 4 per message.
  // To exceed 30k tokens we need messages whose total estimated tokens > 30_000.

  const planMemory = {
    plan: 'Step 1: read files. Step 2: implement.',
    openTasks: [],
    filesTouched: [],
    assumptions: [],
    errorsEncountered: [],
  };

  const emptyPlanMemory = {
    plan: '',
    openTasks: [],
    filesTouched: [],
    assumptions: [],
    errorsEncountered: [],
  };

  // Build messages that produce large token estimates.
  // Each char ≈ 1/3.5 tokens + 4 overhead. A 100_000-char message ≈ 28_575 tokens.
  // Two of those ≈ 57_150 tokens, well over the 30k threshold.
  const bigMessages = [
    { role: 'user', content: 'x'.repeat(100_000) },
    { role: 'assistant', content: 'y'.repeat(100_000) },
  ];

  const smallMessages = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
  ];

  it('returns false when round <= 4', () => {
    assert.equal(shouldDistillMidSession(bigMessages, planMemory, 1, 'anthropic', 'claude'), false);
    assert.equal(shouldDistillMidSession(bigMessages, planMemory, 4, 'anthropic', 'claude'), false);
  });

  it('returns false when workingMemory has no plan', () => {
    assert.equal(shouldDistillMidSession(bigMessages, undefined, 5, 'anthropic', 'claude'), false);
    assert.equal(
      shouldDistillMidSession(bigMessages, emptyPlanMemory, 5, 'anthropic', 'claude'),
      false,
    );
    assert.equal(
      shouldDistillMidSession(bigMessages, { plan: '   ' }, 5, 'anthropic', 'claude'),
      false,
    );
  });

  it('returns false when plan exists but tokens are under half budget', () => {
    assert.equal(
      shouldDistillMidSession(smallMessages, planMemory, 5, 'anthropic', 'claude'),
      false,
    );
  });

  it('returns true when round > 4, plan exists, and tokens exceed half budget', () => {
    assert.equal(shouldDistillMidSession(bigMessages, planMemory, 5, 'anthropic', 'claude'), true);
    assert.equal(shouldDistillMidSession(bigMessages, planMemory, 10, 'anthropic', 'claude'), true);
  });
});

// ─── buildParseErrorMessage ─────────────────────────────────────

describe('buildParseErrorMessage', () => {
  it('wraps a single malformed entry', () => {
    const msg = buildParseErrorMessage([{ reason: 'missing tool', sample: '{"args":{}}' }]);
    assert.ok(msg.startsWith('[TOOL_CALL_PARSE_ERROR]'));
    assert.ok(msg.trimEnd().endsWith('[/TOOL_CALL_PARSE_ERROR]'));
    assert.ok(msg.includes('missing tool'));
    assert.ok(msg.includes('args'));
  });

  it('wraps multiple malformed entries', () => {
    const entries = [
      { reason: 'no tool key', sample: '{bad}' },
      { reason: 'invalid json', sample: 'not json' },
    ];
    const msg = buildParseErrorMessage(entries);
    assert.ok(msg.includes('no tool key'));
    assert.ok(msg.includes('invalid json'));
    assert.ok(msg.includes('not json'));
  });

  it('includes guidance text about strict JSON fenced blocks', () => {
    const msg = buildParseErrorMessage([{ reason: 'test', sample: 's' }]);
    assert.ok(msg.includes('Emit strict JSON fenced blocks'));
  });

  it('includes malformed_tool_call reason field', () => {
    const msg = buildParseErrorMessage([{ reason: 'r', sample: 's' }]);
    const inner = JSON.parse(
      msg.replace('[TOOL_CALL_PARSE_ERROR]\n', '').replace('\n[/TOOL_CALL_PARSE_ERROR]', ''),
    );
    assert.equal(inner.reason, 'malformed_tool_call');
    assert.ok(Array.isArray(inner.malformed));
    assert.equal(inner.malformed.length, 1);
    assert.equal(inner.malformed[0].reason, 'r');
    assert.equal(inner.malformed[0].sample, 's');
  });
});
