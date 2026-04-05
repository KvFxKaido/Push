import { describe, expect, it } from 'vitest';
import type { ScoredMemoryRecord } from '@/types';
import { packRetrievedMemory } from './context-memory-packing';

function makeScored(id: string, summary: string, files?: string[]): ScoredMemoryRecord {
  return {
    record: {
      id,
      kind: 'finding',
      summary,
      scope: { repoFullName: 'owner/repo' },
      source: { kind: 'explorer', label: 'x', createdAt: 0 },
      freshness: 'fresh',
      relatedFiles: files,
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

describe('packRetrievedMemory', () => {
  it('returns empty block when input is empty', () => {
    const result = packRetrievedMemory([]);
    expect(result.block).toBe('');
    expect(result.packed).toHaveLength(0);
  });

  it('wraps records in a compact [RETRIEVED_MEMORY] block with one line per record', () => {
    const result = packRetrievedMemory([
      makeScored('a', 'Auth refresh guarded in useAuth.ts'),
      makeScored('b', 'Routes guarded by session middleware'),
    ]);
    expect(result.block).toContain('[RETRIEVED_MEMORY]');
    expect(result.block).toContain('[/RETRIEVED_MEMORY]');
    expect(result.block).toContain('- [finding | explorer] Auth refresh guarded');
    expect(result.block).toContain('- [finding | explorer] Routes guarded');
    expect(result.packed).toHaveLength(2);
  });

  it('includes file hints under each record when requested', () => {
    const result = packRetrievedMemory(
      [makeScored('a', 'Found session guard', ['app/src/mw.ts', 'app/src/guard.ts'])],
      { includeHints: true },
    );
    expect(result.block).toContain('files: app/src/mw.ts, app/src/guard.ts');
  });

  it('enforces the char budget and drops records that do not fit', () => {
    const big = 'x'.repeat(150);
    const items = [
      makeScored('a', big),
      makeScored('b', big),
      makeScored('c', big),
      makeScored('d', big),
    ];
    const result = packRetrievedMemory(items, { budgetChars: 220 });
    expect(result.packed.length).toBeGreaterThan(0);
    expect(result.packed.length).toBeLessThan(items.length);
    expect(result.dropped.length).toBeGreaterThan(0);
    expect(result.charsUsed).toBeLessThanOrEqual(220);
  });

  it('returns empty block when budget is too small for even the block tags', () => {
    const result = packRetrievedMemory([makeScored('a', 'x')], { budgetChars: 10 });
    expect(result.block).toBe('');
    expect(result.packed).toHaveLength(0);
  });

  it('truncates oversized per-record summaries to a bounded line', () => {
    const longSummary = 'y'.repeat(1000);
    const result = packRetrievedMemory([makeScored('a', longSummary)]);
    const recordLine = result.block.split('\n').find((line) => line.startsWith('- '));
    expect(recordLine).toBeDefined();
    expect(recordLine!.length).toBeLessThan(300);
  });
});
