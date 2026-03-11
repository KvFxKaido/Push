# Harness Ergonomics Plan

## Goal

Close the gap between "tool call succeeded" and "agent knows what to do next" — so the Coder spends rounds on the task, not on re-orienting after every action.

Core outcomes:
- Mutations return enough signal for the agent to proceed without follow-up reads.
- The agent can navigate code structurally (references, not just declarations).
- Working memory degrades gracefully instead of going stale silently.
- The harness prevents wasted turns on impossible actions and interactive traps.

## Status

- Last updated: 2026-03-11
- State: **Sprint 1 complete** — all four items implemented, council-reviewed, fixes applied, tests passing
- Origin: Cross-agent self-report (`documents/analysis/Harness Friction — Agent Self-Report.md`). Gripes sourced from Claude Code (Opus 4.6), Gemini, and Codex (GPT-5.4) during real sessions.

## Why

The Harness Reliability Plan (shipped) focused on making tool calls *work correctly* — hashline edits, error taxonomy, multi-tool dispatch, structured feedback. This plan focuses on making tool calls *inform correctly* — so each successful tool result gives the agent enough context to choose its next action without burning an extra round.

Three agents independently flagged the same core pattern: **mutation results are too thin, symbol navigation stops at declarations, and working memory doesn't know when it's stale.** These are round-efficiency problems, not correctness problems — but they compound. A Coder task that should take 8 rounds takes 14 because half the rounds are re-reads and re-orientation.

## Scope

**Primary target: web app** (mobile-first, Cloudflare + Modal sandbox). All items are designed and prioritized for the web Coder agent running in the sandbox.

The CLI/TUI agent (`cli/`) may benefit from the same ideas, but this plan does not scope CLI work. Where a design decision could affect future CLI adoption, it's noted — but the CLI should not constrain web-side choices. Keep the two surfaces cleanly separated; shared abstractions only when they emerge naturally, not forced.

## Design Constraints

Same constraints as prior plans:
- **Client-side orchestration** — agent loops run in the browser.
- **Cloudflare Workers** — stateless streaming proxy.
- **Mobile-first latency budget** — minimize added round-trips; prefer pre-computation.
- **Token budget pressure** — every injected block costs context window; keep additions compact.
- **Sandbox boundary** — Modal containers are ephemeral (30 min), no persistent daemons. Per-request analysis is fine; persistent LSP is not (unless container lifecycle hooks are added).

## Council Review (2026-03-11)

Gemini and Codex (GPT-5.4) reviewed the draft plan. Codex read the actual codebase before answering, including running `tsc` on the repo to ground the latency question.

### Key decisions from review

1. **1A diagnostics: `tsc --noEmit <file>` is not viable.** Codex tested it on this repo: single-file check took 4.4s and produced bogus path-alias errors (`@/` imports unresolved without full project config). Full project check was 0.38s warm — faster, but still too slow for per-edit. Both agents recommend a **two-tier model**: fast syntax check per-edit, full typecheck only on patchsets.

2. **1B rollback: keep `/tmp` snapshots, don't use git.** Both agents agree. `git checkout` reverts to HEAD, not pre-patchset dirty state. `git stash` bundles pre-existing dirty files. Sandbox Mode may have no meaningful git baseline. File-copy snapshot is the correct approach.

3. **1C granularity: file-level is right.** Both agents agree. Line ranges drift after edits; if ever refined, go to symbol-level, not line-range. Codex flagged that `CoderWorkingMemory` is a flat struct today — `dependsOn` per entry requires adding an `observations[]` array rather than retrofitting the existing fields.

4. **Tier reshuffle: promote 2A, demote 1B.** Both agents say `find_references` saves more rounds than guarded rollback and is cheaper to ship. `1B` requires a new backend transactional endpoint; defer to sprint 2.

5. **Remove 3E (command lifecycle).** Web app doesn't expose `exec_start`/`exec_poll`; this is CLI-only scope.

6. **Implementation location for 1A:** Diagnostics belong in the tool layer (`sandbox-tools.ts`), not raw `sandbox/app.py` write handlers. Low-level write endpoints also fire on file-browser uploads.

7. **Ledger gaps for 2C:** `recordCreation()` is used for both new files and ordinary edits (`sandbox-tools.ts:1682`, `sandbox-tools.ts:3200`). File-browser writes bypass the ledger entirely (`useFileBrowser.ts:72`). Provenance must be added as separate metadata, not piggybacked on `recordCreation`.

### Post-implementation review (2026-03-11)

Council reviewed the Sprint 1 implementation. Codex read the code and ran `tsc -b`; Gemini reviewed at a higher level. 14 findings total, 12 fixed:

