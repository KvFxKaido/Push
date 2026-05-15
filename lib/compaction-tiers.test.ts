import { describe, expect, it } from 'vitest';
import {
  applyTiers,
  createDefaultTiers,
  createDropOldestPairsTier,
  createDropToolOutputsTier,
  createSemanticCompactTier,
  type CompactionContext,
  type CompactionTierMessage,
} from './compaction-tiers.ts';

interface TestMessage extends CompactionTierMessage {
  id?: string;
}

// Token estimator: 1 char ≈ 1 token. Trivial but deterministic for
// tests; production callers pass a real estimator.
function charCountEstimator(messages: TestMessage[]): number {
  let n = 0;
  for (const m of messages) n += m.content.length;
  return n;
}

function ctx(budget: number, preserveTail = 2, preserveHead = 1): CompactionContext {
  return { budget, estimate: charCountEstimator, preserveTail, preserveHead };
}

const sys = (content: string): TestMessage => ({ role: 'system', content });
const usr = (content: string): TestMessage => ({ role: 'user', content });
const ast = (content: string): TestMessage => ({ role: 'assistant', content });
const toolResult = (content: string): TestMessage => ({
  role: 'user',
  content,
  isToolResult: true,
});
const toolCall = (content: string): TestMessage => ({
  role: 'assistant',
  content,
  isToolCall: true,
});

describe('applyTiers — no-op when already under budget', () => {
  it('returns unchanged messages and empty trace when fits', () => {
    const messages = [sys('S'.repeat(10)), usr('u'.repeat(10))];
    const result = applyTiers(messages, ctx(1000), createDefaultTiers());
    expect(result.messages).toBe(messages);
    expect(result.trace.fits).toBe(true);
    expect(result.trace.tiersAttempted).toEqual([]);
    expect(result.trace.tiersApplied).toEqual([]);
  });
});

describe('createDropToolOutputsTier', () => {
  it('drops old tool outputs but keeps the latest N', () => {
    const tier = createDropToolOutputsTier<TestMessage>({ keepLatestN: 1 });
    const messages = [
      sys('SYS'),
      toolCall('call-1'),
      toolResult('result-1 long content '.repeat(20)),
      toolCall('call-2'),
      toolResult('result-2 long content '.repeat(20)),
      toolCall('call-3'),
      toolResult('result-3 long content '.repeat(20)),
      usr('final'),
    ];
    const result = tier.apply(messages, ctx(100, 1, 1));
    // tail of 1 protects the user 'final'. Latest tool result inside
    // the window (result-3) is kept; older two (result-1, result-2)
    // are dropped. Their corresponding tool calls survive.
    const remainingToolResults = result.messages.filter((m) => m.isToolResult);
    expect(remainingToolResults).toHaveLength(1);
    expect(remainingToolResults[0].content).toContain('result-3');
    expect(result.applied).toBe(true);
    expect(result.savedChars).toBeGreaterThan(0);
  });

  it('preserves system prompt + recent tail untouched', () => {
    const tier = createDropToolOutputsTier<TestMessage>({ keepLatestN: 0 });
    const messages = [
      sys('SYSTEM'),
      toolResult('old result'),
      toolResult('mid result'),
      toolResult('newest result'),
    ];
    // preserveHead=1 → sys protected; preserveTail=2 → last two tool
    // results protected. Only the middle one is in the touchable
    // window and gets dropped.
    const result = tier.apply(messages, ctx(50, 2, 1));
    const contents = result.messages.map((m) => m.content);
    expect(contents).toContain('SYSTEM');
    expect(contents).toContain('newest result');
    expect(contents).toContain('mid result');
    expect(contents).not.toContain('old result');
  });
});

describe('createSemanticCompactTier', () => {
  it('rewrites verbose tool results through compactMessage', () => {
    const tier = createSemanticCompactTier<TestMessage>();
    const messages = [
      sys('SYS'),
      toolResult(
        [
          '[Tool Result — sandbox_exec]',
          'Status: ok',
          'Exit code: 0',
          'Stdout: line 1',
          'Stdout: line 2',
          'Stdout: line 3',
          'Stdout: line 4',
          'a very long blob '.repeat(50),
        ].join('\n'),
      ),
      usr('final'),
    ];
    const before = messages[1].content.length;
    const result = tier.apply(messages, ctx(50, 1, 1));
    expect(result.applied).toBe(true);
    expect(result.messages[1].content.length).toBeLessThan(before);
    // Header survives; summary contains the load-bearing prefixes.
    expect(result.messages[1].content).toContain('[Tool Result');
  });
});

