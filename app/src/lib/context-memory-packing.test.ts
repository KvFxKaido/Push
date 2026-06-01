import { describe, expect, it } from 'vitest';
import type { MemoryRecord, ScoredMemoryRecord } from '@/types';
import {
  classifyRetrievedMemorySection,
  DEFAULT_MEMORY_PACK_SECTION_BUDGETS,
  packRetrievedMemory,
} from './context-memory-packing';
import {
  AUDITOR_MEMORY_DETAIL_CAP,
  ROLE_MEMORY_SECTION_BUDGETS,
} from '@push/lib/role-memory-budgets';

function makeScored(
  id: string,
  summary: string,
  overrides: {
    kind?: MemoryRecord['kind'];
    freshness?: MemoryRecord['freshness'];
    files?: string[];
    symbols?: string[];
    detail?: string;
  } = {},
): ScoredMemoryRecord {
  return {
    record: {
      id,
      kind: overrides.kind ?? 'finding',
      summary,
      detail: overrides.detail,
      scope: { repoFullName: 'owner/repo' },
      source: { kind: 'explorer', label: 'x', createdAt: 0 },
      freshness: overrides.freshness ?? 'fresh',
      relatedFiles: overrides.files,
      relatedSymbols: overrides.symbols,
    },
    score: 1,
    breakdown: {
      branch: 0,
      taskLineage: 0,
      taskText: 0,
      fileOverlap: 0,
      symbolOverlap: 0,
      roleFamily: 0,
      recency: 0,
      freshness: 0,
      total: 1,
    },
  };
}

describe('classifyRetrievedMemorySection', () => {
  it('routes fresh records by kind and stale records into the stale section', () => {
    expect(classifyRetrievedMemorySection(makeScored('fact', 'x', { kind: 'fact' }).record)).toBe(
      'facts',
    );
    expect(
      classifyRetrievedMemorySection(makeScored('finding', 'x', { kind: 'finding' }).record),
    ).toBe('facts');
    expect(
      classifyRetrievedMemorySection(makeScored('trace', 'x', { kind: 'dependency_trace' }).record),
    ).toBe('facts');
    expect(
      classifyRetrievedMemorySection(makeScored('decision', 'x', { kind: 'decision' }).record),
    ).toBe('taskMemory');
    expect(
      classifyRetrievedMemorySection(makeScored('task', 'x', { kind: 'task_outcome' }).record),
    ).toBe('taskMemory');
    expect(
      classifyRetrievedMemorySection(makeScored('file', 'x', { kind: 'file_change' }).record),
    ).toBe('taskMemory');
    expect(
      classifyRetrievedMemorySection(
        makeScored('verify', 'x', { kind: 'verification_result' }).record,
      ),
    ).toBe('verification');
    expect(
      classifyRetrievedMemorySection(
        makeScored('stale', 'x', { kind: 'verification_result', freshness: 'stale' }).record,
      ),
    ).toBe('stale');
  });
});