| # | Severity | Finding | Resolution |
|---|----------|---------|------------|
| 1 | High | Shell interpolation in `node -e "..."` diagnostics | Fixed: single-quoted shell + env var |
| 2 | High | Stale expiry used `addedAtRound` instead of `staleAtRound` | Fixed: added `staleAtRound` field |
| 3 | Low | Naive import/call heuristic in find_references | Accepted for v1 |
| 4 | Medium | Magic TS enum numbers (99, 4) | Fixed: `ts.ScriptTarget.ESNext` etc. |
| 5 | High | `diagnostics: false` opt-out not wired through validation | Fixed: carried through `validateSandboxToolCall` |
| 6 | High | Path mismatch: agent `src/foo.ts` vs harness `/workspace/src/foo.ts` | Fixed: `normalizeObservationPath()` |
| 7 | Medium | Patchset `edits[].path` not extracted for invalidation | Fixed: `extractMutatedPaths()` at both sites |
| 8 | Medium | Provenance grew monotonically (never scoped to dirty files) | Fixed: cross-ref with ledger entries |
| 9 | Medium | TypeScript errors (null guards, intersection type) | Fixed: `Omit<>`, null guards, casts |
| 10 | Medium | Missing `recordMutation` at 3 user-facing sites | Fixed: FileBrowser, useChat, useProjectInstructions |
| 11 | Low | Ripgrep not killed after 30-result cap | Fixed: `proc.kill()` + `proc.wait(timeout=2)` |
| 12 | Low | `require('typescript')` crash if not installed | Fixed: try/catch exit 0 |
| 13 | Low | Brittle tsc path filtering (startsWith) | Accepted for v1 |
| 14 | Low | User edits get agent round number in provenance | Cosmetic, deferred |

### Sprint scoping

Full plan is too large for one sprint. Council-recommended sprint 1:
- **1A** Ambient diagnostics v1 (two-tier revised design)
- **1B** `find_references` v1 (rg-backed, lexical)
- **1C** Invalidation-aware memory v1 (new `observations[]` array)
- **1D** Dirty state provenance v1

Sprint 2 (deferred):
- **2A** Guarded apply-check-rollback (needs backend endpoint)
- **2B** Session capability block (extend existing `[SANDBOX_ENVIRONMENT]`)

---

## Tier 1 — Sprint 1

### 1A. Ambient post-mutation diagnostics (two-tier)

**Source:** Gemini #2, Claude #1, Codex #5
**Problem:** After a successful edit, the agent doesn't know if it introduced type errors or lint violations until it explicitly runs a check. This discourages continuous validation and lets errors compound.

**Design:** Two-tier diagnostic model. Fast syntax check on every edit; full typecheck only on patchsets or when conditions allow.

**Implementation sketch:**

*Tier 1 — per-edit syntax check (fast, always-on):*
- `lib/sandbox-tools.ts`: After `sandbox_edit_file` success, run a cheap file-local check in the sandbox.
- TypeScript: `esbuild --bundle=false --log-level=warning <file>` or `node -e "require('typescript').transpileModule(...)"` — catches syntax errors and obvious import failures without full project resolution. Target: <100ms.
- Python: `python -m py_compile <file>`. Target: <50ms.
- Fallback: skip for unknown languages.
- Return in a `[DIAGNOSTICS]` block appended to the edit result. Advisory only — if check times out or fails, omit silently.

*Tier 2 — patchset-level project check (slower, guarded):*
- On `sandbox_apply_patchset` success, run full `npx tsc --noEmit --pretty false` with a **2s timeout**.
- Filter output to only report diagnostics touching files in the patchset.
- If the project check is known to be fast (previous run completed in <1s), also run on single-file edits.
- Config: opt-out via `diagnostics: false` arg.

**Acceptance criteria:**
- [x] `sandbox_edit_file` on a `.ts` file with a syntax error returns `[DIAGNOSTICS]` with the error.
- [x] Per-edit syntax check completes in <200ms (no project-wide `tsc` on this path).
- [x] `sandbox_apply_patchset` runs full project check once after all edits with 2s timeout.
- [x] Diagnostics are filtered to changed files only (no token spam from pre-existing errors).
- [x] Timeout produces no error — diagnostics block is simply omitted.

**Implementation notes (Sprint 1):**
- Tier 1: `ts.transpileModule()` with single-quoted shell command + env var for path (shell-safe). Graceful fallback if typescript is not installed.
- Tier 2: `tsc --noEmit --pretty false` with 2s timeout, filtered to patchset files. Opt-out via `diagnostics: false`.
- Council fix: replaced magic TS enum numbers with `ts.ScriptTarget.ESNext` etc. Added MODULE_NOT_FOUND filtering.

