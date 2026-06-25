import { describe, it, expect, vi } from 'vitest';
import {
  AuditEvalRecorder,
  serializeTrainset,
  serializeTrainsetLine,
  parseTrainset,
  toTrainsetCase,
  replayCase,
  replayTrainset,
  summarizeReplay,
  type AuditEvalPair,
  type AuditEvalTrainsetCase,
  type AuditVerdictObservation,
} from './audit-eval-pairs.js';

const SCOPE = { repoFullName: 'kvfxkaido/push', branch: 'feat/x' };

function diffFor(path: string, line: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1 +1 @@',
    `+${line}`,
    '',
  ].join('\n');
}

function obs(partial: Partial<AuditVerdictObservation>): AuditVerdictObservation {
  return {
    scope: SCOPE,
    diff: diffFor('src/a.ts', 'const x = 1;'),
    verdict: 'safe',
    summary: 'ok',
    risks: [],
    at: 1_000,
    ...partial,
  };
}

describe('AuditEvalRecorder', () => {
  it('captures a rejection→correction pair on the same scope+file', async () => {
    const recorder = new AuditEvalRecorder();
    const rejected = await recorder.observe(
      obs({
        verdict: 'unsafe',
        diff: diffFor('src/a.ts', 'const token = "sk-live-123";'),
        summary: 'hardcoded secret',
        risks: [{ level: 'high', description: 'hardcoded secret' }],
        at: 1_000,
      }),
    );
    expect(rejected).toBeNull();
    expect(recorder.pendingCount()).toBe(1);

    const pair = await recorder.observe(
      obs({
        verdict: 'safe',
        diff: diffFor('src/a.ts', 'const token = process.env.TOKEN;'),
        summary: 'uses env var',
        at: 2_000,
      }),
    );

    expect(pair).not.toBeNull();
    expect(pair?.rejected.summary).toBe('hardcoded secret');
    expect(pair?.rejected.risks).toHaveLength(1);
    expect(pair?.corrected.summary).toBe('uses env var');
    expect(pair?.sharedFiles).toEqual(['src/a.ts']);
    // Pending cleared once captured.
    expect(recorder.pendingCount()).toBe(0);
  });

  it('returns null for a SAFE verdict with no pending rejection', async () => {
    const recorder = new AuditEvalRecorder();
    expect(await recorder.observe(obs({ verdict: 'safe' }))).toBeNull();
  });

  it('keeps the most recent rejection when UNSAFE repeats', async () => {
    const recorder = new AuditEvalRecorder();
    await recorder.observe(
      obs({ verdict: 'unsafe', summary: 'first', diff: diffFor('src/a.ts', 'bad1'), at: 1_000 }),
    );
    await recorder.observe(
      obs({ verdict: 'unsafe', summary: 'second', diff: diffFor('src/a.ts', 'bad2'), at: 1_500 }),
    );
    expect(recorder.pendingCount()).toBe(1);
    const pair = await recorder.observe(
      obs({ verdict: 'safe', diff: diffFor('src/a.ts', 'good'), at: 2_000 }),
    );
    expect(pair?.rejected.summary).toBe('second');
  });

  it('does not pair a SAFE commit that shares no files (keeps pending)', async () => {
    const recorder = new AuditEvalRecorder();
    await recorder.observe(obs({ verdict: 'unsafe', diff: diffFor('src/a.ts', 'bad'), at: 1_000 }));
    const pair = await recorder.observe(
      obs({ verdict: 'safe', diff: diffFor('src/UNRELATED.ts', 'fine'), at: 2_000 }),
    );
    expect(pair).toBeNull();
    // Pending retained — the real fix may still come.
    expect(recorder.pendingCount()).toBe(1);
  });

  it('pairs any next SAFE when requireFileOverlap is false', async () => {
    const recorder = new AuditEvalRecorder({ requireFileOverlap: false });
    await recorder.observe(obs({ verdict: 'unsafe', diff: diffFor('src/a.ts', 'bad'), at: 1_000 }));
    const pair = await recorder.observe(
      obs({ verdict: 'safe', diff: diffFor('src/b.ts', 'fine'), at: 2_000 }),
    );
    expect(pair).not.toBeNull();
    expect(pair?.sharedFiles).toEqual([]);
  });

  it('expires a pending rejection past maxPairAgeMs', async () => {
    const recorder = new AuditEvalRecorder({ maxPairAgeMs: 1_000 });
    await recorder.observe(obs({ verdict: 'unsafe', diff: diffFor('src/a.ts', 'bad'), at: 1_000 }));
    const pair = await recorder.observe(
      obs({ verdict: 'safe', diff: diffFor('src/a.ts', 'good'), at: 5_000 }),
    );
    expect(pair).toBeNull();
    expect(recorder.pendingCount()).toBe(0);
  });

  it('isolates pending rejections by scope', async () => {
    const recorder = new AuditEvalRecorder();
    await recorder.observe(
      obs({
        scope: { repoFullName: 'kvfxkaido/push', branch: 'feat/x' },
        verdict: 'unsafe',
        diff: diffFor('src/a.ts', 'bad'),
        at: 1_000,
      }),
    );
    // A SAFE on a different branch must not consume the other branch's pending.
    const pair = await recorder.observe(
      obs({
        scope: { repoFullName: 'kvfxkaido/push', branch: 'feat/y' },
        verdict: 'safe',
        diff: diffFor('src/a.ts', 'good'),
        at: 2_000,
      }),
    );
    expect(pair).toBeNull();
    expect(recorder.pendingCount()).toBe(1);
  });

  it('invokes the onPair sink with the captured pair', async () => {
    const sink = vi.fn();
    const recorder = new AuditEvalRecorder({ onPair: sink });
    await recorder.observe(obs({ verdict: 'unsafe', diff: diffFor('src/a.ts', 'bad'), at: 1_000 }));
    await recorder.observe(obs({ verdict: 'safe', diff: diffFor('src/a.ts', 'good'), at: 2_000 }));
    expect(sink).toHaveBeenCalledOnce();
    expect(sink.mock.calls[0][0].sharedFiles).toEqual(['src/a.ts']);
  });

  it('swallows + logs a throwing onPair sink without losing the pair', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const recorder = new AuditEvalRecorder({
      onPair: () => {
        throw new Error('disk full');
      },
    });
    await recorder.observe(obs({ verdict: 'unsafe', diff: diffFor('src/a.ts', 'bad'), at: 1_000 }));
    const pair = await recorder.observe(
      obs({ verdict: 'safe', diff: diffFor('src/a.ts', 'good'), at: 2_000 }),
    );
    expect(pair).not.toBeNull();
    expect(
      errSpy.mock.calls.some((c) => String(c[0]).includes('audit_eval_pair_sink_failed')),
    ).toBe(true);
    errSpy.mockRestore();
  });
});

