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
});
