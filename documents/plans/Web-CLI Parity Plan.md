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

## Architecture After Convergence

