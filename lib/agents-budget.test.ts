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

  // The Coder is the only role that MUTATES the repo, so it is the last one that
  // should be guessing at the conventions. At the old 4k budget this file was cut in
  // half and the Coder lost Validation commands, "Behavior lives in code",
  // decision-doc discipline, and the new-feature checklist — every rule constraining
  // how code gets written here, withheld from the role writing it.
  //
  // Same remedy as above if this fails: TRIM AGENTS.md.
  //
  // ⚠️ THIS DOES NOT PROVE THE CODER SEES THE WHOLE FILE, and an earlier version of
  // this test claimed it did. On the web path for the canonical Push repo,
  // `buildEffectiveProjectInstructions` PREPENDS ~2.4k of built-in Push context and
  // the role budget is applied to that COMBINED string — so the injected content is
  // ~10.4k and AGENTS.md is still truncated from the tail (the `# setup:` block at
  // char ~5.9k falls off). Measuring the raw file against the budget is necessary,
  // not sufficient; it says nothing about the string actually injected.
  //
  // The real fix is to bill the budget against repo-provided text only and account
  // for our own preamble separately. That needs the exempt length threaded to the
  // injection sites explicitly — a marker the sanitizer sniffs for would let a repo
  // exempt ITSELF from its cap on the CLI path, and that sanitizer is the
  // injection-defense boundary. Tracked as a follow-up; do not paper over it here.
  it('fits within the Coder budget (necessary, NOT sufficient — see comment)', () => {
    const content = readFileSync(join(REPO_ROOT, 'AGENTS.md'), 'utf8');
    expect(content.length).toBeLessThanOrEqual(SIZE_BUDGETS.agentsMdCoder);
  });
});
