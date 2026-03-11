# Agent Context Sprint Plan

## Goal

Close the information gaps between agent roles so each role can do its job with the context it actually needs — without adding LLM round-trips or breaking the mobile/Cloudflare constraint.

Core outcomes:
- Every role starts its work with the right context instead of burning rounds discovering it.
- Reviewer and Auditor produce higher-signal output with fewer false positives.
- Orchestrator→Coder handoff preserves intent, not just task description.
- All changes are client-side prompt assembly or pre-computation; no Worker architecture changes.

## Status

- Last updated: 2026-03-11
- State: Tier 0, Tier 1, and Tier 2 shipped; deferred follow-ups remain optional
- Intent: Improve agent decision quality by upgrading context injection, not adding capabilities
- Completed: 0A, 0B, 0C, 1A, 1B, 1C, 1D, 2A
- Remaining: Deferred deletion-anchor / two-phase review follow-ups only if dogfooding justifies them
- Post-review follow-up landed: oversized diff fallback, Auditor file-hint alignment, instruction filename sync on sandbox refresh, and regression coverage for all three

## Why

Analysis of all four agent roles surfaced a pattern: each role has specific blind spots that cost rounds, produce false positives, or lose intent during delegation. Most gaps are fixable at prompt-assembly time with information the app already has. The few that aren't can be addressed with bounded pre-computation before the LLM call.

Key gaps identified (verified against codebase):
1. **Coder** doesn't know the active branch, default branch, or protect-main status — burns a round on `git branch --show-current`.
2. **Coder** receives a lossy task summary — the *why* behind a delegation is often lost. Runtime (`tool-dispatch.ts:874`, `coder-agent.ts:483`) drops any fields beyond `task`, `files`, `acceptanceCriteria`.
3. **Coder** project instructions truncated without self-serve fallback hint.
4. **Reviewer and Auditor** hard-slice diffs at 40k/30k chars — later files silently vanish (`reviewer-agent.ts:114`, `auditor-agent.ts:91`).
5. **Reviewer** sees only the diff — can't check callers, imports, or surrounding code.
6. **Reviewer** can't anchor comments on deleted lines (type, UI jump, and GitHub PR posting all RIGHT-side only).
7. **Auditor** can't distinguish test files from production files.

### Gaps ruled out (already implemented)

- ~~Orchestrator doesn't see project instructions~~ — `useProjectInstructions.ts:184-186` appends `[PROJECT INSTRUCTIONS]` to `workspaceContext`, injected at `orchestrator.ts:666`.
- ~~Orchestrator doesn't know the branch~~ — `workspace-context.ts:98-103` already injects branch metadata.
- ~~Reviewer/Auditor don't know branch/repo~~ — `role-context.ts:38-55` injects `activeBranch`, `defaultBranch`, `repoFullName` via `formatCommonContext()`.
- ~~Auditor can't distinguish known domains from novel ones~~ — Council review (Codex) flagged this as **wrong failure mode** for a fail-safe gate: grep-based domain lists would miss env-driven hosts and SDK clients while creating false confidence in listed domains. Cut.

## Design Constraint

All changes must work within:
- **Client-side orchestration** — agent loops run in the browser, not on a server.
- **Cloudflare Workers** — stateless streaming proxy, no persistent state or long-running logic.
- **Mobile-first latency budget** — minimize added round-trips; prefer pre-computation over tool loops.
- **Token budget pressure** — every injected block costs context window; cap additions.

## Council Review (2026-03-11)

External review by Gemini and Codex. Key corrections and feedback incorporated:

| Finding | Source | Action |
|---------|--------|--------|
| 1A (Orchestrator project instructions) already exists via `workspaceContext` | Codex (code-verified) | **Cut** — duplicate work |
| 1B (Orchestrator branch metadata) already exists via `workspace-context.ts:98-103` | Codex (code-verified) | **Narrowed** — Coder-only |
| 1C understates implementation surface — runtime drops `intent`/`constraints` | Codex | **Expanded** — includes runtime changes |
| 1F is not prompt assembly — touches type schema, UI jump, GitHub PR posting | Both | **Moved** to Later tier |
| 2B (known domains for Auditor) creates false confidence in fail-safe gate | Codex | **Cut** |
| 3A (two-phase Reviewer) clashes with sandbox-less GitHub review flow | Both | **Deferred** until Tier 2 proven |
| 3B (default acceptance criteria) — "Broken Main Trap" with pre-existing test failures | Both | **Downgraded** to opt-in suggestion |
| Diff truncation is the biggest actual quality gap, missing from plan | Codex | **Added** as Tier 0 |
| Kill criteria are decorative — no baselines, no operationalized thresholds | Both | **Tightened** with specific numbers |
| 2A regex symbol extraction is brittle; narrow to file-local context, sandbox-only | Both | **Revised** |
| Instruction source filename discarded after fetch | Codex | **Added** tracking to 1D |

