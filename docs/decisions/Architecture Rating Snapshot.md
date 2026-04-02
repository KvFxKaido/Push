# Push Architecture Rating Snapshot

Date: 2026-03-30
Status: Reference snapshot

## Panel Summary

| Model | Overall | Status | Notes |
|---|---|---|---|
| Codex | **8/10** | Filled | Current local assessment after the harness runtime evolution rollout. |
| Claude | **7.5/10** | Filled | Independent code-read pass; more positive on architecture instincts than on current implementation shape. |
| Gemini | **8/10** | Filled | Strongest score on architecture instincts; most concerned about migration bridges and incomplete distributed tracing. |

## Codex

### Rating

Overall: **8/10**

Split view:

- **8.5/10** on product and systems architecture instincts
- **7.5/10** on current implementation shape

### Why it scores well

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

### Why it is not a 9

- The harness is still dense in a few important paths, especially around `useChat.ts` and its adapters.
- Some complexity is inherent, not accidental:
  - client-owned orchestration
  - Worker proxy boundaries
  - sandbox lifecycle
  - multi-agent delegation
  - web/CLI parity pressure
- A lot of the right abstractions now exist, but some of them are still newly landed and not yet boring.
- There are still mirrored surfaces and cross-runtime seams where drift can reappear.

### Current read

Fact:
- The architecture is materially stronger than it was before the runtime-evolution pass.
- The codebase now has better contracts for run state, persistence, verification, and observability.

Inference:
- Push is in the zone where the architecture is clearly good and durable, but still a little young in its newest layers.
- It feels much closer to "serious system with good bones" than "fast-moving prototype," but not yet to "fully settled and mechanically simple."

### What would move it higher

- More time proving the new run-engine / journal / adaptive-profile stack under real usage.
- Further reduction of dense harness coordination logic at the hook layer.
- Continued elimination of web/CLI structural drift.
- Observability maturing from "good instrumentation" into "routine diagnosis is easy."

### Short version

Push has strong architecture taste, strong product boundaries, and increasingly solid runtime discipline. The remaining gap is less about whether the architecture is good and more about how fully the implementation has caught up to the quality of the design.

## Claude

### Rating

Overall: **7.5/10**

Split view:

- **8.5/10** on product and systems architecture instincts
- **6.5/10** on current implementation shape

### Top strengths

- The run engine is a real event-sourced reducer, not ad hoc runtime state:
  - pure transitions
  - serializable state
  - deterministic replay
  - parity checking against observed state
- Role isolation is disciplined:
  - structured delegation envelopes
  - serializable sub-agent results
  - tailored prompt/tool surfaces per role
- The broader context and safety stack is layered well:
  - session-level verification policy
  - additive turn policies
  - branch-scoped chat model
  - two-phase project-instruction loading
  - file-awareness ledger enforcing edits based on observed file ranges

### Top risks

- [coder-agent.ts](/home/ishaw/projects/Push/app/src/lib/coder-agent.ts) is still too dense and carries too many responsibilities in one file.
- Verification remains partly advisory because policy compliance still depends heavily on model behavior instead of hard runtime enforcement.
- [useChat.ts](/home/ishaw/projects/Push/app/src/hooks/useChat.ts) is still the main complexity attractor, even after extraction work.

### Short summary

Claude’s read is that the design abstractions are strong and intentional, especially the reducer-based run engine, envelope-driven delegation, and edit-safety model. The main concern is that the densest implementation modules have not yet been broken apart to the same standard, so the architecture scores higher than the current code shape.

### Notable note

Claude explicitly called out a familiar trap: once the boundaries around a complex module are good enough, it becomes easy to keep adding behavior to that module instead of splitting it further. That maps closely to the current pressure around `coder-agent.ts` and `useChat.ts`.

## Gemini

### Rating

Overall: **8/10**

Split view:

- **9/10** on product and systems architecture instincts
- **7/10** on current implementation shape

### Top strengths

- The run engine is a strong pure reducer boundary:
  - side-effect-free state transitions
  - deterministic replayability
  - invariant-friendly control flow separation from React and streaming layers
- The turn-policy layer is a real architecture surface, not scattered guardrail glue:
  - explicit before/after hooks
  - additive policy composition
  - formal actions such as `inject`, `deny`, and `halt`
- The append-only run journal is seen as a resilient persistence model for:
  - resumability
  - diagnostics
  - lifecycle reconstruction without depending on token-level deltas

### Top risks

- Migration bridges are still a fragility point, especially where newer abstractions still rely on older execution-hook shapes.
- Adapter layers remain a synchronization risk because the pure state model still depends on boundary hooks for writes, streaming, and UI updates.
- Distributed tracing is still not mature enough to make cross-boundary failures easy to debug end-to-end.

### Short summary

Gemini’s read is that Push has unusually strong architecture instincts for an AI-agent system, especially in how it turns the harness into a strict state machine with explicit policy surfaces. The main caveat is that the implementation still carries transition debt where new abstractions meet older bridges, so the architecture is ahead of the code shape in a few critical seams.

## Synthesis

Current agreement across Codex, Claude, and Gemini:

- Push has strong architecture instincts and a real systems model.
- The runtime-evolution pass materially improved the harness.
- The main remaining weakness is concentrated complexity, not weak fundamentals.
- The densest risk surfaces are still the central orchestration and coder paths.
- The architecture currently grades higher than the implementation shape.

Current difference in emphasis:

- Codex is a little more generous on implementation shape (`7.5/10` vs `6.5/10`).
- Claude puts more weight on enforcement softness and the blast radius of dense modules.
- Gemini puts more weight on transition seams, adapter drift risk, and incomplete distributed tracing.

Blended takeaway so far:

- Push looks like a system with very good long-term bones whose abstractions are now strong enough that the next gains are mostly:
  - extraction of the densest modules
  - enforcement hardening at runtime boundaries
  - continued cleanup of migration seams
  - better end-to-end observability under real use