**Risk:** `transpileModule` won't catch type errors (only syntax/import). That's acceptable — syntax errors are the most disruptive failures, and the patchset-level check catches type errors.

**Council note (Gemini):** Consider also running `prettier`/`eslint --fix` if available, so the agent doesn't waste a turn fixing formatting.

---

### 1B. `find_references` / `find_implementations`

**Source:** All three agents (promoted from Tier 2 by council — saves more rounds than guarded rollback, cheaper to ship)
**Problem:** `sandbox_read_symbols` returns declarations but not usage. The agent can see what exists but not what depends on it, causing multi-turn grep hunts for call sites and importers.

**Design:** Add `sandbox_find_references` tool. Lexical/regex-based v1 (rg-backed), not AST-aware.

**Implementation sketch:**
- `sandbox/app.py`: Run `rg -rnw --json '<symbol>' <scope>` with word boundaries. Parse JSON output for file, line, and context.
- `lib/sandbox-tools.ts`: New tool definition, detection, execution.
- Args: `{ "symbol": "getActiveProvider", "scope": "src/" }`.
- Return: `{ "references": [{ "file": "src/lib/auditor-agent.ts", "line": 14, "context": "import { getActiveProvider } from './orchestrator'" }] }`.
- Cap results at 30 references. Include `truncated: true` if more exist.
- Classify results: `import` (line contains `import`/`require`), `call` (default). Lightweight heuristic, not AST.

**Acceptance criteria:**
- [x] Finds import sites and call sites for a given symbol name.
- [x] Respects scope restriction (default: `/workspace/`).
- [x] Results include one line of surrounding context.
- [x] Cap at 30 results with `truncated` flag.
- [x] Registered in `SANDBOX_TOOL_PROTOCOL` prompt and `tool-dispatch.ts`.

**Implementation notes (Sprint 1):**
- Python endpoint in `sandbox/app.py` runs `rg -rnw --json` with word boundaries, parses JSON output.
- Client function `findReferencesInSandbox()` in `sandbox-client.ts`. Lightweight classification: `import` (line contains import/require), `call` (default).
- Council fix: `proc.kill()` + `proc.wait(timeout=2)` after 30-result cap to avoid draining rg output.
- Registered as read-only in `tool-dispatch.ts`.

**Risk:** Word-boundary grep produces false positives (e.g., `Provider` matches `getActiveProvider`). Mitigation: exact word match via `\b` boundaries; agent can refine with scope. v2 can add AST-awareness.

---

### 1C. Invalidation-aware working memory

**Source:** Codex #10, Gemini #3, Claude #5
**Problem:** `CoderWorkingMemory` survives context trimming via re-injection — but entries can go stale when files they reference are mutated. Blind re-injection of stale conclusions causes the agent to act on outdated information.

**Design:** Add an `observations[]` array to `CoderWorkingMemory` where each entry tracks file dependencies. Existing flat fields (`plan`, `openTasks`, `currentPhase`, etc.) stay unchanged — observations are the invalidation-aware layer.

**Implementation sketch:**
- `types/index.ts`: Add to `CoderWorkingMemory`:
  ```typescript
  observations?: Array<{
    id: string;           // agent-assigned, e.g. "adapter-pattern"
    text: string;         // the conclusion
    dependsOn?: string[]; // file paths (file-level granularity)
    stale?: boolean;      // set by harness, not agent
    staleReason?: string; // e.g. "src/foo.ts was modified"
  }>;
  ```
- `coder_update_state` tool accepts `observations` field. Agent can add, update (by id), or remove entries.
- `lib/coder-agent.ts`: After any mutation tool result, check `workingMemory.observations` against the mutated file path. Mark matching entries `stale: true` with reason.
- `formatCoderState()`: Stale observations render as `[STALE — src/foo.ts modified] adapter-pattern: ...`. Non-stale render normally.
- Auto-expire: stale entries older than 5 rounds are dropped from re-injection.
- Agent can clear stale flag by re-emitting the observation with the same id.

**Acceptance criteria:**
- [x] Observation referencing `src/foo.ts` is marked stale after `sandbox_edit_file` on that path.
- [x] Stale observations appear with `[STALE]` prefix in re-injected `[CODER_STATE]`.
- [x] Non-stale observations and flat fields (`plan`, `openTasks`) are unaffected.
- [x] Stale observations auto-expire after 5 rounds.
- [x] Agent can update/remove observations by id.

