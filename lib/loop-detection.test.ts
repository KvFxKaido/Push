import { describe, expect, it } from 'vitest';
import {
  BLOCKS_BEFORE_COMPACT,
  createSimilarityLoopDetector,
  EXACT_REPEAT_LIMIT,
  evaluateLoopState,
  isSimilarityLoopDetectionEnabled,
  jaccard,
  SIMILARITY_BLOCK_HITS,
  SIMILARITY_THRESHOLD,
  SIMILARITY_WARN_HITS,
  SIMILARITY_WINDOW,
  tokenize,
  writeTargetOf,
} from './loop-detection.js';

describe('tokenize', () => {
  it('is whitespace-insensitive', () => {
    expect(tokenize('const x = 1')).toEqual(tokenize('const   x =\n\t1  '));
  });

  it('is object-key-order insensitive', () => {
    expect(tokenize('{ a: 1, b: 2 }')).toEqual(tokenize('{ b: 2, a: 1 }'));
  });

  it('changes exactly one token under identifier churn', () => {
    const before = tokenize('function getUser(id) { return db.find(id); }');
    const after = tokenize('function getPerson(id) { return db.find(id); }');
    // `getuser` dropped, `getperson` added; everything else shared — so a
    // renamed identifier stays highly (but not perfectly) similar.
    expect(before.has('getuser')).toBe(true);
    expect(after.has('getperson')).toBe(true);
    expect(jaccard(before, after)).toBeGreaterThan(0.7);
    expect(jaccard(before, after)).toBeLessThan(1);
  });

  it('caps token-set size', () => {
    const huge = Array.from({ length: 5000 }, (_, i) => `tok${i}`).join(' ');
    expect(tokenize(huge, 100).size).toBe(100);
  });
});

