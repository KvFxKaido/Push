# Web–CLI Parity Plan

## Status
- Created: 2026-03-11
- Last revised: 2026-03-11 (post-council review — Gemini + Codex)
- State: Planning — no tracks started
- Intent: Close feature and quality gaps between the web app and CLI so both surfaces offer a coherent agent experience

## Why

The web app and CLI evolved independently. They share zero imports — every shared concept (hashline, file ledger, error classification, tool detection, provider streaming) is reimplemented in both places. This creates two problems:

1. **Feature asymmetry.** The web app has 50+ tools, 4 agent roles, 7 providers, and rich safety gates. The CLI has 20 tools, 1 agent role, 4 providers, and lighter guards. Users switching between surfaces lose capabilities.
2. **Maintenance drag.** Bug fixes and protocol changes (hashline format, error types, tool dispatch logic) must be applied twice and tested separately. Drift is inevitable.

This plan addresses both — feature gaps first (where users feel the pain), structural convergence second (where maintainers feel the pain).

## Principles

1. CLI is a first-class surface, not a web app afterthought.
2. Port proven patterns — don't reinvent for the CLI what the web already validated.
3. Small, shippable tracks — each track should be mergeable independently.
4. Keep the CLI zero-dependency (Node built-ins only) unless there's a compelling reason.
5. Web-to-CLI ports use the web implementation as the reference spec, not a copy target — adapt to CLI's runtime and conventions.

## Inventory Snapshot

### Feature parity (web has, CLI lacks)

| Feature | Web | CLI | Impact |
|---------|-----|-----|--------|
| ~~Private connectors (Azure, Bedrock, Vertex)~~ | 3 backends + deployment presets | None | ~~High~~ — **Deferred** |
| Reviewer agent | Advisory diff review, line anchors, PR posting | None | High — review workflow missing |
| Auditor pre-commit gate | Binary SAFE/UNSAFE verdict on every commit | Pattern-based approval only | High — safety gap |
| Scratchpad | Session-scoped read/write/append tools | None (`save_memory` is cross-session only) | Medium — agent loses ephemeral notes |
| Protect Main | Blocks commits/pushes to default branch | None | Medium — safety gap |
| Multi-tool dispatch quality | 6 parallel reads + 1 mutation, deduping, structured diagnosis | Parallel reads + 1 mutation (no dedup, no structured diagnosis) | Medium — error recovery + hardening |
| `sandbox_edit_range` / `sandbox_search_replace` | Yes | No equivalent | Low — CLI has `edit_file` hashline ops |
| `sandbox_apply_patchset` | Multi-file transactional edits | No equivalent | Low — nice-to-have |

### Quality parity (same feature, web is more robust)

| Component | Web | CLI | Risk |
|-----------|-----|-----|------|
| Hashline edits | Two-phase resolution, 7-12 char adaptive hashes | Single-pass, fixed 7-char | Edit failures on hash collisions |
| File awareness ledger | 620 lines: edit guards, symbol extraction, staleness | 59 lines: status tracking only | Agent can edit files it hasn't read |
| Tool call metrics | Provider → model → tool → reason hierarchy | Flat reason counter | Can't diagnose per-model issues |
| Error classification | 11 structured types + retryable flags | 6 simple codes | Less actionable LLM feedback |
| Malformed call diagnosis | 4-phase (truncation, validation, JSON, NL intent) + arg hints | Basic JSON parse error | Slower self-correction |
| Diff parsing | Extracted module (`diff-utils.ts`) | Inline regex | No structured diff output |

### Reverse parity (CLI has, web lacks)

