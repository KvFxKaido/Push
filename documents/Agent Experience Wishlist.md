# Agent Experience Wishlist

Date: 2026-02-19
Author: Claude (agent-in-residence) + Council (Gemini + Codex)
Status: **Open — prioritized, not scheduled**

---

## What this is

Improvements to the Push harness from the perspective of the AI agent running inside it. Original list authored by Claude; reviewed and extended by Gemini and Codex via `/council`. Items marked **[Council]** were surfaced or significantly upgraded by the review.

---

## P0 — Foundational (highest leverage)

### 1. Multi-Tool Per Turn (Parallel Dispatch)

**The problem:** `detectAnyToolCall()` extracts the first tool call per message. Every file read is a separate round with full streaming overhead. A typical orientation at task start — read `package.json`, the main entry, and two related modules — costs 4 rounds before touching anything.

**What I'd want:** True multi-call detection per message. Side-effect-free tools (`sandbox_read_file`, `sandbox_read_files`, `sandbox_status`, web search) execute in parallel; mutating tools (`sandbox_edit_file`, `sandbox_commit`, `sandbox_exec`) are serialized. Cap at N calls per round to prevent runaway.

**Implementation sketch:**
```json
[
  { "tool": "sandbox_read_file", "args": { "path": "src/lib/orchestrator.ts", "line_start": 1, "line_end": 80 } },
  { "tool": "sandbox_read_file", "args": { "path": "src/lib/providers.ts" } }
]
```
`detectAnyToolCall()` → `detectAllToolCalls()` returning an array. `executeAnyToolCall` dispatches in parallel for reads, sequential for writes. Results returned as an array in a single synthetic message.

**Impact:** Biggest efficiency gain available. Read-heavy orientation phases dominate Coder round budgets. Parallel reads could cut a 5-round orientation to 1-2.

---

### 2. Error Taxonomy + Retry Semantics **[Council — both flagged as missing P0]**

**The problem:** Tool results don't distinguish error types. When `sandbox_exec` fails, is it a timeout? An auth error? A non-zero exit? A sandbox connectivity loss? The agent can't make intelligent retry decisions — it either retries everything (wastes rounds) or gives up on things it could recover from.

**What I'd want:** A structured `error` field on every tool result:

```json
{
  "success": false,
  "error": {
    "type": "EXEC_NON_ZERO_EXIT",
    "retryable": false,
    "message": "Process exited with code 1",
    "detail": "ModuleNotFoundError: No module named 'requests'"
  }
}
```

Error types: `FILE_NOT_FOUND`, `EXEC_TIMEOUT`, `EXEC_NON_ZERO_EXIT`, `SANDBOX_UNREACHABLE`, `EDIT_HASH_MISMATCH`, `EDIT_CONTENT_NOT_FOUND`, `AUTH_FAILURE`, `RATE_LIMITED`.

**`retryable: true`** = transient (network blip, timeout) → retry with backoff.
**`retryable: false`** = permanent (wrong file path, bad hash) → fix the call, don't retry.

**Impact:** Removes a major class of wasted rounds. Currently, a hash mismatch on `sandbox_edit_file` and a sandbox timeout look the same to the agent. Getting this wrong means burning 3 rounds re-reading files when the real problem was a transient network error.

---

### 3. Machine-Checkable Acceptance Criteria on `delegate_coder`

**The problem:** When the Orchestrator delegates via `delegate_coder`, it passes a freeform task string. There's no structured "done when" condition. The Coder produces a summary and returns — but can't self-evaluate whether the task actually succeeded.

**What I'd want:** Optional `acceptanceCriteria[]` + `requiredEvidence[]` in the delegation payload, and the Coder returns `criteriaResults[]` with pass/fail + proof:

```json
{
  "tool": "delegate_coder",
  "args": {
    "task": "Add rate limiting to the /api/search endpoint",
    "acceptanceCriteria": [
      { "id": "types", "check": "npx tsc --noEmit", "exitCode": 0 },
      { "id": "impl", "check": "grep -r 'rateLimit' src/worker.ts", "exitCode": 0 }
    ]
  }
}
```

Coder return includes:
```json
{
  "criteriaResults": [
    { "id": "types", "passed": true, "output": "" },
    { "id": "impl",  "passed": true, "output": "src/worker.ts:47:  rateLimit(req)" }
  ]
}
```

