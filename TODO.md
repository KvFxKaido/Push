# Big Four Extraction Track — Phase 1: Read-only Inspection

## Current Status
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

## Phase 2 Preview (Mutation Family)
- Characterization tests
- Extraction to sandbox-mutation-handlers.ts

**Target:** sandbox-tools.ts drops ~484 lines (read-only family).
