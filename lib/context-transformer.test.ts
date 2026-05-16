import { describe, it, expect } from 'vitest';
import {
  transformContextBeforeLLM,
  type TransformContextOptions,
  type TransformableMessage,
} from './context-transformer';
import type { UserGoalAnchor } from './user-goal-anchor';

interface FakeMsg extends TransformableMessage {
  role: string;
  content: string;
  visibleToModel?: boolean;
}

const baseOptions: TransformContextOptions<FakeMsg> = {
  surface: 'web',
};

const sample = (overrides: Partial<FakeMsg>): FakeMsg => ({
  role: 'user',
  content: '',
  ...overrides,
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('transformContextBeforeLLM — determinism', () => {
  it('returns deep-equal results when called twice with the same input', () => {
    const messages: FakeMsg[] = [
      sample({ role: 'system', content: 'sys' }),
      sample({ role: 'user', content: 'first' }),
      sample({ role: 'assistant', content: 'reply' }),
      sample({ role: 'user', content: 'second' }),
    ];
    const out1 = transformContextBeforeLLM(messages, baseOptions);
    const out2 = transformContextBeforeLLM(messages, baseOptions);
    expect(out1).toEqual(out2);
  });

  it('does not mutate the input array', () => {
    const messages: FakeMsg[] = [
      sample({ role: 'user', content: 'a' }),
      sample({ role: 'user', content: 'b', visibleToModel: false }),
    ];
    const before = JSON.stringify(messages);
    transformContextBeforeLLM(messages, baseOptions);
    expect(JSON.stringify(messages)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Append-stability
// ---------------------------------------------------------------------------

describe('transformContextBeforeLLM — append-stability', () => {
  it('preserves the transformed prefix byte-for-byte when only appending', () => {
    const base: FakeMsg[] = [
      sample({ role: 'system', content: 'sys' }),
      sample({ role: 'user', content: 'first' }),
      sample({ role: 'assistant', content: 'reply' }),
    ];
    const extended: FakeMsg[] = [...base, sample({ role: 'user', content: 'second' })];

    const baseOut = transformContextBeforeLLM(base, baseOptions);
    const extOut = transformContextBeforeLLM(extended, baseOptions);

    expect(extOut.messages.slice(0, baseOut.messages.length)).toEqual(baseOut.messages);
  });

  it('shifts cacheBreakpointIndices forward (or holds) when only appending and no trim', () => {
    const base: FakeMsg[] = [
      sample({ role: 'user', content: 'first' }),
      sample({ role: 'assistant', content: 'reply' }),
    ];
    const extended: FakeMsg[] = [...base, sample({ role: 'user', content: 'second' })];

    const baseOut = transformContextBeforeLLM(base, baseOptions);
    const extOut = transformContextBeforeLLM(extended, baseOptions);

    if (!baseOut.rewriteApplied && !extOut.rewriteApplied) {
      const baseMaxIdx = Math.max(...baseOut.cacheBreakpointIndices, -1);
      const extMaxIdx = Math.max(...extOut.cacheBreakpointIndices, -1);
      expect(extMaxIdx).toBeGreaterThanOrEqual(baseMaxIdx);
    }
  });

  it('preserves prefix across many sequential appends', () => {
    const transcript: FakeMsg[] = [sample({ role: 'user', content: 'turn-0' })];
    let prevOut = transformContextBeforeLLM(transcript, baseOptions);

    for (let turn = 1; turn < 6; turn++) {
      transcript.push(sample({ role: 'assistant', content: `reply-${turn}` }));
      transcript.push(sample({ role: 'user', content: `turn-${turn}` }));
      const nextOut = transformContextBeforeLLM(transcript, baseOptions);
      expect(nextOut.messages.slice(0, prevOut.messages.length)).toEqual(prevOut.messages);
      prevOut = nextOut;
    }
  });
});

// ---------------------------------------------------------------------------
// filterVisibleStage
// ---------------------------------------------------------------------------

describe('transformContextBeforeLLM — filterVisible stage', () => {
  it('drops messages with visibleToModel: false', () => {
    const messages: FakeMsg[] = [
      sample({ role: 'user', content: 'visible' }),
      sample({ role: 'user', content: 'hidden', visibleToModel: false }),
      sample({ role: 'user', content: 'also visible' }),
    ];
    const out = transformContextBeforeLLM(messages, baseOptions);
    expect(out.messages.map((m) => m.content)).toEqual(['visible', 'also visible']);
  });

  it('keeps messages with visibleToModel: undefined or true', () => {
    const messages: FakeMsg[] = [
      sample({ role: 'user', content: 'a' }),
      sample({ role: 'user', content: 'b', visibleToModel: true }),
    ];
    const out = transformContextBeforeLLM(messages, baseOptions);
    expect(out.messages).toHaveLength(2);
  });

  it('skips filter when enableFilterVisible is false', () => {
    const messages: FakeMsg[] = [
      sample({ role: 'user', content: 'visible' }),
      sample({ role: 'user', content: 'hidden', visibleToModel: false }),
    ];
    const out = transformContextBeforeLLM(messages, {
      ...baseOptions,
      enableFilterVisible: false,
    });
    expect(out.messages).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// manageContext stage
// ---------------------------------------------------------------------------

describe('transformContextBeforeLLM — manageContext stage', () => {
  it('does not run when manageContext is not provided', () => {
    const messages: FakeMsg[] = [sample({ role: 'user', content: 'hello' })];
    const out = transformContextBeforeLLM(messages, baseOptions);
    expect(out.rewriteApplied).toBe(false);
    expect(out.messages).toEqual(messages);
  });

  it('records rewriteApplied when the bound manageContext reports compaction', () => {
    const messages: FakeMsg[] = [
      sample({ role: 'user', content: 'big' }),
      sample({ role: 'assistant', content: 'reply' }),
    ];
    const out = transformContextBeforeLLM(messages, {
      ...baseOptions,
      manageContext: (msgs) => ({
        messages: [sample({ role: 'user', content: '[digest]' }), ...msgs.slice(-1)],
        compactionApplied: true,
      }),
    });
    expect(out.rewriteApplied).toBe(true);
    expect(out.messages[0].content).toBe('[digest]');
  });

  it('skips manageContext when enableManageContext is false', () => {
    const messages: FakeMsg[] = [sample({ role: 'user', content: 'hello' })];
    let called = false;
    transformContextBeforeLLM(messages, {
      ...baseOptions,
      enableManageContext: false,
      manageContext: (msgs) => {
        called = true;
        return { messages: msgs, compactionApplied: false };
      },
    });
    expect(called).toBe(false);
  });

  it('runs filter before manageContext (filter sees full input, mgr sees filtered)', () => {
    const messages: FakeMsg[] = [
      sample({ role: 'user', content: 'visible' }),
      sample({ role: 'user', content: 'hidden', visibleToModel: false }),
      sample({ role: 'assistant', content: 'reply' }),
    ];
    let mgrSawCount = -1;
    transformContextBeforeLLM(messages, {
      ...baseOptions,
      manageContext: (msgs) => {
        mgrSawCount = msgs.length;
        return { messages: msgs, compactionApplied: false };
      },
    });
    expect(mgrSawCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// distill stage
// ---------------------------------------------------------------------------

describe('transformContextBeforeLLM — distill stage', () => {
  const trivialDistill = (msgs: FakeMsg[]) => ({
    messages: msgs.length > 3 ? [msgs[0], ...msgs.slice(-2)] : msgs,
    distilled: msgs.length > 3,
  });

  it('does not run when enableDistillation is false (default)', () => {
    const messages: FakeMsg[] = Array.from({ length: 10 }, (_, i) =>
      sample({ role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}` }),
    );
    const out = transformContextBeforeLLM(messages, {
      ...baseOptions,
      distill: trivialDistill,
    });
    expect(out.messages).toHaveLength(10);
    expect(out.rewriteApplied).toBe(false);
  });

  it('does not run when distill is missing even if enableDistillation is true', () => {
    const messages: FakeMsg[] = [sample({ role: 'user', content: 'a' })];
    const out = transformContextBeforeLLM(messages, {
      ...baseOptions,
      enableDistillation: true,
    });
    expect(out.messages).toEqual(messages);
    expect(out.rewriteApplied).toBe(false);
  });

  it('runs when both enableDistillation and distill are provided', () => {
    const messages: FakeMsg[] = Array.from({ length: 6 }, (_, i) =>
      sample({ role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}` }),
    );
    const out = transformContextBeforeLLM(messages, {
      ...baseOptions,
      enableDistillation: true,
      distill: trivialDistill,
    });
    expect(out.messages).toHaveLength(3);
    expect(out.rewriteApplied).toBe(true);
  });

  it('reports rewriteApplied: false when distill is a no-op', () => {
    const messages: FakeMsg[] = [
      sample({ role: 'user', content: 'a' }),
      sample({ role: 'assistant', content: 'b' }),
    ];
    const out = transformContextBeforeLLM(messages, {
      ...baseOptions,
      enableDistillation: true,
      distill: trivialDistill,
    });
    expect(out.messages).toEqual(messages);
    expect(out.rewriteApplied).toBe(false);
  });

  it('runs filter before distill (distill sees the visible subset)', () => {
    const messages: FakeMsg[] = [
      sample({ role: 'user', content: 'visible' }),
      sample({ role: 'user', content: 'hidden', visibleToModel: false }),
      sample({ role: 'assistant', content: 'reply' }),
      sample({ role: 'user', content: 'tail' }),
    ];
    let distillSawCount = -1;
    transformContextBeforeLLM(messages, {
      ...baseOptions,
      enableDistillation: true,
      distill: (msgs) => {
        distillSawCount = msgs.length;
        return { messages: msgs, distilled: false };
      },
    });
    expect(distillSawCount).toBe(3);
  });

  it('runs distill before manageContext (mgr sees the distilled subset)', () => {
    const messages: FakeMsg[] = Array.from({ length: 5 }, (_, i) =>
      sample({ role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}` }),
    );
    let mgrSawCount = -1;
    transformContextBeforeLLM(messages, {
      ...baseOptions,
      enableDistillation: true,
      distill: (msgs) => ({ messages: msgs.slice(0, 2), distilled: true }),
      manageContext: (msgs) => {
        mgrSawCount = msgs.length;
        return { messages: msgs, compactionApplied: false };
      },
    });
    expect(mgrSawCount).toBe(2);
  });

  it('determinism: identical input produces identical output', () => {
    const messages: FakeMsg[] = Array.from({ length: 8 }, (_, i) =>
      sample({ role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}` }),
    );
    const opts = {
      ...baseOptions,
      enableDistillation: true,
      distill: trivialDistill,
    };
    const out1 = transformContextBeforeLLM(messages, opts);
    const out2 = transformContextBeforeLLM(messages, opts);
    expect(out1).toEqual(out2);
  });

  it('append-stability holds when distill is below trigger threshold', () => {
    const base: FakeMsg[] = [
      sample({ role: 'user', content: 'first' }),
      sample({ role: 'assistant', content: 'reply' }),
    ];
    const extended: FakeMsg[] = [...base, sample({ role: 'user', content: 'second' })];
    const opts = {
      ...baseOptions,
      enableDistillation: true,
      distill: trivialDistill,
    };
    const baseOut = transformContextBeforeLLM(base, opts);
    const extOut = transformContextBeforeLLM(extended, opts);
    expect(baseOut.rewriteApplied).toBe(false);
    expect(extOut.rewriteApplied).toBe(false);
    expect(extOut.messages.slice(0, baseOut.messages.length)).toEqual(baseOut.messages);
  });
});

// ---------------------------------------------------------------------------
// cacheBreakpointIndices — Hermes `system_and_3` rolling tail
// ---------------------------------------------------------------------------

describe('transformContextBeforeLLM — cacheBreakpointIndices', () => {
  it('returns the last 3 non-system indices ordered oldest-first', () => {
    const messages: FakeMsg[] = [
      sample({ role: 'system', content: 's' }),
      sample({ role: 'user', content: 'u1' }),
      sample({ role: 'assistant', content: 'a1' }),
      sample({ role: 'user', content: 'u2' }),
      sample({ role: 'assistant', content: 'a2' }),
    ];
    const out = transformContextBeforeLLM(messages, baseOptions);
    expect(out.cacheBreakpointIndices).toEqual([2, 3, 4]);
  });

  it('returns fewer indices when the transcript has fewer than 3 non-system messages', () => {
    const messages: FakeMsg[] = [
      sample({ role: 'system', content: 's' }),
      sample({ role: 'user', content: 'u1' }),
      sample({ role: 'assistant', content: 'a1' }),
    ];
    const out = transformContextBeforeLLM(messages, baseOptions);
    expect(out.cacheBreakpointIndices).toEqual([1, 2]);
  });

  it('returns an empty array when the transcript is system-only', () => {
    const messages: FakeMsg[] = [sample({ role: 'system', content: 's' })];
    const out = transformContextBeforeLLM(messages, baseOptions);
    expect(out.cacheBreakpointIndices).toEqual([]);
  });

  it('includes assistant messages — not just user', () => {
    // The rolling tail is role-agnostic (non-system); it must include the
    // last assistant so its bytes stay cached across the next tool-result
    // round-trip. This is the substantive shift from the prior `last user
    // only` strategy.
    const messages: FakeMsg[] = [
      sample({ role: 'system', content: 's' }),
      sample({ role: 'user', content: 'u1' }),
      sample({ role: 'assistant', content: 'a1' }),
      sample({ role: 'user', content: 'u2' }),
    ];
    const out = transformContextBeforeLLM(messages, baseOptions);
    expect(out.cacheBreakpointIndices).toEqual([1, 2, 3]);
    expect(out.messages[2].role).toBe('assistant');
  });

  it('reflects post-filter indices (not pre-filter)', () => {
    const messages: FakeMsg[] = [
      sample({ role: 'user', content: 'first' }),
      sample({ role: 'user', content: 'hidden', visibleToModel: false }),
      sample({ role: 'assistant', content: 'reply' }),
      sample({ role: 'user', content: 'second' }),
    ];
    const out = transformContextBeforeLLM(messages, baseOptions);
    // After filter: ['first', 'reply', 'second'] — three non-system messages
    // at indices 0, 1, 2.
    expect(out.cacheBreakpointIndices).toEqual([0, 1, 2]);
  });

  it('never emits more than MAX_ROLLING_CACHE_BREAKPOINTS indices', () => {
    // Anthropic caps a request at 4 markers (system + 3 tail). The transformer
    // emits the tail; the wire adapter adds the system marker. Together they
    // must never exceed 4 — this drift-detector pins the tail half of that
    // budget.
    const messages: FakeMsg[] = [
      sample({ role: 'system', content: 's' }),
      ...Array.from({ length: 10 }, (_, i) =>
        sample({ role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}` }),
      ),
    ];
    const out = transformContextBeforeLLM(messages, baseOptions);
    expect(out.cacheBreakpointIndices.length).toBeLessThanOrEqual(3);
  });

  it('drift-detector: append-only turn keeps the prefix bytes stable', () => {
    // The whole point of cache breakpoints is that the bytes hashed up to
    // each marker don't change between turns when only new messages were
    // appended. Indices shift forward, but the *content* at the prior
    // breakpoint positions is unchanged — that's what makes the cached
    // prefix from the previous turn hit on the next call.
    const turn1: FakeMsg[] = [
      sample({ role: 'system', content: 'sys' }),
      sample({ role: 'user', content: 'q1' }),
      sample({ role: 'assistant', content: 'a1' }),
      sample({ role: 'user', content: 'q2' }),
    ];
    const turn2: FakeMsg[] = [
      ...turn1,
      sample({ role: 'assistant', content: 'a2' }),
      sample({ role: 'user', content: 'q3' }),
    ];

    const out1 = transformContextBeforeLLM(turn1, baseOptions);
    const out2 = transformContextBeforeLLM(turn2, baseOptions);

    // Turn 2's messages must include turn 1's messages byte-for-byte at the
    // same positions — that's the append-only invariant the cache relies on.
    expect(out2.messages.slice(0, out1.messages.length)).toEqual(out1.messages);

    // The breakpoints from turn 1 still point at content that exists,
    // unchanged, in turn 2's transcript. That's the cache-hit condition.
    for (const idx of out1.cacheBreakpointIndices) {
      expect(out2.messages[idx]).toEqual(out1.messages[idx]);
    }
  });
});

// ---------------------------------------------------------------------------
// Snapshot — transformer-level wire-shape
// ---------------------------------------------------------------------------

describe('transformContextBeforeLLM — snapshots', () => {
  it('produces a stable transformer output for a representative web transcript', () => {
    const messages: FakeMsg[] = [
      sample({ role: 'system', content: 'You are a helpful assistant.' }),
      sample({ role: 'user', content: 'List the files in src/.' }),
      sample({
        role: 'user',
        content: '[branch_forked] auto-fork from main',
        visibleToModel: false,
      }),
      sample({ role: 'assistant', content: 'I will read the directory.' }),
      sample({ role: 'user', content: '[TOOL_RESULT] file1.ts\nfile2.ts' }),
      sample({ role: 'user', content: 'Now summarize them.' }),
    ];
    const out = transformContextBeforeLLM(messages, baseOptions);
    expect({
      messages: out.messages,
      cacheBreakpointIndices: out.cacheBreakpointIndices,
      rewriteApplied: out.rewriteApplied,
      metrics: out.metrics,
    }).toMatchInlineSnapshot(`
      {
        "cacheBreakpointIndices": [
          2,
          3,
          4,
        ],
        "messages": [
          {
            "content": "You are a helpful assistant.",
            "role": "system",
          },
          {
            "content": "List the files in src/.",
            "role": "user",
          },
          {
            "content": "I will read the directory.",
            "role": "assistant",
          },
          {
            "content": "[TOOL_RESULT] file1.ts
      file2.ts",
            "role": "user",
          },
          {
            "content": "Now summarize them.",
            "role": "user",
          },
        ],
        "metrics": {
          "inputCount": 6,
          "outputCount": 5,
        },
        "rewriteApplied": false,
      }
    `);
  });

  // (see injectUserGoal stage tests below for goal-anchor coverage)

  it('produces a stable wire-format snapshot when serialized to {role, content} pairs', () => {
    const messages: FakeMsg[] = [
      sample({ role: 'system', content: 'sys' }),
      sample({ role: 'user', content: 'hi' }),
      sample({ role: 'assistant', content: 'hello' }),
      sample({ role: 'user', content: 'and again' }),
    ];
    const out = transformContextBeforeLLM(messages, baseOptions);
    const wire = out.messages.map((m) => ({ role: m.role, content: m.content }));
    const tagged = new Set(out.cacheBreakpointIndices);
    const withCache = wire.map((m, i) =>
      tagged.has(i) ? { ...m, cache_control: { type: 'ephemeral' } } : m,
    );
    // Three non-system messages → all three rolling-tail markers populated.
    // System still gets its own marker at the wire layer (not modeled here).
    expect(withCache).toMatchInlineSnapshot(`
      [
        {
          "content": "sys",
          "role": "system",
        },
        {
          "cache_control": {
            "type": "ephemeral",
          },
          "content": "hi",
          "role": "user",
        },
        {
          "cache_control": {
            "type": "ephemeral",
          },
          "content": "hello",
          "role": "assistant",
        },
        {
          "cache_control": {
            "type": "ephemeral",
          },
          "content": "and again",
          "role": "user",
        },
      ]
    `);
  });
});

// ---------------------------------------------------------------------------
// injectUserGoal stage
//
// The goal anchor is injected just before the last message whenever
// compaction is in play. "In play" means either an upstream stage rewrote
// this turn (rewriteApplied flows in) OR a prior turn left the durable
// `[CONTEXT DIGEST]` marker. Below the threshold + no marker = no anchor,
// keeping short chats unaffected.
// ---------------------------------------------------------------------------

describe('transformContextBeforeLLM — injectUserGoal stage', () => {
  const anchor: UserGoalAnchor = { initialAsk: 'ship the anchor feature' };
  const createGoalMessage = (content: string): FakeMsg => ({ role: 'user', content });

  const goalBlock = ['[USER_GOAL]', 'Initial ask: ship the anchor feature', '[/USER_GOAL]'].join(
    '\n',
  );

  it('does not inject when no anchor is configured', () => {
    const messages: FakeMsg[] = [
      sample({ role: 'user', content: 'first' }),
      sample({ role: 'assistant', content: '[CONTEXT DIGEST] earlier turns dropped' }),
      sample({ role: 'user', content: 'now' }),
    ];
    const out = transformContextBeforeLLM(messages, baseOptions);
    expect(out.messages.some((m) => m.content === goalBlock)).toBe(false);
  });

  it('does not inject when compaction never happened (no rewrite, no marker)', () => {
    const messages: FakeMsg[] = [
      sample({ role: 'user', content: 'first' }),
      sample({ role: 'assistant', content: 'reply' }),
      sample({ role: 'user', content: 'now' }),
    ];
    const out = transformContextBeforeLLM(messages, {
      ...baseOptions,
      userGoalAnchor: anchor,
      createGoalMessage,
    });
    expect(out.messages).toEqual(messages);
    expect(out.rewriteApplied).toBe(false);
  });

  it('injects when an upstream stage rewrote this turn', () => {
    const messages: FakeMsg[] = [
      sample({ role: 'user', content: 'first' }),
      sample({ role: 'assistant', content: 'reply' }),
      sample({ role: 'user', content: 'now' }),
    ];
    const out = transformContextBeforeLLM(messages, {
      ...baseOptions,
      manageContext: (msgs) => ({
        messages: [
          msgs[0],
          sample({ role: 'user', content: '[CONTEXT DIGEST] dropped' }),
          ...msgs.slice(1),
        ],
        compactionApplied: true,
      }),
      userGoalAnchor: anchor,
      createGoalMessage,
    });
    expect(out.rewriteApplied).toBe(true);
    expect(out.messages[out.messages.length - 2].content).toBe(goalBlock);
    expect(out.messages[out.messages.length - 1].content).toBe('now');
  });

  it('injects when a prior turn left the [CONTEXT DIGEST] marker (no rewrite this turn)', () => {
    const messages: FakeMsg[] = [
      sample({ role: 'user', content: 'first' }),
      sample({ role: 'user', content: '[CONTEXT DIGEST] prior compaction' }),
      sample({ role: 'assistant', content: 'reply' }),
      sample({ role: 'user', content: 'now' }),
    ];
    const out = transformContextBeforeLLM(messages, {
      ...baseOptions,
      userGoalAnchor: anchor,
      createGoalMessage,
    });
    expect(out.rewriteApplied).toBe(true);
    expect(out.messages[out.messages.length - 2].content).toBe(goalBlock);
    expect(out.messages[out.messages.length - 1].content).toBe('now');
  });

  it('is idempotent — does not double-inject when an identical anchor is already present', () => {
    const messages: FakeMsg[] = [
      sample({ role: 'user', content: 'first' }),
      sample({ role: 'user', content: '[CONTEXT DIGEST] prior compaction' }),
      sample({ role: 'user', content: goalBlock }),
      sample({ role: 'user', content: 'now' }),
    ];
    const out = transformContextBeforeLLM(messages, {
      ...baseOptions,
      userGoalAnchor: anchor,
      createGoalMessage,
    });
    const anchorCount = out.messages.filter((m) => m.content === goalBlock).length;
    expect(anchorCount).toBe(1);
  });

  it('shifts cacheBreakpointIndices forward by one when injecting before the last user turn', () => {
    const messages: FakeMsg[] = [
      sample({ role: 'user', content: 'first' }),
      sample({ role: 'user', content: '[CONTEXT DIGEST] prior compaction' }),
      sample({ role: 'assistant', content: 'reply' }),
      sample({ role: 'user', content: 'now' }),
    ];
    const out = transformContextBeforeLLM(messages, {
      ...baseOptions,
      userGoalAnchor: anchor,
      createGoalMessage,
    });
    // Pre-injection the last 3 non-system messages were at [1, 2, 3]. The
    // goal anchor inserts at position 3 (before "now"), pushing the tail
    // forward by one: rolling breakpoints become [2, 3, 4] and "now" sits at
    // the last of them.
    expect(out.cacheBreakpointIndices).toEqual([2, 3, 4]);
    const lastIdx = out.cacheBreakpointIndices[out.cacheBreakpointIndices.length - 1];
    expect(out.messages[lastIdx].content).toBe('now');
  });

  it('determinism: identical input + options produces identical output', () => {
    const messages: FakeMsg[] = [
      sample({ role: 'user', content: 'first' }),
      sample({ role: 'user', content: '[CONTEXT DIGEST] prior compaction' }),
      sample({ role: 'user', content: 'now' }),
    ];
    const opts = { ...baseOptions, userGoalAnchor: anchor, createGoalMessage };
    const out1 = transformContextBeforeLLM(messages, opts);
    const out2 = transformContextBeforeLLM(messages, opts);
    expect(out1).toEqual(out2);
  });
});

// ---------------------------------------------------------------------------
// injectSessionDigest stage
//
// Same trigger as the goal-anchor stage: fires only when compaction is in
// play. Materializes a `SessionDigest` from caller-provided records +
// working memory. On subsequent compactions, detects the prior digest
// message by its `[SESSION_DIGEST]` marker and merges in place rather than
// emitting a new one.
// ---------------------------------------------------------------------------

describe('transformContextBeforeLLM — injectSessionDigest stage', () => {
  const createSessionDigestMessage = (content: string): FakeMsg => ({ role: 'user', content });

  it('does not fire when compaction has not happened (no rewrite, no marker)', () => {
    const messages: FakeMsg[] = [
      sample({ role: 'user', content: 'first' }),
      sample({ role: 'assistant', content: 'reply' }),
      sample({ role: 'user', content: 'now' }),
    ];
    const out = transformContextBeforeLLM(messages, {
      ...baseOptions,
      sessionDigestInputs: {
        records: [],
        workingMemory: { plan: 'ship feature' },
      },
      createSessionDigestMessage,
    });
    expect(out.messages).toEqual(messages);
    expect(out.rewriteApplied).toBe(false);
    expect(out.messages.some((m) => m.content.includes('[SESSION_DIGEST]'))).toBe(false);
  });

  it('injects when upstream compaction ran this turn', () => {
    const messages: FakeMsg[] = [
      sample({ role: 'user', content: 'first' }),
      sample({ role: 'assistant', content: 'reply' }),
      sample({ role: 'user', content: 'now' }),
    ];
    const out = transformContextBeforeLLM(messages, {
      ...baseOptions,
      enableManageContext: true,
      manageContext: (msgs) => ({ messages: msgs, compactionApplied: true }),
      sessionDigestInputs: {
        records: [],
        workingMemory: { plan: 'ship feature' },
      },
      createSessionDigestMessage,
    });
    const digestMessage = out.messages.find((m) => m.content.includes('[SESSION_DIGEST]'));
    expect(digestMessage).toBeDefined();
    expect(digestMessage?.content).toContain('Goal: ship feature');
    expect(out.rewriteApplied).toBe(true);
  });

  it('injects when a prior turn left the durable compaction marker', () => {
    const messages: FakeMsg[] = [
      sample({ role: 'user', content: 'first' }),
      sample({
        role: 'user',
        content: '[CONTEXT DIGEST] earlier turns dropped\n[USER_GOAL_COMPACTION_MARKER]',
      }),
      sample({ role: 'user', content: 'now' }),
    ];
    const out = transformContextBeforeLLM(messages, {
      ...baseOptions,
      sessionDigestInputs: {
        records: [],
        workingMemory: { plan: 'g' },
      },
      createSessionDigestMessage,
    });
    expect(out.messages.some((m) => m.content.includes('[SESSION_DIGEST]'))).toBe(true);
  });

  it('inserts the digest message just before the last message', () => {
    const messages: FakeMsg[] = [
      sample({ role: 'user', content: 'first' }),
      sample({ role: 'assistant', content: 'reply' }),
      sample({ role: 'user', content: 'now' }),
    ];
    const out = transformContextBeforeLLM(messages, {
      ...baseOptions,
      enableManageContext: true,
      manageContext: (msgs) => ({ messages: msgs, compactionApplied: true }),
      sessionDigestInputs: { records: [], workingMemory: { plan: 'g' } },
      createSessionDigestMessage,
    });
    // The digest should sit at messages.length - 2, with 'now' (the prior
    // last message) still at the end.
    expect(out.messages[out.messages.length - 1].content).toBe('now');
    expect(out.messages[out.messages.length - 2].content).toContain('[SESSION_DIGEST]');
  });

  it('merges in place when a prior digest exists in the transcript', () => {
    // Build a synthetic prior turn's digest message.
    const priorDigestContent = [
      '[SESSION_DIGEST]',
      'Goal: prior goal',
      'Decisions:',
      '  - prior decision',
      '[/SESSION_DIGEST]',
    ].join('\n');
    const messages: FakeMsg[] = [
      sample({ role: 'user', content: 'first' }),
      sample({ role: 'user', content: priorDigestContent }),
      sample({ role: 'assistant', content: 'reply' }),
      sample({ role: 'user', content: 'now' }),
    ];
    const out = transformContextBeforeLLM(messages, {
      ...baseOptions,
      enableManageContext: true,
      manageContext: (msgs) => ({ messages: msgs, compactionApplied: true }),
      sessionDigestInputs: {
        records: [
          {
            id: 'd-new',
            kind: 'decision',
            summary: 'new decision',
            scope: { repoFullName: 'o/r' },
            source: { kind: 'orchestrator', label: 't', createdAt: 0 },
            freshness: 'fresh',
          },
        ],
        // Don't supply working memory — let the prior `goal` survive.
      },
      createSessionDigestMessage,
    });

    // Same number of messages (merged in place, not appended).
    expect(out.messages.length).toBe(4);
    // The merged digest sits at the SAME index as the prior — index 1.
    expect(out.messages[1].content).toContain('[SESSION_DIGEST]');
    // The merged content has both the prior and the new decision; goal
    // survives from the prior digest since the new build doesn't override.
    expect(out.messages[1].content).toContain('prior decision');
    expect(out.messages[1].content).toContain('new decision');
    expect(out.messages[1].content).toContain('Goal: prior goal');
  });

  it('does not flip rewriteApplied when the merged content matches the prior byte-for-byte', () => {
    // Same inputs as the prior digest → merge is a no-op → byte-stable.
    const priorContent = ['[SESSION_DIGEST]', 'Goal: same goal', '[/SESSION_DIGEST]'].join('\n');
    const messages: FakeMsg[] = [
      sample({ role: 'user', content: 'first' }),
      sample({ role: 'user', content: priorContent }),
      sample({ role: 'user', content: 'now' }),
    ];
    const out = transformContextBeforeLLM(messages, {
      ...baseOptions,
      enableManageContext: true,
      // Pass a compaction that just returns the input unchanged but reports
      // applied=true, so the digest stage runs.
      manageContext: (msgs) => ({ messages: msgs, compactionApplied: true }),
      sessionDigestInputs: { records: [], goal: 'same goal' },
      createSessionDigestMessage,
    });
    // The digest stage itself didn't flip rewrite (its merge produced same
    // bytes). manageContext set it to true so the top-level is true, but
    // we should at least confirm the digest's content was not changed.
    expect(out.messages[1].content).toBe(priorContent);
  });
});

// ---------------------------------------------------------------------------
// safetyNet stage
//
// Last-line-of-defense: when the upstream output is still over the
// `threshold * budget`, hard-trim oldest non-protected messages until the
// estimate fits. Doesn't fire when below threshold; doesn't drop below the
// `preserveTail` window.
// ---------------------------------------------------------------------------

describe('transformContextBeforeLLM — safetyNet stage', () => {
  // Estimate by character count of `content` for predictable test math.
  function estimateByChars(messages: { role: string; content?: unknown }[]): number {
    return messages.reduce((acc, m) => {
      const c = typeof m.content === 'string' ? m.content : '';
      return acc + c.length;
    }, 0);
  }

  it('is a no-op when estimate is below threshold * budget', () => {
    const messages: FakeMsg[] = [
      sample({ role: 'system', content: 'sys' }),
      sample({ role: 'user', content: 'short' }),
      sample({ role: 'user', content: 'short' }),
    ];
    const out = transformContextBeforeLLM(messages, {
      ...baseOptions,
      safetyNet: { estimateTokens: estimateByChars, budget: 1000, threshold: 0.85 },
    });
    expect(out.messages).toEqual(messages);
    expect(out.rewriteApplied).toBe(false);
  });

  it('hard-trims oldest non-protected messages when over threshold', () => {
    // Make total = 200, budget = 100, threshold = 0.85, so ceiling = 85.
    const messages: FakeMsg[] = [
      sample({ role: 'system', content: 'sys-prompt-long' }), // 15 chars (protected)
      sample({ role: 'user', content: 'a'.repeat(80) }), // 80 (eligible)
      sample({ role: 'user', content: 'b'.repeat(40) }), // 40 (eligible)
      sample({ role: 'user', content: 'c'.repeat(20) }), // 20 (within preserveTail)
      sample({ role: 'user', content: 'd'.repeat(20) }), // 20 (within preserveTail)
      sample({ role: 'user', content: 'e'.repeat(20) }), // 20 (within preserveTail)
      sample({ role: 'user', content: 'f'.repeat(20) }), // 20 (within preserveTail)
    ];
    const out = transformContextBeforeLLM(messages, {
      ...baseOptions,
      safetyNet: {
        estimateTokens: estimateByChars,
        budget: 100,
        threshold: 0.85,
        preserveTail: 4,
      },
    });
    // System (index 0) and the last 4 messages must survive. Both eligible
    // head messages ('a' x80 and 'b' x40) should have been dropped — that's
    // all the non-protected fat there is. The protected tail (4 × 20) + system
    // (15) leaves a floor of 95 chars, which already exceeds the 85 ceiling;
    // the stage stops once eligible drops are exhausted rather than breach
    // protection, so we assert the drops happened, not that the estimate fits.
    expect(out.messages[0].content).toBe('sys-prompt-long');
    expect(out.messages.some((m) => m.content === 'a'.repeat(80))).toBe(false);
    expect(out.messages.some((m) => m.content === 'b'.repeat(40))).toBe(false);
    expect(out.messages.length).toBe(5);
    expect(out.rewriteApplied).toBe(true);
  });

  it('respects preserveTail — never drops the trailing window', () => {
    const messages: FakeMsg[] = [
      sample({ role: 'system', content: 'sys' }),
      // Even if we'd need to drop everything to fit, the last 2 messages stay.
      sample({ role: 'user', content: 'a'.repeat(1000) }),
      sample({ role: 'user', content: 'b'.repeat(1000) }),
    ];
    const out = transformContextBeforeLLM(messages, {
      ...baseOptions,
      safetyNet: {
        estimateTokens: estimateByChars,
        budget: 100,
        threshold: 0.85,
        preserveTail: 2,
      },
    });
    // Both protected (tail) — only the system can be dropped, and it would
    // be the only eligible target. Since system is at index 0 we also
    // protect it. Bail when nothing left to drop.
    expect(out.messages.some((m) => m.content === 'b'.repeat(1000))).toBe(true);
    expect(out.messages.some((m) => m.content === 'a'.repeat(1000))).toBe(true);
  });
});
