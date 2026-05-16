import { describe, it, expect } from 'vitest';
import {
  SESSION_DIGEST_FOOTER,
  SESSION_DIGEST_HEADER,
  type SessionDigest,
  buildSessionDigest,
  hasSessionDigest,
  mergeSessionDigests,
  parseSessionDigest,
  renderSessionDigest,
} from './session-digest.ts';
import type { MemoryRecord } from './runtime-contract.ts';
import type { CoderWorkingMemory } from './working-memory.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fact(overrides: Partial<MemoryRecord>): MemoryRecord {
  return {
    id: 'r-fact-1',
    kind: 'fact',
    summary: 'fact 1',
    scope: { repoFullName: 'owner/repo', branch: 'main', chatId: 'c-1' },
    source: { kind: 'orchestrator', label: 'test', createdAt: 0 },
    freshness: 'fresh',
    ...overrides,
  };
}

function decision(summary: string, files?: string[]): MemoryRecord {
  return fact({ id: `dec-${summary}`, kind: 'decision', summary, relatedFiles: files });
}

function outcome(
  summary: string,
  kind: 'task_outcome' | 'verification_result' = 'task_outcome',
): MemoryRecord {
  return fact({ id: `out-${summary}`, kind, summary });
}

const sampleWorkingMemory: CoderWorkingMemory = {
  plan: 'ship the rolling tail cache strategy',
  openTasks: ['add drift-detector test', 'flip decision-doc status'],
  filesTouched: ['lib/context-transformer.ts', 'cli/openai-stream.ts'],
  assumptions: ['OpenRouter is the only Anthropic-routed CLI provider'],
  errorsEncountered: ['type cast warning at index 139'],
  currentPhase: 'wire tests',
  completedPhases: ['type design', 'wire layer'],
};

// ---------------------------------------------------------------------------
// buildSessionDigest
// ---------------------------------------------------------------------------

