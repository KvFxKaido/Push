# Durable Runs — Adopt-on-Silence

**Status:** Current — Phases 0–3 COMPLETE. Phase 0: latency spike #870, eval harness #871 (numbers in [Phase 0 results](#phase-0-results-2026-06-10) — latency does not block Phase 2). Phase 1: schema #873, capture #874. Phase 2: the delegation-collapse precondition (the inline route + flag in `delegation-mode-settings.ts`; A/B measured 2026-06-11 — direct ≥ delegated on every axis, see [Delegation-collapse A/B](#delegation-collapse-ab-measured-2026-06-11)), the **adoption substrate** (heartbeat ledger, checkpoint persistence, watched→adoptable decision — see [Phase 2 substrate](#phase-2-substrate-shipped-2026-06-10)), the **client transport** (register/mirror/heartbeat/release + pull-back-local — see [Phase 2 client transport](#phase-2-client-transport-shipped-2026-06-10)), and the **server-side loop** that consumes `adoptable` (see [Phase 2 server-side loop](#phase-2-server-side-loop-shipped-2026-06-10)). Phase 3: the **attach/viewer** — bearer-authenticated reattach, snapshot hydration, approve/deny pending gates, stop, pull-back-local (see [Phase 3 attach/viewer](#phase-3-attachviewer-shipped-2026-06-11)).

**Date:** 2026-06-10

## Problem

The web orchestrator round loop is browser-resident: the model stream, tool
dispatch, and turn sequencing all run in the page (`app/src/hooks/chat-*`).
Mobile browsers evict background tabs aggressively, so the product's core
promise — dispatch real coding work from a phone — carries an asterisk: *as
long as the screen stays on*. The sandbox half of a run became durable in the
Background Exec track (#861–#867: detached processes survive disconnects,
cursor logs are resumable by construction), which makes the asymmetry sharp:
a ten-minute test run now outlives the phone, but the agent turn awaiting it
dies with the tab.

Adjacent tracks treat symptoms rather than the home: Session Continuity moves
session *state* between surfaces; Pre-Order PRs (Draft) builds a detached
special case; Resumable Sessions recovers from interruption after the fact.
None of them changes where the loop lives.

## Decision

**Local while watched, adopted when away.** The loop is NOT moved wholesale —
today's in-page responsiveness is preserved exactly when a client is attached.
Instead the run learns to survive abandonment:

> **2026-06-11:** the default main-chat turn now honors this decision
> end-to-end. The interim inline default (#887) detached every turn to the
> CoderJob DO from round 0, watched or not;
> [`Inline Foreground Lane — Local While Watched.md`](../archive/decisions/Inline%20Foreground%20Lane%20—%20Local%20While%20Watched.md)
> (Current) moved inline turns back into the browser as foreground coder-
> kernel runs — registered with RunHost, checkpointing per round from
> kernel state (`onCheckpoint` → V1 capture, so adoption's
> `runCheckpointToCoderResumeState` resumes coder-born checkpoints) — and
> left the engine route to the explicit background-mode toggle.

1. The browser loop checkpoints each turn (extending the Resumable Sessions
   primitives) into a server-side **RunHost** Durable Object.
2. The client heartbeats while attached. When heartbeats lapse past a
   threshold mid-run, the RunHost **adopts** the run from its last checkpoint
   and continues the loop server-side, running the same `lib/` agent kernels.
3. Reopening any client **attaches** as a viewer/controller: bearer-
   authenticated, hydrated from snapshot + cursor over the existing run-event
   vocabulary. An attached client may pull the run back local.

The dual-home pattern is established, not invented: the coder kernel already
executes both in-page (delegated) and inside the CoderJob DO (background),
from one host-agnostic kernel. The orchestrator is the last browser-only
kernel; this track ends that.

**Latency stance.** The agent loop's critical path is dominated by inference
and tool time, and today the phone's radio sits inside it (every tool result
hops sandbox → edge → phone → edge → provider). Adoption removes the phone
from the middle; server-side rounds are plausibly faster, not slower. This is
asserted, not proven — Phase 0 measures it before anything is built on it.

