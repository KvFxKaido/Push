# Conversational Lead Convergence — retiring the conversational→Orchestrator downgrade

Status: Current (Phase 3 landed; bake / A-B measurement follow-up remains)
Owner decision: [`../decisions/Agent Runtime Decisions.md`](<../decisions/Agent Runtime Decisions.md>) §10

## Why this exists

Repo-backed chat turns used to fork by intent: a **task** turn ("add a flag to
X") routed to the inline Coder kernel lead, while a **conversational** turn
("what changed recently?", "how does X work?") was *downgraded* to the
foreground Orchestrator loop (`chat-send-background.ts` set `inlineEligible =
repoBranchReady && !conversationalTurn`). That fork was the single biggest
source of "which loop am I in?" confusion, and it forced every bug fix to land
in two loops (the silent-`extraMutations` gap that shipped to the kernel but not
the Orchestrator is the proof — PR #957).

The honest reason the downgrade exists: **the inline lead is the Coder kernel in
a lead prompt costume.** Its skeleton — turn policy, completion guards,
acceptance-criteria, end-of-loop summary contract — is implementer-shaped.
Conversation is handled by *suppressing* those behaviors (`taskInFlight`
gating, post-kernel criteria gating, prompt overrides) rather than by a real
conversational mode. The Orchestrator is conversation-shaped by construction,
so conversation was parked there.

Target achieved in Phase 3: **one lead, conversational by default, that escalates
into coder-shaped behavior only when the turn needs edits**. Repo-backed
conversational turns now route to the inline lead by default, while the
Orchestrator loop remains live for no-repo workspaces, the `delegated` opt-out,
and the temporary conversational escape hatch during bake.

The reframe: promote `taskInFlight` from "mute one guard" to **the kernel's
mode selector.**

## Parity matrix — what a conversational turn gets today (the "must not lose" checklist)

Source: behavior audit of the Orchestrator null-trigger path
(`useChat.ts` → `chat-round-loop.ts` → `chat-no-tool-path.ts` →
`orchestrator.ts:toLLMMessages`) vs the inline lead path
(`chat-send-inline.ts` → `inline-coder-run.ts` → `lib/coder-agent.ts`).

| Capability | Orchestrator (today) | Inline lead (today) | Gap |
|---|---|---|---|
| **Conversation history** | Full transcript, visibility-filtered, budget-aware compaction → `[SESSION DIGEST]` + `[USER_GOAL]` anchor, memory-record injection on compaction (`orchestrator.ts:607-695`) | Phase 1: conversational turns seed the kernel with the raw visible transcript (`buildInlineConversationSeed`) + threaded digest inputs; the stream's `toLLMMessages` runs the single transform per round | Closed in Phase 1 |
| **Linked-library content** | Per-turn fresh inject (system text + images spliced into latest user msg) | Phase 1: inline lane resolves linked libraries fresh per turn, renders `library_context`, and merges linked images into current-turn parts | Closed in Phase 1 |
| **scratchpad / todo tools** | Wired | Phase 2: wired for inline lead when chat-hook handlers are present; current scratchpad/todo blocks are injected into the kernel prompt, protocols are advertised, and calls execute against the chat-state refs. Caveat: the kernel builds its system prompt once, so the prompt-injected block is a run-start snapshot — mid-run edits persist to chat state and the model sees them via tool results, but the prompt block doesn't live-refresh (the Orchestrator's does, per-turn). Fine for conversational turns; revisit if the lead does long scratchpad-heavy runs. | Closed in Phase 2 |
| **delegate_coder / plan_tasks** | Wired | Refused (lead does its own coding) | Low (conversational turns don't delegate code) |
| **delegate_explorer** | Wired | Wired (PR #957) | OK |
| **github / sandbox / web / memory / ask_user / artifacts** | Wired | Wired | OK |
| **Turn policy** | orchestrator-policy: ungrounded-completion, trailing-action-intent nudge, reasoning-channel tool-call nudge | Phase 2: coder-policy keeps task-shaped drift/no-fake-completion gates, adds uncoupled trailing-action nudge for task + conversational turns; kernel handles reasoning-channel buried calls | Closed in Phase 2 |
| **Reasoning-channel buried tool call** | orchestrator-policy nudge | Phase 2: `iteratePushStreamText` preserves `reasoningText`; `lib/coder-agent.ts` emits `tool.call_malformed` and injects `[POLICY: TOOL_CALL_IN_REASONING]` without executing the reasoning-channel call | Closed in Phase 2 |
| **Trailing-action-intent** ("I'll read X" w/ no tool call) | Nudge + re-prompt cap | Phase 2: `coder-policy.ts` reuses the orchestrator detector and capped nudge; applies to both task and conversational turns | Closed in Phase 2 |
| **No-tool reply finalization** | mark done, malformed flagging, `visibleToModel` hygiene (`chat-no-tool-path.ts`) | kernel returns summary; inline lane finalizes | Mostly OK |
| **Run events / telemetry** | `assistant.turn_start/end`, `assistant.prompt_snapshot`, `STREAMING_COMPLETED`, `tool.call_malformed`, … | Phase 2: kernel emits `assistant.turn_start/end` per Coder round, already emits `assistant.prompt_snapshot`, emits `tool.call_malformed` for dropped candidates + reasoning-channel calls, and keeps inline `ROUND_STARTED`/`ACCUMULATED_UPDATED` bridge. `STREAMING_COMPLETED` remains Orchestrator-loop engine telemetry; inline uses the existing mirrored accumulation + kernel completion path instead. | Closed / documented in Phase 2 |
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

**Phase 1 — conversation context parity (LANDED).**
- Conversational inline turns (`taskInFlight === false`) seed the kernel with
  the **raw visible transcript** (`buildInlineConversationSeed` in
  `app/src/lib/inline-conversation-context.ts` → `initialMessages`) and thread
  the session-digest inputs (scope-filtered memory records, prior digest, emit
  callback) through to the provider stream. The stream's `toLLMMessages` then
  runs the **single** context transform — visibility, budget-aware compaction,
  `[USER_GOAL]`, `[SESSION DIGEST]`, safety net — over that seed each round,
  exactly as it already does for the Orchestrator loop. The inline lane does
  NOT pre-transform: doing so (the initial implementation) double-processed the
  transcript, because the stream re-transforms `req.messages` every round and
  the pre-transform's synthetic/`isToolResult` flags were stripped by the
  `LlmMessage` projection — a non-idempotent second pass (Codex review on PR
  #959). Task turns stay on the bounded preamble path.
- Linked libraries are resolved in the inline lane every turn. Text lands in
  the kernel system prompt's `library_context`; linked images are spliced into
  the latest user turn / current-turn multipart parts without persisting them
  into chat history.

**Phase 2 — policy + tool + telemetry parity (LANDED).**
- Ported the missing trailing-action-intent guard into `coder-policy.ts`,
  reusing the Orchestrator detector and the shared capped nudge counter. It is
  intentionally not gated on `taskInFlight`: a conversational answer that ends
  with "I'll read X" and no tool call is the same dead-end as a task turn.
- Verified the reasoning-channel buried-tool gap was only partially covered:
  the shared recovery state had counters, but the Coder kernel did not retain
  reasoning text. `iteratePushStreamText` now returns `reasoningText`, and
  `lib/coder-agent.ts` emits `tool.call_malformed` + injects the
  `[POLICY: TOOL_CALL_IN_REASONING]` correction without ever executing the
  untrusted reasoning-channel call.
- Wired scratchpad/todo for the inline lead because the existing chat-hook
  executors and registry sources made it cheap and coherent. The builder now
  injects current `[SCRATCHPAD]` / `[TODO]` context blocks, advertises the
  protocols, includes the sources in native schemas when supported, and routes
  calls against the chat-state refs instead of the generic Web runtime (which
  still correctly refuses chat-hook tools).
- Reconciled telemetry: the kernel now emits `assistant.turn_start/end` per
  round and `tool.call_malformed` for dropped candidates and reasoning-channel
  tool calls. `assistant.prompt_snapshot` was already emitted by the kernel.
  `STREAMING_COMPLETED` remains specific to the Orchestrator stream loop; the
  inline lane keeps its existing token mirror (`ACCUMULATED_UPDATED`) and
  kernel completion/finalization events rather than inventing a duplicate.

**Phase 3 — flip routing, behind a flag (LANDED).**
- `inlineEligible = repoBranchReady` by default, so repo-backed conversational
  turns route to the foreground inline lead. The old `conversational_downgrade`
  event is replaced by `turn.route` telemetry on the new path:
  `route: "inline-delegation", reason: "conversational_inline"`.
- Bake-period rollback is a storage escape hatch, default off:
  `localStorage["push:conversational-inline-escape-hatch"] = "1"` forces
  repo-backed conversational turns back to the foreground Orchestrator loop and
  emits `reason: "conversational_escape_hatch"` with
  `suppressedRoute: "inline-delegation"`.
- The Orchestrator loop's live triggers are now no-repo workspaces, the
  `delegated` opt-out, and the temporary conversational escape hatch (see the
  LOAD-BEARING markers in `delegation-mode-settings.ts` / `orchestrator.ts`).

## Follow-up
- No-repo workspaces (chat/scratch/local-pc) still need the Orchestrator loop —
  is a sandboxless kernel run the eventual home, or do they keep a lightweight
  conversational path? (Out of scope here; tracked as the remaining Orchestrator
  trigger.)
- Bake / A-B criteria: use the `turn.route` events above to compare
  conversational inline-vs-Orchestrator escape-hatch turns before retiring the
  flag.