describe('packRetrievedMemory', () => {
  it('returns empty output when input is empty', () => {
    const result = packRetrievedMemory([]);
    expect(result.block).toBe('');
    expect(result.packed).toHaveLength(0);
    expect(result.sections.facts.recordCount).toBe(0);
    expect(result.sections.taskMemory.recordCount).toBe(0);
    expect(result.sections.verification.recordCount).toBe(0);
    expect(result.sections.stale.recordCount).toBe(0);
  });

  it('packs fresh records into typed retrieved-memory sections', () => {
    const result = packRetrievedMemory([
      makeScored('a', 'Auth refresh guarded in useAuth.ts', { kind: 'finding' }),
      makeScored('b', 'Task outcome: implemented the auth retry flow', { kind: 'task_outcome' }),
      makeScored('c', 'typecheck: passed', { kind: 'verification_result' }),
    ]);

    expect(result.block).toContain('[RETRIEVED_FACTS]');
    expect(result.block).toContain('[RETRIEVED_TASK_MEMORY]');
    expect(result.block).toContain('[RETRIEVED_VERIFICATION]');
    expect(result.block).not.toContain('[STALE_CONTEXT]');
    expect(result.sections.facts.recordCount).toBe(1);
    expect(result.sections.taskMemory.recordCount).toBe(1);
    expect(result.sections.verification.recordCount).toBe(1);
    expect(result.packed).toHaveLength(3);
    // Each record line leads with its id so the model can memory_expand it.
    expect(result.block).toContain('- [a] [finding | explorer]');
    expect(result.block).toContain('- [b] [task_outcome | explorer]');
  });

  it('enforces hard per-section budgets and drops overflowing records', () => {
    const result = packRetrievedMemory(
      [
        makeScored('a', 'short fact one'),
        makeScored('b', 'short fact two'),
        makeScored('c', 'short fact three'),
      ],
      {
        sectionBudgets: {
          facts: 110,
          taskMemory: DEFAULT_MEMORY_PACK_SECTION_BUDGETS.taskMemory,
          verification: DEFAULT_MEMORY_PACK_SECTION_BUDGETS.verification,
          stale: DEFAULT_MEMORY_PACK_SECTION_BUDGETS.stale,
        },
      },
    );

    expect(result.sections.facts.charsUsed).toBeLessThanOrEqual(110);
    expect(result.sections.facts.recordCount).toBeGreaterThan(0);
    expect(result.sections.facts.recordCount).toBeLessThan(3);
    expect(result.sections.facts.dropped.length).toBeGreaterThan(0);
    expect(result.dropped.map((record) => record.record.id)).toContain('c');
  });

  it('continues packing later short records when earlier giant ones do not fit', () => {
    const giant = 'x'.repeat(500);
    const result = packRetrievedMemory(
      [
        makeScored('giant-1', giant),
        makeScored('giant-2', giant),
        makeScored('small', 'small fact that still fits'),
      ],
      {
        sectionBudgets: {
          facts: 120,
        },
      },
    );

    expect(result.sections.facts.packed.map((record) => record.record.id)).toEqual(['small']);
    expect(result.sections.facts.dropped.map((record) => record.record.id)).toEqual([
      'giant-1',
      'giant-2',
    ]);
  });

  it('routes stale records only into [STALE_CONTEXT]', () => {
    const result = packRetrievedMemory([
      makeScored('fresh-fact', 'Fresh file trace', { kind: 'finding' }),
      makeScored('fresh-verify', 'typecheck: passed', { kind: 'verification_result' }),
      makeScored('stale-fact', 'Old session guard note', { freshness: 'stale' }),
      makeScored('stale-verify', 'tests: failed', {
        kind: 'verification_result',
        freshness: 'stale',
      }),
    ]);

    expect(result.sections.facts.packed.map((record) => record.record.id)).toEqual(['fresh-fact']);
    expect(result.sections.verification.packed.map((record) => record.record.id)).toEqual([
      'fresh-verify',
    ]);
    expect(result.sections.stale.packed.map((record) => record.record.id)).toEqual([
      'stale-fact',
      'stale-verify',
    ]);
    expect(result.sections.facts.packed.some((record) => record.record.id === 'stale-fact')).toBe(
      false,
    );
    expect(
      result.sections.verification.packed.some((record) => record.record.id === 'stale-verify'),
    ).toBe(false);
    expect(result.block).toContain('[STALE_CONTEXT]');
  });

  it('never surfaces detail by default (opt-in flag off)', () => {
    const result = packRetrievedMemory([
      makeScored('a', 'Auth refresh guarded in useAuth.ts', {
        detail: 'Full verbatim detail that should not appear unless includeTopDetail is set.',
      }),
    ]);

    expect(result.block).not.toContain('detail:');
    expect(result.block).not.toContain('should not appear');
  });

  it('surfaces detail for the top-ranked record in a section when includeTopDetail is set', () => {
    const result = packRetrievedMemory(
      [
        makeScored('top', 'Decision summary', {
          kind: 'decision',
          detail: 'Verbatim rationale for the decision that the summary alone would lose.',
        }),
        makeScored('second', 'Second task outcome', {
          kind: 'task_outcome',
          detail: 'Detail for a non-top record that should stay hidden.',
        }),
      ],
      { includeTopDetail: true },
    );

    expect(result.block).toContain('detail: Verbatim rationale for the decision');
    // Only the top-ranked record in the section gets detail; the second does not.
    expect(result.block).not.toContain('should stay hidden');
    expect(result.sections.taskMemory.packed.map((r) => r.record.id)).toEqual(['top', 'second']);
  });

  it('preserves newlines and indentation in surfaced detail', () => {
    const multiline = 'line one\n  indented two\nline three';
    const result = packRetrievedMemory(
      [makeScored('a', 'verification summary', { kind: 'verification_result', detail: multiline })],
      { includeTopDetail: true },
    );

    expect(result.block).toContain('detail: line one');
    // Indentation and line breaks survive rather than collapsing to single spaces.
    expect(result.block).toContain('  indented two');
    expect(result.block).toContain('line three');
    // charsUsed stays consistent with the rendered block (budget accounting intact).
    expect(result.sections.verification.charsUsed).toBe(result.sections.verification.block.length);
  });

  it('does not surface detail when the top-ranked record lacks it, even if a lower record has detail', () => {
    const result = packRetrievedMemory(
      [
        makeScored('top', 'Top-ranked outcome with no detail', { kind: 'task_outcome' }),
        makeScored('second', 'Lower-ranked outcome', {
          kind: 'task_outcome',
          detail: 'Detail that must not be promoted to the top slot.',
        }),
      ],
      { includeTopDetail: true },
    );

    expect(result.sections.taskMemory.packed.map((r) => r.record.id)).toEqual(['top', 'second']);
    expect(result.block).not.toContain('detail:');
    expect(result.block).not.toContain('must not be promoted');
  });

  it('respects a custom detailCap', () => {
    const longDetail = 'D'.repeat(400);
    const result = packRetrievedMemory(
      [makeScored('a', 'summary', { kind: 'decision', detail: longDetail })],
      { includeTopDetail: true, detailCap: 50 },
    );

    const detailLine = result.block.split('\n').find((line) => line.includes('detail:'));
    expect(detailLine).toBeDefined();
    // 'D' run is truncated to the cap (with an ellipsis), well under the original 400.
    expect(detailLine!.length).toBeLessThan(80);
    expect(detailLine).toContain('…');
  });

  it('falls back to summary-only when detail would overflow the section budget', () => {
    const result = packRetrievedMemory(
      [
        makeScored('a', 'short summary', {
          kind: 'decision',
          detail: 'X'.repeat(2000),
        }),
      ],
      { includeTopDetail: true, sectionBudgets: { taskMemory: 120 } },
    );

    // The record is still packed (not dropped), just without its oversized detail.
    expect(result.sections.taskMemory.packed.map((r) => r.record.id)).toEqual(['a']);
    expect(result.block).toContain('short summary');
    expect(result.block).not.toContain('detail:');
    expect(result.sections.taskMemory.charsUsed).toBeLessThanOrEqual(120);
  });

  it('surfaces combined and per-section metadata for prompt-cost inspection', () => {
    const result = packRetrievedMemory([
      makeScored('fact', 'Session middleware runs before route guards', {
        files: ['app/src/middleware.ts'],
      }),
      makeScored('task', 'Updated auth retry flow and touched auth.ts', { kind: 'file_change' }),
      makeScored('verify', 'typecheck: passed', { kind: 'verification_result' }),
      makeScored('stale', 'Older note about auth.ts', { freshness: 'stale' }),
    ]);

    expect(result.charsUsed).toBe(result.block.length);
    expect(result.sections.facts.recordCount).toBe(1);
    expect(result.sections.taskMemory.recordCount).toBe(1);
    expect(result.sections.verification.recordCount).toBe(1);
    expect(result.sections.stale.recordCount).toBe(1);
    expect(result.sections.facts.charsUsed).toBe(result.sections.facts.block.length);
    expect(result.sections.taskMemory.charsUsed).toBe(result.sections.taskMemory.block.length);
    expect(result.sections.verification.charsUsed).toBe(result.sections.verification.block.length);
    expect(result.sections.stale.charsUsed).toBe(result.sections.stale.block.length);
    expect(result.packed).toHaveLength(4);
  });
});

