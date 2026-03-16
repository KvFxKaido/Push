# Web–CLI Parity Plan v2

## Status
- Created: 2026-03-15
- Updated: 2026-03-16
- Supersedes: Web-CLI Parity Plan (2026-03-11)
- State: **In Progress** — Track 1 Complete ✅, Track 2 Complete ✅, Track 3 Complete ✅
- Intent: Share core logic between web and CLI to eliminate dual implementations, prioritize TUI usability over feature parity

## What Changed from v1

**v1 assumed:** CLI stays vanilla `.mjs` + JSDoc, feature parity across surfaces, full role separation (Orchestrator/Coder/Reviewer/Auditor) in both environments.

**v2 commits to:** CLI becomes TypeScript, shares `lib/` with web at the repo root, focuses on TUI ergonomics over role completeness. Most of Track A (safety gates), Track B (agent roles), and Track E (reverse parity) are cut or deferred.

## Why Converge on TypeScript

The web app and CLI currently share zero imports. Every shared concept (hashline, tool protocol, error classification, context management) is reimplemented twice. This creates maintenance drag and protocol drift.

**The original plan (v1) tried to solve this with `shared/*.mjs` + JSDoc types**, preserving CLI's zero-dependency story. That approach works but:
- Still requires manual porting and testing for protocol changes
- JSDoc types are weaker than real TypeScript
- Creates a third location (`shared/`) that neither surface "owns"

**TypeScript convergence eliminates the problem entirely:**
- CLI imports directly from `lib/` (same canonical code web uses)
- Protocol changes only need to be made once
- Real type safety across both surfaces
- One canonical implementation

**The cost:** CLI gains a build step (`tsx` runtime or `tsc` compilation) and loses the "zero dependencies" story.

**The trade is worth it because:**
1. CLI isn't being distributed to external users (no install simplicity requirement)
2. TUI workflow is long-lived sessions or daemon-attached, not cold-start scripts
3. Shared core is more valuable than instant startup

## Revised Scope

### What This Plan Ships

**Phase 1 — TypeScript Migration Foundation**
- Migrate CLI from `.mjs` to `.ts`
- Create `lib/` at the repo root and extract web's `lib/` modules into it (hashline, diff-utils, tool protocol, context budget)
- Create filesystem/git adapters so CLI can use shared tool logic on local files
- Prove the build pipeline works end-to-end

**Phase 2 — TUI Usability**
- Focus on making TUI something Shawn actually reaches for during development
- Terminal-native UX (fits in tmux/screen workflows)
- Fast local file operations (no sandbox proxy latency)
- Live tool output in transcript format
- Session management and context visibility

### What This Plan Defers

**Agent role parity:** CLI doesn't need Reviewer or Auditor gates for MVP. Reviewing happens in web or via direct model questions. Safety gates (Protect Main, pre-commit audit) are nice-to-have, not blockers.

**Reverse parity (Track E):** Persistent memory, skills, explain mode from CLI → web is a separate effort, not part of core convergence.

**Private connectors:** Azure/Bedrock/Vertex in CLI is deferred indefinitely. Enterprise users can proxy through LiteLLM locally.

**GitHub auth in CLI:** No GitHub API integration needed for MVP. Local git operations are sufficient.

## Architecture After Convergence

```
Push/
  lib/                      # Shared modules (canonical, both surfaces import)
    hashline.ts             # Two-phase hash resolution, edit application (Track 1) ✅
    diff-utils.ts           # Diff parsing, file classification, budget packing (Track 2) ✅
    error-types.ts          # Error taxonomy, classifyError, formatStructuredError (Track 2) ✅
    reasoning-tokens.ts     # Think-token parser (<think> tags + native reasoning_content) (Track 2) ✅
    context-budget.ts       # Token estimation, context budget resolution (Track 2) ✅
    tool-protocol.ts        # Tool detection, JSON repair, diagnosis, dedup (Track 2) ✅
    working-memory.ts       # Agent state management, observations, staleness (Track 2) ✅
  app/src/lib/              # Web-specific modules (import from lib/ for shared logic)
  cli/                      # CLI-specific modules (import from lib/ for shared logic)
```

## Tracks

### Track 1 — TypeScript Migration Spike ✅ COMPLETE

**Goal:** Prove the shared module approach works end-to-end with one module (hashline).

**Shipped:**
- [x] Created `lib/hashline.ts` — universal hashline implementation with Node.js (`node:crypto`) and browser (`crypto.subtle`) runtime detection
- [x] Optimized batch hashing for larger files (>2k lines) in Node
- [x] Created `cli/tsconfig.json` with `@push/lib/*` path mapping
- [x] CLI test suite (`cli/test-hashline.ts`) validates convergence
- [x] Both surfaces can import from the same canonical source

---

### Track 2 — Core Module Extraction ✅ COMPLETE

