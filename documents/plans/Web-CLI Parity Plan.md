# Web–CLI Parity Plan v2

## Status
- Created: 2026-03-15
- Supersedes: Web-CLI Parity Plan (2026-03-11)
- State: Planning — TypeScript convergence decision
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

think` tags, native `reasoning_content`)
- [ ] `context-budget.ts` — Token counting and message trimming logic

**For each module:**
1. Audit web and CLI implementations for differences
2. Use web version as reference (it's more mature)
3. Create adapters in CLI where execution differs (filesystem vs HTTP)
4. Update imports in both surfaces
5. Test in both environments

### Track 3 — TUI Usability (Parallel with Track 2)

Make TUI the preferred surface for terminal-based development.

**Current TUI state:**
- Enabled via `PUSH_TUI_ENABLED=1`
- Full-screen interface under active development
- Goal: muscle-memory workflow that fits terminal development

**Key TUI improvements:**
- [ ] Session picker on startup (resume previous or start new)
- [ ] Live tool output in transcript format (readable, not JSON dumps)
- [ ] Context meter showing token budget usage
- [ ] File awareness display (what files have been read/edited)
- [ ] Interrupt handling (Ctrl+C doesn't kill daemon, just stops current tool loop)
- [ ] Keyboard shortcuts for common actions (accept/reject, retry, switch sessions)
- [ ] Status line showing active session, branch, dirty files
- [ ] Scrollback buffer for reviewing previous tool outputs

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
1. Track 1: Migration spike (hashline only)
2. Decision: proceed or fall back to v1 shared modules

**Phase 2 — Core convergence + TUI:**
3. Track 2: Remaining core modules (diff-utils, tool-protocol, error-types, reasoning-tokens, context-budget)
4. Track 3: TUI usability improvements (parallel with Track 2)

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
- CLI and web use identical hashline, diff parsing, and tool dispatch code
- Protocol changes only need to be made once
- No runtime performance regressions in CLI
- TypeScript compilation passes for both surfaces

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
- Track F0's validation-first approach (prove it works with one module before going all-in)
- Adapter pattern for execution differences
- "Port proven patterns, don't reinvent" principle

**What to drop:**
- Track A (Safety Guards) — deferred, not MVP
- Track B (Agent Roles) — CLI doesn't need full role separation for v1
- Track E (Reverse Parity) — separate plan
- Private connector auth complexity

**What to add:**
- Explicit TypeScript migration path
- TUI usability as a first-class track
- Daemon integration as future work (not current scope)
