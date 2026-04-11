import { describe, expect, it } from 'vitest';
import type { MemoryRecord, ScoredMemoryRecord } from '@/types';
import {
  classifyRetrievedMemorySection,
  DEFAULT_MEMORY_PACK_SECTION_BUDGETS,
  packRetrievedMemory,
} from './context-memory-packing';

function makeScored(
  id: string,
  summary: string,
  overrides: {
    kind?: MemoryRecord['kind'];
    freshness?: MemoryRecord['freshness'];
    files?: string[];
    symbols?: string[];
  } = {},
): ScoredMemoryRecord {
  return {
    record: {
      id,
      kind: overrides.kind ?? 'finding',
      summary,
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
