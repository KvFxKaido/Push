# Hashline Effectiveness Metric

**Date:** 2026-04-12
**Status:** Draft plan — not yet executed.
**Owner:** TBD
**Branch:** `claude/explore-openagent-features-q3vuR` (doc only)

## Why this exists

Push ships hashline-anchored edits as part of its "harness reliability"
story (`docs/architecture.md:42`, `docs/decisions/Hashline System Review.md`).
The external comparable, `oh-my-openagent`, publishes a concrete before/after
edit-success delta for the same technique (claimed 6.7% → 68.3% on one
benchmark). Push has the mechanism but no published number. That gap is
risky in two directions:

1. If hashline is carrying its weight, we want to prove it so the work is
   not second-guessed during harness simplification passes.
2. If it is not, we want to catch the drift before it becomes an
   assumption baked into every reliability doc in `docs/`.

This runbook defines a deliberately small experiment to produce that number
and record it where it can be re-run on demand.

## Scope

- **In scope:** measuring edit-apply success rate with hashline on vs. off
  for sandbox writes (`sandbox_write_file`), across a fixed fixture set of
  diffs. One-shot, not continuous.
- **Out of scope:** end-to-end task completion benchmarks, cost comparisons,
  model routing changes, provider-specific telemetry, or anything requiring
  a paid provider key.

## Signals we already have

`app/src/lib/edit-metrics.ts` already tracks per-run write outcomes
(`success`, `stale`, `error`, plus `errorsByCode`). `harness-profiles.ts`
adapts on `editStaleRate` above a threshold. Both are session-scoped — they
report recent behavior but do not isolate the hashline variable.

So the infrastructure for counting is in place. What is missing is:

- A reproducible fixture set of realistic edits.
- A way to run the same edits with hashline anchors disabled.
- A recorded number committed somewhere durable.

## Fixture set

Build a small corpus of ~40 edit scenarios drawn from three buckets:

1. **Clean edits** (15): the file state the model "remembers" matches disk.
   Should succeed under either mode. Useful as a baseline sanity check.
2. **Stale-context edits** (15): the file was modified after the model's
   last read, by either an unrelated insertion elsewhere, a whitespace
   change on the target line, or a neighbor-line edit. This is where
   hashline is expected to win.
3. **Moved-content edits** (10): the target line still exists but has
   shifted in line number due to unrelated changes. Bare-hash relocation is
   the specific hashline feature under test.

Each fixture is a triple `(before.txt, after_expected.txt, edit_ops)`. Keep
them as plain files under `tests/hashline-effectiveness/fixtures/` so they
are diffable and easy to extend.

## Harness toggle

Add a test-only flag — **not** a runtime flag — that bypasses hashline
resolution and falls back to a string-match edit path. The simplest form:

- A new helper in `lib/hashline.ts` tests (or a sibling module under
  `tests/hashline-effectiveness/`) that runs edits two ways:
  - Hashline path: use `resolveHashlineRefs` + `applyResolvedHashlineEdits`.
  - Control path: a naive `string.replaceAll` on the ref's original content
    with no staleness detection, mimicking pre-hashline editing.
- Both paths take the same `(before, edit_ops)` and return the same shape
  (`{ content, applied, errors }`).

The control is deliberately dumb — that is the point. We want a number
for the reliability headroom hashline provides, not a comparison against a
second sophisticated edit engine.

## Execution

1. Write fixtures and the control path as a single test file:
   `tests/hashline-effectiveness/hashline-effectiveness.test.mjs`.
   Use `node:test` to match the CLI test style.
2. For each fixture, run both paths and record:
   - `applied` count
   - `errors` count
   - whether `after_actual === after_expected` (the hardest test)
3. Aggregate per bucket and overall into a `results.json`:
   ```json
   {
     "date": "YYYY-MM-DD",
     "fixtures": 40,
     "hashline":  { "applied": X, "exactMatch": Y, "errors": Z },
     "control":   { "applied": X, "exactMatch": Y, "errors": Z },
     "byBucket":  { "clean": {...}, "stale": {...}, "moved": {...} }
   }
   ```
4. Commit `results.json` alongside the fixtures. Re-running the test
   overwrites it so the number always matches the live code.

## Reporting

- Append the headline number (exact-match rate hashline vs. control) to
  `docs/decisions/Hashline System Review.md` under a new `## Measured
  Effectiveness` section, linked back to this runbook.
- Reference the number in `docs/decisions/Oh My OpenAgent Review.md`
  section 5 where the OMO claim appears.
- If the delta is smaller than ~10 percentage points, open a follow-up
  ticket to audit the control fixtures — a small delta on synthetic edits
  does not automatically invalidate hashline (real sessions hit different
  failure modes), but it should prompt a second look.

## Non-goals (explicit)

- We are **not** gating hashline behind a runtime flag. The control path
  exists only inside the test harness.
- We are **not** benchmarking specific models. The control is purely
  mechanical; there is no LLM in the loop.
- We are **not** shipping a CI gate off this number. It is a one-shot
  validation, rerunnable when someone changes the hashline module.

## Success criteria

- A committed fixture set under `tests/hashline-effectiveness/`.
- A committed `results.json` with the before/after numbers.
- A one-paragraph "Measured Effectiveness" update in the Hashline System
  Review citing the number and the fixture count.
- A back-reference from the OMO review so the gap identified in this
  session is closed.

## Deferred questions

- Should the fixtures include multi-file diffs? (Probably not for v1 —
  hashline operates per file anyway.)
- Should we extend the control to use a line-number match instead of
  content match? (Worth considering as a second control in v2.)
- Should we publish the number in the README? (No — internal only unless
  the delta is large enough to be interesting to users.)
