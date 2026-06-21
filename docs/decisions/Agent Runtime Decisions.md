# Agent Runtime Decisions

Status: **Current**
Reviewed: 2026-06-21

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
ceremony unless `delegationMode: 'delegated'` / `PUSH_DELEGATION_MODE=delegated`
opts back in (the interactive analog of headless `--delegate`, sharing the
web preference's opt-in rule via `lib/delegation-mode.ts`). The second step
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
Orchestrator and CLI surfaces are unchanged) which the Coder kernel executes
in its read-phase `Promise.all`. `delegate:explorer` is part of the
lead-capable `coder` grant; the empty `extraToolSources` on a delegated
sub-Coder keeps the same call refused at the source gate.

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

Status: **Current** — shipped 2026-06-21 (web).

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

CLI parity (a `leadMode` pre-turn LLM compaction mirroring the coordinator) is the
remaining half — see Active Runtime Work item 11.

Source notes: [`How Codex CLI Handles Compacting`](<../research/codex-compacting.md>).

## Active Runtime Work

1. Delete the Planner/brief now that inline is the measured default (2026-06-11); attachments-on-engine-envelope is the prerequisite.
2. Ship auto-branch-on-commit as the universal commit-flow for scratchpad work.
3. Decide scratchpad durable-storage substrate per platform.
4. Finish TUI daemon-session controller extraction.
5. Graduate loop detection enforcement only after telemetry supports thresholds.
6. Memory Phase 3 immutable verbatim logs — **shipped 2026-06-21** (kernel + CLI file backend + write-path `verbatimRef` stamping + `memory_expand` resolution + reducer raw-retention/recall via `memory_expand` `refs`). Only the Worker durable backend remains, tracked in **#1063** (blocked on a Worker-side typed-memory store). See the LCM doc's Phase 3.
7. Promote the diff/annotation envelope only when a roadmap item needs it.
8. TUI focus-stack migration (§12) — **complete**: the whole `processInput` dispatch resolves through the stack across six declarative scopes. Push/pop self-registration was considered and declined (see §12); declarative `isActive()` against authoritative state is the end state.
9. Converge the CLI/daemon terminal chat onto the single conversational lead (a `leadMode` run of the shared kernel), so the TUI feels like the app with local reach (§10) instead of the delegated org-chart model. Step 1 landed 2026-06-12: interactive turns default to the in-loop lead with the Planner wrapper behind `PUSH_DELEGATION_MODE=delegated`. Step 2 landed 2026-06-12: the lead-kernel lane (`cli/lead-turn.ts`) runs the turn on the shared kernel in `leadMode`. Step 3 landed 2026-06-12: the lane is the **default**; `PUSH_LEAD_RUNTIME=engine` is the exact-match opt-out while it bakes. Step 4 — **complete**: the bake-period `PUSH_LEAD_RUNTIME=engine` opt-out and the CLI-local engine round loop are retired; `runAssistantTurn` delegates unconditionally to the kernel lane and the now-unreachable helper cluster the loop left behind in `cli/engine.ts` (awareness guard, finalization/parse-error builders, mid-session distill — no callers once `runAssistantLoop` was gone; the kernel owns these live concerns) plus its obsolete tests were removed. Behavior-neutral removal.
10. Tool-output compaction (§13): the TokenJuice pattern is **already shipped** (`lib/tool-output-reducers.ts`, both surfaces). The remaining "keep the raw output losslessly" half is folded into memory Phase 3 (item 6) — a reduced result stamps a `verbatimRef` into `lib/verbatim-log.ts`. A declarative `.push/`-scoped rule overlay is deliberately deferred (YAGNI until a repo needs custom rules).
11. Context-window compaction (§14): **always-on + visible + LLM-summarized shipped 2026-06-21 (web)** — toggle removed, `lib/llm-compaction.ts` engine + `app/src/hooks/chat-compaction.ts` coordinator wired pre-turn, three visibility surfaces. Remaining: CLI/daemon parity (a `leadMode` pre-turn LLM compaction reusing the shared engine), and graduating the run-event `phase` vocabulary if ops need to distinguish heuristic-summarization from LLM-summarization (today both report `phase: 'summarization'` to avoid churning the drift-pinned `context.compaction` schema).

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