**Implementation notes (Sprint 1):**
- `CoderObservation` type with `dependsOn`, `stale`, `staleReason`, `staleAtRound`, `addedAtRound`.
- `applyObservationUpdates()` merges by id, clears stale flags on re-emit, removes on `remove: true`.
- `invalidateObservationDependencies()` cross-references mutated paths with `dependsOn`.
- Council fixes: path normalization (strips `/workspace/` prefix on both sides), `staleAtRound` for expiry (not `addedAtRound`), patchset path extraction via `extractMutatedPaths()`, `Omit<>` on intersection type to fix TS error.
- `SANDBOX_TOOL_PROTOCOL` updated with `observations` field documentation on `coder_update_state`.

**Risk:** Agent may not use `dependsOn` — the feature is opt-in. Mitigation: the system prompt can encourage it, and `filesTouched` already tracks which files were modified so the harness can cross-reference even without explicit `dependsOn`.

**Council note (Codex):** If the agent never sets `dependsOn`, consider auto-inferring it from `filesTouched` — any observation added in the same round as a file read could auto-bind to that file.

---

### 1D. Dirty state provenance

**Source:** Codex #4
**Problem:** A dirty file could have been modified by the agent, the user, codegen, or formatting. Without provenance, the agent can't decide whether to re-read or trust its memory.

**Design:** Extend the file-awareness ledger with `lastModifiedBy` metadata, separate from the existing `recordCreation()` semantics.

**Implementation sketch:**
- `lib/file-awareness-ledger.ts`: Add new metadata field to file state entries:
  ```typescript
  lastModifiedBy?: 'agent' | 'user' | 'unknown';
  lastModifiedAtRound?: number;
  ```
- Do NOT piggyback on `recordCreation()` — that method is called for both new files and ordinary edits (`sandbox-tools.ts:1682`, `sandbox-tools.ts:3200`). Add a separate `recordMutation(path, by)` method, or extend `markStale()` to accept a source.
- After `sandbox_edit_file` / `sandbox_apply_patchset`: mark affected files `by: 'agent'`.
- `hooks/useFileBrowser.ts`: After file-browser writes/uploads (currently at line 72, which bypasses the ledger entirely), call `fileLedger.recordMutation(path, 'user')`.
- Sandbox status diffs with no known source → `'unknown'`.
- Expose in `[meta]` dirty file list: `modifiedFiles: [{ path: "src/foo.ts", by: "agent" }]`.

**Acceptance criteria:**
- [x] Agent edits via sandbox tools are attributed to `'agent'`.
- [x] User file-browser edits/uploads are attributed to `'user'`.
- [x] `[meta]` includes `by` field for dirty files.
- [x] File-browser writes now go through the ledger (fixes existing gap).

**Implementation notes (Sprint 1):**
- `MutationProvenance` type + `recordMutation(path, by)` on the file-awareness ledger.
- `getDirtyFilesWithProvenance()` cross-references provenance map with ledger entries (only reports actually-dirty files).
- `buildMetaLine()` in `useChat.ts` includes provenance counts: `by:[agent=N,user=M,unknown=K]`.
- Council fixes: provenance at all 5 `recordCreation()` sites in sandbox-tools, 3 user-facing sites (FileBrowser save, useChat editor save, useProjectInstructions AGENTS.md create), scoped to entries that are still `model_authored` or `stale`.

**Risk:** Low. Mostly plumbing work to wire up existing call sites.

---

## Tier 2 — Sprint 2

### 2A. Guarded apply-check-rollback

**Source:** Codex #6 (demoted from Tier 1 by council — requires backend endpoint work)
**Problem:** `sandbox_apply_patchset` and `acceptanceCriteria[]` are separate primitives. The agent can't say "apply these edits, run these checks, and rollback if they fail" in one atomic operation.

**Design:** Extend `sandbox_apply_patchset` with optional `checks[]` and `rollbackOnFailure: true`.

**Implementation sketch:**
- `sandbox_apply_patchset` args gain:
  ```json
  {
    "edits": [...],
    "checks": [
      { "command": "npx tsc --noEmit", "exitCode": 0, "timeoutMs": 10000 }
    ],
    "rollbackOnFailure": true
  }
  ```
- `sandbox/app.py`: Before applying edits, snapshot affected files to `/tmp/patchset_backup_<id>/` (including "file did not exist" state for new files). Apply edits. Run checks sequentially with per-check timeout (default 10s, max 30s). If any check fails and `rollbackOnFailure` is true, restore snapshots and return failure with check output.
- Return shape includes `checksResults[]` with pass/fail + output per check.
- Rollback uses `/tmp` file snapshots, NOT git. Rationale (council): `git checkout` reverts to HEAD not pre-patchset dirty state; `git stash` bundles pre-existing dirty files; Sandbox Mode may have no git baseline.

