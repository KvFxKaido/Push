import { describe, expect, it } from 'vitest';
import { deterministicEmptyDiffVerdict, hasUntrackedFiles } from './auditor-delegation-handler';

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
    // their pre-#604 behavior. The handler in this PR collapses
    // unknown-commits into commitsMade=true at the caller site so the
    // mixed-version safety net lives there, not here.
    const result = deterministicEmptyDiffVerdict({
      diffFetchSucceeded: true,
      evalDiff: '',
      criteriaResults: [],
    });
    expect(result).not.toBeNull();
  });

  it('falls through to LLM when commitsMade is true even from the handler-collapsed unknown case', () => {
    // Locks in the Copilot P1 fix: when the sandbox omits head_sha
    // (legacy / mixed-version response), the handler now passes
    // commitsMade=true rather than relying on the falsy default. The
    // predicate must keep treating a truthy commitsMade as "do not
    // short-circuit" so the mixed-version safety net works end-to-end.
    const result = deterministicEmptyDiffVerdict({
      diffFetchSucceeded: true,
      evalDiff: '',
      criteriaResults: [],
      commitsMade: true,
    });
    expect(result).toBeNull();
  });

  it('falls through to LLM when untracked files were created — `git diff HEAD` misses them', () => {
    // Reproduces the 2026-05-20 retry-session bug: Coder ran
    // sandbox_write_file on a brand new path. The file exists on
    // disk but `git diff HEAD` is empty (untracked, never staged,
    // never committed) and HEAD didn't move. The deterministic
    // short-circuit previously fired "no workspace changes" on a
    // turn that did real work. With the porcelain-status signal
    // wired in, the predicate now defers to the LLM Auditor.
    const result = deterministicEmptyDiffVerdict({
      diffFetchSucceeded: true,
      evalDiff: '',
      criteriaResults: [],
      commitsMade: false,
      untrackedFilesPresent: true,
    });
    expect(result).toBeNull();
  });

  it('still short-circuits when nothing happened — diff empty, no commits, no untracked, no criteria', () => {
    // The true no-op case: Coder claimed done but the workspace is
    // untouched on every channel. Worth keeping a crisp deterministic
    // verdict here instead of paying for an LLM call that reaches
    // the same conclusion.
    const result = deterministicEmptyDiffVerdict({
      diffFetchSucceeded: true,
      evalDiff: '',
      criteriaResults: [],
      commitsMade: false,
      untrackedFilesPresent: false,
    });
    expect(result).not.toBeNull();
    expect(result?.verdict).toBe('incomplete');
  });
});

describe('hasUntrackedFiles', () => {
  it('returns false for null/undefined/empty input — the sandbox returns "" when git status is clean', () => {
    expect(hasUntrackedFiles(undefined)).toBe(false);
    expect(hasUntrackedFiles(null)).toBe(false);
    expect(hasUntrackedFiles('')).toBe(false);
  });

  it('returns true on a `??` line (the porcelain prefix for untracked entries)', () => {
    // The exact shape sandbox/worker emits from `git status --porcelain`.
    expect(hasUntrackedFiles('?? hello.txt\n')).toBe(true);
  });

  it('returns true when an untracked entry is mixed with modified entries', () => {
    // A turn that edits one tracked file AND creates one untracked
    // file would have a non-empty diff already, but we still want
    // the porcelain signal to honor untracked entries — they're
    // independent evidence channels.
    expect(hasUntrackedFiles(' M src/app.ts\n?? new.txt\n')).toBe(true);
  });

  it('returns false when only modified/staged entries are present (no untracked)', () => {
    // Modified-but-not-untracked goes via `git diff HEAD`, not via
    // the untracked-file signal. The predicate already has the diff
    // body to drive its decision; we don't want to double-trip on
    // the porcelain status.
    expect(hasUntrackedFiles('M  src/a.ts\n M src/b.ts\n')).toBe(false);
  });

  it('tolerates CRLF line endings from the worker shell', () => {
    expect(hasUntrackedFiles('?? a.txt\r\n')).toBe(true);
  });
});