**Implementation sketch:** `lib/coder-agent.ts` runs each criterion as a `sandbox_exec` call after its last work round, appends results to the summary card.

**Impact:** Closes the feedback loop on the most important question: *did the task actually work?* Moves the agent from "best effort + hope" to self-verifying.

---

## P1 — High Value, Lower Urgency

### 4. Universal `meta` Envelope on Every Tool Result **[Council — Codex]**

**The problem:** The UI has a ContextMeter. The agent doesn't. Items 3 (round counter) and 4 (sandbox status) from the original list were proposed as separate concerns — but Codex pointed out a cleaner design: fold both into a standard `meta` block on every tool response. The agent gets orientation data on every call without having to ask.

**What I'd want:**
```json
{
  "result": "...",
  "meta": {
    "round": 8,
    "contextKb": 43,
    "contextCapKb": 120,
    "gitDirty": true,
    "modifiedFiles": ["src/lib/orchestrator.ts"],
    "containerAgeMinutes": 14,
    "containerLifetimeMinutes": 30
  }
}
```

**Implementation sketch:** `useChat.ts` injects `round` and estimated `contextKb` client-side. `sandbox/app.py` returns `gitDirty`, `modifiedFiles`, and `containerAgeMinutes` from a lightweight status call cached per-round (not per-tool-call).

**Impact:** Replaces two separate feature requests with one architectural change. Agent can self-regulate wrap-up timing and prioritize committing before container expiry.

---

### 5. Agent-Internal Working Memory **[Council — both]**

**The problem:** The user-facing scratchpad is shared with the user and injected into the system prompt. It's not a good place for the agent's internal plan, open tasks, and assumptions — it's noisy, size-capped, and gets compacted away. After context compaction, the agent loses its own reasoning thread.

**What I'd want:** A separate, compaction-safe `coder_state` that persists:
- Current plan and open sub-tasks
- Files touched and what changed
- Assumptions made about the codebase
- Errors encountered and attempted fixes

This is kept outside the rolling context window and injected at the start of each round as a compact header (e.g., 2KB max).

**Implementation sketch:** Stored alongside the existing scratchpad in localStorage (or session state). A `coder_update_state` tool lets the agent write to it; the harness injects it as a prefixed system block at round start. Reset on task completion.

**Impact:** Makes the agent's behavior consistent across long tasks where context compaction currently causes it to "forget" what it was doing and restart orientation from scratch.

---

### 6. Edit Result Diff in Tool Response

**The problem:** After `sandbox_edit_file` succeeds, the response confirms success but shows nothing. I can't verify the edit matched intent without a full re-read round.

**What I'd want:** The tool result includes the applied diff — just the changed hunks, not the full file:

```
✓ sandbox_edit_file applied (2 hunks, +4 -2 lines)
beforeHash: a3f2c1b → afterHash: 9d4e2fa

@@ -47,6 +47,8 @@
-  const old = getSomething();
+  const updated = getSomethingNew();
+  const extra = alsoNew();
```

**[Council — Codex]:** Also include `beforeHash`, `afterHash`, `changedRanges`, and conflict details on hash mismatch. This feeds the file-awareness ledger with higher-fidelity post-edit state.

**Implementation sketch:** In `sandbox/app.py`, after applying the edit, run `git diff --unified=2 -- <file>` and include the output in the JSON response.

**Impact:** Eliminates the verify-round for the most common Coder operation.

---

### 7. Structured Malformed-Call Feedback to the Agent **[Council — Codex, re-read]**

**The problem:** Track C (tool-call diagnosis) added `getMalformedToolCallMetrics()` so *we* can observe malformed tool calls by provider/model/reason. But when the harness detects a failed or garbled tool call, the agent receives a prose correction message — not a machine-readable signal. The agent has no structured way to know that its previous output was identified as a failed tool-call attempt, what specifically was wrong, or whether it should retry differently.

This is the operator-side and agent-side of the same problem. Track C gave us the telemetry. This gives the agent the feedback loop.

**What I'd want:** When the harness injects a correction for a diagnosed failure, the injected message includes a structured header:

```
[TOOL_CALL_PARSE_ERROR]
reason: validation_failed
detected_tool: sandbox_edit_file
problem: args.ops was missing or not an array
telemetry_only: false

Your previous response contained a tool call that could not be executed.
Please re-emit it with the correct format...
```

