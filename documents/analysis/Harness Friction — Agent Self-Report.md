# Harness Friction — Agent Self-Report

Cross-agent analysis of harness pain points observed during real coding sessions. Each gripe is written from the agent's perspective and mapped to Push's architecture where relevant.

Reviewed against current code: 2026-03-30
Note: several recommendations below were updated to reflect work that shipped after the original 2026-03-11 session.

---

## Source: Claude Code (Opus 4.6)

Observed during multi-file edits, test runs, and review workflows in the Push codebase. Session date: 2026-03-11.

### 1. Edit-then-verify costs a full round trip

**Problem:** After a mutating edit, the agent gets success/failure — but not enough surrounding context to decide the next move. Confirming the edit landed correctly requires a follow-up read.

**Push status:** `sandbox_edit_file` returns a diff in the result, which is ahead. The `[meta]` envelope adds round number, context size, and dirty state.

**Recommendation:** After any write/edit, return ~5 lines above and below the edit site in the tool result. Let the agent visually confirm without burning a read call. Generalize the principle: every mutating tool should return enough state for the agent to decide its next action without a follow-up.

---

### 2. Staleness is indistinguishable from a bad match

**Problem:** If a file changes between read and edit (user action, hook, background process), the error is identical to "your match string was wrong." The agent can't distinguish drift from a typo in the match.

**Push status:** Hashline edits (`lib/hashline.ts`) solve this — content hashes per line give implicit staleness detection as a distinct failure mode. This is one of Push's strongest harness advantages.

**Recommendation:** Already shipped in Push. Other agents (CLI, future delegation targets) should inherit the same pattern. Consider surfacing staleness as a first-class `ToolErrorType` (e.g., `stale_content`) distinct from `invalid_argument`.

---

### 3. No cheap "workspace pulse" — global state requires explicit tool calls

**Problem:** After the initial system prompt, the agent has no ambient awareness of workspace state. Checking dirty files, HEAD position, or diff size costs 1-2 tool calls just to orient.

**Push status:** Largely addressed on the main web path. The orchestrator now gets a machine-readable session capability block at startup, and tool results can carry an automatic `[pulse]` line after mutations and on a periodic cadence with branch/HEAD/dirty-file context.

**Recommendation:** Shipped in spirit. The remaining follow-up is parity and tuning: extend the same ambient pulse behavior to other agent surfaces where useful, and decide whether the pulse should include diff-size or budget-remaining hints in addition to branch/dirty state.
```
[workspace] main@a700e77 | 3 dirty | +47/-12 | 2.1k ctx remaining
```
Zero tool calls. Ambient awareness. The Orchestrator should get an equivalent signal, not just the Coder.

---

### 4. No transactional multi-file edits

**Problem:** Coordinated changes across multiple files are not atomic. If the 3rd edit in a 4-file rename fails, files 1-2 are already modified. Rollback is manual and error-prone.

**Push status:** `sandbox_apply_patchset` provides multi-file transactional edits. Shipped.

**Recommendation:** Already shipped in Push. Ensure the CLI agent (`cli/tools.ts`) also has a patchset path, not just single-file edits. Consider a lightweight transaction wrapper that snapshots affected files before a multi-edit sequence and rolls back on any failure.

---

### 5. Context pressure is invisible until compression fires

**Problem:** The agent has no token counter or budget indicator. Context limits are hit silently — the system compresses prior messages without warning. The agent can't proactively decide "I should summarize now before I lose my findings."

**Push status:** Mostly addressed on the main web path. Tool results now expose context pressure as a percentage and severity inside the `[meta]` envelope, alongside the existing working-memory reinjection pattern.

**Recommendation:** Keep the remaining work focused on actionability rather than visibility: decide whether pressure should trigger explicit compaction hints or working-memory summarization prompts once thresholds are crossed.

---

### 6. Acceptance criteria are manual, not structural

**Problem:** "Make sure tests pass" is a hope, not a gate. The agent has to remember to run verification. There's no structural guarantee that verification happens.

**Push status:** `acceptanceCriteria[]` on `delegate_coder` — shell commands that run automatically after the Coder finishes. Pass/fail + output. Shipped.

**Recommendation:** Already shipped for Coder delegation. Consider extending to the Orchestrator's own tool loop: allow the user to attach persistent acceptance criteria to a chat session (e.g., "always run `npm test` before reporting done"). This turns verification from per-delegation to per-session.

---

## Where Push is already ahead

