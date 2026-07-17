# Agent Runtime Decisions

Status: **Current**
Reviewed: 2026-06-30

This is the live decision surface for Push's agent runtime. Archived source
notes live in [`../archive/decisions/`](../archive/decisions/README.md).

## Operating Contracts

### 1. Shared runtime semantics, different shells

Push keeps agent-runtime semantics in shared `lib/` modules whenever web and
CLI both depend on the same vocabulary. Surfaces can differ in transport and
UX, but shared tools, capabilities, protocol envelopes, memory contracts, and
role vocabulary need one source of truth plus drift tests.

Source notes:
[`Web and CLI Runtime Contract`](<../archive/decisions/Web and CLI Runtime Contract.md>),
[`push-runtime-v2`](../archive/decisions/push-runtime-v2.md),
[`PushStream Gateway Migration`](<../archive/decisions/PushStream Gateway Migration.md>).

### 2. The Orchestrator is the capable lead

The default loop is read, edit, run, and ship in-loop. Delegation remains a
durable engine path, not the default mental model for ordinary work. The
current first-priority runtime track is to collapse the Orchestrator-to-Coder
wrapper while keeping the durable job engine, replay, checkpoints, safety
boundaries, and event compatibility.

Status:
- **Inline is the default (flipped 2026-06-11).** `delegation-mode-settings.ts`
  defaults to `inline`; an explicit `delegated` storage value opts back into
  the wrapper arc.
- **The Orchestrator role/loop is still load-bearing — do not prune it.**
  `resolveTurnEngineTrigger` (`delegation-mode-settings.ts`) returns `null`
  (→ foreground Orchestrator loop, prompt built at runtime by
  `buildOrchestratorBaseBuilder` in `app/src/lib/orchestrator.ts`) on two
  primary live triggers: (1) **no-repo workspaces** (chat / scratch / local-pc),
  which are never inline-eligible; (2) the **`delegated` opt-out**. Only the Orchestrator→Coder
  *wrapper/Planner* arc is slated for deletion below — the lead loop itself
  stays until those triggers are re-homed.
  (Correction: an earlier note here claimed attachment turns force the
  Orchestrator loop. They don't — attachments set `conversationalTurn=false`,
  so they route to the inline lane and are carried into the kernel as multipart
  content; see the dispatch table in `delegation-mode-settings.ts`.)
- **Measured (2026-06-11, two runs): quality ties, the wrapper costs ~78%
  wall-clock and owns a unique failure mode** — v2 on fixed instruments:
  completion 11/12 both arms, median wall 33.3 s direct vs 59.3 s delegated,
  tool-error 17% vs 18%; delegated's failure was the handoff itself dying
  (2 m 26 s, zero tool calls), the second dead handoff across runs. The v1
  run's apparent direct-arm failures were instrument defects (cumulative CLI
  loop breaker + harness without `--allow-exec`), fixed in PR #886. Full
  12-task eval suite on zen/glm-5.1; results in
  `docs/measurements/delegation-collapse-ab/`, analysis in
  [`Durable Runs — Adopt-on-Silence`](<Durable Runs — Adopt-on-Silence.md>)
  §Delegation-collapse A/B.
- Pending: delete the Planner/brief (the delegated arc's wrapper). Two
  prerequisites the deletion PR must clear: attachments on the engine
  envelope (or an explicit attachments story), and a bake period on the
  inline default to catch UX regressions the eval can't see (JobCard-first
  presentation, the one-active-job send lock).
- Protected: event compatibility, runtime safety boundary, progress/liveness.

Source notes:
[`Coder Delegation Collapse`](<../archive/decisions/Coder Delegation Collapse — Component Audit.md>),
[`Main as Scratchpad`](<../archive/decisions/Main as Scratchpad — Branch on Graduation.md>),
[`Role Display De-emphasis`](<../archive/decisions/Role Display De-emphasis.md>).

### 3. Runtime protocol is code-backed, not prompt-backed

Prompts describe cooperation; protocol correctness lives in code. The runtime
wire contract is `push.runtime.v1` with envelope validation in
`lib/protocol-schema.ts`, publishable JSON Schema generated from
`lib/protocol-json-schema.ts`, and drift tests for shared vocabularies.

The tool-call parser path is converged on the shared dispatcher. New tool/event
vocabularies need a canonical definition and a drift test in the same PR.

#### Headless machine interface (landed 2026-07-14)

`push run --jsonl` exposes the existing `push.runtime.v1` event envelopes as a
compact stdout JSONL stream. It does not define a parallel CLI event taxonomy:
assistant tokens, tool lifecycle, status, errors, acceptance results, and the
terminal `run_complete` use the same types and validators as pushd. Human and
diagnostic output stays on stderr. `--json` remains the aggregate final-result
mode and is mutually exclusive with `--jsonl`.

The adapter withholds the kernel's early `run_complete` until post-run
acceptance and output-schema checks finish, so exactly one `run_complete` is
the final line and its outcome represents the whole command. Envelope `seq`
keeps daemon semantics: it is the session journal cursor, so live-only events
may repeat the current value and consumers use line order for live delivery
rather than advancing replay state from every line.

`push run --output-schema <path>` adds the final-result contract paired with
that event stream. The CLI precompiles a Draft 2020-12 schema before the run,
prompts for exact JSON, and validates the final assistant text in code. An
invalid candidate gets at most two output-only repair requests through the
locked provider/model. Repair requests have no tools attached, so they cannot
repeat the primary turn's filesystem, GitHub, or command side effects. If no
candidate conforms, the command fails closed with
`OUTPUT_SCHEMA_VALIDATION_FAILED`; JSONL still ends with exactly one failed
`run_complete`. Native provider constraints remain an optional optimization —
post-generation validation is the provider-independent enforcement floor.

#### Turn quiescence (landed 2026-07-11)

`assistant.turn_end` is a **round** boundary, not proof that a foreground run
is quiet: cleanup can still release the tab lock, clear a resume checkpoint, or
schedule another queued follow-up. `turn.quiesced` is the terminal receipt
emitted only after that cleanup has finished and no follow-up will immediately
start. It carries `runId` plus `completed` / `aborted` / `failed`, persists with
the run-event journal, and is strict-validated in the shared wire schema.
Because the receipt fires after the terminal loop event has already finalized
the journal entry, the journal keeps a narrow post-finalization seam that
accepts ONLY `turn.quiesced` for the just-finalized run. A tab-lock denial also
quiesces (`failed`): the denied run emitted `RUN_STARTED`, so observers waiting
on its terminal receipt must still see one.

