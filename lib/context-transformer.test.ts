import { describe, it, expect } from 'vitest';
import {
  transformContextBeforeLLM,
  type TransformContextOptions,
  type TransformableMessage,
} from './context-transformer';

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

  it('shifts cacheBreakpointIndex forward (or holds) when only appending and no trim', () => {
    const base: FakeMsg[] = [
      sample({ role: 'user', content: 'first' }),
      sample({ role: 'assistant', content: 'reply' }),
    ];
    const extended: FakeMsg[] = [...base, sample({ role: 'user', content: 'second' })];

    const baseOut = transformContextBeforeLLM(base, baseOptions);
    const extOut = transformContextBeforeLLM(extended, baseOptions);

    if (!baseOut.compactionApplied && !extOut.compactionApplied) {
      expect(extOut.cacheBreakpointIndex).toBeGreaterThanOrEqual(baseOut.cacheBreakpointIndex);
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
    expect(out.compactionApplied).toBe(false);
    expect(out.messages).toEqual(messages);
  });

  it('records compactionApplied when the bound manageContext reports compaction', () => {
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
    expect(out.compactionApplied).toBe(true);
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
// cacheBreakpointIndex
// ---------------------------------------------------------------------------

describe('transformContextBeforeLLM — cacheBreakpointIndex', () => {
  it('points at the last user message', () => {
    const messages: FakeMsg[] = [
      sample({ role: 'system', content: 's' }),
      sample({ role: 'user', content: 'u1' }),
      sample({ role: 'assistant', content: 'a1' }),
      sample({ role: 'user', content: 'u2' }),
      sample({ role: 'assistant', content: 'a2' }),
    ];
    const out = transformContextBeforeLLM(messages, baseOptions);
    expect(out.cacheBreakpointIndex).toBe(3);
  });

  it('returns -1 when no user message is present', () => {
    const messages: FakeMsg[] = [
      sample({ role: 'system', content: 's' }),
      sample({ role: 'assistant', content: 'a' }),
    ];
    const out = transformContextBeforeLLM(messages, baseOptions);
    expect(out.cacheBreakpointIndex).toBe(-1);
  });

  it('reflects post-filter index (not pre-filter)', () => {
    const messages: FakeMsg[] = [
      sample({ role: 'user', content: 'first' }),
      sample({ role: 'user', content: 'hidden', visibleToModel: false }),
      sample({ role: 'assistant', content: 'reply' }),
      sample({ role: 'user', content: 'second' }),
    ];
    const out = transformContextBeforeLLM(messages, baseOptions);
    // After filter: ['first', 'reply', 'second'] — 'second' is at index 2
    expect(out.cacheBreakpointIndex).toBe(2);
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
      cacheBreakpointIndex: out.cacheBreakpointIndex,
      compactionApplied: out.compactionApplied,
      metrics: out.metrics,
    }).toMatchInlineSnapshot(`
      {
        "cacheBreakpointIndex": 4,
        "compactionApplied": false,
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
      }
    `);
  });

  it('produces a stable wire-format snapshot when serialized to {role, content} pairs', () => {
    const messages: FakeMsg[] = [
      sample({ role: 'system', content: 'sys' }),
      sample({ role: 'user', content: 'hi' }),
      sample({ role: 'assistant', content: 'hello' }),
      sample({ role: 'user', content: 'and again' }),
    ];
    const out = transformContextBeforeLLM(messages, baseOptions);
    const wire = out.messages.map((m) => ({ role: m.role, content: m.content }));
    const withCache = wire.map((m, i) =>
      i === out.cacheBreakpointIndex ? { ...m, cache_control: { type: 'ephemeral' } } : m,
    );
    expect(withCache).toMatchInlineSnapshot(`
      [
        {
          "content": "sys",
          "role": "system",
        },
        {
          "content": "hi",
          "role": "user",
        },
        {
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
