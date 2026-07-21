# Edit Dialect Rollout Measurement

**Date:** 2026-07-21  
**Status:** Active measurement  
**Rollout:** PR #1567 (`edit_file` exact search/replace aliases)

## Baseline

The pre-rollout CLI corpus contains 559 persisted sessions. Of those, 52 use
GLM-5.1 and contain 35 completed `edit_file` calls. Ten calls failed, all with
invalid hashline refs: **10 / 35 = 28.6%** (the PR rounded this to 30%).

This is the comparison baseline. It measures executed edit calls, not task
completion, and keeps invalid-ref failures visible as the specific defect class
the dialect rollout targets.

## Reproducible report

Run:

```bash
pnpm report:edit-dialect
```

Use `PUSH_SESSION_DIR` or `--session-dir <path>` to scan a different CLI session
store. `--json` emits machine-readable output. The report cohorts by the
persisted tool-protocol marker (`old_string?, new_string?`), not by wall-clock
time, so an old resumed session or a machine that updates later cannot be
misclassified as post-rollout.

The default readiness floor is 35 post-dialect `edit_file` calls, matching the
baseline denominator. Until then the report says `pending` and gives the exact
remaining call count. Once ready it reports absolute and relative error-rate
change; it does not claim causality beyond this before/after observational
cohort.

## Web cohort

Web sessions already emit `tool.execute` spans with `push.provider`,
`push.model`, `push.tool.name`, and `push.tool.error_type`. Query GLM-5.1 spans
for the exact-edit tools (`sandbox_edit_file` and `sandbox_search_replace`) and
split at the production deployment of #1567 (2026-07-21 10:39:28 UTC). Use the
same 35-call minimum before publishing the after rate. Invalid-ref/hash mismatch
failures are the primary defect-class measure; total edit errors remain the
headline denominator-compatible measure.

CLI and web should be reported separately first. Combining them is defensible
only after each surface has enough calls, because their storage, session mix,
and guard/error taxonomies differ.
