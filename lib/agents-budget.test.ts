import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sanitizeProjectInstructions } from './project-instructions.js';
import { SIZE_BUDGETS } from './size-budgets.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (name: string): string => readFileSync(join(REPO_ROOT, name), 'utf8');

// AGENTS.md is the orientation file the instruction loaders actually inject:
// first-found-wins resolves it ahead of CLAUDE.md / GEMINI.md, and there is no
// PUSH.md. It is capped at SIZE_BUDGETS.projectInstructions on injection.
//
// The old rule here was "if this fails, TRIM AGENTS.md; do not raise the budget (it
// bills every repo/user every turn)." That rule is retired, because its premise did
// not survive arithmetic: project instructions ride the SYSTEM PROMPT, which Push tags
// with `cache_control`, so they sit in the cached prefix — billed once at write and at
// cache-read rates thereafter (~$0.009/turn for a 6k-token delta). The budget was
// defending pennies by deleting the second half of the rulebook.
//
// The rule that replaces it: the file must FIT, and the assertions below measure what
// is actually INJECTED — not the raw file, which is the mistake the previous version of
// this test made (it passed while the Coder was still reading a truncated block).
describe('AGENTS.md injection budget', () => {
  // String.length (UTF-16 code units) is what `sanitizeProjectInstructions` compares
  // against the cap — NOT byte length (`wc -c`), which over-counts AGENTS.md's many
  // multi-byte em dashes and arrows.
  it('fits within the project-instructions budget (code units)', () => {
    expect(read('AGENTS.md').length).toBeLessThanOrEqual(SIZE_BUDGETS.projectInstructions);
  });

  // The assertion that actually matters, and the one the old test could not make:
  // run the file through the real injection chokepoint and prove nothing was dropped.
  // A raw-length check is necessary but NOT sufficient — it says nothing about the
  // string the model receives.
  it('survives the real sanitizer intact — nothing truncated at the injection site', () => {
    const injected = sanitizeProjectInstructions(read('AGENTS.md'));
    expect(injected).not.toContain('[Project instructions truncated');
  });

  // The conventions are the POINT of the file, and they live in its back half — which
  // is exactly what an 8k cap used to delete. Pin a few load-bearing ones so a future
  // trim can't quietly amputate the sections that constrain how code gets written here.
  it('delivers the conventions, not just the orientation', () => {
    const injected = sanitizeProjectInstructions(read('AGENTS.md'));
    for (const marker of ['# setup:', '# test:', '# typecheck:']) {
      expect(injected, `AGENTS.md must still declare "${marker}" after injection`).toContain(
        marker,
      );
    }
  });
});

// CLAUDE.md is not injected by Push's own loader (AGENTS.md wins first-found), but it
// IS what every other agent on this repo reads, and it is the file that exposed how
// destructive the old cap was: at 8k it kept 29% of CLAUDE.md, cut mid-sentence, losing
// every convention section — Tool protocol, "Behavior lives in code", symmetric
// structured logs, decision-doc discipline, the new-feature checklist, and the PR
// self-review pass. This pins that it now fits.
describe('CLAUDE.md injection budget', () => {
  it('fits within the project-instructions budget, so no agent reads half a rulebook', () => {
    expect(read('CLAUDE.md').length).toBeLessThanOrEqual(SIZE_BUDGETS.projectInstructions);
  });

  it('would survive the sanitizer intact if a loader reached it', () => {
    const injected = sanitizeProjectInstructions(read('CLAUDE.md'));
    expect(injected).not.toContain('[Project instructions truncated');
    // The section that used to be structurally unreachable under the cap.
    expect(injected).toContain('PR self-review pass');
  });
});