describe('trainset serialization', () => {
  const pair: AuditEvalPair = {
    scope: SCOPE,
    rejected: {
      diff: diffFor('src/a.ts', 'const token = "sk-live";'),
      summary: 'secret',
      risks: [{ level: 'high', description: 'hardcoded secret' }],
      at: 1_000,
    },
    corrected: {
      diff: diffFor('src/a.ts', 'const token = process.env.TOKEN;'),
      summary: 'env var',
      at: 2_000,
    },
    sharedFiles: ['src/a.ts'],
  };

  it('derives a deterministic id from scope + timestamps', () => {
    expect(toTrainsetCase(pair).id).toBe(toTrainsetCase(pair).id);
    expect(toTrainsetCase(pair).id).toMatch(/^aep_[0-9a-f]{8}$/);
  });

  it('maps a pair to a replayable case with both verdicts', () => {
    const c = toTrainsetCase(pair);
    expect(c.expectedVerdict).toBe('safe');
    expect(c.priorVerdict).toBe('unsafe');
    expect(c.correctedDiff).toContain('process.env.TOKEN');
    expect(c.rejectedDiff).toContain('sk-live');
    expect(c.priorRisks).toHaveLength(1);
  });

  it('round-trips through JSONL', () => {
    const blob = serializeTrainset([pair, pair]);
    expect(blob.endsWith('\n')).toBe(true);
    const cases = parseTrainset(blob);
    expect(cases).toHaveLength(2);
    expect(cases[0].id).toBe(toTrainsetCase(pair).id);
  });

  it('serializeTrainsetLine appends exactly one newline', () => {
    expect(serializeTrainsetLine(pair).match(/\n/g)).toHaveLength(1);
  });

  it('skips malformed JSONL lines without dropping valid ones', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const blob = serializeTrainsetLine(pair) + 'not json\n' + serializeTrainsetLine(pair);
    const cases = parseTrainset(blob);
    expect(cases).toHaveLength(2);
    errSpy.mockRestore();
  });

  it('ignores blank lines', () => {
    expect(parseTrainset('\n\n  \n')).toEqual([]);
  });
});

