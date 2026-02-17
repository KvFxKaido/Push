# Truncation-Aware Edit Safety

**Status:** Draft — ready for promotion review  
**Date:** 2026-02-17  
**Source:** Council session (GLM + Claude)  
**Roadmap parent:** Harness Reliability Program (Track B — Read Efficiency)

## Problem

When files exceed the read truncation limit (~15K tokens), the model receives partial content and a truncation notice. It then attempts edits against code it never saw. The model improvises the missing portions — confidently and often incorrectly. Hashline (Track A) solves edit *application* precision but not this: the model editing blind is a **read problem**, not an edit problem.

## Design: File Awareness Ledger + Edit Guard

### Core Concept

A per-session ledger tracks what the model has actually seen of each file. An edit guard checks the ledger before allowing writes. Together they form a **situation awareness layer** — the harness tells the model what it knows instead of the model reconstructing that from conversation history.

### Ledger States

Each file in the session carries one of:

| State | Meaning |
|---|---|
| `never_read` | File exists but model hasn't read it |
| `partial_read(ranges)` | Model has seen specific line ranges |
| `fully_read` | Model has seen the complete file |
| `model_authored` | Model created this file in the current session |
| `stale` | File modified since last model read (coarser than `expected_version` hash check — spans the whole session as a soft signal) |

Range tracking is additive: reading lines 1-200 then 201-400 means lines 1-400 are covered. The ledger lives at the **harness level**, not inside a specific agent's tool loop, so awareness persists across Orchestrator → Coder handoffs within a session.

### Edit Guard Behavior

On any write/edit tool call, the guard checks: **do the ledger's read ranges cover the lines being modified?**

- **Full coverage** → edit proceeds normally
- **Partial overlap** (e.g., model read 50-100, wants to write 80-120) → **block with precise message**: "Lines 101-120 were not read. Read that range first." Model knows exactly what to do next.
- **No coverage** → block: "File was partially read — use read_file with target line range first."
- **New file creation** → always allowed (no prior read needed)
- **Model-authored file** → always allowed (model knows full content because it wrote it, even if a subsequent read was truncated)
- **Stale file** → soft warning, not a block. "You last saw this file N rounds ago; it may have changed."

### Signature Extraction (Friction Reducer)

Cheap regex-based extraction of structural hints from truncated portions, appended to the truncation notice:

```
[Lines 401-680 truncated — contains: function handleAuth(), function refreshToken(), 
 export default AuthProvider, class TokenCache]
```

Patterns to scan: `function\s+\w+`, `class\s+\w+`, `export`, `interface\s+\w+`, `type\s+\w+`, `def\s+\w+` (Python).

Not a parser. ~70% accurate. Value: model can make a targeted range read on the first try instead of guessing. **Must be validated against real Push files before shipping** — if regex produces misleading output, false confidence is worse than acknowledged ignorance.

### Scoped Auto-Expand (Graceful Recovery)

When the edit guard fires, the harness can optionally auto-re-read the missing range and feed it back to the model, allowing a seamless retry. The user may not even notice the extra round trip.

- No global cap changes
- Edit intent detected *after* it matters (the guard is the intent detector)
- Model gets full context only when it proves it needs it

## Shipping Sequence

### Phase 1: Edit Guard (MVP safety)
- Implement ledger with range tracking
- Wire guard into write/edit tool path
- Handle exceptions: new file creation, model-authored files
- Log trigger rate — this is the key decision metric
- **Gate:** Guard shipping and trigger rate measured. If >15%, fast-track Phase 3.

### Phase 2: Signature Extraction (friction reducer)
- Build regex extractor for TS + Python patterns
- Validate against ~10 real Push files (check for misleading output)
- Append signatures to truncation notices in read_file responses
- Measure: does guard trigger rate drop?
- **Gate:** Signatures validated as net-helpful (not producing junk that misleads the model).

### Phase 3: Scoped Auto-Expand (UX fix)
- On guard trigger, auto-re-read the missing range at expanded limit
- Feed expanded content back to model; model retries edit
- Measure: end-to-end edit success rate with guard + auto-expand
- **Gate:** Auto-expand resolves >80% of guard triggers without user intervention.

## Non-Goals

- Full AST parsing / tree-sitter integration (too expensive to build and maintain for a solo dev)
- Raising the global truncation cap (defeats the purpose of context management)
- Detecting edit intent *before* the model acts (too magical, too fragile)
- Fine-grained "modified by you vs. modified by other" stale tracking (overkill for now)

## Open Questions

1. **Stale detection granularity** — Is round-counting enough, or do we need timestamp-based staleness? Round-counting is simpler and sufficient if sessions are short.
2. **Ledger persistence** — Does it reset on branch switch? (Probably yes, since branch switch tears down the sandbox.) Does it reset on chat continuation? (Probably no — if you resume a chat, prior reads are still valid if files haven't changed.)
3. **Compaction interaction** — When message compaction removes earlier tool calls from context, the ledger becomes the *only* record of what the model has seen. This is the deeper win: it's a memory prosthetic for a context-limited agent.

## Promotion Criteria

Ready for ROADMAP.md when:
- [x] Problem statement is clear
- [x] V1 scope is bounded (Phase 0 + Phase 1)
- [x] Success criteria are testable (trigger rates, blind-edit rates)
- [x] Ownership is clear (Shawn, phased)
- [x] Non-goals are explicit
