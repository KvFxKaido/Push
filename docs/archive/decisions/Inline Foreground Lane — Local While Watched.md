# Inline Foreground Lane — Local While Watched

Date: 2026-06-11
Status: **Archived (shipped)** — shipped 2026-06-11 in two PRs: the kernel-run builder
extraction (`app/src/lib/inline-coder-run.ts`, PR 1) and the lane + routing
flip (`app/src/hooks/chat-send-inline.ts`, PR 2). Convergence point of the
Coder Delegation Collapse (archived audit) and Durable Runs — Adopt-on-Silence
(Current) tracks.
Owner: Push

> **Surface scope:** this lane is the web implementation of the single
> conversational lead, but the lead model is cross-surface — the TUI/daemon
> should converge on it with local reach. See
> [`Agent Runtime Decisions`](<Agent Runtime Decisions.md>) §10.

## Problem

The `inline` delegation-mode default (#887) collapsed the Orchestrator wrapper
by routing raw turns to the **CoderJob DO engine** — the seam chosen for step-1
expedience ("an inline turn currently inherits the detached/JobCard UX", per
the audit doc). Consequences now visible in daily use:

- **Every turn is a detached job.** "What changed recently in Push?" renders as
  a Background Coder card, not a streaming chat answer. The A/B that gated the
  flip measured the 12-task *coding* suite; conversational turns were never in
  the experiment, and for them the foreground loop wasn't ceremony — it was
  the product.
- **It contradicts Durable Runs' own requirement.** That doc's decision is
  *"local while watched, adopted when away… today's in-page responsiveness is
  preserved exactly when a client is attached"* — and responsiveness
  preservation is a stated user requirement. The inline default detaches every
  turn from round 0, watched or not.
- **It strands the adoption machinery.** RunHost registration/checkpointing is
  foreground-only; with most turns engine-routed, phases 1–3 of Durable Runs
  mostly serve the `delegated` opt-out.
- **Engine turns are capability-poorer.** Memory tools are deliberately not
  wired in the DO (empty in-isolate store); the browser run has them, scoped
  to repo/branch/chat.

The aligning fact: **adoption already lives in the collapsed world.** RunHost
continues *any* foreground run as a coder kernel
(`runCheckpointToCoderResumeState` → `runCoderAgent`), Orchestrator or not.
The adopted side is single-agent today; only the watched side still has the
wrapper-or-job dichotomy.

## Decision

Add a third lane and make it what `inline` means:

> **Inline = the coder kernel runs in the browser as the lead agent** — no
> Orchestrator handoff, no Planner, no brief — streaming into the normal chat
> transcript, registered with RunHost like every foreground run, so silence →
> adoption keeps it durable.

Routing becomes:

| Turn shape | Route |
|---|---|
| `inline` (default), repo+branch, no attachments | **Foreground inline lane** (this doc) |
| `background-mode` toggle on (explicit detach) | CoderJob DO engine + JobCard (unchanged) |
| Attachments, no-repo workspaces | Foreground Orchestrator loop (unchanged) |
| `delegated` opt-out | Foreground Orchestrator + delegate_coder arc (unchanged) |

The engine-capability gate (#889/#890) moves to **background-mode and adoption
only** — the inline lane is a foreground run, so browser-held Settings keys
work directly; server-side keys (env or user-stored, #890) matter exactly when
the run leaves the browser: explicit detach, or adoption after silence.

## Design

### Lane module

`app/src/hooks/chat-send-inline.ts` (sibling module per the `useChat.ts`
max-lines guard; coordinator home named before code, per the new-feature
checklist). Owns: run-session acquisition, kernel bindings, streaming bridge,
per-round checkpointing, Auditor invocation, session finalization.

`useChat.sendMessage` keeps the single `resolveSendEngineTrigger` seam;
`'inline-delegation'` now dispatches to `startInlineCoderTurn` instead of
`startBackgroundMainChatTurn`. `'background-mode'` keeps the engine route.

### Kernel wiring (reuse, not reinvention)

The delegated arc already runs `runCoderAgent` in-page
(`coder-delegation-handler.ts:656`) with browser bindings. Extract the
reusable wiring into a shared builder both callers use:

- `stream`: `getProviderPushStream(lockedProvider)` — **wrapped in a tee**
  (below).
- `toolExec` / detectors: `buildCoderToolExec` / `buildCoderDetectors` over
  web services — capability ledger (`ROLE_CAPABILITIES.coder`), git
  checkout/switch blocks, Protect Main: all come along unchanged.
- **Memory tools: wired** (`createMemoryToolExecutor` scoped
  repo/branch/chatId) — restoring what the engine route dropped.
- **Lead tool surface: wired** (`leadToolSurface`, 2026-06-12). The collapsed
  single lead is the Orchestrator, so it carries the Orchestrator's tool
  surface — GitHub PR/commit/CI + workflow tools, `ask_user`, and
  `create_artifact` — on top of the Coder's sandbox/web/memory tools. Without
  it the lane was sandbox-only: a conversational turn like "what changed
  recently?" could only read the sandbox's shallow git clone, where the old
  Orchestrator called `list_commits` / `list_prs` against GitHub. Wiring:
  `inline-coder-run.ts` threads `extraToolSources`
  (`{ github, ask-user, artifacts }`) + an `executeExtraToolCall` over
  `WebToolExecutionRuntime` into the bindings, advertises the matching
  protocols via `CoderAgentOptions.extraToolProtocols` (GitHub block is
  delegation-free — single agent), and folds the repo name into the workspace
  block so the GitHub executor's repo arg resolves. The Coder role grant
  already covers `pr:*` / `workflow:*` / `user:ask` / `artifacts:write`, so the
  kernel + runtime role gates pass. **Delegation stays out** — the inline lane
  is single-agent with no delegation arc wired; `delegate_*` is neither
  advertised nor accepted. The delegated Coder arc leaves `leadToolSurface`
  unset and keeps its narrow three-source surface (parity-pinned in
  `inline-coder-run.test.ts`).
  - *Caveat — `ask_user`:* it executes through the runtime (full-auto
    auto-resolves; supervised emits the question card), but the coder kernel
    has no human-pause primitive — its only interactive pause is
    `coder_checkpoint` (asks the Orchestrator, answered by
    `onCheckpointRequest`). So the lead's `ask_user` renders the card and
    returns a "question sent" result without blocking the loop for the human
    answer. Acceptable for v1 (the prompt steers toward reasonable
    assumptions over asking); a kernel-level human-pause is a follow-up on the
    mid-run-steering track.
- `taskPreamble`: the raw user turn + project instructions + branch context +
  approval-mode block + verification-policy block. **No Planner, no
  `buildCoderDelegationBrief`** — that ceremony stays on the delegated arc
  until category-2 deletion.
- Prior-turn context: the transcript is local — seed the kernel with recent
  chat history (see open question 1) instead of the DO's summary-preamble
  loader.

### Streaming bridge (no kernel changes)

The kernel exposes `onStatus`/`onCheckpoint`/`onWorkingMemoryUpdate` but no
token callback — it consumes its PushStream internally. The lane **tees the
stream**: a wrapper PushStream forwards every event to the kernel unchanged
while mirroring `text_delta`/reasoning events into the streaming assistant
placeholder (`prepareSendContext` with `skipStreamingPlaceholder: false` — the
placeholder machinery is already there). Tool rounds render through the
existing tool-activity cards; the kernel's final summary text completes the
assistant message. Role display stays phase-first (`lib/role-display.ts`): the
lead renders as "Assistant", phases as "Editing"/"Exploring".

### Durability (the point)

The lane runs inside the existing run-session machinery
(`acquireRunSession` → `finalizeRunSession`), so it inherits:

- per-turn `RunCheckpointV1` capture (`captureV1Checkpoint` from
  `runEngineStateRef`) → IndexedDB + RunHost mirror,
- lazy RunHost registration on first publish, heartbeats while attached,
  release on terminal paths,
- attach/viewer + pull-back-local (#878) and adoption on silence (#877).

Additionally the lane wires the kernel's own `onCheckpoint` (cadence-driven
`CoderCheckpointState`) into the V1 capture so an adopted continuation resumes
from kernel state rather than reconstructing it — adoption's
`runCheckpointToCoderResumeState` gets a checkpoint that was *born* as coder
state. Round numbers, working memory, and cards align by construction.

### Safety parity (audit category 4 — protected)

- **Auditor**: same gate as the delegated arc — `evaluateAfterCoder` per
  harness settings, `handleCoderAuditor` with pre-run HEAD snapshot,
  deterministic short-circuit, verdict folded into the turn outcome. The loop
  reads the verdict (UNSAFE → revise), same as everywhere.
- Approval gates run natively in the foreground (supervised pauses are just
  UI), and a paused-then-adopted run already round-trips via
  `pausedForApproval` (#878).
- Writer lock: an inline run is a normal foreground run — `acquireRunSession`
  tab-locking applies; `hasActiveBackgroundJob` continues to gate only
  engine jobs.

### Measurement

The lane emits `inline_turn_started` / `inline_turn_completed` (chatId, runId,
rounds, wall-clock, outcome) — comparable with `delegation_engine_job_started`
and `coder_delegation_measured`, so the three arcs stay A/B-able with the
existing eval harness.

## What this does NOT change

- The CoderJob DO engine, JobCard, `/api/jobs/*` — unchanged; still the
  explicit-detach path and the PR-review/Pre-Order substrate.
- The delegated arc — untouched until the audit's category-2 deletion gate.
- Event-shape compatibility, protocol pins, capability gating, Auditor,
  liveness machinery (audit categories 3–5).

## Open questions

1. **Prior-context seeding.** Recommendation: inject a bounded recent-history
   block into the preamble for v1 (mirrors the DO's `formatPriorTurnsPreamble`
   shape, but from the local transcript). Seeding the kernel's message array
   directly is richer but touches resume-state semantics — defer.
   *Shipped as recommended:* `buildInlineTurnPreamble` (last 6 non-tool
   turns, 700-char clip per turn).
2. **Mid-run steering.** `routeActiveRunInput` queues follow-ups for
   foreground runs today; v1 keeps queue-until-done. Injecting steering into a
   running kernel is its own track.
3. **`background-mode` + `inline` both on**: background wins (explicit detach
   is the more specific intent now — note this inverts the old precedence
   where inline-delegation won the *label*; re-pin in
   `delegation-mode-settings` tests). *Shipped:* precedence inverted in
   `resolveTurnEngineTrigger`, re-pinned, with engine-ineligible
   background turns falling back to the inline lane.
4. **Engine-inline measurement variant**: keep `startMainChatJob` reachable
   for the eval harness (it is, via background-mode) — no third preference
   value needed.

## Implementation plan (two PRs)

**PR 1 — extract the kernel-run builder (no behavior change).**
Pull the reusable in-page coder wiring out of `coder-delegation-handler.ts`
into `app/src/lib/inline-coder-run.ts` (bindings builder + stream tee +
auditor-invocation helper). Delegated arc consumes it; tests pin that the
delegated arc's options are unchanged (serializer-option-parity discipline).

**PR 2 — the lane + routing flip.**
`chat-send-inline.ts` (session acquisition, placeholder streaming, per-round
checkpoint wiring, auditor, finalize + measurement events); `useChat.sendMessage`
dispatches `inline-delegation` → lane; `resolveSendEngineTrigger` keeps the
provider-capability fold for `background-mode` only; docs truth-sync (this doc
→ Current, audit doc note, Durable Runs cross-reference) in the same PR.
Drift pins: routing tests for the new dispatch table, a checkpoint-shape test
that an inline run's V1 checkpoint round-trips through
`runCheckpointToCoderResumeState`.
