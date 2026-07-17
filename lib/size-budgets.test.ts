import { describe, it, expect } from 'vitest';
import { SIZE_BUDGETS } from './size-budgets.js';

describe('SIZE_BUDGETS', () => {
  it('pins the canonical prompt-content budgets', () => {
    // Snapshot of the inventory — also fails if a key is added/removed without
    // updating this guard, so the single source of truth stays intentional.
    expect(SIZE_BUDGETS).toEqual({
      projectInstructions: 32_000,
      roleProjectHints: 2_500,
      workspaceMemory: 4_000,
      reviewGuidance: 18_000,
      priorReviewFindings: 6_000,
      toolResultReadOnly: 8_000,
      toolResultCoder: 24_000,
      auditorDiff: 15_000,
      reviewerDiffChunk: 40_000,
      auditorDiffChunk: 30_000,
    });
  });

  it('keeps the project-instructions budget at or under the tightest ecosystem cap', () => {
    // Codex's `project_doc_max_bytes` (32 KiB) is the ONLY hard cap any comparable
    // agent enforces — Claude Code loads CLAUDE.md in full, Cursor/Aider/Gemini CLI
    // and the agents.md spec don't cap at all. A cross-tool repo already has to fit
    // 32 KiB, so exceeding it here would buy the model nothing it can rely on
    // elsewhere. Raise only with a reason that survives that argument.
    expect(SIZE_BUDGETS.projectInstructions).toBeLessThanOrEqual(32 * 1024);
  });

  it('encodes the intended budget relationships', () => {
    // ONE instruction budget for every role. The old three-way split (8k lead /
    // 12k read-only agents / 8k Coder) meant a Coder and an Explorer read DIFFERENT
    // HALVES of the same AGENTS.md, and the only role that mutates the repo got less
    // of the rulebook than the role that cannot change a line. There is no coherent
    // reason for roles to disagree about what the project's conventions say.
    //
    // The Coder's tool-result window is the largest; side hints get the smallest budget.
    expect(SIZE_BUDGETS.toolResultCoder).toBeGreaterThan(SIZE_BUDGETS.toolResultReadOnly);
    // Distilled policy hints are a side block, not the instruction file.
    expect(SIZE_BUDGETS.roleProjectHints).toBeLessThan(SIZE_BUDGETS.projectInstructions);
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

describe('REVIEW.md fits in the budget that carries it', () => {
  // The guard that did not exist. REVIEW.md is the reviewers' rulebook, injected
  // through formatReviewGuidance and cut at SIZE_BUDGETS.reviewGuidance. At 8,000
  // it had silently overflowed (11,967 chars), so every runtime review had been
  // running WITHOUT the tail of its own guidance — delivery rules, provider
  // routing, decision-doc discipline, the per-turn tool budget, validation
  // expectations — and nothing anywhere went red. A truncated rulebook reads
  // exactly like a complete one.
  //
  // This test is the whole fix. Raising the number was the easy half; making the
  // NEXT overflow loud is the half that lasts. If it fails: either raise
  // `reviewGuidance` deliberately, or cut REVIEW.md. Do not "fix" it by trimming
  // whatever section happens to sit at the boundary.
  it('is smaller than SIZE_BUDGETS.reviewGuidance, so no rule is dropped in silence', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');

    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
    const review = readFileSync(join(repoRoot, 'REVIEW.md'), 'utf8');

    expect(
      review.length,
      `REVIEW.md is ${review.length} chars but SIZE_BUDGETS.reviewGuidance is ` +
        `${SIZE_BUDGETS.reviewGuidance}. The reviewers would silently lose the tail of ` +
        `their own rulebook. Raise the budget deliberately, or cut the file.`,
    ).toBeLessThanOrEqual(SIZE_BUDGETS.reviewGuidance);
  });

  it('keeps real headroom, so the next edit is not an instant cliff', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');

    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
    const review = readFileSync(join(repoRoot, 'REVIEW.md'), 'utf8');
    const headroom = 1 - review.length / SIZE_BUDGETS.reviewGuidance;

    expect(
      headroom,
      `REVIEW.md uses ${Math.round((1 - headroom) * 100)}% of its budget. Landing this ` +
        `close to the cap means the next added rule silently evicts an existing one.`,
    ).toBeGreaterThan(0.1);
  });
});