| Capability | Push | Claude Code |
|---|---|---|
| Staleness detection | Hashline content hashes | String match (no distinction) |
| Multi-tool dispatch | Read/mutate split with semantic awareness | Parallel calls, no semantic split |
| Error taxonomy | `classifyError()` with `error_type` + `retryable` | Unstructured error strings |
| Session recovery | Checkpoint + reconciliation message | Conversation compression (lossy) |
| Working memory | `CoderWorkingMemory` survives trimming | Memory files (cross-session only) |
| Acceptance criteria | Structural post-task gates | Manual verification |

## Where Claude Code is ahead

| Capability | Claude Code | Push |
|---|---|---|
| Parallel sub-agents | Fan-out research to isolated subagents | Single Coder sub-agent |
| File search | First-class `Glob` + `Grep` tools | `sandbox_exec` grep/find |
| Cross-session memory | Persistent file-based memory system | None (localStorage per device) |

---

## Source: Gemini (via /council)

Consulted 2026-03-11. Gemini's gripes lean toward AST-aware tooling and ambient validation — closing the gap between "tool succeeded" and "code is semantically correct."

### 1. The "Guess the Line Number" Paging Game

**Problem:** Understanding a specific function in a large file requires a multi-turn guessing game: grep for the signature line, read with a guessed end line, discover the function was truncated, page down. Context bloat if the guess is too large, wasted turns if too short.

**Push status:** `sandbox_read_symbols` returns declarations/signatures. `read_file` supports line anchors. But neither returns the full body of a specific symbol.

**Recommendation:** Implement an AST-aware `read_symbol_body` tool. Ask for `read_symbol_body("AuthService.login")` and receive exactly the scope of that AST node — no more, no less. Eliminates paging guesswork entirely.

---

### 2. Lack of Ambient Validation on Mutations (Silent Breakage)

**Problem:** After an edit, the tool result says "Edit applied successfully" — but doesn't report if the edit introduced a syntax error, broke a type contract, or violated a linter rule. Verifying requires a separate explicit turn running `tsc` or `lint`. This turn-cost discourages continuous validation, and errors compound silently until a major test run fails.

**Push status:** Partially addressed. `sandbox_edit_file` now runs a fast per-edit syntax check, and `sandbox_apply_patchset` can append project typecheck diagnostics for changed files. The remaining gap is consistency and structure: diagnostics are still text-first, not universal across every mutating tool, and not exposed as a normalized postcondition object.

**Recommendation:** Standardize and deepen ambient diagnostics on mutation responses. Keep the existing zero-turn checks, but make them consistent across mutation tools and expose them in a structured shape alongside human-readable text.

---

### 3. Investigation "Rabbit Hole" and Context Eviction

**Problem:** Fixing a complex bug requires traversing a chain of files (UI → hook → service → API). By the time the root cause is located deep in the stack, the context window is filled with file reads, and the original mental model of the user's request may have been evicted or heavily summarized.

**Push status:** `CoderWorkingMemory` survives context trimming via structural re-injection — a strong start.

**Recommendation:** Evolve `CoderWorkingMemory` to support an explicit "investigation stack" or task tree. Allow push/pop of hypotheses. When a deep dive hits a dead end, "pop" the stack to drop irrelevant file context and cleanly revert mental state to the last good branch of investigation.

---

### 4. Interactive Traps in Shell Execution

**Problem:** Shell commands that unexpectedly prompt for input (e.g., "Update snapshot tests? [y/N]") or enter watch mode cause the execution tool to hang until a hard timeout, returning a truncated, useless buffer. The agent then wastes a turn retrying with `--no-interactive` flags.

**Push status:** Execution is split into `exec`, `exec_start`, `exec_poll`, `exec_write`, which provides control but doesn't detect the hang.

**Recommendation:** Add heuristic "interactive trap" detection. If the PTY detects the process is waiting on stdin for >N seconds without output, immediately abort or pause and return `INTERACTIVE_PROMPT_DETECTED` with the prompt text, allowing the agent to react via `exec_write` or restart with correct flags.

---

### 5. Regex-Based Mass Refactoring is Dangerous

**Problem:** Renaming a core interface across 15 files via sequential `edit_file` calls eats context. Search-and-replace catches false positives in comments, strings, and unrelated scopes, causing collateral damage that burns more turns to fix.

**Push status:** `sandbox_search_replace` and `sandbox_apply_patchset` exist but are text-based, not scope-aware.

**Recommendation:** Expose an AST-aware refactoring tool backed by an LSP: `sandbox_rename_symbol(old_name, new_name, file_scope)`. Safe, project-wide, single-turn structural refactoring without textual false positives.

---

## Source: Codex / GPT-5.4 (via /council)

Consulted 2026-03-11. Codex's gripes lean toward contracts, provenance, and queryable system state — treating the harness as a typed API rather than a text stream.