---

## Tier 0: Instrumentation (shipped)

### 0A. Prompt-size telemetry

**Status:** Shipped (dev-mode prompt-size breakdown is live).

**Problem:** No visibility into how much context budget each injected block consumes. Can't manage what isn't measured.

**Fix:** Add telemetry to `toLLMMessages()` and `buildCoderSystemPrompt()` that logs the byte/char size of each injected block:
- Orchestrator system prompt (base)
- User identity block
- Workspace context (including `[PROJECT INSTRUCTIONS]`)
- Sandbox tool protocol
- Scratchpad context
- Web search / ask-user protocols
- Total system prompt size

Log to console in dev; emit to `recordContextMetric()` (already exists at `orchestrator.ts` import) for aggregate tracking.

**Where:** `lib/orchestrator.ts` — `toLLMMessages()`. `lib/coder-agent.ts` — `buildCoderSystemPrompt()`.

**Latency cost:** Zero — string length checks.

**Acceptance:**
- Console logs show block-by-block size breakdown in dev mode.
- `recordContextMetric()` captures total system prompt size per call.
- Baseline numbers captured before any Tier 1 changes.

### 0B. Diff chunking for Reviewer and Auditor

**Status:** Shipped, with post-review fix for oversized first-file truncation.

**Problem:** Reviewer hard-slices diffs at 40k chars, Auditor at 30k chars (`reviewer-agent.ts:114`, `auditor-agent.ts:91`). Later files in the diff silently vanish. This is the single biggest quality gap — Codex correctly identified that fixing callers/imports before fixing "the diff is getting chopped arbitrarily" is backward.

**Fix:** Replace naive `.slice(0, LIMIT)` with file-aware chunking:

1. Parse the diff into per-file hunks (using existing `parseDiffIntoFiles()` from `lib/diff-utils.ts`).
2. Prioritize files by likely risk: production > test > fixture > tooling (reuse classification from 1E).
3. Pack files into the budget greedily until the char limit is reached — never split a file mid-hunk.
4. If files are dropped, append a summary: `[N files omitted due to size limit: path1.ts, path2.ts, ...]`.

**Where:**
- `lib/reviewer-agent.ts` — replace `annotatedDiff.slice(0, DIFF_LIMIT)` with `chunkDiffByFile()`.
- `lib/auditor-agent.ts` — replace `diff.slice(0, 30_000)` with `chunkDiffByFile()`.
- `lib/diff-utils.ts` — new `chunkDiffByFile(diff, limit, prioritize?)` utility shared by both.

**Token cost:** Same budget, better allocation. Potentially fewer tokens wasted on partial file hunks that cut off mid-context.

**Acceptance:**
- No file is split mid-hunk in the truncated diff.
- Dropped files are listed by name in a summary footer.
- Production files are prioritized over test/fixture files when space is limited.
- Reviewer's `filesReviewed` / `totalFiles` counts remain accurate.
- Auditor's fail-safe behavior unchanged — UNSAFE still the default on error.

### 0C. Instruction source tracking

**Status:** Shipped, with post-review fix for sandbox create/refresh sync.