**Relationship to Single-Agent Loop (prior first priority).** Step 1 of that
track — collapse Coder delegation behind a flag, lead edits inline — folds in
as the precondition of Phase 2 here: the loop should be simplified *as* it is
made host-agnostic, not durable-ized with the Planner/brief scaffolding intact
and then re-cut. Its measurement gate ("≥ the delegated path") is supplied by
the Phase 0 eval harness. Steps 2–4 (auto-branch-on-commit, Auditor unbundle
remainder, storage substrate) are untouched and remain sequenced behind it.

## Phases

### Phase 0 — Instruments (gate for everything else)

- **Latency spike:** relay one provider's stream through a DO and measure
  time-to-first-token + per-turn overhead against the direct path, from a
  phone on cellular. If WS-from-DO numbers are ugly, the hybrid leans harder
  local and Phase 2's continuation UX is re-scoped. Throwaway code; numbers
  recorded in this doc.
- **Agent eval harness:** ~10–20 repeatable agent tasks against the live
  stack with scored outcomes (task completion, turn count, wall-clock,
  tool-error rate). Required by this track's Phase 2 comparison AND the
  delegation-collapse A/B, which at design time was gated on measurement that
  did not exist (since taken — see
  [Delegation-collapse A/B](#delegation-collapse-ab-measured-2026-06-11)).
  Lives as its own small runner; not CI-gating initially.

#### Phase 0 results (2026-06-10)

Both instruments shipped: latency spike (#870, `RunHost` DO +
`/api/runhost/spike/page`) and eval harness (#871,
`scripts/eval/run-evals.ts`, 12-task manifest, smoke-validated on
zen/deepseek-v4-flash).

**Latency spike.** Android Chrome 149, cellular (good LTE), prod Worker,
provider `zen`, 6 interleaved trials per arm. Raw JSON in
`docs/measurements/durable-runs-phase0/`. Two runs: `glm-5.1` (TTFT not
captured — the reasoning variant spent the 256-token budget on
`reasoning_content`, which the spike's scanners don't count) and
`deepseek-v4-flash` (full data). Medians, ms:

| metric | direct (today) | relay-SSE via DO | relay-WS via DO | server-turn (DO only) |
|---|---|---|---|---|
| first token at consumer | 3545 | 3870 | 3592 | 3958 (at the DO) |
| total turn | 3897 | 4577 | 3973 | 4691 |

Decomposed fixed costs (consistent across both runs):

- **phone↔edge, per HTTP request:** ~180–190 ms (server-turn
  `clientRoundTrip − serverTotal`, paired within trial)
- **WS delivery DO→phone, first token:** ~140 ms; **WS connect:**
  ~250–330 ms one-time
- **DO→provider response headers:** ~225 ms on glm-5.1;
  deepseek-v4-flash holds headers until near first token (1.5–2.8 s),
  so header-time is model-specific

Reads:

1. **Provider variance dominates transport** — upstream first-chunk time
   ranged 0.9–3.4 s across trials of one model; cross-arm differences in
   medians at n=6 are within that noise. No arm is pathological.
2. **WS-from-DO is NOT ugly** — the re-scope contingency in Phase 0's
   design does not trigger. ~140 ms added first-token latency over a
   connected socket, ~330 ms to connect once.
3. **Latency stance supported in the weak form:** server-side turns are
   not slower, and each tool round trip an adopted run avoids costs the
   attached path ~2 phone hops (~190 ms each on good LTE). The benefit
   scales with tool-call count and with radio quality degradation; on
   good cellular it is modest, not dramatic.
4. The attached path keeps today's behavior by construction, so none of
   this is a regression risk — it bounds the cost of the *adopted* and
   *viewer* paths.

**Verdict: Phase 2 is not blocked on latency. Phase 1 may proceed.**
Caveats for re-measurement: n=6, one provider, good-LTE cellular;
worth re-running on bad radio before tuning the heartbeat/adoption
threshold, and the spike page needs a `reasoning_content`-aware scanner
for reasoning models.

### Phase 1 — Checkpoint fidelity

Per-turn run checkpoints sufficient to resume mid-run without context loss:
messages, tool state, locked provider/model, verification state, working
memory, user-goal anchor. Define the `RunCheckpoint` schema in `lib/` with a
strict-mode drift pin (same discipline as `protocol-schema.ts`). Resumable
Sessions checkpoints are the starting point; the gap analysis (what they drop
that adoption needs) is the first task.

#### Phase 1 gap analysis (2026-06-10)

The Resumable Sessions checkpoint (`app/src/types` `RunCheckpoint`,
captured in `useChatCheckpoint.ts`, stored in IndexedDB) is a
**client-anchored delta**: it indexes into the browser's IndexedDB
conversation (`baseMessageCount` + ≤50KB `deltaMessages`) and its resume
path re-derives everything else from live browser state. Each
client-local dependency is an adoption gap:

| adoption needs | today | gap class |
|---|---|---|
| full LLM-visible transcript | `baseMessageCount` index into IndexedDB + trimmed delta | self-containment |
| working memory | `lastCoderState` JSON string, used display-only in the reconciliation message | fidelity |
| user-goal anchor | not captured | fidelity |
| approval mode + pending-gate state | read from settings / daemon queues at dispatch time | adopted-mode semantics |
| verification policy | not captured (CoderJobStartInput carries it for background jobs) | fidelity |
| provider lock incl. transport opts | provider+model only; `zenGo` lives in localStorage | fidelity |
| reasoning blocks (Anthropic signed round-trip) | live inside IndexedDB conversation messages | self-containment |
| run-event seq anchor | not captured | Phase 3 attach |
| sandbox owner token / provider keys / GitHub token | live refs — correctly NOT in the checkpoint | **out-of-band by design**: provisioned at adoption time (the `CoderJobStartInput` precedent); the schema *enforces* this with a credential-field blocklist |
| mid-flight task-graph state | lost on interrupt | accepted v1 loss — resume restarts the triggering tool call |
| scratchpad/todo chat-hook state | browser localStorage | already a Phase 2 design point (§Phase 2) |

**Shipped:** `lib/run-checkpoint.ts` defines `RunCheckpointV1`
(self-contained transcript + loop state; credentials structurally
rejected; permissive on benign extras) with hand-rolled validators and
the exact field vocabulary pinned by
`cli/tests/run-checkpoint-drift.test.mjs`.

**Shipped (capture-side wiring):** the web loop now writes a V1
checkpoint per turn. `app/src/lib/run-checkpoint-capture.ts` builds the
record from live loop state (wire-faithful transcript incl. attachments
→ contentParts and reasoning blocks; `userGoal` from the latest real
user message; approval mode / verification policy / zen-Go flag read at
capture time) and persists to the `run_checkpoints_v1` IndexedDB store
next to the legacy delta checkpoint. Capture points: pre-tools
(`TOOLS_STARTED`), post-tools turn boundary, and steer drains — all
`reason: 'turn'`; `visibilitychange` flushes as `'interrupt'`, expiry as
`'expiry'`. Lifecycle is shared with the legacy checkpoint (every clear
path clears both). Every write logs `run_checkpoint_captured` with
`estimateRunCheckpointBytes` (symmetric: `run_checkpoint_invalid`,
`run_checkpoint_write_failed`, `run_checkpoint_skipped` for
no-repo-scope chats). The DO-key cap (128 KiB per storage value) is now
**enforced at the host consumer**: the Phase 2 `RunHost` checkpoint
endpoint rejects an oversize checkpoint loudly (`413
CHECKPOINT_TOO_LARGE` + `run_host_checkpoint_rejected_oversize`) rather
than letting `storage.put` fail opaquely or truncate, and logs the
observed byte size on every accepted write
(`run_host_checkpoint_persisted` with `bytes`). The tiering decision
(chunking vs R2 spill) is still open, but it is now answerable from real
persisted-byte logs instead of estimates — and an oversize run fails
visibly in the meantime rather than silently losing fidelity.

### Phase 2 — RunHost DO + adoption

- Delegation collapse lands first (behind a flag, measured via Phase 0 evals —
  done; results below).
- `RunHost` DO owns: heartbeat ledger, adoption decision (silence threshold,
  only adopts a run that is mid-flight), the server-side loop over the same
  kernels, checkpoint persistence, orphan/alarm hygiene per the CoderJob and
  PrReviewJob patterns (one alarm, bounded sweeps, persistent backstop —
  lessons from #866 apply verbatim).
- Mode semantics while adopted: full-auto continues uninterrupted (AFK is
  its meaning); supervised runs PAUSE at approval gates and surface a
  notification hook (push notification integration is an open extension, not
  required for v1 — a paused run that survives is already the win).
- Chat-hook tools (scratchpad/todo) execute in-page today; while adopted they
  execute against the server-side store or are deferred with a model-readable
  note. Decide during Phase 2 design; do not silently drop them.

#### Phase 2 substrate (shipped 2026-06-10)

The heartbeat ledger + checkpoint persistence + adoption *decision* landed
ahead of the server-side loop, so the loop is built on a tested substrate
rather than alongside it:

- **`lib/run-host-adoption.ts`** — the canonical run-lifecycle vocabulary and
  the pure adoption kernel, drift-pinned by
  `cli/tests/run-host-adoption.test.mjs` (lifecycle states, record fields,
  constants — same discipline as `run-checkpoint.ts`). Lifecycle:
  `watched → adoptable → adopted → released/ended`. `decideAdoption(record,
  now)` is pure (the DO supplies the clock and applies the result); it only
  adopts a `watched`, mid-flight run that has a checkpoint and whose
  heartbeats have lapsed past `RUN_HOST_SILENCE_THRESHOLD_MS` (45 s, ≥3× the
  15 s client cadence so one dropped beat never trips adoption). The
  scope→instance map `runHostInstanceId(repoFullName+branch+chatId)` is the
  durable handle a reopening client reconstructs to attach (Phase 3), no
  server-minted id needed.
- **`app/src/worker/run-host-do.ts`** — the DO is now a thin storage/alarm
  wrapper around that kernel. Endpoints (`/api/runhost/run/*`, behind the
  universal session gate, instance derived server-side from scope):
  `register` (open/refresh → `watched`, arm the silence alarm), `checkpoint`
  (validate incl. the credential blocklist, enforce the 128 KiB cap, persist,
  re-arm), `heartbeat` (keepalive), `release` (pull-back-local / teardown),
  `status`. One singleton alarm (CoderJob discipline) is the silence
  detector; on lapse it transitions the run to `adoptable` and logs — and
  **parks there**, because the server-side loop that consumes `adoptable` is
  the next piece. Every alarm branch logs symmetrically (`run_host_run_adoptable`
  ↔ `run_host_alarm_rearmed` ↔ `run_host_alarm_idle`).
- ~~**Deferred to the loop PR:**~~ all four deferred items shipped in the
  loop PR below: running the kernels server-side from `adoptable`, the
  supervised-pause / full-auto-continue mode semantics, orphan-sweep
  cross-eviction recovery, and the chat-hook/follow-up question.

#### Phase 2 client transport (shipped 2026-06-10)

The web shell now feeds the substrate — real runs populate the ledger, so
the `run_host_checkpoint_persisted` byte logs the tiering decision is
waiting on come from production traffic, and the loop PR lands against a
host that actually has adoptable runs:

- **`app/src/lib/run-host-transport.ts`** — the owning coordinator
  (new-feature checklist #2: named home, not `useChat.ts`). Lazy
  registration: the first published checkpoint registers the run — `runId`,
  scope, approval mode, and round all ride on the checkpoint itself, so
  there is no parallel bookkeeping to drift. Then per-turn checkpoint PUTs,
  a heartbeat keepalive at the server-announced cadence
  (`heartbeatIntervalMs` from register, falling back to
  `RUN_HOST_HEARTBEAT_INTERVAL_MS`), and release on every terminal path
  (from `finalizeRunSession`, so completed/aborted/threw all tear down).
  Fire-and-forget discipline throughout: the transport never throws into
  the round loop, and every branch logs symmetrically
  (`run_host_client_registered` ↔ `_register_failed`,
  `_checkpoint_sent` ↔ `_checkpoint_failed` ↔ `_checkpoint_oversize`, …).
- **Pull-back-local** — a heartbeat answered with `state: 'adoptable'`
  re-registers the run (the host's documented reclaim contract). Browser
  timer throttling in hidden tabs is deliberate behavior, not a defect: a
  backgrounded phone stops beating and the run becomes adoptable; a tab
  that comes back reclaims it.
- **`runId` now rides on captured checkpoints** —
  `run-checkpoint-capture.ts` carries the engine's run id (only while a run
  is active), which the hosted checkpoint endpoint requires; expiry saves
  after a run ended stay local-only so the host never watches a run that
  isn't running.
- **NOT_CONFIGURED latch** — a 503 register (no `RUN_HOST` binding)
  disables the transport for the session after one log line; deployments
  without the DO see zero retry noise.

#### Phase 2 server-side loop (shipped 2026-06-10)

The host now consumes `adoptable`: on heartbeat lapse the run is adopted and
continued server-side from its stored `RunCheckpointV1`.

**Architecture.** An adopted run continues on the **coder kernel**
(`lib/coder-agent.ts`) — the one `lib/` role kernel already proven
dual-homed (in-page delegated + CoderJob DO). That is the delegation-collapse
payoff: the simplified orchestrator loop and the inline coder loop converge,
so adoption seeds the kernel from the checkpoint transcript
(`lib/run-adoption-loop.ts` maps checkpoint → `resumeState`, appending a
model-readable `[RUN_ADOPTED]` context note) instead of growing a second
orchestrator home. The DO-side assembly
(`app/src/worker/run-host-adoption-runner.ts`) reuses the CoderJob adapter
stack verbatim — stream/executor/detector adapters call Worker handlers as
functions with `env`. Pure decisions (watchdog, relaunch cap, wall clock)
live in `lib/run-host-adoption.ts` (`decideAdoptedAlarm`), drift-pinned next
to `decideAdoption`.

**Credentials are provisioned out-of-band at adoption time** (the
CoderJobStartInput precedent): the checkpoint carries the sandbox *identity*
(`sandboxSessionId`); the host re-derives the owner token from the
SANDBOX_TOKENS KV (`readOwnerToken`, server-internal). Provider keys live in
Worker env; the deployment origin is stamped server-derived by the route
layer and persisted on the record. A blocked provisioning (token expired,
unsupported provider, pre-loop record without an origin) parks the run
`adoptable` LOUDLY (`run_host_adoption_blocked` + alarm cleared) — the
client pull-back contract still applies.

**Mode semantics.** Full-auto/autonomous runs continue uninterrupted (AFK is
their meaning). Supervised runs evaluate `lib/approval-gates` before every
sandbox/web-search call; an `ask_user` decision (destructive exec,
direct-git override, remote side effect — or a literal `ask_user` call)
PAUSES the run: the gate's `[RUN_PAUSED_FOR_APPROVAL]` note lands in the
transcript, the per-round checkpoint persists it, `pausedForApproval` rides
on the record, the watchdog stands down, and the run waits for a returning
client to reclaim it. Delivery rules hold by construction: the background
executor doesn't wire the audited commit tools (`sandbox_prepare_commit` /
`sandbox_push` return structured blocks) and direct `git commit/push/merge`
is guard-blocked, so an adopted run can explore/edit/test but cannot land
unaudited history — the Auditor gate is never bypassed because commits wait
for an attended surface.

**Reclaim handoff (chosen semantics): register always wins.** A returning
client's re-register aborts the server loop (AbortController + an
`adoptionId` ownership check on every per-round checkpoint — the loop stops
without writing once ownership is lost) before the record returns to
`watched`; the register response carries `reclaimedFromAdopted` +
`hostRound` so the divergence is visible. Checkpoint PUTs are accepted only
from the attached owner of a `watched` run — any detached state
(`adoptable`/`adopted`) gets `409 RUN_NOT_WATCHED`, which makes the
transport drop its registration
and re-register on the next publish — the same reclaim path heartbeats take
(a beat answered `adopted`, like `adoptable`, triggers re-register). This
also closes the torn-read race where a late client checkpoint landing while
the adoption launcher was mid-provisioning would be accepted and then
overwritten by the loop's first persisted round. The
double-execution window is bounded: at most one already-in-flight tool call
can overlap a reclaim, the same bounded race the CoderJob orphan path
documents. The client's local transcript may lag the host's checkpoint until
Phase 3 attach hydration; the host copy remains the adoption source if
heartbeats lapse again.

**Orphan recovery.** While adopted, a durable watchdog alarm
(`RUN_HOST_ADOPTED_WATCHDOG_MS`) is re-armed on every per-round checkpoint.
After a DO eviction the alarm survives in storage, fires, finds no live loop
in memory, and relaunches from the last persisted checkpoint — bounded by a
persisted `adoptionRelaunches` cap (`RUN_HOST_MAX_ADOPTION_RELAUNCHES`,
increment-before-launch) and a wall-clock budget
(`RUN_HOST_ADOPTED_WALL_CLOCK_MS`), after which the run is expired loudly.
Loop failures park `adoptable` with a bounded retry alarm under the same
cap. Server-side progress is checkpointed every round (`checkpointCadenceRounds: 1`
— there is no client mirror, so the durable copy is the only copy) in the
same `RunCheckpointV1` schema both homes write.

**Resolved: chat-hook tools and queued user follow-ups.** Chat-hook /
orchestrator-only tool families (`scratchpad`, `todo`, `delegate`,
`ask-user`, `artifacts`, `github` — pinned in
`cli/tests/run-adoption-loop.test.mjs`) are **deferred with a model-readable
note** recorded in the transcript, never silently dropped (the in-page
stores don't exist server-side; the CoderJob memory-tools precedent). Queued
user follow-ups need no server-side queue in v1: there is no channel into an
adopted run until Phase 3 attach, and a user typing a follow-up implies a
returned client — whose re-register reclaims the run and drains its queue
locally, exactly today's behavior.

**Known v1 limits** (accepted, revisit with Phase 3): a sandbox that died
while the run was unattended is not re-provisioned (no workspace-snapshot
infra on this path — adoption retries are bounded and then park
`adoptable`); multimodal `contentParts` degrade to their text fallback on
the server-side wire (the checkpoint preserves them for the client); the
final assistant summary lives in the terminal checkpoint awaiting Phase 3
hydration.

#### Delegation-collapse A/B (measured 2026-06-11)

The measurement the collapse was gated on. Full 12-task suite
(`scripts/eval/run-evals.ts`), `zen/glm-5.1`, 1 trial/task, arms run
sequentially on the same machine. Raw results in
`docs/measurements/delegation-collapse-ab/`.

**v1 run (defective instruments — superseded by v2 below):**

| metric | direct (inline proxy) | delegated (task-graph) |
|---|---|---|
| harness completion | 10/12 | 10/12 |
| **acceptance-pass** (work actually correct) | **12/12** | **10/12** |
| median rounds | 5 | 5 |
| median wall-clock | 41.5 s | 63 s (+52%) |
| tool-error rate | 25% (19/76) | 30% (26/88) |
| malformed tool calls | 3 | 3 |

**v1 verdict: direct ≥ delegated on every axis.** The headline completion
tie hides a qualitative split in failure classes:

- Direct's two "failures" were **loop-detector aborts after acceptance had
  already passed** — the model finished the edit, then repeated an identical
  tool call 3× instead of emitting its final answer. Work done, exit messy.
- Delegated's two failures were **failures of the work**: one
  `delegation_failed` at rounds 0 (the handoff itself died — same loop quirk
  firing *before* any work, plus 2 malformed calls in the handoff), and one
  **false-positive success** (`guard-error-handling`: exit 0, outcome
  success, acceptance failed). The direct arm passed that task in 3 rounds /
  27 s.

The per-task miniature: `extract-helper` — 47 s direct vs 2 m 51 s delegated
with a 50% tool-error rate (12/24). The wrapper added churn, not quality.

**Instrument defects (diagnosed same day, fixed in PR #886).** Tracing the
direct arm's two aborts dissolved the apparent glm-5.1 stop-behavior quirk
into two defects in the measurement stack itself — in every abort the model
had finished the work and was trying to *verify* it:

1. **The harness ran agents that couldn't execute anything.** `push run`
   headless blocks `exec` without `--allow-exec`, so every verification
   attempt errored (`EXEC_DISABLED`) — 15 of direct's 19 and 17 of
   delegated's 26 "tool errors" were these blocks and their skipped
   batch-mates (real error rate ~5–6%, not 25–30%) — and the models were
   pushed into re-reading files as their only verification affordance.
2. **The CLI exact-repeat breaker counted cumulatively across the whole
   run** (`cli/engine.ts`) — never reset by intervening calls, no warn rung.
   Three productive reads of one small file across six turns = abort. The
   web tracker and coder kernel never had this defect; the CLI was the
   outlier. Fixed by converging on the web's consecutive-identical
   semantics, with drift pins against regrowth.

**v2 run (fixed instruments, same stack and protocol):**

| metric | direct (inline proxy) | delegated (task-graph) |
|---|---|---|
| completion | 11/12 | 11/12 |
| median rounds | 5 | 5 |
| median wall-clock | **33.3 s** | 59.3 s (+78%) |
| tool-error rate | 17% (12/71) | 18% (15/83) |

Zero loop aborts, zero `EXEC_DISABLED`, zero error events on the direct arm.
Each arm dropped one *different* task: direct failed `write-docs-section` at
the round cap (the fenced-JSON-containing-triple-backticks struggle — real
protocol friction); delegated failed `guard-error-handling` as
`delegation_failed` at rounds 0 — **2 m 26 s producing zero tool calls** —
the second dead handoff across runs, a failure class only the wrapper has.

**Verdict (v2, final): quality ties; the wrapper costs ~78% wall-clock and
owns a unique failure mode (the handoff itself dying).** The "inline ≥
delegated before deleting the Planner/brief" gate (Single-Agent Loop step 1)
is met. Default flip + Planner/brief deletion are unblocked as runtime work;
tracked on the ROADMAP, not here.

**Caveats:** n=1 per task; one model; the CLI `--delegate` task-graph path is
a proxy for the web delegated arc, not the arc itself.

**Model-facing findings the fixed eval now surfaces (follow-on candidates):**
the fenced-JSON tool protocol fights file content containing triple backticks
(glm worked around it with `\u0060` escapes once, burned 14 rounds
on it the next time); and `edit_file` "Invalid ref" errors cluster (~6/arm)
where the model passes prose or line numbers instead of hashline refs.

### Phase 3 — Attach/viewer

Reopen → bearer-authenticated attach → snapshot hydration (reuse
`get_session_snapshot` work) + cursor-follow over run events. Controls:
stop, approve/deny pending gates, pull-back-local. The TUI/pushd surface is
unaffected (pushd is already CLI's durable home); a later phase may let the
web client attach to either home through one vocabulary — that is the point
where this track and Session Continuity merge.

#### Phase 3 attach/viewer (shipped 2026-06-11)

**Bearer stance.** `/api/runhost/run/*` sits behind the universal
GitHub-identity session gate, which IS the bearer for the same-origin web
surface — no tokenless class, no separate mint (the pushd attach-token
universe stays the CLI's own). The DO instance is reconstructed server-side
from the durable scope, exactly as the Phase 2 substrate planned.

**Snapshot + cursor-follow.** `GET /run/attach` is the RunHost analogue of
pushd's `get_session_snapshot` packet: lifecycle summary + the stored
`RunCheckpointV1` when it's fresher than the caller's `sinceSavedAt` cursor
(`buildAttachSnapshot` in `lib/run-host-adoption.ts`, field-pinned next to
the record vocabulary). The checkpoint IS the snapshot — and since the
adopted loop persists every round, `savedAt` is the natural cursor grain, so
cursor-follow is a read-only 10 s poll (`RUN_HOST_ATTACH_POLL_INTERVAL_MS`)
that ships only the rounds the viewer hasn't seen. Attach never bumps the
heartbeat clock: watching can't resurrect a run (control stays explicit —
register/approval/stop/release). Event-grain streaming (the `lastEventSeq`
anchor, WS delivery per the Phase 0 spike) remains the open refinement; the
adopted loop does not emit run events yet.

**Hydration.** `useRunHostAttach` (mounted from `useChatCheckpoint`, the
resume-lifecycle owner) folds the host transcript into the conversation via
`planTranscriptHydration`: the anchor is the client's own last mirrored V1
checkpoint, everything past it is the server-side gap, appended as
ChatMessages (wire-replayable — the next send seeds from the conversation).
Multimodal `contentParts` are rebuilt as attachments on hydration (the exact
inverse of the capture-side encoding), so images and attached files survive
pull-back instead of degrading to the text fallback; unrecognized parts fold
into `content` verbatim rather than dropping. After each hydration the host
copy is saved as the new local anchor, making re-attach idempotent.
No-anchor and compaction cases degrade to a whole-transcript replace,
logged. Runtime scaffolding notes keep their verbatim `content` for the
model but render a one-line `displayContent`.

**Controls.**
- *Approve/deny* (`POST /run/approval`): only a paused `adopted` run with a
  matching `approvalId` accepts a decision (409 otherwise — a stale approval
  can never fire an action the model isn't waiting on). The decision rides
  the record as `resolvedApproval`, consumed by exactly one relaunch: the
  seed gains a model-readable `[APPROVAL_RESOLVED]` note and the tool gate
  gets a one-shot execution grant (approve) or a sticky model-readable
  denial (deny). The grant is bound to **tool + argument fingerprint**
  (`fingerprintApprovalArgs`, canonical-JSON FNV-1a captured at pause time)
  — the user approves a specific action, not a tool family, so a same-tool
  call with different arguments after the resolution note re-pauses instead
  of riding the grant. A crash-relaunch re-pauses rather than re-using a
  grant the user gave a different attempt. `pausedForApproval` now carries
  `tool` + `argsFingerprint` explicitly (pre-fingerprint records degrade to
  tool-level matching, and tool falls back to parsing the deterministic
  approvalId).
- *Stop* (`POST /run/stop`): aborts the loop, marks `ended`, clears the
  alarm — and KEEPS the checkpoint so the final transcript stays hydratable;
  release remains the storage cleanup.
- *Pull-back-local*: final hydration → `release` → a `[RUN_RECLAIMED]` user
  turn continues the run in-page (mid-flight runs only); the legacy
  interrupted-run checkpoint is cleared so the stale ResumeBanner doesn't
  double-offer.

**UI.** One banner (`RunHostAttachBanner` in `ChatContainer`, suppressing
the legacy ResumeBanner while present) renders the four viewer states:
paused-for-approval (Approve/Deny/Continue here), running server-side
(Stop/Continue here), parked (`adoptable` + `lastError`), and finished
(transcript synced; dismiss releases). A user send while viewing follows the
Phase 2 contract unchanged: the new run's register supersedes and aborts the
server loop.

**Known limits** (accepted): hydration needs an existing local conversation
(cross-device attach waits on chat sync); secondary clients are viewers by
construction (non-goal held); ask_user pauses resolve as proceed/stop
notes, not free-text replies — a reply is a pull-back + typed follow-up.

## Non-goals (v1)

- Moving the loop server-side unconditionally — attached-and-watching stays
  in-page, byte-for-byte today's behavior.
- Multi-client concurrent control (viewer-only for secondary clients is fine).
- CLI/pushd changes. Pre-Order PRs (separate Draft) — becomes a thin special
  case of RunHost later, not built here.
- Push notifications (hook point defined, integration deferred).

## Risks

- **Two-home drift** during transition — mitigated by the kernel/host split
  already proven on coder, plus eval-harness parity runs between homes.
- **Checkpoint size/cost** per turn — measure in Phase 1; tier if needed.
- **Adoption false-positives** (flaky heartbeat on bad cellular) — threshold
  generous, adoption idempotent, pull-back-local always available.
- **DO colo latency** — Phase 0's job; numbers before architecture.

## Protected throughout

Durable job engine, event-shape compat (`subagent.*`/`task_graph.*` drift
pins), capability gating, Protect Main, git checkout/switch blocks, bearer
auth on every attach (no tokenless class — Universal Session Bearer applies).

## Acceptance (track-level)

Start a multi-tool run on the phone, lock the phone mid-run, wait past the
adoption threshold, reopen: the run continued server-side from its checkpoint,
the transcript is complete across the gap, an approval-gated action in
supervised mode paused rather than proceeded, and a run watched end-to-end
with the tab open behaves exactly as today (no added latency in the attached
path beyond Phase 0's measured budget).