The `reason` and `problem` fields give the agent actionable signal — it can distinguish "I used the wrong field name" from "my JSON was truncated" from "I described the tool in prose instead of emitting it."

**Relationship to Track C:** `diagnoseToolCallFailure()` already computes `reason` and `toolName`. The correction injection in `useChat.ts` already exists. This is mostly a formatting change to what gets injected — making the structured data from the diagnosis visible to the agent, not just logged to telemetry.

**Impact:** Closes the loop between our observability work and agent behavior. The agent stops guessing why its tool call failed and gets a direct signal it can act on. Especially valuable for providers that garble tool calls consistently — the agent can adapt mid-session rather than repeating the same malformed pattern.

---

## P2 — Novel Ideas, Longer Horizon

### 9. `sandbox_read_symbols` / `sandbox_find_references` (AST Tool) **[Council — Codex]**

**The problem:** Orienting on an unfamiliar codebase requires reading full files to understand structure. A 500-line file might only export 3 functions the agent cares about — but it has to read all 500 lines to find them.

**What I'd want:** A structural query tool that returns the symbol index without file content:

```json
{
  "tool": "sandbox_read_symbols",
  "args": { "path": "src/lib/orchestrator.ts" }
}
```

Returns:
```json
{
  "exports": [
    { "name": "getActiveProvider", "kind": "function", "line": 1441, "signature": "() => ActiveProvider" },
    { "name": "streamChat",        "kind": "function", "line": 1487, "signature": "(messages, ...) => Promise<void>" }
  ],
  "imports": ["providers", "orchestrator"]
}
```

**Implementation sketch:** In the Python sandbox, run `tsc --listFiles` or a lightweight AST walker (tree-sitter). For Python, use `ast` stdlib. Return the symbol table, not the source.

**Impact:** Could cut orientation from 5+ read rounds to 1 structural query on large files. Especially valuable on the first call to an unfamiliar codebase.

---

### 10. `sandbox_apply_patchset` — Transactional Multi-File Edits **[Council — Codex]**

**The problem:** Multi-file refactors require multiple sequential `sandbox_edit_file` calls. If the 4th edit conflicts with something the 1st edit changed, the agent discovers this only after partial application. Rolling back requires re-reading every touched file and re-editing.

**What I'd want:** A transactional patchset tool with dry-run:

```json
{
  "tool": "sandbox_apply_patchset",
  "args": {
    "dryRun": true,
    "edits": [
      { "path": "src/lib/providers.ts",    "ops": [...] },
      { "path": "src/lib/orchestrator.ts", "ops": [...] }
    ]
  }
}
```

Dry-run returns what would change and flags conflicts. On `dryRun: false`, applies atomically — all succeed or none are committed.

**Implementation sketch:** `sandbox/app.py` validates all hashline ops against current file state before writing any. On conflict, returns which ops failed and why.

**Impact:** Safer multi-file refactors. Currently, partial application leaves the codebase in an inconsistent state that the agent then has to debug.

---

## Priority Summary

| Rank | Item | Effort | Council signal |
|------|------|--------|----------------|
| P0 | Multi-tool per turn (parallel read-only / serial mutating) | Medium | Both agree |
| P0 | Error taxonomy + retry semantics | Low-Medium | Both flagged as missing |
| P0 | Machine-checkable acceptance criteria | Medium | Both agree |
| P1 | Universal `meta` envelope on every tool result | Low | Codex — strictly better than items 3+4 |
| P1 | Agent-internal working memory (compaction-safe) | Medium | Both agree |
| P1 | Edit result diff with hash/range info | Low | Both agree |
| P1 | Structured malformed-call feedback to agent | Low | Codex re-read — closes Track C loop |
| P2 | `sandbox_read_symbols` / find_references (AST tool) | Medium | Codex |
| P2 | `sandbox_apply_patchset` (transactional multi-file edits) | Medium | Codex |

**If only three things ship:** multi-tool per turn, error taxonomy, and machine-checkable acceptance criteria. These address the three failure modes that waste the most rounds: serial reads, bad retries, and silent task failure.

---

## What this is NOT

These aren't user-facing features. They're harness improvements that make the agent more reliable and self-aware — which translates directly to fewer wrong answers, fewer wasted rounds, and better task completion on the first try.