### 1. Capability Discovery Is Prompt-Only

**Problem:** Writable roots, network access, approval policy, timeout ceilings, and available tools are inferred from prose instructions instead of a queryable capability object. Planning is brittle; turns are wasted on actions that were never possible.

**Push status:** Largely addressed on the main web path. The orchestrator prompt now includes a machine-readable session capability block with workspace mode, GitHub/sandbox availability, writable root, git availability, container TTL, warnings, and the mutation contract.

**Recommendation:** Shipped for startup/session context. The remaining gap is broader contract coverage: approval/network/timeout details and non-web-surface parity.

---

### 2. Tool Results Aren't Reusable Objects

**Problem:** Search hits, diffs, diagnostics, and command output are plain text in conversation. They can be read once but can't be referenced later ("use the files from that grep result") without re-running the tool or re-tokenizing the output.

**Push status:** Not addressed. Results are UI-structured but have no stable agent-facing handles.

**Recommendation:** Give every tool result an artifact ID with typed payloads and selectors: `artifact://grep/17`, `artifact://diff/9:file.ts`. Allow later tool calls to reference prior results by ID instead of re-executing.

---

### 3. Repo Affordances Must Be Reconstructed Every Session

**Problem:** Multiple reads are spent rediscovering the repo's operating manual: package manager, test entrypoints, lint/typecheck scripts, build system, app entrypoints, conventions. Raw file access is not a synthesized project map.

**Push status:** Partially addressed. The CLI workspace snapshot and project instructions (AGENTS.md) help, but the Coder doesn't get a structured machine-readable repo index.

**Recommendation:** Maintain a structured repo index: manifests, scripts, test topology, package boundaries, likely entrypoints, and known-good validation commands. Auto-generate on sandbox start, update on file mutations.

---

### 4. Dirty State Lacks Provenance

**Problem:** A file can be detected as dirty, but not whether it changed from the agent's last edit, a user edit, codegen, formatting, or another process. Cautious editing in a non-clean tree requires provenance the harness doesn't provide.

**Push status:** Partially addressed. Hashlines and the file-awareness ledger track staleness/read coverage, but not last-writer provenance.

**Recommendation:** Track per-file revision IDs plus `modified_by` (agent/user/tool), `last_tool`, and `seen_at_revision` metadata in status and edit results.

---

### 5. Successful Mutations Don't Return Strong Postconditions

**Problem:** After an edit, "success" is too weak. The agent wants exact changed spans, updated hashes, invalidated read handles, and obvious follow-up risks. Without these, the next turn starts with another read or diff.

**Push status:** Now largely addressed on the main web path. `sandbox_edit_file`, `sandbox_write_file`, and `sandbox_apply_patchset` return structured mutation postconditions with touched files, versions, changed spans/full-write markers, diagnostics, and rollback/check metadata where available.

**Recommendation:** The remaining work is breadth and reuse: extend the same contract to any remaining mutating tools and make more of the structured payload referenceable by later turns.

---

### 6. No Guarded Apply-Check-Rollback Primitive

**Problem:** The desired pattern is: apply edits only if read handles are still valid, run checks, rollback if checks fail. Currently this requires several fragile steps with manual recovery.

**Push status:** Mostly addressed for patchsets. `sandbox_apply_patchset` validates edits up front, supports post-write checks, and can roll back on failure. The remaining gap is making that verified-change contract the default path across more mutation workflows instead of concentrating it in one advanced tool.

**Recommendation:** Push the patchset contract outward: either make `sandbox_apply_patchset` the standard verified-change primitive for multi-file work or expose the same preconditions/checks/rollback guarantees through simpler edit flows.

---

### 7. Symbols Without References Leave the Agent Blind

**Problem:** A symbol list shows what exists but not what is coupled. Hunting call sites, importers, implementers, and transitive edges across files costs many turns.

**Push status:** Partially addressed. `sandbox_read_symbols` now has a companion `sandbox_find_references`, which closes the basic declaration-to-reference gap. What is still missing is deeper coupling data: implementations, call-graph edges, and more structural queries than simple name-based references.

**Recommendation:** Add `find_implementations` and lightweight import/call-graph queries with file+span anchors. The remaining gap is no longer "references at all," but "richer structural navigation than declarations plus basic references."

---

### 8. Exit Codes Are Not Enough for Exec Failures

**Problem:** Raw exit code + stderr doesn't distinguish missing binary, permission error, wrong cwd, timeout, compile error, failing assertion, or OOM. Each needs a different recovery strategy.

**Push status:** Partially addressed. `classifyError()` covers tool-layer failures, but command/test output failures don't get the same treatment.

