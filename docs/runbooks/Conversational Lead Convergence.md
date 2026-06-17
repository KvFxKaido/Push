# Conversational Lead Convergence — retiring the conversational→Orchestrator downgrade

Status: Draft (Phase 0 landed)
Owner decision: [`../decisions/Agent Runtime Decisions.md`](<../decisions/Agent Runtime Decisions.md>) §10

## Why this exists

Repo-backed chat turns fork by intent: a **task** turn ("add a flag to X") routes
to the inline Coder kernel lead; a **conversational** turn ("what changed
recently?", "how does X work?") is *downgraded* to the foreground Orchestrator
loop (`chat-send-background.ts` sets `inlineEligible = repoBranchReady &&
!conversationalTurn`). That fork is the single biggest source of "which loop am
I in?" confusion, and it forces every bug fix to land in two loops (the
silent-`extraMutations` gap that shipped to the kernel but not the Orchestrator
is the proof — PR #957).

The honest reason the downgrade exists: **the inline lead is the Coder kernel in
a lead prompt costume.** Its skeleton — turn policy, completion guards,
acceptance-criteria, end-of-loop summary contract — is implementer-shaped.
Conversation is handled by *suppressing* those behaviors (`taskInFlight`
gating, post-kernel criteria gating, prompt overrides) rather than by a real
conversational mode. The Orchestrator is conversation-shaped by construction,
so conversation was parked there.

Target: **one lead, conversational by default, that escalates into coder-shaped
behavior only when the turn needs edits** — at which point the
conversational→Orchestrator downgrade is deleted and the Orchestrator loop's
live triggers drop from three to two (no-repo workspaces, `delegated` opt-out).

The reframe: promote `taskInFlight` from "mute one guard" to **the kernel's
mode selector.**

## Parity matrix — what a conversational turn gets today (the "must not lose" checklist)

Source: behavior audit of the Orchestrator null-trigger path
(`useChat.ts` → `chat-round-loop.ts` → `chat-no-tool-path.ts` →
`orchestrator.ts:toLLMMessages`) vs the inline lead path
(`chat-send-inline.ts` → `inline-coder-run.ts` → `lib/coder-agent.ts`).

| Capability | Orchestrator (today) | Inline lead (today) | Gap |
|---|---|---|---|
| **Conversation history** | Full transcript, visibility-filtered, budget-aware compaction → `[SESSION DIGEST]` + `[USER_GOAL]` anchor, memory-record injection on compaction (`orchestrator.ts:607-695`) | Last 6 turns × 700 chars, flat text preamble (`buildInlineTurnPreamble`, `chat-send-inline.ts:115-144`) | **CRITICAL** |
| **Linked-library content** | Per-turn fresh inject (system text + images spliced into latest user msg) | Not threaded (zero refs in `chat-send-inline.ts`) | **Real** |
| **scratchpad / todo tools** | Wired | Not wired | Medium (low conversational use) |
| **delegate_coder / plan_tasks** | Wired | Refused (lead does its own coding) | Low (conversational turns don't delegate code) |
| **delegate_explorer** | Wired | Wired (PR #957) | OK |
| **github / sandbox / web / memory / ask_user / artifacts** | Wired | Wired | OK |
| **Turn policy** | orchestrator-policy: ungrounded-completion, trailing-action-intent nudge, reasoning-channel tool-call nudge | coder-policy: drift, no-fake-completion (gated), backpressure | Partial — see below |
| **Reasoning-channel buried tool call** | orchestrator-policy nudge | `lib/tool-call-recovery.ts` (kernel) | Likely covered — verify |
| **Trailing-action-intent** ("I'll read X" w/ no tool call) | Nudge + re-prompt cap | Not present in kernel | **Verify / possible gap** |
| **No-tool reply finalization** | mark done, malformed flagging, `visibleToModel` hygiene (`chat-no-tool-path.ts`) | kernel returns summary; inline lane finalizes | Mostly OK |
| **Run events / telemetry** | `assistant.turn_start/end`, `assistant.prompt_snapshot`, `STREAMING_COMPLETED`, `tool.call_malformed`, … | `tool.execution_complete`, `ROUND_STARTED`, mirrored `ACCUMULATED_UPDATED` | **Vocabulary differs — verify downstream** |
| **Checkpoints / adoption** | `flushCheckpoint('turn')` | inline bridges `onCheckpoint` → `flushCheckpoint('turn')` | OK |
| **Multi-round (read → answer)** | Yes | Yes (kernel loops) | OK |
| **Memory writes on conversational turn** | None (read-only digest only) | None unless edited | OK |

### Confirmed coder-shape leaks (the things the lead suppresses rather than avoids)
- **Drift guard** fired regardless of intent → could steer a long prose answer
  into implementer behavior. **Closed in Phase 0.**
- **No-fake-completion guard** already gated on `taskInFlight === false`
  (`coder-policy.ts`).
- **Acceptance criteria** run unconditionally at kernel end-of-loop; the inline
  lane lifts them out and gates on "did the turn edit"
  (`runInlineVerificationCriteria`). Works, but the gate lives outside the
  kernel — a coder-ism patched from the host.
- **Done/Changed/Verified/Open template** is the kernel default; the lead prompt
  has to say "for a question, just answer — do NOT use that template" — prompt
  fighting the default.

## Phased plan

**Phase 0 — safe, additive, no routing change (LANDED).**
- Gate the cognitive-drift guard on `taskInFlight === false` so a conversational
  reply can't trip it (`coder-policy.ts`). Mirrors the no-fake-completion guard.
  Zero regression: `taskInFlight` is unset for delegated Coders / engine runs,
  so their drift protection is unchanged. (+ test.)

**Phase 1 — conversation context parity (the crux, NOT YET STARTED).**
- Give the conversational lead real history instead of the 6×700 preamble. Two
  options: (a) reuse the Orchestrator's `toLLMMessages` / context-transform
  pipeline (compaction + session digest + memory injection) from the inline
  lane when `taskInFlight === false`; (b) give the kernel a "conversational
  context mode" that threads the managed transcript. This is the load-bearing
  piece — the inline lane was *built* around bounded task context, so this is
  real integration work, not a tweak.
- Thread linked-library content into the inline lane.

**Phase 2 — policy + tool + telemetry parity.**
- Audit orchestrator-policy's trailing-action-intent + reasoning-channel nudges
  vs the kernel's `tool-call-recovery`; port anything missing.
- Decide scratchpad/todo: wire them for the lead, or confirm conversational
  turns don't need them.
- Reconcile run-event vocabulary so observability/telemetry doesn't regress.

**Phase 3 — flip routing, behind a flag.**
- `inlineEligible = repoBranchReady` (drop `&& !conversationalTurn`), delete the
  `conversational_downgrade` route event. Gate behind a setting, A/B against the
  Orchestrator path on conversational turns, then default.
- After bake: the Orchestrator loop's live triggers drop to no-repo workspaces +
  `delegated` opt-out (see the LOAD-BEARING markers in
  `delegation-mode-settings.ts` / `orchestrator.ts`).

**Do NOT flip routing (Phase 3) until Phase 1 + 2 gaps are closed and verified.**

## Open questions
- No-repo workspaces (chat/scratch/local-pc) still need the Orchestrator loop —
  is a sandboxless kernel run the eventual home, or do they keep a lightweight
  conversational path? (Out of scope here; tracked as the remaining Orchestrator
  trigger.)
- Is the `assistant.prompt_snapshot` telemetry consumed anywhere that a kernel
  turn would need to reproduce?