**Acceptance criteria:**
- [ ] Patchset with passing checks applies normally.
- [ ] Patchset with failing check rolls back all edits and returns check output.
- [ ] Rollback restores exact file contents (verified by hash comparison).
- [ ] New files created by the patchset are deleted on rollback.
- [ ] Per-check timeout enforced (hard cap 30s).

**Risk:** Snapshot storage for large files. Mitigation: `/tmp` is ephemeral per sandbox session; cap total snapshot size at 5MB.

---

### 2B. Session capability block

**Source:** Codex #1
**Problem:** The agent infers what it can and can't do from prose instructions. Wasted turns on impossible actions.

**Design:** Extend the existing `[SANDBOX_ENVIRONMENT]` block (`sandbox-tools.ts:3401`) rather than inventing a second mechanism.

**Implementation sketch:**
- Extend the existing environment probe to include: available tools, writable roots, network policy, git availability, timeout ceiling, container lifetime, and detected test command.
- Include detected test command (council suggestion from Gemini): scan `package.json` scripts for `test`/`lint`/`typecheck` entries.
- Inject into the Coder's first tool result via existing `[SANDBOX_ENVIRONMENT]` path.

**Acceptance criteria:**
- [ ] Extended capability block is present in the Coder's first tool result.
- [ ] Block includes detected test/lint commands.
- [ ] Block reflects actual sandbox configuration.

---

## Tier 3 — Novel but longer horizon

### 3A. Interactive trap detection

**Source:** Gemini #4
**Design:** PTY heuristic in `sandbox/app.py` — if process is waiting on stdin for >3s without output, return `INTERACTIVE_PROMPT_DETECTED` error with the last line of output as the prompt text. Alternative (Gemini): run all `exec` commands with `DEBIAN_FRONTEND=noninteractive` and `< /dev/null` by default.

### 3B. Artifact handles on tool results

**Source:** Codex #2
**Design:** Assign stable IDs to tool results so later tool calls can reference prior outputs by ID instead of re-executing. Requires protocol-level change to how results are stored and referenced.

### 3C. AST-aware rename

**Source:** Gemini #5
**Design:** `sandbox_rename_symbol(old_name, new_name, scope)` backed by language-specific refactoring (TypeScript: `ts-morph` or `tsc` language service; Python: `rope`). Eliminates regex false positives on mass renames.

### 3D. Structured repo index

**Source:** Codex #3
**Design:** Auto-generate a machine-readable project map on sandbox start: manifests, scripts, test topology, package boundaries, entrypoints. Extends the workspace snapshot concept into a structured object.

---

## Relationship to prior plans

| Plan | Scope | This plan extends |
|---|---|---|
| Harness Reliability | Tool calls work correctly | Tool calls *inform* correctly |
| Agent Context Sprint | Roles start with right context | Roles *maintain* context across rounds |
| Agent Experience Wishlist | Shipped 9 harness features | Builds on those features (patchset, meta, memory) |
| Truncation-Aware Edit Safety | Edits don't corrupt unseen code | Edits report their own impact |

## Priority summary

### Sprint 1

| Item | Effort | Source | Builds on |
|---|---|---|---|
| 1A Ambient diagnostics (two-tier) | Medium | Gemini, Claude, Codex | `sandbox_edit_file` result path in `sandbox-tools.ts` |
| 1B Find references (rg-backed) | Medium | All three (promoted by council) | `sandbox_read_symbols` |
| 1C Invalidation-aware memory | Low-Medium | Codex, Gemini, Claude | `CoderWorkingMemory` + `coder_update_state` |
| 1D Dirty state provenance | Low | Codex | File-awareness ledger |

### Sprint 2

| Item | Effort | Source | Builds on |
|---|---|---|---|
| 2A Guarded apply-check-rollback | Medium-High | Codex | `sandbox_apply_patchset` + backend endpoint |
| 2B Session capability block | Low | Codex | Existing `[SANDBOX_ENVIRONMENT]` |

### Deferred

| Item | Effort | Source | Builds on |
|---|---|---|---|
| 3A Interactive trap detection | Medium | Gemini | `sandbox_exec` |
| 3B Artifact handles | High | Codex | Protocol-level change |
| 3C AST-aware rename | High | Gemini | Language-specific tooling |
| 3D Structured repo index | Medium | Codex | Workspace snapshot |