Tests that need a real terminal boundary use `waitForTurnQuiescence` from
`lib/turn-quiescence.ts`, subscribing to the event stream instead of polling
React state, timers, or Git. This is intentionally distinct from
`workspace.state_snapshot` / `workspace.state_delta`: quiescence guarantees
turn-owned work is done, not that a fresh ambient workspace-state read has
finished. A future `workspace.quiesced` receipt may compose both once a
cross-surface workspace-refresh barrier exists.

Source notes:
[`Tool-Call Parser Convergence Gap`](<../archive/decisions/Tool-Call Parser Convergence Gap.md>),
[`phase-5-tool-runtime-brief`](../archive/decisions/phase-5-tool-runtime-brief.md),
[`Phase 5 Handoff`](<../archive/decisions/Phase 5 Handoff - Task-Graph Extraction.md>).

### 4. Roles are runtime labels; display vocabulary is separate

Runtime roles stay precise: Orchestrator, Explorer, Coder, Reviewer, Auditor.
User-facing surfaces de-emphasize internal org-chart language through
`lib/role-display.ts`: Explorer/Coder render as workflow phases, Orchestrator
renders as Assistant in attribution, and Reviewer/Auditor keep names where
independent attribution is a trust signal.

### 5. Memory is typed, scoped, and selectively verbatim

Context memory is scoped by durable repo/branch/chat identity, not incidental
session IDs. Summary packing is the default. Lossless verbatim memory retrieval
has shipped through the deterministic expand/grep kernel, top-detail packing
override, and model-facing memory tools. **Phase 3 — the append-only verbatim
log that makes retrieval truly lossless (the typed store caps `detail` at
800/2000 chars before storage) — shipped 2026-06-21:** the cross-surface
`lib/verbatim-log.ts` kernel (content-addressed, collision-safe), the CLI file
backend (`cli/verbatim-log-file-store.ts`, append-only), write-path stamping of
`verbatimRef` when detail overflows (`persistRecord` in `lib/context-memory.ts`),
and read-path resolution through `memory_expand` (full original at a 12k render
cap). The reducer's raw-retention half also shipped (2026-06-21): a reduced
`sandbox_exec` result retains its full output (`lib/verbatim-retain.ts`) and the
model recalls it via `memory_expand` `refs` (scope-guarded). Only the **Worker
durable backend** remains deferred — it has no consumer until a Worker-side typed
store exists; tracked in **#1063**.