**Recommendation:** Extend the error taxonomy into exec results. Normalize command failures into classes with retryability, likely cause, and suggested next action.

---

### 9. Long-Running Sessions Need Lifecycle State

**Problem:** For builds, dev servers, or slow tests, plain streaming text isn't enough. The agent wants heartbeat, truncation markers, waiting-for-input detection, exit reason, and artifact capture.

**Push status:** Unclear. Push CLI has session tools, but the Coder feature list doesn't mention structured lifecycle metadata for long-running commands.

**Recommendation:** Model long-running commands as first-class sessions with states: `starting`, `running`, `waiting_input`, `hung`, `completed`, `failed`. Emit state transitions as structured events, not just text output.

---

### 10. Derived Working Memory Should Be Invalidation-Aware

**Problem:** Important conclusions ("file A is the adapter," "tests X and Y passed," "approach B failed due to import cycle C") are expensive to rediscover after context trimming. Blindly reinjecting them risks acting on stale conclusions.

**Push status:** Addressed better than Codex's own harness. `CoderWorkingMemory` provides structural re-injection.

**Recommendation:** Make working memory file-scoped and invalidation-aware. When a file referenced by a memory entry is mutated, mark the entry stale and flag it for re-verification rather than reinjecting it as current truth.

---

## Synthesis

### Strong convergence (all three agents flagged)

| Theme | Claude | Gemini | Codex |
|---|---|---|---|
| **Mutation results are too thin** | Edit-then-verify round trip (#1) | Diagnostics now exist, but are not yet universal/structured (#2) | Weak postconditions — no spans/hashes (#5) |
| **Symbol navigation still wants richer structure** | (noted as Claude Code advantage) | Paging game — need AST body reads (#1) | Implementations/call graph still missing (#7) |
| **Working memory needs structure** | Context pressure invisible (#5) | Investigation rabbit hole (#3) | Invalidation-aware memory (#10) |
| **Exec error signals are too coarse** | (implicit in staleness gripe) | Interactive traps (#4) | Exit codes aren't enough (#8) |

### Novel ideas (surfaced by one agent)

| Idea | Source | Push status | Impact estimate |
|---|---|---|---|
| **Ambient post-mutation diagnostics** (LSP/compiler check on edit) | Gemini #2 | Partially shipped | Medium-High — move from text-only checks to universal structured diagnostics |
| **Artifact handles** on tool results (referenceable IDs) | Codex #2 | Not shipped | High — eliminates re-tokenization |
| **Session capability block** (machine-readable environment contract) | Codex #1 | Shipped on main web path | Medium — eliminates impossible-action turns |
| **Guarded apply-check-rollback** (single atomic verified-change primitive) | Codex #6 | Mostly shipped for patchsets | Medium — extend the verified-change contract across more flows |
| **Interactive trap detection** (PTY stdin-wait heuristic) | Gemini #4 | Not shipped | Medium — prevents timeout waste |
| **Dirty state provenance** (`modified_by` / `last_tool` per file) | Codex #4 | Not shipped | Medium — enables cautious editing in dirty trees |
| **Structured repo index** (auto-generated project map) | Codex #3 | Partially shipped (AGENTS.md + workspace snapshot) | Medium — cuts orientation phase |
| **Long-running command lifecycle** (state machine for builds/tests) | Codex #9 | Not shipped | Medium — prevents streaming blindness |
| **AST-aware rename** (`sandbox_rename_symbol`) | Gemini #5 | Not shipped | Medium — safe mass refactoring |

### Prioritized recommendations for Push

**Tier 1 — Highest leverage, builds on shipped infrastructure:**
1. **Invalidation-aware working memory** — Extend `CoderWorkingMemory` to track which files each conclusion depends on and mark entries stale on mutation.
2. **Guarded apply-check-rollback** — Promote the verified-change contract beyond advanced patchset flows so it becomes the default safe path instead of a specialized one.
3. **Ambient diagnostics parity** — Extend the now-structured mutation diagnostics contract across the remaining edit/mutation surfaces.

**Tier 2 — High value, moderate implementation cost:**
4. **`find_implementations` / call-graph queries** — Extend the new declaration-plus-reference layer into richer structural navigation.
5. **Dirty state provenance** — Add `modified_by` to the file-awareness ledger.
6. **Non-web parity for runtime contract** — Decide how much of the new session-capability/workspace-pulse contract should carry into other agent surfaces.

**Tier 3 — Novel but longer horizon:**
7. **Artifact handles** on tool results (requires protocol-level change)
8. **Interactive trap detection** in PTY (heuristic complexity)
9. **AST-aware rename** (requires language-specific LSP integration)
10. **Long-running command lifecycle** (state machine for background processes)
