import { describe, it, expect } from 'vitest';
import { SIZE_BUDGETS } from './size-budgets.js';

describe('SIZE_BUDGETS', () => {
  it('pins the canonical prompt-content budgets', () => {
    // Snapshot of the inventory — also fails if a key is added/removed without
    // updating this guard, so the single source of truth stays intentional.
    expect(SIZE_BUDGETS).toEqual({
      projectInstructionsDefault: 8_000,
      projectInstructionsAgent: 12_000,
      agentsMdCoder: 8_000,
      roleProjectHints: 2_500,
      workspaceMemory: 4_000,
      reviewGuidance: 8_000,
      priorReviewFindings: 6_000,
      toolResultReadOnly: 8_000,
      toolResultCoder: 24_000,
      auditorDiff: 15_000,
      reviewerDiffChunk: 40_000,
      auditorDiffChunk: 30_000,
    });
  });

  it('encodes the intended budget relationships', () => {
    // Investigation agents get more instruction room than the orchestrator default.
    expect(SIZE_BUDGETS.projectInstructionsAgent).toBeGreaterThan(
      SIZE_BUDGETS.projectInstructionsDefault,
    );
    // The Coder's tool-result window is the largest; side hints get the smallest budget.
    expect(SIZE_BUDGETS.toolResultCoder).toBeGreaterThan(SIZE_BUDGETS.toolResultReadOnly);
    expect(SIZE_BUDGETS.roleProjectHints).toBeLessThan(SIZE_BUDGETS.projectInstructionsDefault);
    // The auditor's diff-chunking cap is intentionally tighter than the
    // reviewers' — it trades diff breadth for prompt headroom (file context +
    // security prompt). Keep this ordering if the values are ever retuned.
    expect(SIZE_BUDGETS.auditorDiffChunk).toBeLessThan(SIZE_BUDGETS.reviewerDiffChunk);
    // Prior-review memory is supporting context — smaller than the primary
    // REVIEW.md guidance budget.
    expect(SIZE_BUDGETS.priorReviewFindings).toBeLessThan(SIZE_BUDGETS.reviewGuidance);
    // Every budget is a positive integer.
    for (const value of Object.values(SIZE_BUDGETS)) {
      expect(Number.isInteger(value) && value > 0).toBe(true);
    }
  });
});