describe('jaccard', () => {
  it('identical sets score 1', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
  });

  it('disjoint sets score 0', () => {
    expect(jaccard(new Set(['a']), new Set(['b']))).toBe(0);
  });

  it('two empty sets are identical', () => {
    expect(jaccard(new Set(), new Set())).toBe(1);
  });

  it('empty vs non-empty is disjoint', () => {
    expect(jaccard(new Set(), new Set(['a']))).toBe(0);
  });

  it('computes a known overlap', () => {
    // {a,b,c} ∩ {b,c,d} = {b,c} (2); ∪ = {a,b,c,d} (4) -> 0.5
    expect(jaccard(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd']))).toBe(0.5);
  });
});

describe('createSimilarityLoopDetector', () => {
  // Large enough that a single differing token (the number) keeps Jaccard
  // comfortably above SIMILARITY_THRESHOLD — i.e. genuinely near-duplicate.
  const nearDuplicate = (n: number) =>
    `export function processRecord(record, options, context) {
       const validated = validate(record, options);
       logger.info("processing started for the current batch", context);
       return persist(validated, context, ${n});
     }`;

  it('first write to a path has no prior window (similarity 0, streak 1)', () => {
    const d = createSimilarityLoopDetector();
    const obs = d.observeWrite('a.ts', nearDuplicate(1));
    expect(obs.similarity).toBe(0);
    expect(obs.streak).toBe(1);
  });

  it('grows the streak across near-duplicate writes to the same path', () => {
    const d = createSimilarityLoopDetector();
    const streaks = [1, 2, 3, 4, 5, 6].map((n) => d.observeWrite('a.ts', nearDuplicate(n)).streak);
    expect(streaks).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('does NOT trip when identical content goes to DIFFERENT paths', () => {
    const d = createSimilarityLoopDetector();
    const content = nearDuplicate(1);
    for (let i = 0; i < 8; i++) {
      const obs = d.observeWrite(`file-${i}.ts`, content);
      expect(obs.similarity).toBe(0);
      expect(obs.streak).toBe(1);
    }
  });

  it('resets the streak when a genuinely different write intervenes', () => {
    const d = createSimilarityLoopDetector();
    d.observeWrite('a.ts', nearDuplicate(1));
    d.observeWrite('a.ts', nearDuplicate(2));
    expect(d.observeWrite('a.ts', nearDuplicate(3)).streak).toBe(3);
    const different = d.observeWrite('a.ts', 'export const totally = "unrelated tiny module";');
    expect(different.similarity).toBeLessThan(SIMILARITY_THRESHOLD);
    expect(different.streak).toBe(1);
  });

  it('expires old content past the sliding window', () => {
    const d = createSimilarityLoopDetector({ window: 3 });
    const original = nearDuplicate(1);
    d.observeWrite('a.ts', original);
    // Push 3 unrelated writes — each disjoint from the others and from `original`.
    d.observeWrite('a.ts', 'alpha alpha alpha unique_one');
    d.observeWrite('a.ts', 'beta beta beta unique_two');
    d.observeWrite('a.ts', 'gamma gamma gamma unique_three');
    // `original` has now fallen out of the size-3 window, so re-writing it
    // finds no match.
    expect(d.peekSimilarity('a.ts', original)).toBe(0);
  });

  it('peekSimilarity does not mutate window or streak', () => {
    const d = createSimilarityLoopDetector();
    d.observeWrite('a.ts', nearDuplicate(1));
    d.peekSimilarity('a.ts', nearDuplicate(2));
    d.peekSimilarity('a.ts', nearDuplicate(3));
    // Streak should still reflect just the one recorded write.
    expect(d.observeWrite('a.ts', nearDuplicate(4)).streak).toBe(2);
  });

  it('clear() resets all per-path state', () => {
    const d = createSimilarityLoopDetector();
    d.observeWrite('a.ts', nearDuplicate(1));
    d.observeWrite('a.ts', nearDuplicate(2));
    d.clear();
    const obs = d.observeWrite('a.ts', nearDuplicate(3));
    expect(obs.similarity).toBe(0);
    expect(obs.streak).toBe(1);
  });
});

describe('evaluateLoopState — exact repeated calls (always enforced)', () => {
  it('aborts at the limit regardless of similarity enforcement', () => {
    const dark = evaluateLoopState({
      exactRepeat: { count: EXACT_REPEAT_LIMIT },
      similarityEnforced: false,
    });
    expect(dark.level).toBe('abort');
    expect(dark.action).toBe('abort');
  });

  it('does not abort below the limit', () => {
    const v = evaluateLoopState({ exactRepeat: { count: EXACT_REPEAT_LIMIT - 1 } });
    expect(v.level).toBe('none');
    expect(v.action).toBe('none');
  });

  it('honors a custom limit', () => {
    expect(evaluateLoopState({ exactRepeat: { count: 5, limit: 6 } }).action).toBe('none');
    expect(evaluateLoopState({ exactRepeat: { count: 6, limit: 6 } }).action).toBe('abort');
  });
});

describe('evaluateLoopState — pre-tripped exact breakers (web shape)', () => {
  it('aborts when any exact breaker reason is present', () => {
    const v = evaluateLoopState({ exactBreakers: ['repeated failure: read_file'] });
    expect(v.level).toBe('abort');
    expect(v.action).toBe('abort');
    expect(v.reasons).toContain('repeated failure: read_file');
  });

  it('does not abort on an empty breaker list', () => {
    expect(evaluateLoopState({ exactBreakers: [] }).action).toBe('none');
  });

  it('aborts regardless of similarity enforcement and surfaces every reason', () => {
    const v = evaluateLoopState({
      exactBreakers: ['repeated call: delegate_coder', 'delegation-outcome: coder'],
      similarityEnforced: false,
    });
    expect(v.action).toBe('abort');
    expect(v.reasons).toHaveLength(2);
  });
});

describe('evaluateLoopState — near-duplicate ladder (gated)', () => {
  it('reports level but suppresses action when dark', () => {
    const v = evaluateLoopState({
      similarity: { value: 0.95, streak: SIMILARITY_WARN_HITS },
      similarityEnforced: false,
    });
    expect(v.level).toBe('warn');
    expect(v.action).toBe('none');
    expect(v.enforced).toBe(false);
    expect(v.similarity).toBe(0.95);
  });

  it('warns when enforced at the warn boundary', () => {
    expect(
      evaluateLoopState({
        similarity: { value: 0.9, streak: SIMILARITY_WARN_HITS - 1 },
        similarityEnforced: true,
      }).action,
    ).toBe('none');
    expect(
      evaluateLoopState({
        similarity: { value: 0.9, streak: SIMILARITY_WARN_HITS },
        similarityEnforced: true,
      }).action,
    ).toBe('warn');
  });

  it('blocks at the block boundary', () => {
    const v = evaluateLoopState({
      similarity: { value: 0.9, streak: SIMILARITY_BLOCK_HITS },
      similarityEnforced: true,
    });
    expect(v.action).toBe('block');
  });

  it('escalates to compact once enough blocks have been issued', () => {
    const v = evaluateLoopState({
      similarity: { value: 0.9, streak: SIMILARITY_BLOCK_HITS },
      blocksIssued: BLOCKS_BEFORE_COMPACT - 1,
      similarityEnforced: true,
    });
    expect(v.action).toBe('compact');
  });
});

describe('evaluateLoopState — combined signals', () => {
  it('takes the strongest level across signals, enforcing exact-match even when similarity is dark', () => {
    const v = evaluateLoopState({
      exactRepeat: { count: EXACT_REPEAT_LIMIT },
      similarity: { value: 0.95, streak: SIMILARITY_WARN_HITS },
      similarityEnforced: false,
    });
    expect(v.level).toBe('abort'); // abort (exact) > warn (similarity)
    expect(v.action).toBe('abort'); // exact-match is always enforceable
    expect(v.reasons).toHaveLength(2);
  });

  it('returns none with no signals', () => {
    const v = evaluateLoopState({});
    expect(v.level).toBe('none');
    expect(v.action).toBe('none');
    expect(v.reasons).toEqual([]);
  });
});

describe('writeTargetOf', () => {
  it('extracts write_file content', () => {
    expect(writeTargetOf({ path: 'a.ts', content: 'x' })).toEqual({ path: 'a.ts', content: 'x' });
  });

  it('extracts edit_file replacement text', () => {
    expect(writeTargetOf({ path: 'a.ts', old_string: 'a', new_string: 'b' })).toEqual({
      path: 'a.ts',
      content: 'b',
    });
  });

  it('returns null for non-write calls', () => {
    expect(writeTargetOf({ pattern: 'foo' })).toBeNull();
    expect(writeTargetOf(undefined)).toBeNull();
    expect(writeTargetOf({ path: 'a.ts' })).toBeNull();
  });
});

describe('isSimilarityLoopDetectionEnabled', () => {
  it('is opt-in via PUSH_LOOP_DETECTION=1', () => {
    expect(isSimilarityLoopDetectionEnabled({})).toBe(false);
    expect(isSimilarityLoopDetectionEnabled({ PUSH_LOOP_DETECTION: '0' })).toBe(false);
    expect(isSimilarityLoopDetectionEnabled({ PUSH_LOOP_DETECTION: '1' })).toBe(true);
  });
});

describe('exported tunables', () => {
  it('keep the documented ordering', () => {
    expect(SIMILARITY_WARN_HITS).toBeLessThan(SIMILARITY_BLOCK_HITS);
    expect(SIMILARITY_THRESHOLD).toBeGreaterThan(0);
    expect(SIMILARITY_THRESHOLD).toBeLessThanOrEqual(1);
    expect(SIMILARITY_WINDOW).toBeGreaterThan(0);
  });
});
