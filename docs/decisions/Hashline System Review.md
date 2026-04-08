# Hashline System Review

**Date:** 2026-04-08
**Status:** Active — recommendations A, C, D, and E shipped on 2026-04-08; recommendation B implemented as a tool-level patchset range form instead of a low-level `HashlineOp`

## Overview

The hashline system is Push's content-addressed editing mechanism. It assigns a truncated SHA-256 hash to each line of a file, uses those hashes as stable references in edit operations, and resolves all refs against the original file state before applying mutations. This document reviews the system's current design, identifies friction points for models, and proposes concrete improvements.

## Architecture

### Core files

| File | Role |
|------|------|
| `lib/hashline.ts` | Canonical implementation (async, Web Crypto + fallback) |
| `cli/hashline.ts` | CLI sync adapter over the shared resolution/apply engine (Node.js `createHash`) |
| `app/src/lib/hashline.ts` | Thin re-export for web imports |
| `app/src/lib/sandbox-edit-ops.ts` | Auto-recovery, retry hints, range-to-hashline compilation |
| `app/src/lib/sandbox-tools.ts` | Read rendering, edit orchestration, truncation guards |
| `app/src/lib/sandbox-tool-detection.ts` | System prompt (SANDBOX_TOOL_PROTOCOL) with model instructions |
| `app/src/lib/tool-registry.ts` | Tool schema definitions |

### How it works

**Reading:** When a model reads a file, each line is rendered as:
```
lineNo:7-char-hash\tcontent
```

**Editing:** Models emit `HashlineOp` arrays:
```typescript
type HashlineOp =
  | { op: 'replace_line'; ref: string; content: string }
  | { op: 'insert_after'; ref: string; content: string }
  | { op: 'insert_before'; ref: string; content: string }
  | { op: 'delete_line'; ref: string };
```

Refs are either bare hashes (`"a1b2c3d"`) or line-qualified (`"42:a1b2c3d"`).

**Resolution (two-phase):**
1. All refs are resolved against the original file content before any mutations.
2. Edits are applied in declaration order with offset tracking for shifted indices.

**Auto-recovery:** If edits fail, the harness tries:
1. Refreshing stale line-qualified refs to current same-line hashes.
2. Re-reading the file and retrying with bare-hash-only refs (content relocation).

## What works well

1. **Staleness is detectable, not silent.** Hash mismatch surfaces stale context explicitly, unlike string-match editing where the wrong occurrence can match silently.

2. **Content motion tracking.** Bare-hash refs can relocate content that moved due to insertions/deletions elsewhere in the file.

3. **Two-phase resolution** avoids cascading-mutation bugs where early edits invalidate later refs.

4. **Layered auto-recovery** reduces manual correction loops without hiding real failures.

5. **Multi-tool surface** (`edit` for surgical, `edit_range` for blocks, `replace` for substrings) gives models appropriate tools for different edit shapes.

## Friction points

### 1. Bare hashes still cause frequent ambiguity on real code

The display/ref mismatch has now been fixed: reads render as `42:a1b2c3d\tcontent`, so every displayed line is a copy-pasteable line-qualified ref.

7 hex chars (28 bits) provide ample collision resistance for *distinct* content. But real code contains massive amounts of identical-content lines: `}`, `});`, blank lines, `return;`, `break;`, repeated imports, etc. These are identical *content*, not hash collisions — and they're the majority case for ambiguity errors.

The error diagnostics are excellent (suggest line-qualified refs), but each failure costs a round trip.

### 2. Complex contiguous edits still need the right tool surface

Replacing lines 10-15 via `sandbox_edit_file` requires:
- 5 `delete_line` ops (lines 15 down to 11)
- 1 `replace_line` for line 10
- N `insert_after` ops for additional replacement lines

`edit_range` handles this cleanly for one file, and `sandbox_apply_patchset` now has a matching tool-level form for contiguous replacements: `{ path, start_line, end_line, content }`. That covers the practical product need without adding a new low-level `HashlineOp`. The remaining limitation is that `sandbox_edit_file` itself still uses the line-anchored edit vocabulary.

### 3. CLI reimplements the core algorithm

This was true before the current extraction pass. `cli/hashline.ts` now delegates to the shared resolution + apply engine in `lib/hashline.ts`, keeping only the sync crypto layer and CLI-shaped result formatting local.

