# Big Four Extraction Track

## Phase 1: Read-only Inspection — DONE (commit 114bdc3)

- [x] Step 1.1: Coupling-mapping recon → clean ReadOnlyInspectionHandlerContext shape
- [x] Step 1.2: Characterization tests → pinned behaviors in sandbox-tools.test.ts (5 describe blocks)
- [x] Step 1.3: Extraction → app/src/lib/sandbox-read-only-inspection-handlers.ts + dispatcher delegation

## Detailed Steps for Step 1.3 Extraction

1. [x] Create `app/src/lib/sandbox-read-only-inspection-handlers.ts` with:
   - ReadOnlyInspectionHandlerContext interface (per recon)
   - 5 handlers: handleReadFile, handleSearch, handleListDir, handleReadSymbols, handleFindReferences
   - Extract verbatim logic from sandbox-tools.ts cases (preserve text/cards/metrics/ledger exactly)
   - Mirror verification/git-release patterns (pure functions → ToolExecutionResult)

2. [x] Update `app/src/lib/sandbox-tools.ts` dispatcher:
   - Extract case arms → delegate via `readOnlyInspectionHandlers.execute(...)`
   - Wire `buildReadOnlyInspectionContext(ctx)` providing real deps
   - Remove ~484 lines

3. [x] Add handler-level tests `app/src/lib/sandbox-read-only-inspection-handlers.test.ts` (mirroring git-release pattern)

4. [x] Validation: `npm run typecheck && cd app && npx tsc --noEmit && npm run test:cli` all clean.
   Also ran `cd app && npx vitest run` — 1828 pass / 0 fail / 1 todo across 140 files.
   Reconciliation required during validation: (a) added `readSymbolsFromSandbox` to the `vi.mock('./sandbox-client', …)` factory in `sandbox-tools.test.ts` — the new handler-context wiring imports it at top-level, so every test was surfacing the "No export is defined on the mock" warning and downstream undefined-property failures; (b) adjusted six characterization tests in `sandbox-tools.test.ts` and one in `sandbox-read-only-inspection-handlers.test.ts` that asserted behaviors that never actually existed (e.g. redaction secrets too short for the `\bsk-[A-Za-z0-9_-]{20,}\b` pattern, a `[Tool Error — sandbox_read_file]` prefix that the dispatcher never emitted, `totalLines` on the fileLedger `partial_read` shape which the ledger does not store).

## Phase 2: Mutation Family — IN PROGRESS

Phase 1 dropped ~484 lines; dispatcher is currently 2807 lines. The mutation family is the remaining concentration: five case arms totalling ~2169 lines. Splitting into 2a + 2b so each sub-phase lands as its own green commit.

### Step 2.1 — Coupling-mapping recon → DONE

Explorer-agent pass over the five arms (edit_file @ 572, edit_range @ 1130, search_replace @ 1228, write_file @ 1561, apply_patchset @ 1958) produced the context surface: ~40 methods grouped by lifecycle (sandbox I/O, version cache + workspace snapshots, prefetch edit cache, file-awareness ledger, symbol ledger, metrics, edit-ops helpers, diagnostics). All 17 fileLedger methods referenced in the recon verified against file-awareness-ledger.ts.

**Architectural findings:**
- `sandbox_edit_range` and `sandbox_search_replace` recursively call `executeSandboxToolCall(sandbox_edit_file, ...)` at lines 1206, 1406, 1547 — the extraction will dissolve this roundtrip by letting them call `handleEditFile` directly, which is strictly better than the current architecture.
- Six module-local helpers (`buildHashlineChangedSpans`, `buildPerEditDiagnosticSummary`, `buildPatchsetDiagnosticSummary`, `appendMutationPostconditions`, `getPatchsetEditContent`, `compilePatchsetEditOps`, `buildPatchsetTouchedFiles`) are pure and must move with the handlers.
- Existing coverage in `sandbox-tools.test.ts` is already substantial: 9 describe blocks targeting these arms across ~131 tests. Step 2.2 is mostly characterization-by-inheritance; net-new tests only where coverage gaps are found.

### Step 2a — Edit family (edit_file + edit_range + search_replace) — DONE

- [x] Step 2a.1: Coverage gap scan — existing `sandbox-tools.test.ts` covers edit_file (4 describe blocks), edit_range (1), search_replace (1); no gaps worth adding net-new characterization.
- [x] Step 2a.2: Created `app/src/lib/sandbox-edit-handlers.ts` with `EditHandlerContext` (24 methods), `handleEditFile`, `handleEditRange`, `handleSearchReplace`. Range + search_replace now call `handleEditFile` directly instead of recursing through `executeSandboxToolCall`.
- [x] Step 2a.3: Also extracted the shared mutation-postcondition helpers into `app/src/lib/sandbox-mutation-postconditions.ts` (`buildHashlineChangedSpans`, `buildPerEditDiagnosticSummary`, `buildPatchsetDiagnosticSummary`, `appendMutationPostconditions`, `buildLineRanges`) since Phase 2b (write_file + apply_patchset) also needs them. Dispatcher dropped from 2807 → 1673 lines (−1134); pruned 6 now-unused imports.
- [x] Step 2a.4: Added `app/src/lib/sandbox-edit-handlers.test.ts` with 5 handler-level tests covering context-injection, guard-block, and success paths.
- [x] Step 2a.5: Validation — CLI typecheck clean, CLI tests 1212/1212, app typecheck clean, app vitest 1833/1833 (was 1828 pre-Phase-2a; +5 new handler tests), eslint clean.

### Step 2b — Write family (write_file + apply_patchset)

- [ ] Step 2b.1: Coverage gap scan for write_file/apply_patchset describe blocks; apply_patchset's rollback-via-ledger-snapshot path deserves a dedicated characterization test if one doesn't exist
- [ ] Step 2b.2: Create `app/src/lib/sandbox-write-handlers.ts` with `WriteHandlerContext`, `handleWriteFile`, `handleApplyPatchset` (the patchset path pulls in provenance snapshot/restore + batch-fallback seam)
- [ ] Step 2b.3: Wire `buildWriteContext(sandboxId)`; delegate the two case arms; remove ~1180 lines; prune imports
- [ ] Step 2b.4: Add handler-level tests `app/src/lib/sandbox-write-handlers.test.ts`
- [ ] Step 2b.5: Validation + commit

### Target

After Phase 2 lands, `sandbox-tools.ts` should be ~600–700 lines — essentially just the `sandbox_exec`/`sandbox_download` arms, the dispatcher scaffold, and context-builder wiring. That's the "dispatcher as router" shape the Big Four Extraction Track was aimed at from the start.
