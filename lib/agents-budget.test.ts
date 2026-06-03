import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SIZE_BUDGETS } from './size-budgets.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('AGENTS.md injection budget', () => {
  // AGENTS.md is the orientation file the instruction loaders actually inject:
  // first-found-wins resolves it ahead of CLAUDE.md / GEMINI.md, and there is
  // no PUSH.md. At the orchestrator injection site it's capped at
  // SIZE_BUDGETS.projectInstructionsDefault. Overflow isn't fully silent — the
  // sanitizer leaves a "[Project instructions truncated …]" marker — but the
  // tail content past the cap is gone (which once dropped the ARCHITECTURE.md
  // precedence note). This pins the fix so the file can't quietly creep back
  // over budget.
  //
  // The assertion measures String.length (UTF-16 code units) because that is
  // exactly what `sanitizeProjectInstructions` compares against the cap — NOT
  // byte length (`wc -c`), which over-counts AGENTS.md's many multi-byte em
  // dashes and arrows. If this fails, trim AGENTS.md; do not raise the budget
  // (it bills every repo/user every turn).
  it('fits within the default project-instructions budget (code units)', () => {
    const content = readFileSync(join(REPO_ROOT, 'AGENTS.md'), 'utf8');
    expect(content.length).toBeLessThanOrEqual(SIZE_BUDGETS.projectInstructionsDefault);
  });
});