describe('replay', () => {
  function caseFor(overrides: Partial<AuditEvalTrainsetCase> = {}): AuditEvalTrainsetCase {
    return {
      id: 'aep_test0001',
      scope: SCOPE,
      correctedDiff: diffFor('src/a.ts', 'const t = process.env.TOKEN;'),
      expectedVerdict: 'safe',
      rejectedDiff: diffFor('src/a.ts', 'const t = "sk-live";'),
      priorVerdict: 'unsafe',
      priorRisks: [{ level: 'high', description: 'hardcoded secret' }],
      rejectedSummary: 'secret',
      correctedSummary: 'env var',
      sharedFiles: ['src/a.ts'],
      ...overrides,
    };
  }

  it('passes when the Auditor reproduces both recorded verdicts', async () => {
    // Corrected → safe, rejected → unsafe (the corpus's recorded expectation).
    const getVerdict = async (diff: string) =>
      diff.includes('sk-live') ? ('unsafe' as const) : ('safe' as const);
    const result = await replayCase(caseFor(), getVerdict);
    expect(result.regressions).toEqual([]);
    expect(result.corrected.ok).toBe(true);
    expect(result.rejected?.ok).toBe(true);
  });

  it('flags rejected_now_safe when the Auditor stops catching the issue', async () => {
    const getVerdict = async () => 'safe' as const; // always safe now
    const result = await replayCase(caseFor(), getVerdict);
    expect(result.regressions).toContain('rejected_now_safe');
    expect(result.corrected.ok).toBe(true);
    expect(result.rejected?.ok).toBe(false);
  });

  it('flags corrected_now_unsafe when the Auditor gets stricter', async () => {
    const getVerdict = async () => 'unsafe' as const; // always unsafe now
    const result = await replayCase(caseFor(), getVerdict);
    expect(result.regressions).toContain('corrected_now_unsafe');
    expect(result.corrected.ok).toBe(false);
  });

  it('skips the rejected arm when checkRejected is false', async () => {
    const getVerdict = vi.fn(async () => 'safe' as const);
    const result = await replayCase(caseFor(), getVerdict, { checkRejected: false });
    expect(result.rejected).toBeUndefined();
    expect(getVerdict).toHaveBeenCalledTimes(1); // corrected arm only
    expect(result.regressions).toEqual([]);
  });

  it('summarizes a mixed corpus', async () => {
    const cases = [
      caseFor({ id: 'aep_ok000001' }),
      caseFor({ id: 'aep_lax00001' }),
      caseFor({ id: 'aep_strict01' }),
    ];
    const getVerdict = async (diff: string) => {
      // ok case: behaves correctly. lax case: rejected diff now safe.
      // strict case: corrected diff now unsafe.
      if (diff.includes('strict-marker')) return 'unsafe' as const;
      if (diff.includes('sk-live')) return 'unsafe' as const;
      return 'safe' as const;
    };
    // Make case 2's rejected diff slip past (now safe) and case 3's corrected
    // diff trip the stricter rule.
    cases[1].rejectedDiff = diffFor('src/a.ts', 'const t = OBFUSCATED;');
    cases[2].correctedDiff = diffFor('src/a.ts', 'const t = "strict-marker";');

    const { results, summary } = await replayTrainset(cases, getVerdict);
    expect(results).toHaveLength(3);
    expect(summary.total).toBe(3);
    expect(summary.passed).toBe(1);
    expect(summary.regressed).toBe(2);
    expect(summary.rejectedNowSafe).toBe(1);
    expect(summary.correctedNowUnsafe).toBe(1);
  });

  it('stops early and reports partial results when the signal aborts', async () => {
    const controller = new AbortController();
    let calls = 0;
    const getVerdict = async (diff: string) => {
      calls += 1;
      controller.abort(); // abort after the first verdict
      return diff.includes('sk-live') ? ('unsafe' as const) : ('safe' as const);
    };
    const cases = [caseFor({ id: 'aep_a' }), caseFor({ id: 'aep_b' })];
    const { results, aborted } = await replayTrainset(cases, getVerdict, {
      signal: controller.signal,
    });
    expect(aborted).toBe(true);
    // First case's corrected arm ran, then abort caught before its rejected arm.
    expect(results.length).toBeLessThan(2);
    expect(calls).toBeLessThanOrEqual(2);
  });

  it('summarizeReplay counts an empty result set as all-passed', () => {
    expect(summarizeReplay([])).toEqual({
      total: 0,
      passed: 0,
      regressed: 0,
      rejectedNowSafe: 0,
      correctedNowUnsafe: 0,
    });
  });
});