describe('createDropOldestPairsTier', () => {
  it('drops oldest assistant+tool-result pairs together', () => {
    const tier = createDropOldestPairsTier<TestMessage>();
    const messages = [
      sys('SYS'),
      toolCall('call-A'),
      toolResult('result-A'),
      toolCall('call-B'),
      toolResult('result-B'),
      ast('latest assistant'),
      usr('latest user'),
    ];
    // Budget is small. Tail of 2 protects 'latest user' + 'latest
    // assistant'. Drop-pair walks from the head of the touchable
    // window: drops (call-A, result-A) together, then (call-B,
    // result-B). Each iteration re-checks budget.
    const result = tier.apply(messages, ctx(30, 2, 1));
    const contents = result.messages.map((m) => m.content);
    expect(contents).toContain('SYS');
    expect(contents).toContain('latest user');
    expect(contents).not.toContain('call-A');
    expect(contents).not.toContain('result-A');
    expect(result.applied).toBe(true);
  });
});

describe('applyTiers — cheap-first ordering', () => {
  it('stops at the first tier that fits the budget', () => {
    const messages = [
      sys('SYS'),
      toolCall('call-1'),
      toolResult('x'.repeat(500)),
      toolCall('call-2'),
      toolResult('y'.repeat(500)),
      toolCall('call-3'),
      toolResult('z'.repeat(500)),
      usr('q'),
    ];
    // Default `keepLatestN: 2` means the drop tier shaves the oldest
    // tool result (x*500) and leaves the two newer ones. Budget set so
    // post-drop fits, semantic-compact and drop-pairs should not run.
    const tiers = createDefaultTiers<TestMessage>();
    const result = applyTiers(messages, ctx(1100, 1, 1), tiers);
    expect(result.trace.fits).toBe(true);
    expect(result.trace.tiersApplied).toEqual(['drop-old-tool-outputs']);
    expect(result.trace.tiersAttempted).toEqual(['drop-old-tool-outputs']);
  });

  it('falls through to semantic compact when drop alone is not enough', () => {
    const messages = [
      sys('SYS'),
      toolResult(
        [
          '[Tool Result — sandbox_read_file]',
          'Path: a.ts',
          'Status: ok',
          'big content '.repeat(80),
        ].join('\n'),
      ),
      usr('q'),
    ];
    const tiers = createDefaultTiers<TestMessage>();
    // Drop tier can't help (only one tool result, in the keep-latest
    // window). Semantic compact should rewrite it.
    const result = applyTiers(messages, ctx(120, 1, 1), tiers);
    expect(result.trace.tiersApplied).toContain('semantic-compact');
  });

  it('uses hard fallback only when both cheaper tiers fall short', () => {
    const messages = [
      sys('SYS'),
      toolCall('c'),
      toolResult('x'.repeat(200)),
      toolCall('d'),
      toolResult('y'.repeat(200)),
      usr('final'),
    ];
    const tiers = createDefaultTiers<TestMessage>();
    // Tight budget — semantic shrink might help but won't be enough;
    // drop-pairs should run last.
    const result = applyTiers(messages, ctx(20, 1, 1), tiers);
    expect(result.trace.tiersApplied).toContain('drop-oldest-pairs');
  });

  it('accumulates savedChars across tiers', () => {
    const messages = [
      sys('SYS'),
      toolResult('verbose '.repeat(50)),
      toolResult('more verbose '.repeat(50)),
      usr('q'),
    ];
    const result = applyTiers(messages, ctx(30, 1, 1), createDefaultTiers());
    expect(result.trace.totalSavedChars).toBeGreaterThan(0);
  });

  it('respects preserveHead by not touching the system prompt', () => {
    const messages = [sys('S'.repeat(200)), toolResult('verbose '.repeat(50)), usr('q')];
    const result = applyTiers(messages, ctx(20, 1, 1), createDefaultTiers());
    expect(result.messages[0].content).toBe('S'.repeat(200));
  });

  it('preserves the most recent tail messages verbatim', () => {
    const messages = [
      sys('SYS'),
      toolResult('old '.repeat(50)),
      toolResult('mid '.repeat(50)),
      ast('most recent assistant — must be preserved exactly'),
      usr('most recent user — must be preserved exactly'),
    ];
    const result = applyTiers(messages, ctx(40, 2, 1), createDefaultTiers());
    const last = result.messages[result.messages.length - 1];
    const secondLast = result.messages[result.messages.length - 2];
    expect(last.content).toBe('most recent user — must be preserved exactly');
    expect(secondLast.content).toBe('most recent assistant — must be preserved exactly');
  });
});

describe('CompactionTrace shape', () => {
  it('is empty when no tiering happens', () => {
    const result = applyTiers([sys('x'), usr('y')], ctx(1000), createDefaultTiers());
    expect(result.trace).toEqual({
      tiersAttempted: [],
      tiersApplied: [],
      totalSavedChars: 0,
      fits: true,
    });
  });

  it('reports fits=false when even all tiers cannot meet the budget', () => {
    const messages = [sys('S'.repeat(1000)), ast('assistant final'), usr('user final')];
    // preserveTail=2 keeps last two, preserveHead=1 keeps sys; no
    // touchable window. Budget is too small. fits should be false.
    const result = applyTiers(messages, ctx(10, 2, 1), createDefaultTiers());
    expect(result.trace.fits).toBe(false);
  });
});