**Goal:** Extract remaining shared logic into runtime-agnostic modules in `lib/`.

**Shipped:**

#### diff-utils.ts
- [x] `parseDiffStats()` — count files/additions/deletions from unified diff
- [x] `parseDiffIntoFiles()` — split unified diff into per-file sections
- [x] `classifyFilePath()` — production/tooling/test/fixture classification
- [x] `chunkDiffByFile()` — budget-aware diff packing with priority sorting
- [x] `formatSize()` — human-friendly byte size label
- [x] Web app re-exports from `@push/lib/diff-utils` (zero-change for consumers)

#### error-types.ts
- [x] `ToolErrorType` union type (13 error types)
- [x] `StructuredToolError` interface
- [x] `classifyError()` — pattern-matching error classifier (superset of both web and CLI patterns)
- [x] `formatStructuredError()` — text block formatter for tool results
- [x] CLI-specific patterns (PATH_ESCAPE, non-zero exit) mapped to canonical types

#### reasoning-tokens.ts
- [x] `createReasoningTokenParser()` — unified parser handling both `<think>` tags and native `reasoning_content` deltas
- [x] Based on CLI's more complete implementation (web version lacked native reasoning_content support)
- [x] Full TypeScript types (`ReasoningTokenParser` interface)

#### context-budget.ts
- [x] `ContextBudget` interface with maxTokens/targetTokens/summarizeTokens
- [x] `getContextBudget()` — model-aware budget resolution (default, Gemini, Claude, GPT-5.4, Grok)
- [x] `estimateTokens()` — content-aware heuristic (code/prose/CJK detection via sampling)
- [x] `estimateMessageTokens()` / `estimateContextTokens()` — message-level estimation
- [x] `TokenEstimationMessage` interface (decoupled from app-specific ChatMessage type)
- [x] Runtime-agnostic (no localStorage dependency)

#### tool-protocol.ts
- [x] `asRecord()` / `JsonRecord` — safe object coercion
- [x] `diagnoseJsonSyntaxError()` — pinpoints structural JSON errors (missing brace, unterminated string, unbalanced brackets)
- [x] `repairToolJson()` — best-effort recovery for common LLM garbling (trailing commas, unquoted keys, single quotes, Python literals, auto-close truncated)
- [x] `detectTruncatedToolCall()` — detects JSON cut off mid-stream (unbalanced braces after tool pattern)
- [x] `extractBareToolJsonObjects()` — brace-counting extraction of `{"tool":..}` objects from prose
- [x] `detectToolFromText()` — generic fenced-JSON + bare-JSON tool detection factory
- [x] `stableJsonStringify()` — canonical key generation for dedup (sorted keys, normalized values)
- [x] `isInsideInlineCode()`, `findPrecedingBrace()`, `findFollowingBrace()` — region extraction helpers
- [x] `ToolCallDiagnosis` type — diagnosis result structure

#### working-memory.ts
- [x] `CoderWorkingMemory` / `CoderObservation` types — full type system with staleness tracking
- [x] `createWorkingMemory()` — factory for fresh empty state
- [x] `applyWorkingMemoryUpdate()` — partial update with array dedup (unifies CLI's `applyWorkingMemoryUpdate` and web's per-field merge)
- [x] `applyObservationUpdates()` — add/update/remove observations with round tracking
- [x] `invalidateObservationDependencies()` — mark observations stale when file dependencies are modified
- [x] `getVisibleObservations()` — filter expired stale observations (5-round auto-expiry)
- [x] `hasCoderState()` / `formatCoderState()` — check non-emptiness and format `[CODER_STATE]` blocks
- [x] `detectUpdateStateCall()` — parse `coder_update_state` tool calls from model output
- [x] Imports `detectToolFromText` from `tool-protocol.ts` — validates shared module cross-imports

**Build integration:**
- [x] Web app: `@push/lib/*` path alias in `vite.config.ts`, `tsconfig.json`, `tsconfig.app.json`
- [x] CLI: existing `@push/lib/*` path mapping in `cli/tsconfig.json`
- [x] Test suite: `cli/test-track2.ts` — 125 tests, all passing

---

### Track 3 — TUI Usability ✅ COMPLETE

Make TUI the preferred surface for terminal-based development.

**Shipped:**

#### Session picker on startup
- [x] Auto-shows session resume modal when previous sessions exist (fresh sessions only, skipped with `--session`)
- [x] Ctrl+R opens session picker at any time (replaces placeholder)
- [x] Session picker supports fuzzy search, rename, delete, preview

#### Live tool output in transcript format
- [x] Tool calls show args preview (path, command, file) inline on the TOOL badge line
- [x] Tool results show first-line preview text below the tool entry (readable, not raw JSON)
- [x] Tool pane (Ctrl+T) shows recent tool calls/results with duration and error status
- [x] Payload inspector (Ctrl+O) for per-block expand/collapse of JSON tool payloads