describe('includeTopDetail char-budget impact (Auditor opt-in measurement)', () => {
  // A realistic Auditor retrieval: a decision with rationale + a failed verification
  // whose detail is the verbatim command output the Auditor most wants to read.
  function auditorRecords(): ScoredMemoryRecord[] {
    return [
      makeScored('decision', 'Gate the merge on the typecheck passing', {
        kind: 'decision',
        detail:
          'Question: should Protect Main block this merge?\nAnswer: yes — the branch touches ' +
          'the auth seam and the prior audit flagged an asymmetric allowlist check that was ' +
          'only fixed on one path.',
      }),
      makeScored('verify', 'typecheck: failed (exit 2)', {
        kind: 'verification_result',
        detail:
          'app/src/lib/role-memory-context.ts(37,5): error TS2554: Expected 1 arguments, but got 2.\n' +
          'app/src/lib/auditor.ts(88,12): error TS2345: Argument of type ... is not assignable.',
      }),
      makeScored('finding', 'Auth refresh guarded in useAuth.ts', { kind: 'finding' }),
    ];
  }

  const budgetSum = Object.values(ROLE_MEMORY_SECTION_BUDGETS).reduce((s, v) => s + v, 0);

  it('surfaces verbatim verification + decision detail when opted in', () => {
    const off = packRetrievedMemory(auditorRecords(), {
      sectionBudgets: ROLE_MEMORY_SECTION_BUDGETS,
    });
    const on = packRetrievedMemory(auditorRecords(), {
      sectionBudgets: ROLE_MEMORY_SECTION_BUDGETS,
      includeTopDetail: true,
      detailCap: AUDITOR_MEMORY_DETAIL_CAP,
    });

    // Off: no detail at all. On: the verbatim TS error output and decision rationale appear.
    expect(off.block).not.toContain('detail:');
    expect(on.block).toContain('error TS2554');
    expect(on.block).toContain('asymmetric allowlist');
    // Opting in grows the block (depth), but never beyond the existing section-budget ceiling.
    expect(on.charsUsed).toBeGreaterThan(off.charsUsed);
    expect(on.charsUsed).toBeLessThanOrEqual(budgetSum);
  });

  it('never exceeds any per-section budget when detail is surfaced', () => {
    const on = packRetrievedMemory(auditorRecords(), {
      sectionBudgets: ROLE_MEMORY_SECTION_BUDGETS,
      includeTopDetail: true,
      detailCap: AUDITOR_MEMORY_DETAIL_CAP,
    });

    expect(on.sections.facts.charsUsed).toBeLessThanOrEqual(ROLE_MEMORY_SECTION_BUDGETS.facts);
    expect(on.sections.taskMemory.charsUsed).toBeLessThanOrEqual(
      ROLE_MEMORY_SECTION_BUDGETS.taskMemory,
    );
    expect(on.sections.verification.charsUsed).toBeLessThanOrEqual(
      ROLE_MEMORY_SECTION_BUDGETS.verification,
    );
  });
});