**Problem:** The app fetches AGENTS.md, CLAUDE.md, or GEMINI.md but discards which filename was loaded (`fetchProjectInstructions` in `github-tools.ts:2412` returns content + filename, but downstream consumers don't propagate the filename). The Coder's self-serve hint (1D) needs to name the correct file.

**Fix:** Propagate the instruction filename through the data flow:
- `useProjectInstructions` already receives `filename` from `fetchProjectInstructions` — store it alongside `agentsMdContent`.
- Pass it through to `runCoderAgent()` so the self-serve hint names the right file.

**Where:**
- `hooks/useProjectInstructions.ts` — store `instructionFilename` state alongside `agentsMdContent`.
- `hooks/useChat.ts` → `lib/coder-agent.ts` — thread the filename through delegation.

**Latency cost:** Zero.

**Acceptance:**
- Instruction filename is preserved and accessible for downstream consumers.
- No behavior change — just data plumbing.

---

## Tier 1: Prompt Assembly (shipped)

Changes to how context blocks are built before the first LLM call. No additional latency.

### 1A. Coder branch metadata

**Status:** Shipped.

**Problem:** The Coder doesn't know the active branch, default branch, or protect-main status. Burns a round on `sandbox_exec('git branch --show-current')` to orient itself. (The Orchestrator already has this via `workspace-context.ts:98-103`; Reviewer/Auditor get it via `role-context.ts:38-55`.)

**Fix:** Inject branch metadata into the Coder's system prompt:
```
[WORKSPACE CONTEXT]
Active branch: feature/new-auth
Default branch: main
Protect main: on
```

**Where:** `lib/coder-agent.ts` — `buildCoderSystemPrompt()`, or passed via `runCoderAgent()` args. Values sourced from `useActiveRepo` / `useProtectMain` state, threaded through delegation.

**Token cost:** ~30 tokens. Negligible.

**Acceptance:**
- Coder system prompt includes branch metadata when available.
- Values match the UI state at delegation time.

### 1B. Structured delegation brief

**Status:** Shipped.

**Problem:** Orchestrator→Coder handoff loses intent. The `task` string is a lossy compression of a rich conversation. The runtime (`tool-dispatch.ts:874`, `coder-agent.ts:483`) currently only accepts `task`, `files`, and `acceptanceCriteria` — any other fields are silently dropped.

**Fix:** Extend the delegation format and runtime to support `intent` and `constraints`:

```typescript
// In delegate_coder args
{
  task: string;              // what to do (existing)
  intent?: string;           // why the user wants this (1-2 sentences)
  constraints?: string[];    // discussed limits on the approach
  files?: string[];          // already exists — file hints
  acceptanceCriteria?: ...;  // already exists
}
```

**Implementation surface** (all required — prompt-only change is insufficient):
1. `lib/github-tools.ts` — update `delegate_coder` tool definition and protocol prompt.
2. `lib/tool-dispatch.ts` — update `detectDelegateCoder()` to parse `intent` and `constraints` from args.
3. `lib/coder-agent.ts` — update `runCoderAgent()` signature, include `intent`/`constraints` in task preamble.
4. `hooks/useChat.ts` — thread new fields from detection through to `runCoderAgent()` call.

**Token cost:** ~100-200 tokens per delegation (intent + constraints). Paid once.

**Acceptance:**
- `delegate_coder` protocol prompt documents `intent` and `constraints` as optional fields.
- Runtime detects, parses, and threads `intent`/`constraints` through to the Coder.
- Coder's task preamble renders intent/constraints when present.
- Orchestrator system prompt includes guidance: "When delegating, include `intent` (why the user wants this) and `constraints` (limits discussed) to preserve context."

### 1C. Project instructions self-serve hint for Coder

**Status:** Shipped.

**Problem:** Coder's project instructions are truncated at ~2500 chars. Large instruction files lose important details.

**Fix:** Append a hint after the truncated block:
```
[PROJECT INSTRUCTIONS — truncated to 2500 chars]
...content...

Full file available at /workspace/AGENTS.md — use sandbox_read_file if you need details not shown above.
```

**Depends on:** 0C (instruction source tracking) to name the correct file.

**Where:** `lib/coder-agent.ts` — where `agentsMd` is injected into the system prompt.

**Token cost:** ~30 tokens. Only added when instructions are truncated.

**Acceptance:**
- Hint appears only when project instructions exceed the truncation cap.
- Hint names the correct filename (AGENTS.md, CLAUDE.md, or GEMINI.md — whichever was loaded).

### 1D. File classification hints for Auditor

**Status:** Shipped, with post-review fix to build hints from the chunked diff actually sent to the model.

**Problem:** Auditor can't distinguish test fixtures with hardcoded values from production files with leaked secrets. This is the single biggest source of false UNSAFE verdicts.

**Fix:** Before passing the diff, classify each changed file path by convention:
```
[FILE HINTS]
src/lib/auth.ts — production
src/lib/__tests__/auth.test.ts — test
scripts/seed-db.ts — tooling
fixtures/mock-tokens.json — fixture
```

Classification rules (pure string matching on paths already in the diff):
- `__tests__/`, `.test.`, `.spec.`, `test/`, `tests/` → test
- `fixtures/`, `mocks/`, `__mocks__/`, `__fixtures__/` → fixture
- `scripts/`, `tools/`, `bin/` → tooling
- Everything else → production

**Where:** `lib/auditor-agent.ts` — in context block assembly, before diff injection. Shared with 0B (diff chunking uses the same classification for prioritization).

**Token cost:** ~5-10 tokens per file. Typically <50 tokens total.

**Acceptance:**
- Auditor context includes `[FILE HINTS]` block when diff contains multiple files.
- Classification is path-based only (no file content analysis).
- Auditor prompt updated to reference file hints: "Use [FILE HINTS] to calibrate risk — hardcoded values in test/fixture files are lower risk than in production files."

---

## Tier 2: Pre-computation (new HTTP calls, no new LLM round-trips)

These fetch additional context before the single-shot LLM call. Cost is HTTP latency, not LLM turns.

### 2A. File-local context for Reviewer

**Status:** Shipped.

**Problem:** Reviewer sees only the diff. Can't check surrounding code structure to validate whether a change is safe.

**Fix:** Before the Reviewer LLM call, pre-fetch structural context from changed files:

1. Parse the diff to identify changed file paths.
2. For each changed file (up to 3), run `sandbox_read_symbols(path)` to get a structural index (functions, classes, interfaces with line numbers).
3. Inject as a supplementary block:

```
[FILE STRUCTURE — auto-fetched from changed files]
--- src/lib/auth.ts ---
export function validateToken(token: string): boolean [L12]
export function refreshSession(req: Request): Promise<Session> [L45]
export class AuthProvider [L78]
```

**Scope narrowing (per council review):**
- **Sandbox-only.** Do not fall back to GitHub API `search_files` — it's default-branch-indexed and stale for feature-branch reviews.
- **File-local only.** Use `sandbox_read_symbols` on the changed files themselves, not repo-wide symbol search. Repo-wide regex extraction is brittle against multi-line signatures, decorators, and anonymous functions.
- **2KB cap** (not 8KB). Keep supplementary context compact — it's structural hints, not full file contents.

**Where:** `lib/reviewer-agent.ts` — new `fetchFileStructure()` step before `runReviewer()`.

**Latency cost:** 1-3 parallel `sandbox_read_symbols` calls via `Promise.allSettled()`. ~1-2 seconds.

**Token cost:** Capped at 2KB total.

**Acceptance:**
- Reviewer prompt includes `[FILE STRUCTURE]` block when sandbox is available and changed files exist.
- Block is capped at 2KB.
- Context fetching uses `Promise.allSettled()` — individual failures don't block the review.
- Reviewer prompt notes: "File structure is auto-fetched and shows the outline of changed files. Use it for orientation but don't assume it's complete."
- When sandbox is unavailable (GitHub-only review), block is simply omitted — no degradation.
- UI shows "Preparing review..." state during pre-fetch.

---

## Later: Deferred items

These are valid improvements but should wait until earlier tiers prove out. Each has a specific trigger for when to revisit.

### Deleted-line annotations for Reviewer

**What:** Annotate removed lines with `[Dxxx]` markers, extend `ReviewComment` type with `removed_line` field, update diff-jump UI to handle left-side anchors, update GitHub PR posting to emit `side: 'LEFT'` comments.

**Why deferred:** Not a prompt assembly change — it's a multi-layer feature touching `types/index.ts`, `reviewer-agent.ts`, `HubReviewTab.tsx`, and `github-tools.ts` (PR posting). Implementation surface is larger than the other Tier 1 items. Both consultants flagged this as mis-tiered.

**Revisit when:** Dogfood feedback shows deletion-related review misses as a top-3 quality issue.

### Two-phase Reviewer (read-only tool access)

**What:** Convert Reviewer from single-shot to a two-phase pattern — Phase 1 produces review + optional read requests, Phase 2 (if needed) re-reviews with fetched context. Cap at 3 read-only tools, sandbox-only.

**Why deferred:** Clashes with the "GitHub review without sandbox" model (Branch/PR/commit review paths intentionally skip sandbox startup). Would create an inconsistent capability split. Both consultants said to prove Tier 2 first — if `sandbox_read_symbols` context is sufficient, two-phase may be unnecessary.

**Revisit when:** Tier 2 dogfood shows review quality still limited by missing context that file-local structure doesn't cover.

### Acceptance criteria suggestions

**What:** Generate suggested acceptance criteria from sandbox environment probe markers (e.g., `package.json` → suggest `npm test`). Surface as an opt-in UI suggestion in the delegation flow, not auto-injected.

**Why deferred:** The environment probe doesn't confirm whether `npm test` exists, is cheap, or passes on the current codebase. Auto-injecting would trigger the "Broken Main Trap" — the Coder burns all 30 rounds chasing pre-existing test failures unrelated to its task. Both consultants flagged >5% false failure rate as unacceptable.

**Why opt-in only:** At most, surface as a suggested checklist in the delegation sheet ("Would you like to require `npm test`?"). Never inject invisibly.

**Revisit when:** Probe data is enriched to detect whether test/typecheck scripts exist and are likely to pass (e.g., by running them once at sandbox startup and caching the result).

---

## Sequencing

### Phase 1 — Instrumentation (Tier 0)
- **Status:** Completed
- **Scope:** 0A (prompt telemetry), 0B (diff chunking), 0C (instruction filename tracking)
- **Risk:** Low for 0A/0C (pure data plumbing). Medium for 0B (changes diff presentation to Reviewer/Auditor — must preserve existing truncation stats and fail-safe behavior).
- **Validation:** Capture baseline prompt sizes. Verify diff chunking never splits files mid-hunk. Run `npm run lint && npm run test && npm run build`.
- **Gate:** Baseline prompt-size numbers must be captured before proceeding to Phase 2.

### Phase 2 — Prompt assembly (Tier 1)
- **Status:** Completed
- **Scope:** 1A (Coder branch metadata), 1B (structured delegation brief), 1C (Coder instruction hint), 1D (Auditor file hints)
- **Risk:** Low for 1A/1C/1D (prompt string additions). Medium for 1B (runtime changes across 4 files — tool-dispatch, coder-agent, github-tools, useChat).
- **Validation:** Verify prompt sizes stay within 15% of Tier 0 baselines. Verify `intent`/`constraints` survive round-trip through tool detection → coder execution. Dogfood 5+ delegations with structured briefs.

### Phase 3 — Pre-computation (Tier 2)
- **Status:** Completed
- **Scope:** 2A (file-local Reviewer context)
- **Risk:** Medium — adds sandbox HTTP calls before review LLM call. Must degrade gracefully when sandbox unavailable.
- **Validation:** Dogfood 5+ reviews with file structure context. Compare review signal quality vs. Phase 2 baseline. Verify p90 pre-fetch latency stays under 3 seconds.

---

## Out of Scope

- Server-side agent loops or Durable Objects.
- Giving Auditor tool access (conflicts with fail-fast safety design).
- Unbounded Reviewer tool loops.
- Passing full conversation history to Coder (token cost too high; structured brief is the right compression).
- Native function calling (provider-agnostic design is a deliberate tradeoff).
- Known-domain summary for Auditor (wrong failure mode for fail-safe gate — creates false confidence).

## Kill Criteria

All thresholds are relative to baselines captured in Tier 0.

- **Prompt size:** If Tier 1 increases the Orchestrator or Coder system prompt by more than 15% of the total rolling-window budget (measured via 0A telemetry), roll back to pre-sprint injection sizes.
- **Pre-fetch latency:** If p90 time-to-first-byte of the Reviewer LLM response increases by more than 3 seconds on mobile networks (measured via review start timestamp → first stream chunk), make 2A opt-in rather than default.
- **Diff chunking regression:** If chunked diffs produce worse Auditor verdicts than raw slicing in 1 week of dogfood (measured by comparing SAFE/UNSAFE ratio on same diffs with both methods), revert to raw slicing.
- **Delegation brief adoption:** If fewer than 30% of delegations include `intent` after 2 weeks, revisit the prompt guidance — the model may need stronger encouragement or examples.

## Measurement

Baselines captured in Phase 1 (Tier 0). All metrics tracked per-phase.

Primary metrics:
- System prompt size by block (chars) — baseline from 0A
- Coder orientation rounds (branch/context discovery calls in first 3 rounds — should decrease with 1A)
- Reviewer file coverage (filesReviewed / totalFiles — should increase with 0B)
- Auditor false-UNSAFE rate on test files (should decrease with 1D)

Secondary metrics:
- Delegation intent coverage (% of delegations that include `intent` field — tracks 1B adoption)
- Coder self-serve project instruction reads (frequency of full AGENTS.md reads via 1C hint)
- Review pre-fetch latency (p50, p95 for 2A)
- Diff files dropped by chunking (count per review/audit — tracks 0B effectiveness)