**Draft — session-summary records (2026-07-02).** The typed store captures
artifacts (decisions, findings, verification output) but nothing captures
session-level narrative — "a previous chat diagnosed and fixed X" — so a fresh
chat has no grounded way to reference prior efforts. (The motivating incident:
a stale repo-scoped [TODO] block leaked into a new chat and the model
confabulated first-person continuity; the leak is fixed by clearing the todo
list on chat mint, but the *legitimate* version of that continuity is this
draft.) Proposal: a `session_summary` record kind (extend `MEMORY_RECORD_KINDS`
in `lib/runtime-contract.ts` — already the single source of truth the
validators iterate), written **by the runtime, not by model choice** (behavior
lives in code, not prompts) at the effort-ship boundary — the Gate-at-Push
moment on web (`prepare_push` / `sandbox_push` success), the commit-gate
equivalent on CLI. Content is an LLM-written narrative of the effort (what was
diagnosed, what shipped, what's still open) via the existing
`lib/llm-compaction.ts` summarization engine; scope is repo-level (no `branch`
so it survives `expireBranchScopedMemory`; `chatId` recorded as provenance
only); retrieval rides the existing packing with its retrieved-memory framing,
so the model says "a previous session fixed this" instead of claiming lived
history. Persistence policy caps freshness to the last few summaries per repo
(`lib/memory-persistence-policy.ts` is the home for that call). Kernel goes in
`lib/` per the cross-surface checklist. Design-in-motion; implementation still
needs an owner commitment.

Source notes:
[`Context Memory and Retrieval Architecture`](<../archive/decisions/Context Memory and Retrieval Architecture.md>),
[`Lossless Verbatim Memory Retrieval`](<../archive/decisions/Lossless Verbatim Memory Retrieval (LCM).md>).

### 6. Prompt assembly is sectioned and inspectable

Prompt construction uses sectioned builders and prompt snapshots so debugging
can answer what reached the model without re-running composition. CLI and web
prompt-builder convergence has shipped for the core path.

Source notes:
[`Sectioned System Prompts`](<../archive/decisions/Sectioned System Prompts.md>),
[`CLI Prompt Builder Convergence`](<../archive/decisions/CLI Prompt Builder Convergence.md>).

### 7. Task graphs are goal-anchored, not decorative

`TaskGraphNode.addresses` ties graph nodes back to the user goal. Runtime
validation should reject missing goal anchors instead of relying on prompt
cooperation. Web shipped first; CLI parity is still a separate work item.

Source note:
[`Goal-Anchored Task Graph Layering`](<../archive/decisions/Goal-Anchored Task Graph Layering.md>).

### 8. Loop control is deterministic first, interactive only when useful

Push has exact-call and near-duplicate loop detection in shared code. The
similarity ladder is opt-in/dark by default and should graduate only with
telemetry. A future interactive escalation rung can ask the user before abort
on live surfaces; headless contexts should stay autonomous.

Source notes:
[`Loop Detection`](<../archive/decisions/Loop Detection — Near-Duplicate Layer.md>),
[`ZeroStack Cross-Reference`](<../archive/decisions/ZeroStack Cross-Reference — Interactive Loop Escalation.md>),
[`Kernel Progress Liveness`](<../archive/decisions/Kernel Progress Liveness.md>).

### 9. TUI decomposition targets orchestration, not leaf helpers

The remaining TUI complexity is command orchestration and daemon-session
lifecycle state. Phase 0 shipped the IO/dependency seam and headless harness.
Next extraction should put daemon session lifecycle in a controller module under
`cli/`, not `lib/`.

Source note:
[`TUI Decomposition`](<../archive/decisions/TUI Decomposition - Testability Seam and Daemon Session Controller.md>).

### 10. Every surface is the same conversational lead; local surfaces add reach

The collapse in §2 is the product model for **every** surface, not a web-only
default. Web, TUI, and the local daemon should all present **one agent you
talk to** — the single conversational lead (phase-first status, no
brief/Orchestrator ceremony) — and differ only in *reach*. The CLI/daemon is
that same lead with a bigger tool surface precisely because it runs locally:
the real filesystem, a real shell with no sandbox token or 30-minute expiry,
the persistent daemon for long-running and background work, and direct machine
access. The target is "feels like the app, with more capabilities" — not a
different interaction model per surface.

Current state / gap: the web `inline` lane is the collapsed lead today
(`app/src/hooks/chat-send-inline.ts` plus the kernel's `leadMode` option — see
[`Inline Foreground Lane`](<../archive/decisions/Inline Foreground Lane — Local While Watched.md>)).
On the CLI, the first convergence step landed 2026-06-12: interactive turns
(TUI + daemon `send_user_message`) default to the single lead in-loop —
`runAssistantTurn` no longer runs the Planner pre-pass or the subagent
ceremony. (At the time a `delegationMode: 'delegated'` /
`PUSH_DELEGATION_MODE=delegated` opt-in kept the wrapper reachable, the
interactive analog of headless `--delegate`; it has since been retired along
with the engine loop — the CLI no longer reads either knob, and
`lib/delegation-mode.ts` is consumed by the web preference only. The dead
headless brief shim `cli/task-brief.ts` was deleted 2026-07-08.) The second step
landed the same day as an opt-in lane: `cli/lead-turn.ts` runs the terminal
turn as a `leadMode: true` run of the **shared** coder kernel — same kernel +
lead framing as the inline lane, assembled with the CLI's local reach
(`executeToolCall` against the real filesystem, the CLI provider streams, the
existing approval/Auditor gates) and speaking the engine's existing event
vocabulary so the TUI/REPL/daemon clients render it unchanged. Routing lives
at the `runAssistantTurn` seam, which now delegates **unconditionally** to the
kernel lane: the bake-period `PUSH_LEAD_RUNTIME=engine` opt-out and the
CLI-local engine round loop (`runAssistantLoop`) have both been retired. With
the loop gone, its helper cluster in `cli/engine.ts` (the file-awareness guard,
the max-rounds / empty-success / parse-error builders, the mid-session distill
check) had **no remaining callers** — verified repo-wide; the functions sat at
their definitions only — so removing them is behavior-neutral. The live concerns
those helpers used to serve are owned by the shared kernel under different
shapes: file awareness via `getAwarenessBlock`, the round-cap finalization and
parse-error envelopes inline in `lib/coder-agent.ts`, empty-final-turn handling
in the same loop, and context compaction through the kernel's stream pipeline
(`toLLMMessages`). `cli/engine.ts` is now a thin seam: prompt assembly, the live
`buildToolResultMessage`, and the `runAssistantTurn` → `runLeadKernelTurn`
delegator. The daemon's delegated task-graph nodes keep the implementer prompt
by design (they are delegations, not the lead).

The inline lead is not delegation-free: it wires a narrow, **Explorer-only**
delegation arc (`delegate_explorer` via the kernel's `extraToolSources` /
`executeExtraToolCall` seam, executed by `runInlineExplorerDelegation` in
`app/src/lib/inline-coder-run.ts`). The lead stays the implementer — it does
its own coding and `delegate_coder` / `plan_tasks` are refused — but it can
offload read-only investigation when a question spans many files, and fan out
up to two Explorers concurrently in one turn. This rides an opt-in
parallel-delegation bucket in the shared grouper
(`lib/tool-call-grouping.ts:maxParallelDelegations`, default-disabled so the
Orchestrator and the delegated sub-agent nodes are unchanged) which the Coder
kernel executes in its read-phase `Promise.all`. `delegate:explorer` is part
of the lead-capable `coder` grant; the empty `extraToolSources` on a delegated
sub-Coder keeps the same call refused at the source gate.

The **CLI lead carries the same arc** (2026-07-08): `cli/lead-explorer.ts`
runs a `delegate_explorer` call on the shared Explorer kernel
(`lib/explorer-agent.ts`) against the real filesystem — the read-only tool
executor is the same capability-gated implementation the daemon's delegated
Explorer/Deep Reviewer runs use (`makeCliReadOnlyToolExec`, which
`makeDaemonExplorerToolExec` now wraps) — and the lead lane
(`cli/lead-turn.ts`) opts into the same fan-out cap (2) through the shared
grouper, advertises the arc via `LEAD_EXPLORER_DELEGATION_PROTOCOL` (the
native function schema parses from the same block, so prompt and schema can't
drift), and reports lifecycle through the existing `subagent.*` events the
TUI/REPL delegation renderers already handle. Provider/model inherit the
lead's lock, with the session's `roleRouting.explorer` override honored
(same precedence as the daemon's `delegate_explorer` RPC). An Explorer cannot
fan out further Explorers: sub-runs get the default (bucket-disabled)
detectors and the `explorer` grant refuses `delegate:explorer` at the
capability gate.

**Conversational-lead convergence (routing fork removed by default).**
Repo-backed *conversational* turns now route to the inline lead by default
(`chat-send-background.ts`: `inlineEligible = repoBranchReady`; the Phase 3
escape hatch has been retired). The full parity matrix for what a
conversational turn must not lose lives in
[`../runbooks/Conversational Lead Convergence.md`](<../runbooks/Conversational Lead Convergence.md>).
Phase 0 landed: the cognitive-drift guard is now gated on `taskInFlight === false`
(mirroring the no-fake-completion guard). Phase 1 landed: conversational inline
turns seed the kernel from managed transcript messages and linked-library
context instead of collapsing history into the bounded task preamble. Phase 2
landed: the Coder kernel carries the remaining policy/observability/tool parity
needed before the flip — trailing-action-intent nudges in `coder-policy.ts`,
reasoning-channel buried-tool recovery in `lib/coder-agent.ts`, scratchpad/todo
tool wiring for the inline lead, per-round `assistant.turn_start/end`, and
`tool.call_malformed` events for dropped candidates. Phase 3 landed the routing
flip (inline default); the bake-period escape hatch has been retired. A/B
measurement continues as follow-up, not as a blocker for the default route.

Protected during convergence: the shared runtime semantics in §1 (one kernel,
drift tests), the durable job engine, and the safety/Auditor boundary — the
local lead still goes through the same gates, just without the sandbox's
constraints.

### 11. Reads default to GitHub; the cloud sandbox is the on-demand exception

On the **web/cloud-sandbox** surface the two read tiers are not peers. The
GitHub read tier (`repo_read` / `repo_search` / `repo_grep` / `repo_ls` /
`branches`, registry `source: 'github'`, read-only) is the **default** way the
lead explores, searches, and reads code: it reflects the active branch's last
pushed state and stays available even when the cloud sandbox is slow, starting,
or unavailable. The cloud sandbox read tools (`read` / `search` / `list_dir` /
`read_symbols` / `refs`) are the **on-demand exception** — reached only for the
**working tree** (files created or edited this session, not yet pushed) or when
a GitHub read fails. This decouples exploration from a substrate we don't yet
trust for reliability; a flaky sandbox no longer blocks "where is X / read Y /
how does Z work."

The precedence lives in the advertised tool set plus the read-tier framing in
both web protocol builders (`buildGitHubToolProtocol` in
`app/src/lib/github-tool-protocol.ts`, `SANDBOX_TOOL_PROTOCOL` in
`app/src/lib/sandbox-tool-detection.ts`), pinned against silent re-merge by
`app/src/lib/read-tier-precedence.test.ts`. The sandbox read tools stay
advertised (precedence is a default, not a ban) so read-before-edit on
uncommitted files still works.

Scope: **web only.** The CLI/daemon (§10) reads a real local filesystem, which
*is* the reliable default there — its local read tools stay primary and GitHub
reads serve cross-repo / pushed-state lookups.

The precedence is also **code-enforced**, not contract-only, so it holds for a
non-cooperating model that calls a sandbox read anyway when the sandbox is down:
`tryGitHubReadFallback` in `app/src/lib/web-tool-execution-runtime.ts` maps a
cloud-sandbox read to its GitHub-tier equivalent
(`app/src/lib/sandbox-read-github-fallback.ts`) and serves it when there is no
sandbox session or a cloud read returns `SANDBOX_UNREACHABLE` — annotating the
result as last-pushed state, since the GitHub tier can't see uncommitted
working-tree edits. The fallback is cloud-only (local-PC keeps its own re-pair
path), covers the reads with a clean GitHub analog (`read`/`search`/`list_dir`,
plus `find_references` → GitHub code search since references ≈ search hits for
the symbol), and emits symmetric structured logs (`read_tier_github_fallback` ↔
`_skipped` ↔ `_failed`). Those logs are emitted **browser-side** — this runtime
is the inline lane, and its sandbox/GitHub calls are `fetch` clients to the
Worker, so the lines land in the client console, not `wrangler tail`. Of the
branches only the *served* case leaves a durable, greppable trail — via the
result-text annotation persisted in the chat transcript; the `_skipped` /
`_failed` branches exist only in the browser console and vanish on tab close.
`read_symbols` is the one sandbox read with no GitHub
analog — its extractor runs as a Python script inside the sandbox — so it keeps
the original error. The `search_files` fallback (`search` / `find_references`)
is additionally gated to the **default branch**: GitHub's `/search/code` only
indexes the default branch and ignores `&ref`, so on a feature branch it would
return stale/no-match results as a success; there the fallback declines and the
retryable sandbox error is preserved (`read`/`list_dir` use the branch-aware
contents API and are unaffected). This is the §3 "code-backed, not
prompt-backed" closure of the precedence.

The fallback is also **inline-only by construction**: the background coder path
(Worker DO) bypasses `WebToolExecutionRuntime` and, on sandbox loss, resumes on
a fresh sandbox rather than degrading to pushed-state reads. That asymmetry is
deliberate — degrading a *watched* read to last-pushed state is strictly better
than failing in front of someone, but an *unwatched* job editing against stale
bytes is worse than pausing.

### 12. TUI key routing borrows giggles' focus model; we do not adopt the framework

[giggles](https://github.com/zion-off/giggles) is a batteries-included
React/Ink framework for terminal UIs (decentralized "each component owns its
keys" handling, focus scopes with restoration, a context-aware keybinding
registry, a component library). It was evaluated for the CLI TUI. The decision
is **borrow the patterns, do not adopt the dependency.**

Adopt was rejected on a runtime mismatch, not on quality. Push's TUI is
~14k lines of hand-rolled, **zero-dependency** raw-ANSI rendering across the
`cli/tui-*.ts` modules (`tui.ts` alone is the imperative round loop +
renderer); the top of `tui.ts` states the zero-dependency tenet explicitly.
giggles is a reactive React + Ink runtime. Adopting it means pulling in
React + Ink + the framework and porting the entire renderer onto a component
model — a from-scratch rewrite of a mature surface, against an explicit design
invariant, while §9/§10 are pulling the TUI toward *convergence and
simplification* (one conversational lead), not a framework migration. It would
also make a pre-1.0 external project load-bearing for the primary local
surface. None of those costs buy something the borrow can't.

What is worth taking is the *idea*: focus scopes that own their keys with
explicit fall-through to a global keybind map. The TUI already had the seed of
this — the approval pane exposes a `handleKey(key): boolean` Pane contract, and
the dispatcher carried a comment wanting future non-modal panes to fall through
to the global map — but the precedence lived as a hand-maintained cascade
(`if (runState === 'awaiting_approval') … if (awaiting_user_question) … switch
(getActiveOverlayModal()) …`) inside the 7k-line `processInput`.

Shipped: `cli/tui-focus.ts` is a generic, dependency-free `FocusStack` —
ordered `KeyScope`s evaluated highest-priority-first, each owning its keys and
returning consumed/fall-through. The **entire** `processInput` key dispatch now
resolves through `focusStack.dispatch(key)` over six scopes in precedence
order: approval pane → ask-user → overlay modal → tab completion → global
keybinds → composer (bottom). The global keybind map and composer editing are
no longer a special imperative tail — they are just the lowest-priority scopes,
and a key no scope claims is a deliberate no-op exactly as before. Precedence
and behavior are byte-for-byte the prior hand-rolled cascade; the resolution is
data-driven, inspectable (`activeScope()`), and unit-tested
(`cli/tests/tui-focus.test.mjs`), with the full CLI suite (2707 tests) green
across the migration. This is consistent with §9: it extracts a testability
seam from `tui.ts` orchestration rather than reaching for leaf helpers.

Considered and declined: push/pop self-registration. giggles' scopes mount and
unmount with their React components, so a pane "pushing" its focus scope on
mount is free there — the framework guarantees the paired unmount. This TUI has
no such guarantee. Every focusable surface here is already backed by
*authoritative* state that is **also the render source of truth**: the approval
pane by `runState === 'awaiting_approval'` + `tuiState.approvalPane` (held in
lockstep by `openApprovalPane`/`closeApprovalPane`), the overlay modals by the
booleans behind `getActiveOverlayModal()` (single writer:
`setActiveOverlayModal`). Converting these to push/pop would replace a
zero-maintenance declarative gate with a parallel stack-membership state that
has to be hand-synced at ~11 open/close call sites — a *second* source of truth
for "what owns input," and precisely the desync class the repo guards against
elsewhere (the branch/sandbox sync rules). The declarative `isActive()`
predicate IS each component's focus ownership, expressed against the one
authoritative state; it is the correct end state, not an interim one. Dynamic
push/pop would only earn its keep for a genuinely transient overlay with no
backing state — there is none today, so the primitive is intentionally not
added (YAGNI). If one appears, add `push()` then.

### 13. Tool-output compaction: the TokenJuice pattern is already adopted; lossless raw retention is the remaining half

Status: **Current** for the reducer; the lossless-retention half is tracked under §5 / LCM Phase 3.

> Correction (2026-06-21): an earlier draft of this section claimed Push had "no
> content-aware reducer, only blunt byte caps" and proposed building one. That was
> wrong — `lib/tool-output-reducers.ts` already exists and is wired on both
> surfaces. This section is rewritten to record the actual state.

[OpenHuman](https://github.com/tinyhumansai/openhuman) (`tinyhumansai/openhuman`,
GPL-3.0, Rust + Tauri) ships **TokenJuice**, a rule overlay that compacts verbose
tool output *before* it enters LLM context (`tool result → TokenJuice → context`):
builtin rules for common commands (git, npm, cargo, docker, kubectl, ls) under
user and repo-checked-in layers, declarative transforms (`truncate, dedup lines,
fold whitespace, drop matching regexes, summarize sections`), and a debug log of
which rule matched and the reduction ratio. Push **already adopted this pattern**
(clean-room — OpenHuman's GPL-3.0 Rust can be read for ideas, not copied):
`lib/tool-output-reducers.ts` (`reduceToolOutput`) is a command-aware,
deterministic, pure reducer wired into both surfaces — CLI `cli/tools.ts` and web
`app/src/lib/sandbox-tools.ts`. It runs *upstream of* the blunt byte caps
(`SIZE_BUDGETS.toolResultReadOnly` 8k / `toolResultCoder` 24k in
`lib/size-budgets.ts`), so the budget that survives into context — and into
context-memory packing (§5) — is mostly signal, not the first 24k of progress
bars. Its own design boundaries are sound: it reduces only the text it is given
(never exit-code/failure semantics), bails out unchanged on unsafe/ambiguous
command shapes (pipes, chains, substitution), and passes small wins through
unchanged to protect prompt-cache stability.

The decision (borrow the pattern, not the project) stands and is **already lived**.
The other half — *"keep the raw stdout/stderr"* the reducer's header promised but
had nowhere durable to put — **shipped 2026-06-21**: when `sandbox_exec` output is
reduced, the full (sanitized, unreduced) output is retained in the verbatim log
(`lib/verbatim-retain.ts`, both surfaces) and the model-facing result gets a recall
marker. The model pulls it back via `memory_expand` `refs` — `lib/memory-tool-exec.ts`
now accepts verbatim `vb_…` refs alongside record `ids`, reading the log directly
with a cross-repo scope guard (`verbatimScopeMatches`). On web the retained copy is
sanitized (recall re-enters the model, so it carries the same injection defanging as
the inline output); the raw card data stays untouched. So the two threads converged
on one backing store, exactly as predicted.

Deliberately **not** pursued (revisit only with evidence): a fully declarative,
repo-checked-in `.push/`-scoped rule overlay à la TokenJuice's three layers. The
current reducer hard-codes its command awareness in `lib/`. A `.push/`-checked-in
rule layer (mirroring the `PUSH.md → AGENTS.md → CLAUDE.md` loader precedence)
would be the natural extension *if* repos need per-project compaction rules — but
it adds a new vocabulary (canonical definition + drift test obligation) and a
`drop regex` rule could strip the one line a security-relevant exec needed, so any
such layer must stay advisory over the raw result the Auditor sees, never a filter
on it. No demand yet; the hard-coded reducer covers the high-noise commands. YAGNI
until a repo actually needs custom rules.

### 14. Context-window compaction is always-on, runtime-owned, visible, and LLM-summarized

Status: **Current** (shipped 2026-06-21, web). **Threshold model revised 2026-06-26** — see *Revision* at the end of this section; the dead parallel compaction ladders were retired in the same change.

Two prior gaps: compaction was (a) silently applied — it fired `context.compaction`
run events that only surfaced in the Hub console, so a user never saw the window
being trimmed — and (b) *optional*: a `contextMode` Settings toggle ("Keep all")
could disable it entirely, whose only possible outcome on a long chat is a
provider context-window error. Both are removed.

**Runtime-owned.** The `contextMode` toggle and its `ContextMode`/`getContextMode`/
`setContextMode` plumbing are deleted end-to-end. `manageContext` compacts
unconditionally; there is no user opt-out. Context management is a correctness
concern, not a preference.

**Two-tier mechanism, lossless.** The synchronous heuristic
(`lib/message-context-manager.ts`: summarize tool output → drop oldest pairs →
hard-trim) stays as the always-on backstop inside the pure
`transformContextBeforeLLM` boundary — it guarantees a turn never overflows. On
top of it, a **pre-turn LLM compaction** (`lib/llm-compaction.ts` engine +
`app/src/hooks/chat-compaction.ts` web coordinator) asks the model itself to write
a Codex-style "[CONTEXT HANDOFF]" summary of the older span when the working set
nears budget. It is **lossless** (LCM §5/§13): the summarized span is never
deleted — it is marked `visibleToModel: false` (the existing wire-filter drops it
from the prompt) while remaining in the durable transcript and the verbatim log.
A model-visible handoff message carries the summary forward; repeated compactions
fold the prior handoff in (Codex #14347 cumulative mitigation). The engine is pure
and provider-agnostic — the model call goes through an injected `PushStream` (the
Auditor/Reviewer seam, `iteratePushStreamText`), so it unit-tests against a fake
stream. It **fails soft**: any error/timeout/empty summary leaves the transcript
untouched and the heuristic backstops the turn.

**Visible.** Three surfaces, mirroring Codex's "Compacting context" affordance:
the transient `AgentStatusBar` pill ("Compacting context…", driven by the
`onPreCompact` callback and the coordinator), a persistent `kind: 'compaction'`
transcript divider ("Compacted context 88k → 42k", rendered like the `branch_*`
events and filtered from the wire), and a retuned `ContextMeter` that warns
(amber → red + pulse) as the window approaches the compaction boundary (~85%).

**CLI parity** shipped alongside (`cli/lead-compaction.ts`, wired pre-turn in
`cli/lead-turn.ts`). The CLI lead turn differs architecturally: it feeds the
model a *bounded* preamble (`buildLeadTurnPreamble` — last `PRIOR_TURNS_MAX`
turns, each clipped), so a long session silently forgets the early thread. The
coordinator closes that gap with the **same shared engine**: when the durable
history exceeds budget, it collapses the older span into a `[CONTEXT HANDOFF]`
message the preamble now renders un-clipped. Because the CLI `Message` has no
`visibleToModel` flag, this is a destructive collapse (matching the existing
`compactContext`/`[CONTEXT DIGEST]` model) rather than a hide — tool-output
losslessness is already covered by the verbatim log. Surfaced via the existing
`context_compacted` session event + `cli_llm_compaction_*` structured logs.

Source notes: [`How Codex CLI Handles Compacting`](<../research/codex-compacting.md>).

**Revision (2026-06-26) — split the compaction knob; fill the window by default; consolidate onto one tier spine.**

The original design drove *both* mechanisms off a single threshold,
`summarizeTokens = min(88k, 0.85·window)`: the heuristic Phase-1 tool-output
compression **and** the visible LLM handoff both fired at it
(`triggerTokens = budget.summarizeTokens` in both coordinators —
`app/src/hooks/chat-compaction.ts`, `cli/lead-compaction.ts`). On a 1M-window
model that collapses the conversation to `[first user turn] + handoff + ~24k
tail` (PRESERVE_TAIL_RATIO 0.4 of the 88k trigger = 35k, capped at
`PRESERVE_TAIL_CAP` = 24k) at **~9% of the window** — a quality- and
cache-cost paid on a model with 900k of unused room. Three decisions correct it.

1. **Split the knob.** The two mechanisms have opposite cost profiles, so they
   get separate thresholds:
   - *Tool-output compression* (heuristic Phase 1) is **lossless** — the raw
     bytes survive in the verbatim log (§13) and `memory_expand` recalls them —
     so it stays **eager**: threshold `compressionTokens`, unchanged from today's
     `min(88k, 0.85·window)`. Compressing early loses no working context (the
     reason it's exempt from the "fill the window" pull below); it only keeps the
     active prompt's signal density high.
   - The *LLM handoff collapse* is a model round-trip, **busts the prompt cache**
     (it rewrites the prefix), and is lossy in practice (the model rarely knows
     to recall). So it becomes **patient and window-aware**: new field
     `handoffTokens = clamp(HANDOFF_RATIO·window, 88k, HANDOFF_CEILING)`. The
     **web** coordinator (`chat-compaction.ts`) repoints `triggerTokens` from
     `summarizeTokens` to `handoffTokens`; nothing else in the handoff path changes.

   **The CLI lead coordinator (`cli/lead-compaction.ts`) deliberately does NOT
   adopt `handoffTokens` — it stays eager on `summarizeTokens`.** The split's
   patience is safe only for the web, which sends the model its *full* message
   array (the handoff merely shrinks what's already visible). The CLI lead feeds
   a *bounded* preamble (`buildLeadTurnPreamble` — last `PRIOR_TURNS_MAX` turns),
   so the `[CONTEXT HANDOFF]` summary is the **only** carrier of older context.
   Deferring it to a window-aware 400k would let a long session (esp. on 1M-window
   DeepSeek/Gemini/Claude) drop every turn beyond the preamble with no summary —
   a memory regression for exactly the sessions compaction protects (Codex P1 on
   PR #1194). A bounded preamble can't be patient; collapse eagerly or lose context.

2. **Fill the window by default.** Prefer context retention + cache stability
   over a lean working set; when the right threshold is genuinely ambiguous,
   default to carrying *more* context, not less. `HANDOFF_RATIO = 0.70` sits
   below the `targetTokens` (0.85) drop-backstop, so the lossless quality handoff
   always fires before the lossy heuristic drop ever would. A 128k model lands
   ≈ today's 88k (continuity for the small-window majority — Kimi/GLM/gpt-oss/
   qwen); a 1M model fills to the ceiling before paying for a collapse.
   `HANDOFF_CEILING = 400k` is the deliberate **middle-ground guard** — it caps
   the genuinely-degrading tail so a 2M-window model (Grok) never carries 1.4M of
   diluted context. It starts generous and rises only on telemetry evidence.

3. **Prefix-aware scoping (Codex `BodyAfterPrefix`) — DEFERRED, needs its own
   design pass.** The intent: measure *conversation growth*, not fixed overhead,
   so a large cached prefix never pulls compaction forward. But this maps less
   cleanly to Push than to Codex and was **not** shipped with #1/#2 above: the
   LLM-compaction coordinators already measure conversation-only tokens
   (`estimateContextTokens(visible)` over the message array — the system prompt
   lives at the wire layer, not in the array), so there is no flat prefix to
   subtract. The real open question is where the *cached* boundary sits (system
   prompt + project instructions + pinned first-user task + any stable head
   turns) and whether the heuristic estimator can locate it reliably. Tracked as
   follow-up; the orchestrator safety-net's existing `fixedOverheadTokens` thread
   is the nearest prior art to build on.

The constants are **telemetry-tunable, not settled.** Prompt-cache token capture
(provider observability) already lands the data; cache-hit-rate sampled around
`context.compaction` events picks `HANDOFF_RATIO` and `HANDOFF_CEILING`. Recorded
here as the operating direction — measured before any hard-tuning.

**Consolidation: retire the two dead parallel ladders.** A closer reading found
the "three implementations" weren't peers. The two *live* compaction paths are
`manageContext` (web, via `createContextManager`'s dependency-injection seam —
the web binds `compactChatMessage` / digest factory / metrics) and `distillContext`
(CLI, bound into `lib/context-transformer.ts`), each legitimately surface-tuned.
The other two were dead weight: `lib/compaction-tiers.ts` — a speculative
single-budget cheap→expensive composer written "for new sites and future
migrations" but adopted by **nobody** (zero non-test callers) — and
`cli/context-manager.ts`'s `trimContext`, a vestigial port of the web's
two-budget ladder that never got wired into a live path (referenced only by its
own tests; the CLI's real automatic trimming goes through `distillContext` +
`lead-compaction`). Both were **deleted** with their tests. That is the honest
"reduce the overlap" — remove the unadopted/vestigial parallel attempts, not
contort a per-turn hot path onto the unadopted one: the spine is single-budget
cheap→expensive, the live managers are two-budget summarize-then-drop-with-digest,
and forcing one onto the other would make the primitive leaky and risk the live
path (its #283/#285 regressions pin message-level behavior). A future site needing
tiered compaction should extend the adopted `createContextManager` seam, not
resurrect a speculative parallel. The async LLM handoff (`lib/llm-compaction.ts`)
is structurally unchanged — now keyed off `handoffTokens` (above).

### 15. Runtime interventions use steer/block vocabulary over one tool ledger

Status: **Current** (partially implemented; continued by the
[`Runtime Unification Plan`](../runbooks/Runtime%20Unification%20Plan.md)).

Push already intervenes in agent turns, but the live paths historically named
their choices locally: tool-call recovery injects corrective messages, the
mutation transaction refuses unsafe ordering, loop detection skips/halts repeated
work, sandbox recovery changes retry guidance, and `prepare_push` gates delivery
through the Auditor. These are one runtime concept and should share vocabulary:

- **Steer** means the runtime does not execute the missing/invalid action yet; it
  gives the model concrete, runtime-generated guidance and continues the loop.
  Examples: malformed tool-call feedback, tool-call-in-reasoning nudges,
  announced-action-without-tool-call nudges, ungrounded-completion verification
  prompts, and retry guidance after recoverable tool errors.
- **Block** means the runtime refuses an action or stops a run because continuing
  would violate a hard boundary. Examples: role/capability denial, a second
  trailing side effect in one turn, file-mutation overflow/ordering violations,
  repeated-call loop breakers, unsafe Auditor verdicts, and unrunnable required
  gates at the push boundary.

The intervention type belongs in shared `lib/` code as a small data contract, not
as a hook/plugin framework. A useful shape names the lifecycle point
(`after_model`, `before_tool`, `after_tool`, `delivery_gate`), the mode
(`steer` / `block`), the source policy, a stable reason code, the affected tool
call when one exists, and any model-facing guidance. Steer payloads must be
runtime-generated and traceable to deterministic state; prompts may explain the
contract, but they are not the control plane.

The shared state source is a **tool ledger**, not another grouping state machine.
`lib/tool-call-grouping.ts` already owns the read-prefix -> file-mutation batch ->
single trailing side-effect classifier and caps. The ledger should sit beside the
turn/run execution path and record what happened: emitted calls, accepted calls,
rejected/overflow calls, source, tool name, normalized args key, phase slot,
execution start/end, duration, error/retryability, structured error type,
postconditions, and side-effect class. Budget enforcement, loop/intervention
decisions, Auditor context, and future steer handlers should query that ledger
instead of re-deriving history from transcript text or local arrays.

Intervention points are intentionally few:

1. **After model output, before tool execution** — recover malformed/misplaced
   calls or steer false completions.
2. **Before tool execution** — enforce capabilities, role boundaries, tool-order
   budgets, approval gates, and sensitive-path guards.
3. **After tool execution** — record results, update verification/sandbox state,
   steer recoverable failures, and trigger loop breakers.
4. **Delivery boundary** — run secret/Auditor gates over the pushed diff; steer
   through review-card feedback when safe to continue, block when the gate is
   unsafe or required and unrunnable.

Non-goals stay explicit: no Graph/Swarm adoption, no generic hook framework, no
MCP expansion beyond the current CLI-scoped posture, and no new agent capability.
This is consolidation of existing runtime behavior under a named contract.

Source notes:
[#1260](https://github.com/KvFxKaido/Push/issues/1260),
[`strands-agents/harness-sdk`](https://github.com/strands-agents/harness-sdk),
[`Strands steering`](https://strandsagents.com/docs/user-guide/concepts/plugins/steering/).

### 16. Long-running commands block server-side; the model never polls in a loop

Status: **Current** (shipped 2026-07-05, CLI — `feat(tools): exec_wait`).

The CLI session-exec family (`exec_start` → `exec_poll` → `exec_stop`,
`cli/tools.ts`) lets a long command run detached, but `exec_poll` is a
*snapshot* read — it returns whatever output exists right now and returns
immediately. There was no blocking wait, so to wait out a long command the model
had to **busy-poll**: one full model round-trip per poll. Measured on the lead
loop, a single 200-second command took **169 rounds** (~169 provider calls to
babysit one command). The runtime had *accommodated* the spin rather than
removing it — `exec_poll` sits in `REPEAT_EXEMPT_TOOLS` (so the exact-repeat loop
breaker won't abort it) and the adaptive round budget (`adaptMaxRounds`) expands
to absorb the extra rounds. Two mechanisms kept the spin alive; none eliminated
it.

Why it is load-bearing for stability: N poll rounds is N independent chances for
a provider stall, a 429, or a network blip, any one of which kills the turn. On a
stall-prone default (Gemini) that fragility is the dominant "long tasks are
unstable" failure mode on the CLI. It also partly explains why the autonomous
reviewer is the most stable loop in the system — it is read-only and **never
enters this spin**: a durable no-client loop that also never runs long commands
dodges several instability axes at once.

The decision: a long command is waited on with a **blocking** tool, not a
model-driven poll loop. `exec_wait(session_id, timeout_ms?, from_seq?,
max_chars?)` blocks server-side until the process exits, needs input, the wait
budget elapses, or the run is aborted, then returns new output + final status. It
is event-driven (reuses `waitForSessionExit`, resolves the instant the process
exits — not a Node-side busy-wait), abortable via `options.signal` so Stop
interrupts the wait without killing the command (that stays `exec_stop`'s job),
and reports a `waited` state (`exited` | `needs_input` | `running` | `aborted`)
where `running` tells the model it may wait again. The poll loop moves off the
model and into one tool call.

Evidence: the identical 200s probe dropped from **169 → 4 rounds**. The model
adopted `exec_wait` from the tool-doc hint with **no runtime steer** — the tool
plus its result semantics are the code-level fix; the doc line is advertisement,
and the measurement said advertisement sufficed. A steer (after K repeat polls on
a live session, nudge toward `exec_wait`) is the fallback if adoption proves
provider-dependent, per §15's steer vocabulary — not added preemptively.

Scope: **CLI session-exec only.** The cloud `sandbox_exec` path already polls
server-side in its detached runner (background-exec, PR #863), so it does not
have this model-driven spin; the CLI was the worse case. This closes one
instability axis (the busy-poll storm); the durable-loop-host and sandbox-loss
axes are separate.

### 17. Vision is a runtime capability; non-vision models get a describing sidecar, not a model swap

Status: **Draft** (spec complete; implementation not started).

When the chat-locked model cannot read images, the runtime routes image
attachments through a vision-capable model that describes/OCRs them and
injects the description as labeled text — instead of refusing the send, which
is today's behavior. Contract points:

- **The chat lock holds.** The fallback is a sidecar preprocessing call (the
  Auditor/Reviewer pattern: `lib/` kernel + injected PushStream), never a
  swap of the lead model, and it does not upgrade declared capabilities —
  `visionInput` stays `unsupported` and the awareness block says plainly that
  the model is reading a description, not the image.
- **Resolution is explicit:** user-set sticky selection
  (`visionFallback.provider` / `visionFallback.modelByProvider`, the
  `reviewerAdvisory*` shape) → zero-config Workers AI default on web/cloud
  (the `AI` binding in `wrangler.jsonc` is already provisioned) → degrade to
  today's honest refusal. No silent auto-scan of other configured providers.
- **Fail open to the status quo:** a failed describe call injects an honest
  placeholder and the send proceeds; attachments are never silently dropped.
  Descriptions are cached per attachment so prior-turn re-injection doesn't
  re-bill.
- **Not Modal-shaped.** Inference never runs in the sandbox; this is one more
  provider call from the Worker. Self-hosted GPU vision is an explicit
  non-goal.
- v2 (separate promotion): `describe_image` as a governed, model-callable
  tool, which is the point where `lib/capabilities.ts` and drift tests get
  involved. v1 preprocessing does not touch the tool surface.

Source notes:
[`Vision Fallback for Non-Vision Models`](<../runbooks/Vision Fallback for Non-Vision Models.md>).

## Active Runtime Work

1. Delete the Planner/brief now that inline is the measured default (2026-06-11); attachments-on-engine-envelope is the prerequisite. Partial: the CLI's headless brief shim (`cli/task-brief.ts`, dead since the engine-loop retirement — test-only callers) was deleted 2026-07-08; the shared `lib/delegation-brief.ts` stays (live in the web's delegated Coder/Explorer arcs) until the web-side deletion lands.
2. Ship auto-branch-on-commit as the universal commit-flow for scratchpad work.
3. Decide scratchpad durable-storage substrate per platform.
4. Finish TUI daemon-session controller extraction — **shipped 2026-07-09** (#1369): `cli/tui-daemon-session.ts` owns the daemon-session state/lifecycle/verbs behind a hook seam; `runTUI`'s ~100 ambient reads collapsed to `daemon.*`. Phase 2 of the TUI decomposition (command-handler module) stays optional; see the archived decision doc.
5. Graduate loop detection enforcement only after telemetry supports thresholds.
6. Memory Phase 3 immutable verbatim logs — **shipped 2026-06-21** (kernel + CLI file backend + write-path `verbatimRef` stamping + `memory_expand` resolution + reducer raw-retention/recall via `memory_expand` `refs`). Only the Worker durable backend remains, tracked in **#1063** (blocked on a Worker-side typed-memory store). See the LCM doc's Phase 3.
7. Promote the diff/annotation envelope only when a committed decision needs it.
8. TUI focus-stack migration (§12) — **complete**: the whole `processInput` dispatch resolves through the stack across six declarative scopes. Push/pop self-registration was considered and declined (see §12); declarative `isActive()` against authoritative state is the end state.
9. Converge the CLI/daemon terminal chat onto the single conversational lead (a `leadMode` run of the shared kernel), so the TUI feels like the app with local reach (§10) instead of the delegated org-chart model. Step 1 landed 2026-06-12: interactive turns default to the in-loop lead with the Planner wrapper behind `PUSH_DELEGATION_MODE=delegated`. Step 2 landed 2026-06-12: the lead-kernel lane (`cli/lead-turn.ts`) runs the turn on the shared kernel in `leadMode`. Step 3 landed 2026-06-12: the lane is the **default**; `PUSH_LEAD_RUNTIME=engine` is the exact-match opt-out while it bakes. Step 4 — **complete**: the bake-period `PUSH_LEAD_RUNTIME=engine` opt-out and the CLI-local engine round loop are retired; `runAssistantTurn` delegates unconditionally to the kernel lane and the now-unreachable helper cluster the loop left behind in `cli/engine.ts` (awareness guard, finalization/parse-error builders, mid-session distill — no callers once `runAssistantLoop` was gone; the kernel owns these live concerns) plus its obsolete tests were removed. Behavior-neutral removal. Step 5 landed 2026-07-08: Explorer fan-out parity — the CLI lead wires the same Explorer-only delegation arc as the web inline lane (`cli/lead-explorer.ts`, cap 2, shared-grouper bucket, `subagent.*` lifecycle events); see the §10 arc paragraph.
10. Tool-output compaction (§13): the TokenJuice pattern is **already shipped** (`lib/tool-output-reducers.ts`, both surfaces). The remaining "keep the raw output losslessly" half is folded into memory Phase 3 (item 6) — a reduced result stamps a `verbatimRef` into `lib/verbatim-log.ts`. A declarative `.push/`-scoped rule overlay is deliberately deferred (YAGNI until a repo needs custom rules).
11. Context-window compaction (§14): **always-on + visible + LLM-summarized shipped 2026-06-21 (web + CLI)** — toggle removed, `lib/llm-compaction.ts` engine, `app/src/hooks/chat-compaction.ts` (web) + `cli/lead-compaction.ts` (CLI lead) coordinators wired pre-turn, three web visibility surfaces + the CLI `context_compacted` event. Remaining: graduate the run-event `phase` vocabulary if ops need to distinguish heuristic- from LLM-summarization (today both report `phase: 'summarization'` to avoid churning the drift-pinned `context.compaction` schema), and a Worker-side background-coder integration if those long jobs need it.
12. Unify runtime intervention machinery (§15 / #1260): the shared steer/block contract, grouping-ledger snapshot, tool-budget block, and tool-call-recovery steer have landed. Phases 1–2 of the [`Runtime Unification Plan`](../runbooks/Runtime%20Unification%20Plan.md) are complete: every Coder host uses the shared stateful policy factory, copy-shaped provider transports now converge by wire family, and Anthropic `pause_turn` continuation is one cross-shell state machine. Completion grounding remains selected by turn intent rather than host, and provider quirks remain explicit at leaf adapters rather than disappearing into a mega-adapter. Next: the Phase 3 capability resolver, then execution-ledger updates and the remaining loop/Auditor consumers, without changing agent capability.
13. Long-command blocking wait (§16): **shipped 2026-07-05** (`exec_wait`, CLI) — the 200s probe collapsed 169 → 4 rounds, model adopted it from the tool-doc hint (no steer). Follow-ups only if warranted: a repeat-poll → `exec_wait` steer if adoption proves provider-dependent, and a cloud parity check (the detached runner already polls server-side, so likely a no-op).

## Archived Context Worth Knowing

Architecture/provenance:
[`Architecture Rating Snapshot`](<../archive/decisions/Architecture Rating Snapshot.md>),
[`Architecture Remediation Plan`](<../archive/decisions/Architecture Remediation Plan — Defusing the Big Four.md>),
[`useAgentDelegation Coupling Recon`](<../archive/decisions/useAgentDelegation Coupling Recon.md>),
[`useChat Regression Audit`](<../archive/decisions/useChat Regression Audit.md>),
[`Duplication and Structural Symmetry Analysis`](<../archive/decisions/Duplication and Structural Symmetry Analysis.md>).

Comparative/research:
[`Agent Tool Patterns`](<../archive/decisions/Agent Tool Patterns — Claude Code Cross-Reference.md>),
[`Claude Code In-App Patterns`](<../archive/decisions/Claude Code In-App Patterns — Lessons For Push.md>),
[`Copilot SDK Research`](<../archive/decisions/Copilot SDK Research.md>),
[`Hermes Agent`](<../archive/decisions/Hermes Agent — Lessons For Push.md>),
[`opencode SDK Review`](<../archive/decisions/opencode SDK Review.md>),
[`pi-mono Agent Loop Review`](<../archive/decisions/pi-mono Agent Loop Review.md>).