#### Context meter showing token budget usage
- [x] Visual bar meter in status bar: `▰▰▰▰▱▱▱▱ 42k/100k` with color coding (green/yellow/red)
- [x] Uses `getContextBudget()` from `context-manager.mjs` for model-aware budget (Gemini 1M, default 100k)
- [x] Uses `estimateContextTokens()` for accurate per-message token estimation

#### File awareness display
- [x] TUI-local file ledger tracks files from tool_call/tool_result events
- [x] Status bar shows file count with read/write breakdown: `3 files (1w)`
- [x] Powered by shared `file-ledger.mjs` (same logic as engine)

#### Interrupt handling
- [x] Ctrl+C cancels the current run (aborts the engine loop), does not kill the process
- [x] Second Ctrl+C exits the TUI cleanly
- [x] Signal handlers (SIGTERM, SIGHUP) perform emergency cleanup

#### Keyboard shortcuts
- [x] Ctrl+Y/y approve, Ctrl+N/n deny, a always-approve, Esc dismiss (approval modal)
- [x] Ctrl+R session picker, Ctrl+P provider switcher, Ctrl+G reasoning, Ctrl+T tools
- [x] Ctrl+O payload inspector (j/k move, Enter toggle, a toggle-all)
- [x] PageUp/PageDown scrollback, Ctrl+L clear viewport
- [x] Emacs-style editing: Ctrl+A/E/U/K/W, Ctrl+Left/Right word nav

#### Status line
- [x] Git branch with dirty count, ahead/behind indicators
- [x] Shortened cwd path
- [x] Session name displayed in header (with session ID)
- [x] LIVE indicator during streaming
- [x] Context-aware keybind hints in footer

#### Scrollback buffer
- [x] PageUp/PageDown scroll transcript history
- [x] Auto-scroll on new tokens
- [x] 2000-line transcript buffer with overflow trimming

### Track 4 — Daemon Integration (Future)

Not part of this plan's scope, but the natural next step after TUI stabilizes.

**Vision:**
- `pushd` runs as persistent background daemon
- TUI becomes a client that attaches/detaches
- Background sessions continue when TUI closes
- Multiple TUI clients can observe same session (mob programming)

**Deferred because:**
- Requires Unix socket IPC or HTTP server
- Session state persistence and recovery
- Multi-client coordination
- Not blocking TUI usability for solo development

## Execution Order

**Phase 1 — Validate TypeScript convergence:**
1. Track 1: Migration spike (hashline only) ✅
2. Decision: proceed or fall back to v1 shared modules ✅ (proceeding)

**Phase 2 — Core convergence + TUI:**
3. Track 2: Remaining core modules (diff-utils, error-types, reasoning-tokens, context-budget) ✅
4. Track 3: TUI usability improvements ✅

**Phase 3 — Polish:**
5. Performance testing (startup time, local file ops)
6. Error handling parity (both surfaces should classify errors identically)
7. Documentation (CLI README update, architecture decision record)

**Later (separate plans):**
- Track 4: Daemon integration
- Safety gates (Protect Main, Auditor) if terminal workflow proves valuable
- Reverse parity (CLI features → web)

## Success Criteria

**Technical:**
- CLI and web use identical hashline, diff parsing, and tool dispatch code ✅ (hashline, diff, errors, reasoning, context, tool-protocol, working-memory)
- Protocol changes only need to be made once ✅
- No runtime performance regressions in CLI
- TypeScript compilation passes for both surfaces ✅

**Product:**
- Shawn reaches for TUI during development instead of web chat
- Local file operations feel instant
- Terminal workflow integrates naturally with tmux/vim/git habits
- Session resumption works reliably

## Open Architecture Decisions (Resolved)

1. **Runtime choice:** `tsx` is the recommended starting point for development simplicity. We can optimize with `tsc` later if startup time becomes painful.
2. **Shared module ownership:** `lib/` MUST live at the repo root. Root makes the "shared" intent clearer and prevents the CLI from being littered with fragile `../../app/src/lib` imports.
3. **ESM Strictness:** Node natively running ESM is strict about file extensions (e.g., `import { foo } from './bar.js'`). This will be the main friction point in Track 1 to ensure compatibility with Vite's looser resolution.

## Migration from v1 Plan

**What to preserve:**
- Track F0's validation-first approach (prove it works with one module before going all-in) ✅
- Adapter pattern for execution differences
- "Port proven patterns, don't reinvent" principle

**What to drop:**
- Track A (Safety Guards) — deferred, not MVP
- Track B (Agent Roles) — CLI doesn't need full role separation for v1
- Track E (Reverse Parity) — separate plan
- Private connector auth complexity

**What to add:**
- Explicit TypeScript migration path ✅
- TUI usability as a first-class track
- Daemon integration as future work (not current scope)