### 4. Offset tracking is O(n^2) and relies on careful case analysis

The offset adjustment loop iterates all prior applied edits for each new edit. Correctness depends on per-case analysis of every `(current_op, prior_op, same_line?)` combination. Edge cases like `insert_after` on a `replace_line`'d line (shifting past the full replaced block) require specific handling.

## Recommendations

### A. Align display format with ref format (Priority: High, shipped)

Change read output from:
```
[a1b2c3d]  42	function foo() {
```
to:
```
42:a1b2c3d	function foo() {
```

**Why:** Every displayed line becomes a valid, copy-pasteable ref. Line-qualified refs are always unambiguous, eliminating the most common failure path. The system prompt simplifies — no need to explain bare vs. qualified refs or the duplicate-content caveat.

**Impact:** Reduces model edit failures on duplicate-content lines to near zero. Removes a class of round trips.

**Risk:** Low. Models that already use line-qualified refs benefit immediately. Models using bare hashes still work (the resolver accepts both). Existing auto-recovery remains as a safety net.

**Status:** Implemented in the current hashline renderers and sandbox read output on 2026-04-08.

### B. Add contiguous range replacement to patchsets (Priority: Medium, shipped via tool-level form)

```typescript
{ path: string; start_line: number; end_line: number; content: string }
```

**Why:** Lets `sandbox_apply_patchset` express contiguous replacements in a single entry instead of decomposing them into delete + replace + insert sequences. This captures the main ergonomics win without expanding the low-level hashline op surface.

**Risk:** Moderate if added at the low-level op layer. The shipped approach keeps the risk lower by compiling the range entry down to ordinary hashline ops inside the tool, so the shared engine stays simpler.

**Status:** Implemented in `sandbox_apply_patchset` as a tool-level range form on 2026-04-08. The original low-level `replace_range` `HashlineOp` idea is intentionally deferred.

### C. Adaptive hash length for high-collision files (Priority: Medium)

When rendering read output, detect collision rate among displayed lines. If >5% of lines share a 7-char hash prefix, bump to 8-9 chars.

**Why:** Reduces ambiguity errors for template-heavy and repetitive files (HTML, config, boilerplate-heavy modules).

**Risk:** Low. Longer hashes are already supported everywhere (7-12 range).

**Status:** Implemented in the shared and CLI renderers on 2026-04-08.

### D. Consolidate CLI onto shared lib (Priority: Medium)

Extract the pure resolution + offset logic into sync helpers that both lib and CLI share. Keep only the crypto layer different (Web Crypto vs. Node `createHash`).

**Why:** Eliminates divergence risk. Currently a fix to one implementation must be manually mirrored.

**Risk:** Low. Internal refactor with no behavioral change.

**Status:** Implemented on 2026-04-08.

### E. Double-replace guard (Priority: Low)

Warn when two `replace_line` ops target the same original line in a batch. Currently the second silently applies to already-mutated content. (Duplicate `delete_line` is already caught.)

**Why:** Prevents surprising behavior where the model may not realize it's overwriting its own prior edit within the same batch.

**Status:** Implemented on 2026-04-08. The shared engine emits an explicit warning, and app/CLI success paths now surface it.

## Priority order

Ranked by impact on model edit success rate per token:

1. **A — Align display with ref format** (highest leverage, lowest risk)
2. **C — Adaptive hash length** (low effort, reduces round trips)
3. **D — CLI consolidation** (maintenance win, no model-facing change)
4. **B — tool-level patchset range replacement** (useful for mixed multi-file edits)
5. **E — Double-replace guard** (edge case, but now surfaced)

## Current scorecard

| Rec | Description | Status |
|-----|-------------|--------|
| A | Align display ↔ ref format | Shipped |
| B | Contiguous range replacement in patchsets | Shipped at the tool level; low-level `replace_range` op deferred |
| C | Adaptive hash length | Shipped |
| D | CLI consolidation onto shared engine | Shipped |
| E | Double-replace guard | Shipped |

## Design question

Should the hashline system default to line-qualified refs or keep bare hashes as the primary mode?

Current design is permissive — bare hashes work when unique, line-qualified refs are the fallback. But given that duplicate-content lines are the norm in real code (not an edge case), making line-qualified refs the default via display format alignment (recommendation A) flips the probability distribution in the model's favor. Bare hashes remain valid for backward compatibility and for cases where content has moved.
