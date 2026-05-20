import { describe, expect, it } from 'vitest';
import { deterministicEmptyDiffVerdict } from './auditor-delegation-handler';

// Unit test for the pure short-circuit predicate that decides whether
// the Auditor can return a canned "no workspace changes" verdict without
// spinning up an LLM call. Catches the Coder-loop case where the model
// claimed completion but never edited a file — visible in the original
// session log (2026-05-20T04:27:06Z) where the Auditor's LLM-composed
// "no diff evidence" phrasing failed to break the loop.

describe('deterministicEmptyDiffVerdict', () => {
  it('short-circuits when the diff fetch succeeded, diff is empty, and no criterion passed', () => {
    const result = deterministicEmptyDiffVerdict({
      diffFetchSucceeded: true,
      evalDiff: null,
      criteriaResults: [],
    });
    expect(result).not.toBeNull();
    expect(result?.verdict).toBe('incomplete');
    expect(result?.confidence).toBe('high');
    expect(result?.summary).toContain('No workspace changes detected');
  });

  it('short-circuits when the diff is whitespace-only (treats it the same as null)', () => {
    const result = deterministicEmptyDiffVerdict({
      diffFetchSucceeded: true,
      evalDiff: '   \n\n  ',
      criteriaResults: [],
    });
    expect(result).not.toBeNull();
  });

  it('short-circuits when criteria ran but none passed', () => {
    const result = deterministicEmptyDiffVerdict({
      diffFetchSucceeded: true,
      evalDiff: null,
      criteriaResults: [{ passed: false }, { passed: false }],
    });
    expect(result).not.toBeNull();
  });

  it('falls through to LLM when ANY criterion passed — verification-against-green is legitimate', () => {
    // A user that wired up `npm test` as an acceptance check might
    // legitimately ship a Coder turn that ran the tests, saw them
    // pass, and concluded no edits were needed. The Auditor LLM
    // should make that judgment call, not the deterministic gate.
    const result = deterministicEmptyDiffVerdict({
      diffFetchSucceeded: true,
      evalDiff: null,
      criteriaResults: [{ passed: true }, { passed: false }],
    });
    expect(result).toBeNull();
  });

  it('falls through to LLM when the diff has any non-whitespace content', () => {
    const result = deterministicEmptyDiffVerdict({
      diffFetchSucceeded: true,
      evalDiff: 'diff --git a/foo b/foo\n+ new line\n',
      criteriaResults: [],
    });
    expect(result).toBeNull();
  });

  it('falls through to LLM when the diff fetch failed — we cannot assert empty without proof', () => {
    // If `getSandboxDiff` threw, evalDiff stays null but we have no
    // ground truth. Trust the LLM (which sees other signals like
    // workingMemory and the Coder summary) rather than asserting
    // "no changes" from a missing data point.
    const result = deterministicEmptyDiffVerdict({
      diffFetchSucceeded: false,
      evalDiff: null,
      criteriaResults: [],
    });
    expect(result).toBeNull();
  });

  it('falls through to LLM when an error-bearing diff response arrives — DiffResult.error means the fetch is unreliable', () => {
    // Pins the Codex/Copilot P1 contract from PR #601: the handler must
    // set `diffFetchSucceeded = false` whenever `DiffResult.error` is
    // populated, even though no exception was thrown. This predicate
    // test documents that the {diffFetchSucceeded: false, diff: ''}
    // shape — which is exactly what the handler produces in the
    // error case — must NOT short-circuit. A sandbox/git failure
    // misclassified as "coder no-op" would mislead the Orchestrator
    // into looping on a real infrastructure problem.
    const result = deterministicEmptyDiffVerdict({
      diffFetchSucceeded: false,
      evalDiff: '',
      criteriaResults: [],
    });
    expect(result).toBeNull();
  });

  it('returns a high-confidence verdict with an actionable gap line for the Orchestrator', () => {
    // The gap line is the message the Orchestrator's model reads.
    // It needs to point at the upstream cause (malformed tool call,
    // missing write tool invocation) so the model doesn't just
    // re-delegate the same task again.
    const result = deterministicEmptyDiffVerdict({
      diffFetchSucceeded: true,
      evalDiff: '',
      criteriaResults: [],
    });
    expect(result?.gaps).toHaveLength(1);
    expect(result?.gaps[0]).toContain('malformed tool call');
  });

  it('falls through to LLM when commitsMade is true even with an empty diff — committed work is real work', () => {
    // Reproduces the PR #601 false-positive surfaced in the 2026-05-20
    // session: the Coder ran `git commit && git push` via sandbox_exec,
    // `git diff HEAD` came back empty (working tree is clean post-
    // commit), and the short-circuit fired "no workspace changes
    // detected" even though the work landed on GitHub. With the pre/
    // post-HEAD snapshot from PR #604 the handler now knows HEAD
    // advanced and sets commitsMade=true, so the short-circuit defers
    // to the LLM Auditor (which sees the ranged diff and can audit
    // the committed changes).
    const result = deterministicEmptyDiffVerdict({
      diffFetchSucceeded: true,
      evalDiff: '',
      criteriaResults: [],
      commitsMade: true,
    });
    expect(result).toBeNull();
  });

  it('still short-circuits when commitsMade is false and the diff is empty (true no-op turn)', () => {
    // The "Coder claimed done but did nothing" case — explicit absence
    // of commits — must still trip the short-circuit so the
    // orchestrator gets a crisp signal instead of paying for an LLM
    // call that would reach the same conclusion.
    const result = deterministicEmptyDiffVerdict({
      diffFetchSucceeded: true,
      evalDiff: '',
      criteriaResults: [],
      commitsMade: false,
    });
    expect(result).not.toBeNull();
    expect(result?.verdict).toBe('incomplete');
  });

  it('treats an undefined commitsMade as "no commits detected" (backward-compat)', () => {
    // Pre-#604 callers don't pass commitsMade. The predicate must not
    // start blocking the short-circuit on those — they should keep
    // their pre-#604 behavior.
    const result = deterministicEmptyDiffVerdict({
      diffFetchSucceeded: true,
      evalDiff: '',
      criteriaResults: [],
    });
    expect(result).not.toBeNull();
  });
});