| Feature | CLI | Web | Notes |
|---------|-----|-----|-------|
| Persistent memory (`save_memory`) | Cross-session `.push/memory.md`, injected into prompt | None | Web scratchpad is session-scoped |
| Skills / prompt templates | `.push/skills/*.md`, recursive discovery, `/skills reload` | None | Composable prompt reuse |
| `undo_edit` with backups | Auto-backup before writes, explicit undo tool | Git-based undo only | Explicit undo is faster UX |
| Explain mode | `[explain]` notes after actions | None | Learnable agent behavior |
| Execution sessions | `exec_start`/`exec_poll`/`exec_write`/`exec_stop` | `sandbox_exec` (fire-and-forget) | Streaming output for long commands |
| LSP diagnostics | TS, Python, Rust, Go | `sandbox_check_types` (TS only) | Broader language coverage |
| Docker local sandbox | Optional containerized exec | Modal only (serverless) | Offline / air-gapped use |

---

## Tracks

### Track A — Safety Guards (Small, High Value)

Port the web app's safety primitives to the CLI. Each item is independently shippable.

#### A1. Protect Main

Block `git_commit` when the active branch is the repo's default branch (usually `main` or `master`).

- [ ] Add `isDefaultBranch()` check to `tools.mjs` using `git symbolic-ref refs/remotes/origin/HEAD` or config fallback
- [ ] Gate `git_commit` tool: if on default branch and protect-main is enabled, return structured error with suggestion to create a branch
- [ ] Add `protectMain` field to `config-store.mjs` (default: `false`, matching web's opt-in behavior)
- [ ] Add `--protect-main` CLI flag override
- [ ] Test: commit on main blocked, commit on feature branch allowed, flag override works

**Reference:** `hooks/useProtectMain.ts`, sandbox-tools.ts `sandbox_prepare_commit` guard.

#### A2. Auditor Pre-Commit Gate

Wrap `git_commit` with an LLM-driven diff review that produces a SAFE/UNSAFE verdict.

**Design note:** The CLI's `git_commit` tool stages files and commits in one shot (`tools.mjs:1742`). The auditor must review the *actual commit payload*, not an empty `--cached` diff. The correct sequence is: stage → audit the staged diff → commit on SAFE / unstage on UNSAFE. This matches the web's `sandbox_prepare_commit` flow where staging happens before the auditor runs.

- [ ] Port auditor prompt from `lib/auditor-agent.ts` to CLI (keep prompts local per surface — share parsers and schemas, not prompt text)
- [ ] Add `auditDiff(diffText, provider, model)` function to new `cli/auditor.mjs`
- [ ] Restructure `git_commit` staging flow: (1) stage files via `git add`, (2) capture `git diff --cached`, (3) run auditor, (4) commit on SAFE or `git reset` on UNSAFE
- [ ] Fail-safe: default to UNSAFE on LLM error, timeout (60s), or unparseable response
- [ ] Add `--no-audit` flag for explicit bypass (headless mode only)
- [ ] Configurable in `config-store.mjs`: `auditCommits: true|false` (default: `true`)
- [ ] Test: SAFE passes, UNSAFE blocks, LLM timeout blocks, `--no-audit` bypasses, unstage-on-UNSAFE works cleanly
- [ ] **TUI:** Emit a color-coded verdict event (`[SAFE]` green / `[UNSAFE]` red) in the transcript via the existing `tool_result` event stream

**Reference:** `lib/auditor-agent.ts` (verdict parsing, fail-safe logic), `lib/diff-utils.ts` (diff stat parsing for auditor context).

#### A3. File Ledger Upgrade — Edit Guards

Port the web's edit guard logic so the CLI agent can't edit lines it hasn't read.

- [ ] Expand `file-ledger.mjs` to track line ranges per file (not just status)
- [ ] Add `checkEditGuard(path, lineRanges)` — returns `{ allowed, reason }` based on read coverage
- [ ] Wire `edit_file` and `write_file` in `tools.mjs` to consult the ledger before executing
- [ ] Guard modes: `warn` (include warning in tool result) and `block` (return error, don't write)
- [ ] Default to `warn` for `write_file`, `block` for `edit_file` (matches web behavior)
- [ ] Update `read_file` handler to call `recordRead(path, startLine, endLine, totalLines)`
- [ ] Test: edit on unread file blocked, edit on partially-read file warns, edit on fully-read file passes

**Reference:** `lib/file-awareness-ledger.ts` (`FileAwarenessLedger` class, `checkEditGuard()`, `recordRead()`).

---

### Track B — Agent Capabilities (Medium, High Value)

Add missing agent roles and tools.

#### B1. Scratchpad

Session-scoped notepad the agent can read/write, distinct from cross-session `save_memory`.

- [ ] Add `set_scratchpad`, `append_scratchpad`, `read_scratchpad` tools to `tools.mjs`
- [ ] Store scratchpad content in session state (`session-store.mjs`)
- [ ] Inject current scratchpad content into system prompt as `[SCRATCHPAD]...[/SCRATCHPAD]` block
- [ ] Escape content to prevent prompt injection (zero-width space at delimiters, matching web approach)
- [ ] Size cap: 50KB (matching web)
- [ ] Test: set/append/read round-trip, injection escaping, size cap enforcement
- [ ] **TUI:** Add `/scratchpad` command to view current content in a scrollable panel; show scratchpad byte size in the status bar when non-empty

**Reference:** `lib/scratchpad-tools.ts`, `hooks/useScratchpad.ts`.

#### B2a. Reviewer Agent — Local Review

Local diff review with structured findings. No sandbox or GitHub API required — just `git diff`.

- [ ] Create `cli/reviewer.mjs` with `reviewDiff(diffText, provider, model, options)` function
- [ ] Port reviewer prompt from `lib/reviewer-agent.ts` (keep prompt local — share the `ReviewComment` parser/schema, not the prompt text)
- [ ] Support three diff sources:
  - `git diff` (working tree)
  - `git diff --cached` (staged)
  - `git diff main...HEAD` (branch diff)
- [ ] Parse structured `ReviewComment[]` output (file, line, severity, comment)
- [ ] New `/review` CLI command: `./push review [working|staged|branch]`
- [ ] JSON output: `./push review --json` emits `{ source, ref, base, provider, model, findings[], summary }` to stdout
- [ ] Exit codes: 0 if no critical/warning findings, 1 otherwise (CI-friendly)
- [ ] Provider/model selection: inherit active provider or `--provider`/`--model` override
- [ ] 90s timeout (matching web)
- [ ] Test: structured output parsing, severity levels, diff source selection, exit codes
- [ ] **TUI:** Add `/review [working|staged|branch]` as an in-session command; render findings as color-coded transcript entries (critical=red, warning=yellow, suggestion=cyan, note=dim)

**Reference:** `lib/reviewer-agent.ts` (prompt, `ReviewComment` parsing, severity enum).

#### B2b. Reviewer — GitHub PR Posting — DEFERRED

Post review findings directly to GitHub as a PR review. Deferred: the CLI has no GitHub auth/client layer today, and CLI users can pipe `--json` output to `gh pr review` in the meantime.

- [ ] Add GitHub token config to `config-store.mjs` (or read from `gh auth token`)
- [ ] `./push review --post-to-pr <number>` posts findings as a PR review via GitHub API (inline comments for line-anchored findings, body bullets for file-level notes)
- [ ] Test: PR posting with inline comments, auth failure handling

#### ~~B3. Private Connectors (Azure, Bedrock, Vertex)~~ — DEFERRED

Deferred indefinitely. The web app covers the hard UX; CLI users with enterprise backends can add a provider entry themselves. See Open Question 4.

---

### Track C — Tool Dispatch Quality (Medium, Efficiency)

Close the gap in how the CLI detects, validates, and parallelizes tool calls.

#### C1. Multi-Tool Dispatch Hardening

The CLI already parallelizes read-only calls and enforces one-mutation-per-turn (`engine.mjs:405`). What's missing is dedup, boundary semantics, and the parallel cap. This is hardening, not a greenfield port.

- [ ] Add deduplication of logically-identical invocations (stable JSON key comparison) to `detectAllToolCalls()` in `tools.mjs`
- [ ] Cap at 6 parallel reads + 1 mutation (matching web)
- [ ] Improve read-only vs. mutating classification if any tools are miscategorized
- [ ] Test: dedup works, cap enforced, edge cases (e.g. same file read with different line ranges is not deduped)

**Reference:** `lib/tool-dispatch.ts` (`detectAllToolCalls()`, `isReadOnlyToolCall()`, dedup logic).

#### C2. Structured Malformed-Call Diagnosis

Replace basic JSON parse errors with 4-phase diagnosis and arg hints.

- [ ] Port diagnosis phases from `lib/tool-dispatch.ts`:
  1. Truncation detection (unbalanced braces, cut-off JSON)
  2. Validation failure (JSON parses, known tool name, bad args)
  3. Malformed JSON (syntax error with specific diagnosis)
  4. Natural language intent (model described wanting a tool in prose)
- [ ] Include example JSON format for the detected tool name (arg hints)
- [ ] Inject structured feedback as tool result so model can self-correct
- [ ] Upgrade `tool-call-metrics.mjs` to track by provider/model/tool/reason (matching web hierarchy)
- [ ] Test: each diagnosis phase triggers correctly, arg hints are accurate

**Reference:** `lib/tool-dispatch.ts` (`diagnoseToolCallFailure()`, `TOOL_CALL_ARG_HINTS`).

#### C3. Error Classification Upgrade

Expand CLI error types to match web's structured taxonomy.

- [ ] Expand `classifyToolError()` in `tools.mjs` to cover all 11 web error types:
  - FILE_NOT_FOUND, EXEC_TIMEOUT, WORKSPACE_CHANGED, STALE_FILE
  - EDIT_GUARD_BLOCKED, EDIT_HASH_MISMATCH, AUTH_FAILURE
  - RATE_LIMITED, WRITE_FAILED, COMMAND_FAILED, UNKNOWN
- [ ] Add `retryable` boolean to all classified errors
- [ ] Add `detail` field for context (matching web's `StructuredToolError`)
- [ ] Ensure all tool result errors flow through `classifyToolError()`
- [ ] Test: each error type is reachable, retryable flags are correct

**Reference:** `lib/sandbox-tools.ts` (`classifyError()`, `StructuredToolError` type, `ToolErrorType` enum).

---

### Track D — Hashline Correctness (Medium, Safety)

The CLI's single-pass, fixed 7-char hashline implementation is materially weaker than the web's two-phase, adaptive-length version. This is correctness work — hash collisions can corrupt files.

#### D1. Two-Phase Hashline Resolution

Port the web's more robust hashline edit algorithm.

- [ ] Replace CLI's single-pass resolution with two-phase approach:
  1. **Ref resolution phase:** Resolve all `lineNo:hash` refs to concrete line numbers upfront, detecting stale refs and hash collisions before any edits
  2. **Application phase:** Apply resolved edits with offset tracking for insertions/deletions
- [ ] Support adaptive hash length (7-char default, extend to 12-char on collision)
- [ ] Add disambiguation logic: when two lines share a 7-char hash, auto-extend and report
- [ ] Preserve `calculateContentVersion()` (CLI-only, used for expected_version tracking)
- [ ] Test: collision disambiguation, stale ref detection, multi-edit offset tracking, batch ordering

**Reference:** `lib/hashline.ts` (two-phase `applyHashlineEdits()`, `calculateLineHash()` with length param).

**Note:** D2 (Diff Parsing Module) was merged into F1 — diff-utils is now the first shared-module extraction spike instead of being created twice.

---

### Track E — Reverse Parity — SEPARATED

Track E (web adopts CLI features: persistent memory, skills, explain mode) has been moved to a separate follow-on plan. Rationale: these are additive web features, not CLI parity gaps, and they add scope before safety and correctness gaps are closed. Items preserved for reference:

- **E1. Persistent Memory** — Web agent accumulates cross-session knowledge per repo (like CLI's `save_memory`)
- **E2. Skills / Prompt Templates** — Load `.push/skills/*.md` from repos, surface as `/skill-name` commands in composer
- **E3. Explain Mode** — Toggle that makes the agent add `[explain]` notes after actions

### Web Auditor Provider Fix

The resolved Open Question 2 identified a web-side inconsistency: the Auditor resolves through `getActiveProvider()` (global Settings preference) instead of inheriting the chat-locked provider/model like the Orchestrator and Coder do.

- [ ] Thread the chat-locked provider/model through to `runAuditorReview()` in `lib/auditor-agent.ts`
- [ ] Fall back to `getActiveProvider()` only when no chat lock exists (e.g. non-chat flows)
- [ ] Test: auditor uses chat-locked provider when available, falls back to active provider otherwise

---

### Track F — Structural Convergence (Large, Long-Term)

Extract shared logic into runtime-agnostic modules both surfaces can import. This is the long-term play to eliminate the synchronization burden.

#### F0. Decision Record — Shared Module Format

**Decision:** Plain `.mjs` modules with JSDoc types in a `shared/` directory. No TypeScript dependency for the CLI.

**Context:** The CLI is 13,700 lines of zero-dependency ESM JavaScript (no `package.json`, no build step). The web app is TypeScript + Vite. We evaluated three options for enabling code sharing:

| Option | Pros | Cons |
|--------|------|------|
| **A. Plain `.mjs` + JSDoc** | No build step, no new deps, CLI runs files directly, Vite imports `.mjs` natively | No compile-time type checking in CLI (IDE-only via `// @ts-check`), JSDoc is more verbose than TS syntax |
| **B. TypeScript for CLI** | Type safety at build time, easier porting from web `.ts` files, shared `.ts` sources | Adds build step (`edit → compile → run`), needs `package.json` + `tsconfig.json`, breaks zero-dependency principle |
| **C. Node `--experimental-strip-types`** | Write `.ts`, run directly with Node 22 | Experimental flag, no type-checking at runtime (still need `tsc` in CI), doesn't actually strip enums or other TS-only emit |

**Why not TypeScript (Option B):**
- The language gap (TS vs JS) and the runtime gap (browser vs Node) are separate problems. TypeScript solves the first but does nothing about the second — and the second is what blocks sharing for crypto-dependent modules (hashline hashing, provider streaming).
- The CLI's edit → run workflow with no build step is a real asset. Adding a compile step for ~15 shared type definitions isn't worth the friction.
- TypeScript would be a small net positive for internal CLI quality, but it's not the lever that unlocks sharing. That lever is the adapter pattern (inject runtime dependencies, share the algorithm).

**Why plain `.mjs` (Option A):**
- Vite already imports `.mjs` files. The CLI already runs them. Zero setup on either side.
- JSDoc `@typedef` and `@param` annotations provide IDE-level type checking when paired with `// @ts-check`. Not as strong as `tsc`, but sufficient for ~5 shared modules of pure logic.
- The shared modules are small and algorithmic — exactly the kind of code where JSDoc types are adequate.
- If we later decide CLI quality demands full TypeScript, we can migrate incrementally without changing the shared module format (TS can import `.mjs`).

**Runtime API strategy:** Modules that depend on platform APIs (crypto, fetch) use dependency injection — the caller provides the runtime-specific function, the shared module contains only the algorithm.

```javascript
// shared/hashline-core.mjs — pure algorithm, hashFn injected
export function applyHashlineEdits(content, edits, hashFn) { /* ... */ }

// cli/hashline.mjs — Node adapter
import { applyHashlineEdits } from '../shared/hashline-core.mjs';
const hashFn = (line) => createHash('sha1').update(line).digest('hex').slice(0, 7);
export const apply = (content, edits) => applyHashlineEdits(content, edits, hashFn);

// app/src/lib/hashline.ts — Browser adapter
import { applyHashlineEdits } from '../../shared/hashline-core.mjs';
const hashFn = async (line) => { /* crypto.subtle */ };
export const apply = (content, edits) => applyHashlineEdits(content, edits, hashFn);
```

**Candidate shared modules (pure logic, no runtime APIs):**

| Module | What it contains | Runtime-dependent parts |
|--------|-----------------|----------------------|
| `shared/hashline-core.mjs` | Ref parsing, two-phase resolution, offset-tracking edit application | Hash function (injected) |
| `shared/diff-utils.mjs` | `parseDiffStats`, `parseDiffIntoFiles`, `formatSize` | None |
| `shared/reasoning-tokens.mjs` | Think-token parser (`<think>...</think>`, native `reasoning_content`) | None |
| `shared/error-types.mjs` | Error type enum, classification patterns, `retryable` flags | None |
| `shared/tool-detection.mjs` | Fenced JSON scanning, bare JSON recovery, repair heuristics | None |

**Status:** DECIDED. Proceed with Option A.

#### F1. Phase 0 Spike — Validate Shared Module Pipeline

Before extracting multiple modules, prove the `shared/` approach works end-to-end with one module. Both advisors flagged that `app/tsconfig.app.json` only includes `src/` and Vite's dev server may not serve files above `app/` without configuration. Validate before committing to the pattern.

- [ ] Create `shared/` directory at repo root with a README explaining the contract (pure ESM, no runtime deps, JSDoc types, `// @ts-check`)
- [ ] Extract `shared/diff-utils.mjs` from `app/src/lib/diff-utils.ts` (easiest candidate: zero runtime deps, pure string parsing, 77 lines)
- [ ] Replace inline diff regex in CLI's `tools.mjs` with imports from `shared/diff-utils.mjs`
- [ ] Update `app/src/lib/diff-utils.ts` to re-export from `../../shared/diff-utils.mjs` (or replace entirely)
- [ ] Add `shared/` to Vite's `server.fs.allow` in `app/vite.config.ts`
- [ ] Update `app/tsconfig.app.json` to include `../shared` in its `include` array (or add `allowJs: true` + path mapping)
- [ ] Add `// @ts-check` + JSDoc type annotations to the shared module
- [ ] Write one shared test file that runs under both `vitest` (web) and `node:test` (CLI)
- [ ] Verify: `npm run build`, `npm run typecheck`, `npm run test` all pass in `app/`; CLI tests pass
- [ ] Verify Vite production build includes shared module correctly (no missing chunks)

**If the spike succeeds**, proceed with remaining extractions. If Vite or TypeScript integration proves too painful, fall back to duplicated-but-aligned modules with a shared test suite.

#### F2. Extract Remaining Shared Modules (after F1 spike validates)

- [ ] `shared/error-types.mjs` — error type enum, classification patterns, `retryable` flags
- [ ] `shared/reasoning-tokens.mjs` — think-token parser (`<think>...</think>`, native `reasoning_content`)
- [ ] `shared/hashline-core.mjs` — ref parsing, two-phase resolution, edit application with injected `hashFn` (extract after D1 lands so we extract the final algorithm)
- [ ] `shared/tool-detection.mjs` — fenced JSON scanning, bare JSON recovery, repair heuristics (extract cautiously — both surfaces' detection contracts should be aligned first)
- [ ] Update imports in both `app/src/lib/` and `cli/` to use shared modules
- [ ] Test: all existing tests pass in both environments, no runtime regressions

---

## Execution Order

Revised after Gemini + Codex council review. Key changes from original: D1 moved to Phase 1 (correctness, not late capability), D2 merged into F1 spike, Track E separated, C1 reframed as hardening, B2 split into local/GitHub-posting phases.

**Phase 0 — Validate shared pipeline (1 session):**
1. F1 (Shared Module Spike — diff-utils): prove `shared/` works end-to-end before building on the pattern

**Phase 1 — Safety and correctness (1-2 sessions each):**
2. A1 (Protect Main)
3. D1 (Hashline Two-Phase) — correctness fix, not a late capability
4. A3 (File Ledger Upgrade)
5. B1 (Scratchpad)

**Phase 2 — Quality and gates (2-3 sessions each):**
6. A2 (Auditor Gate — with corrected staging flow)
7. C2 + C1 (Malformed-Call Diagnosis + Dispatch Hardening — ship together)
8. C3 (Error Classification)
9. Web Auditor Provider Fix (small, web-side only)

**Phase 3 — Capabilities and extraction (3-5 sessions each):**
10. B2a (Reviewer, local only)
11. F2 (Extract remaining shared modules — error-types, reasoning-tokens, hashline-core after D1, tool-detection cautiously)

**Later (separate plans):**
- B2b (Reviewer GitHub PR posting — needs CLI GitHub auth layer)
- Track E (Reverse parity: persistent memory, skills, explain mode for web)
- B3 (Private connectors — deferred indefinitely)

## Dependencies

- D1 (Hashline) and A3 (File Ledger) are both correctness work; A3 should land before or alongside D1 so edit guards and hashline upgrades compose cleanly.
- A2 (Auditor) benefits from C3 (Error Classification) for cleaner error handling but doesn't strictly depend on it.
- C1 (Dispatch Hardening) and C2 (Malformed Diagnosis) are independent but ship well together — both touch tool detection.
- B2a (Reviewer) benefits from `shared/diff-utils.mjs` (Phase 0 spike) for consistent diff parsing.
- F2 hashline-core extraction must wait for D1 to land so we extract the final two-phase algorithm.
- F2 tool-detection extraction should wait until C1+C2 stabilize the CLI's detection contract.
- Track E is independent of all CLI tracks (separated into its own plan).

## Open Questions

1. ~~**Shared module format:**~~ **RESOLVED** — Plain `.mjs` + JSDoc types. See Track F0 decision record.
2. ~~**Auditor model routing:**~~ **RESOLVED** — Auditor inherits the active provider/model (same as Orchestrator/Coder), not a dedicated role-specific model. Applies to both web and CLI. Web-side fix is now an explicit task (see "Web Auditor Provider Fix" above). **Caveat from Gemini council review:** if a user chats with a cheap/fast model (e.g. Haiku), auditing with that same model may degrade safety. Monitor after shipping — if this becomes a problem, consider allowing an auditor model override in config.
3. ~~**Reviewer CI integration:**~~ **RESOLVED** — Custom `ReviewComment[]`-aligned JSON, not SARIF. Output format: `{ source, ref, base, provider, model, findings: [{ file, line, severity, comment }], summary: { critical, warning, suggestion, note } }`. Exit code 0 if no critical/warning, non-zero otherwise. GitHub posting deferred to B2b (needs CLI GitHub auth layer). Users can pipe `--json` to `gh pr review` in the meantime.
4. ~~**Private connector auth:**~~ **RESOLVED** — Deferred indefinitely. Auth/runtime complexity (AWS SigV4, Google ADC) in a zero-dependency CLI is not justified without proven demand. Enterprise CLI users can set up an OpenAI-compatible proxy (e.g. LiteLLM) locally and point the CLI at that.

## Council Review Log

**Reviewed:** 2026-03-11 by Gemini (gemini-3.1-pro-preview) and Codex (GPT-5.4).

**Key revisions applied:**
- D1 (Hashline) moved from Phase 3 to Phase 1 — correctness work, not a late capability (both advisors)
- D2 (Diff Parsing) merged into F1 spike to avoid double extraction (both advisors)
- Phase 0 spike added for shared module validation — tsconfig/Vite integration risk (both advisors)
- A2 (Auditor) staging flow redesigned: stage → audit → commit/rollback (Codex found the bug)
- B2 split into B2a (local review) and B2b (GitHub posting, deferred) — CLI has no GitHub auth layer (Codex)
- C1 reframed as hardening — CLI already has parallel dispatch (Codex found the inventory error)
- Track E separated into its own plan — additive web features shouldn't block safety work (both advisors)
- Web Auditor provider fix promoted from a note to an explicit task (Codex)
- "Share parsers and schemas, not prompts" guidance applied to A2 and B2a (Codex)
- Gemini cautioned that auditor-inherits-chat-lock may degrade safety with cheap models — noted for monitoring