describe('buildSessionDigest', () => {
  it('populates fields from working memory only when no records present', () => {
    const digest = buildSessionDigest({ records: [], workingMemory: sampleWorkingMemory });
    expect(digest.goal).toBe('ship the rolling tail cache strategy');
    expect(digest.constraints).toEqual(['OpenRouter is the only Anthropic-routed CLI provider']);
    expect(digest.progress.done).toEqual(['type design', 'wire layer']);
    expect(digest.progress.inProgress).toEqual(['wire tests']);
    expect(digest.progress.blocked).toEqual(['type cast warning at index 139']);
    expect(digest.nextSteps).toEqual(['add drift-detector test', 'flip decision-doc status']);
    expect(digest.relevantFiles).toEqual(['lib/context-transformer.ts', 'cli/openai-stream.ts']);
    expect(digest.decisions).toEqual([]);
  });

  it('populates decisions from MemoryRecord rows with kind=decision', () => {
    const digest = buildSessionDigest({
      records: [decision('Use Modal for GPU'), decision('Drop Vertex non-Anthropic path')],
    });
    expect(digest.decisions).toEqual(['Use Modal for GPU', 'Drop Vertex non-Anthropic path']);
  });

  it('unions relatedFiles from records with workingMemory.filesTouched, dedupes', () => {
    const digest = buildSessionDigest({
      records: [decision('d1', ['lib/a.ts', 'lib/b.ts']), decision('d2', ['lib/b.ts', 'lib/c.ts'])],
      workingMemory: { filesTouched: ['lib/c.ts', 'lib/d.ts'] },
    });
    expect(digest.relevantFiles).toEqual(['lib/c.ts', 'lib/d.ts', 'lib/a.ts', 'lib/b.ts']);
  });

  it('classifies task_outcome records by tone — failed/blocked/error → blocked, else → done', () => {
    const digest = buildSessionDigest({
      records: [
        outcome('Test suite passed'),
        outcome('Failed to compile typescript'),
        outcome('Blocked on missing API key'),
        outcome('Built artifact in 3.2s'),
      ],
    });
    expect(digest.progress.done).toContain('Test suite passed');
    expect(digest.progress.done).toContain('Built artifact in 3.2s');
    expect(digest.progress.blocked).toContain('Failed to compile typescript');
    expect(digest.progress.blocked).toContain('Blocked on missing API key');
  });

  it('classifies verification_result records the same way', () => {
    const digest = buildSessionDigest({
      records: [
        outcome('Lint passes', 'verification_result'),
        outcome('Type check failure', 'verification_result'),
      ],
    });
    expect(digest.progress.done).toContain('Lint passes');
    expect(digest.progress.blocked).toContain('Type check failure');
  });

  it('skips expired records entirely', () => {
    const digest = buildSessionDigest({
      records: [
        decision('Live decision'),
        fact({ id: 'd-stale', kind: 'decision', summary: 'Stale decision', freshness: 'expired' }),
      ],
    });
    expect(digest.decisions).toEqual(['Live decision']);
  });

  it('explicit goal input overrides workingMemory.plan', () => {
    const digest = buildSessionDigest({
      records: [],
      workingMemory: { plan: 'old goal' },
      goal: 'new goal from user-goal anchor',
    });
    expect(digest.goal).toBe('new goal from user-goal anchor');
  });

  it('omits goal when neither input provides one', () => {
    const digest = buildSessionDigest({ records: [] });
    expect(digest.goal).toBeUndefined();
  });

  it('caps lists at maxItemsPerList', () => {
    const records = Array.from({ length: 30 }, (_, i) => decision(`Decision ${i}`));
    const digest = buildSessionDigest({ records, maxItemsPerList: 5 });
    expect(digest.decisions.length).toBe(5);
    expect(digest.decisions[0]).toBe('Decision 0');
    expect(digest.decisions[4]).toBe('Decision 4');
  });

  it('truncates over-long entries to maxItemChars with an ellipsis', () => {
    const longSummary = 'x'.repeat(500);
    const digest = buildSessionDigest({
      records: [decision(longSummary)],
      maxItemChars: 50,
    });
    expect(digest.decisions[0].length).toBe(50);
    expect(digest.decisions[0].endsWith('…')).toBe(true);
  });

  it('deduplicates entries that survive truncation', () => {
    // Two long strings that are identical after truncation should collapse.
    const a = `${'x'.repeat(50)} suffix-a`;
    const b = `${'x'.repeat(50)} suffix-b`;
    const digest = buildSessionDigest({
      records: [decision(a), decision(b)],
      maxItemChars: 30, // truncates both to 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxx…'
    });
    expect(digest.decisions.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// render → parse round-trip
// ---------------------------------------------------------------------------

describe('renderSessionDigest / parseSessionDigest round-trip', () => {
  it('round-trips a fully-populated digest', () => {
    const digest: SessionDigest = {
      goal: 'Ship the rolling-tail cache strategy',
      constraints: ['OpenRouter only', 'No new dependencies'],
      progress: {
        done: ['Type design', 'Wire layer'],
        inProgress: ['Tests'],
        blocked: ['Vertex parity'],
      },
      decisions: ['Use Modal for GPU', 'Drop Vertex non-Anthropic path'],
      relevantFiles: ['lib/context-transformer.ts', 'cli/openai-stream.ts'],
      nextSteps: ['Run the full vitest pass', 'Flip the decision-doc status'],
      criticalContext: 'Cache markers must survive the worker guardrails layer.',
    };
    const rendered = renderSessionDigest(digest);
    expect(rendered.startsWith(SESSION_DIGEST_HEADER)).toBe(true);
    expect(rendered.endsWith(SESSION_DIGEST_FOOTER)).toBe(true);
    const parsed = parseSessionDigest(rendered);
    expect(parsed).toEqual(digest);
  });

  it('round-trips a minimal digest (only a goal)', () => {
    const digest: SessionDigest = {
      goal: 'Just a goal',
      constraints: [],
      progress: { done: [], inProgress: [], blocked: [] },
      decisions: [],
      relevantFiles: [],
      nextSteps: [],
    };
    const rendered = renderSessionDigest(digest);
    expect(rendered).toBe(`${SESSION_DIGEST_HEADER}\nGoal: Just a goal\n${SESSION_DIGEST_FOOTER}`);
    expect(parseSessionDigest(rendered)).toEqual(digest);
  });

  it('omits empty sections from the rendered block', () => {
    const digest: SessionDigest = {
      goal: 'g',
      constraints: [],
      progress: { done: ['d'], inProgress: [], blocked: [] },
      decisions: [],
      relevantFiles: [],
      nextSteps: [],
    };
    const rendered = renderSessionDigest(digest);
    // Constraints/Decisions/Relevant files/Next steps shouldn't appear at all.
    expect(rendered).not.toContain('Constraints:');
    expect(rendered).not.toContain('Decisions:');
    expect(rendered).not.toContain('Relevant files:');
    expect(rendered).not.toContain('Next steps:');
    expect(rendered).toContain('Done:');
  });

  it('parse returns null when no marker is present', () => {
    expect(parseSessionDigest('just some content without markers')).toBeNull();
  });

  it('parse returns null when only the opening marker is present (malformed)', () => {
    expect(parseSessionDigest(`prefix ${SESSION_DIGEST_HEADER}\nGoal: x\nno-footer`)).toBeNull();
  });

  it('parse extracts a digest embedded in a longer message', () => {
    const digest: SessionDigest = {
      goal: 'embedded',
      constraints: [],
      progress: { done: [], inProgress: [], blocked: [] },
      decisions: [],
      relevantFiles: [],
      nextSteps: [],
    };
    const wrapped = `Some preface.\n\n${renderSessionDigest(digest)}\n\nSome trailing text.`;
    expect(parseSessionDigest(wrapped)).toEqual(digest);
  });

  it('parse ignores unknown field labels (forward compat)', () => {
    const malformed = [
      SESSION_DIGEST_HEADER,
      'Goal: g',
      'Future field:',
      '  - some future value',
      'Decisions:',
      '  - d1',
      SESSION_DIGEST_FOOTER,
    ].join('\n');
    const parsed = parseSessionDigest(malformed);
    expect(parsed?.goal).toBe('g');
    expect(parsed?.decisions).toEqual(['d1']);
  });
});

// ---------------------------------------------------------------------------
// mergeSessionDigests
// ---------------------------------------------------------------------------

describe('mergeSessionDigests', () => {
  function digest(overrides: Partial<SessionDigest>): SessionDigest {
    return {
      constraints: [],
      progress: { done: [], inProgress: [], blocked: [] },
      decisions: [],
      relevantFiles: [],
      nextSteps: [],
      ...overrides,
    };
  }

  it('preserves prior entries and appends new ones not seen before', () => {
    const prior = digest({ decisions: ['d1', 'd2'] });
    const next = digest({ decisions: ['d2', 'd3'] });
    const merged = mergeSessionDigests(prior, next);
    expect(merged.decisions).toEqual(['d1', 'd2', 'd3']);
  });

  it('newer scalar fields win (goal, criticalContext)', () => {
    const prior = digest({ goal: 'old goal', criticalContext: 'old ctx' });
    const next = digest({ goal: 'new goal', criticalContext: 'new ctx' });
    const merged = mergeSessionDigests(prior, next);
    expect(merged.goal).toBe('new goal');
    expect(merged.criticalContext).toBe('new ctx');
  });

  it('falls back to prior scalar when newer is undefined', () => {
    const prior = digest({ goal: 'old goal' });
    const next = digest({});
    const merged = mergeSessionDigests(prior, next);
    expect(merged.goal).toBe('old goal');
  });

  it('progress sub-arrays merge independently', () => {
    const prior = digest({ progress: { done: ['a'], inProgress: ['b'], blocked: ['c'] } });
    const next = digest({ progress: { done: ['d'], inProgress: ['e'], blocked: ['f'] } });
    const merged = mergeSessionDigests(prior, next);
    expect(merged.progress).toEqual({
      done: ['a', 'd'],
      inProgress: ['b', 'e'],
      blocked: ['c', 'f'],
    });
  });

  it('respects maxItemsPerList cap after union', () => {
    const prior = digest({ decisions: ['d1', 'd2', 'd3'] });
    const next = digest({ decisions: ['d4', 'd5', 'd6'] });
    const merged = mergeSessionDigests(prior, next, { maxItemsPerList: 4 });
    expect(merged.decisions.length).toBe(4);
    expect(merged.decisions).toEqual(['d1', 'd2', 'd3', 'd4']);
  });

  it('respects maxFiles cap separately from maxItemsPerList', () => {
    const prior = digest({
      relevantFiles: Array.from({ length: 10 }, (_, i) => `f${i}`),
      decisions: ['d1'],
    });
    const next = digest({
      relevantFiles: Array.from({ length: 10 }, (_, i) => `g${i}`),
      decisions: ['d2'],
    });
    const merged = mergeSessionDigests(prior, next, { maxFiles: 5, maxItemsPerList: 100 });
    expect(merged.relevantFiles.length).toBe(5);
    expect(merged.decisions.length).toBe(2);
  });

  it('merge is associative for append-only sequences', () => {
    // A common pattern: digest emitted at turn N, merged with new digest at N+1,
    // then merged again at N+2. The order of pairwise merges shouldn't matter
    // for entries that never appear twice.
    const d1 = digest({ decisions: ['a'] });
    const d2 = digest({ decisions: ['b'] });
    const d3 = digest({ decisions: ['c'] });
    const left = mergeSessionDigests(mergeSessionDigests(d1, d2), d3);
    const right = mergeSessionDigests(d1, mergeSessionDigests(d2, d3));
    expect(left.decisions).toEqual(right.decisions);
  });
});

// ---------------------------------------------------------------------------
// hasSessionDigest
// ---------------------------------------------------------------------------

describe('hasSessionDigest', () => {
  it('returns true when any message content contains the header', () => {
    const messages = [
      { content: 'normal user message' },
      { content: `prefix ${SESSION_DIGEST_HEADER}\n…${SESSION_DIGEST_FOOTER}` },
    ];
    expect(hasSessionDigest(messages)).toBe(true);
  });

  it('returns false when no message has the marker', () => {
    expect(hasSessionDigest([{ content: 'a' }, { content: 'b' }])).toBe(false);
  });

  it('tolerates non-string content (multimodal / null)', () => {
    expect(hasSessionDigest([{ content: null }, { content: ['array'] }])).toBe(false);
  });
});
