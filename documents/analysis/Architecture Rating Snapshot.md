# Push Architecture Rating Snapshot

Date: 2026-03-30
Status: Reference snapshot

## Rating

Overall: **8/10**

Split view:

- **8.5/10** on product and systems architecture instincts
- **7.5/10** on current implementation shape

## Why it scores well

- Push has a real system architecture, not just prompt layering:
  - Orchestrator
  - Explorer
  - Coder
  - Reviewer
  - Auditor
- The core repo model is strong:
  - repo-scoped context
  - branch-scoped chats
  - explicit branch switching
  - PR-only merge flow
- The harness now handles several genuinely hard reliability problems in a deliberate way:
  - resumable runs and checkpoints
  - steer vs queue control
  - authoritative run engine
  - unified run journal
  - session-level verification policy
  - runtime tracing across app and Worker boundaries
- The system tends to preserve truth in the right places:
  - sandbox/workspace state as execution truth
  - structured run/event state for replay and diagnostics
  - provider/model lock semantics at the chat boundary

## Why it is not a 9

- The harness is still dense in a few important paths, especially around `useChat.ts` and its adapters.
- Some complexity is inherent, not accidental:
  - client-owned orchestration
  - Worker proxy boundaries
  - sandbox lifecycle
  - multi-agent delegation
  - web/CLI parity pressure
- A lot of the right abstractions now exist, but some of them are still newly landed and not yet boring.
- There are still mirrored surfaces and cross-runtime seams where drift can reappear.

## Current read

Fact:
- The architecture is materially stronger than it was before the runtime-evolution pass.
- The codebase now has better contracts for run state, persistence, verification, and observability.

Inference:
- Push is in the zone where the architecture is clearly good and durable, but still a little young in its newest layers.
- It feels much closer to "serious system with good bones" than "fast-moving prototype," but not yet to "fully settled and mechanically simple."

## What would move it higher

- More time proving the new run-engine / journal / adaptive-profile stack under real usage.
- Further reduction of dense harness coordination logic at the hook layer.
- Continued elimination of web/CLI structural drift.
- Observability maturing from "good instrumentation" into "routine diagnosis is easy."

## Short version

Push has strong architecture taste, strong product boundaries, and increasingly solid runtime discipline. The remaining gap is less about whether the architecture is good and more about how fully the implementation has caught up to the quality of the design.
