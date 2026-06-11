# Coder Delegation Collapse — Component Audit

Date: 2026-06-02 (cross-linked 2026-06-03)
Status: **ROADMAP-tracked (first priority, promoted 2026-06-03); step 1 landed behind a flag (2026-06-03), still default-off and unmeasured.** Sequenced *first* in the combined "Single-Agent Loop + Branch-at-Commit Persistence" item — category-2 cut goes behind a flag and is measured against the delegated path before any deletion. **Step 1 shipped:** a `delegation-mode` preference (`delegated` default | `inline`) routes interactive turns to the durable single-agent engine (`startMainChatJob`) when `inline`, reusing — and deliberately decoupled-in-framing from — the existing background-mode engine route; both arcs now emit comparable measurement (`coder_delegation_measured` on the delegated arc, `delegation_engine_job_started` + the CoderJob DO's `coder_job_*` logs on the inline arc). The Planner/brief are NOT deleted. Flip to `Current` when the lead-drives-the-engine-inline path is the *default* (after the A/B gate clears).

> **2026-06-11 update (post-flip):** the A/B gate cleared and `inline`
> became the default (#887) on the engine seam — and the seam then moved.
> The step-1 "inline = engine turn" routing was superseded by
> [`Inline Foreground Lane — Local While Watched.md`](../../decisions/Inline%20Foreground%20Lane%20—%20Local%20While%20Watched.md)
> (Current): inline turns now run the coder kernel **in the browser as the
> lead agent** (`chat-send-inline.ts` + `inline-coder-run.ts`), with the
> CoderJob DO engine reachable via the explicit background-mode toggle and
> `startMainChatJob` retained for the eval harness. The collapse itself
> (no Orchestrator handoff / no Planner / no brief on inline turns) stands;
> the measurement vocabulary gained `inline_turn_started` /
> `inline_turn_completed` for the foreground lane. Categories 2–5 and the
> deletion gate are unchanged.
Owner: Push
Related: [`Main as Scratchpad — Branch on Graduation.md`](Main%20as%20Scratchpad%20—%20Branch%20on%20Graduation.md) — **pairs with this track.** Same move (frontier-lead expired a scaffolding layer → cut the wrapper, keep the engine), same two durable floors (job engine + snapshot). Its `auto-branch-on-commit` is the durability story for the collapsed single-agent loop, and a *headless detached engine run* (more central after this collapse) can't answer a prompt — which is independent evidence auto-branch beats a prompt. **Note the Auditor reconciliation in Category 4 below.**

## Premise

Coder delegation was built for two reasons that have both expired: cheap context
management, and keeping small models focused. With a frontier model in the lead
slot, the first is a *display* problem (now handled by the role-display seam,
[`Role Display De-emphasis.md`](Role%20Display%20De-emphasis.md), PR #758) and
the second is moot. In practice the delegation handoff is "more trouble than
it's worth — at best it works, at worst it hangs."

A code trace + the `CoderJob` DO test suite (`app/src/worker/coder-job-do.test.ts`,
21 cases green) established the load-bearing facts:

- **"Don't lose the sandbox"** is delivered by idle hibernation → R2 snapshot →
  restore (`app/src/hooks/useSandbox.ts:248`), independent of jobs and delegation.
- **"Don't lose the work"** is delivered only by the **durable job engine** — the
  DO runs server-side via `ctx.waitUntil` (`coder-job-do.ts:530`), reattaches via
  `Last-Event-ID` replay, checkpoints, and resumes across eviction with bounded,
  loudly-logged failure modes.
- That engine is **separable from delegation**: a raw user turn already runs
  through it with no Orchestrator handoff and no Planner
  (`app/src/hooks/chat-send-background.ts:91` → `startMainChatJob`), and the DO's
  `runLoop` is role-agnostic by design (`coder-job-do.ts:542–546`).

So the target is: **keep the engine, collapse the wrapper.** This audit
classifies the delegation surface so the cut is surgical.

## Governing rule

Keep intact, do not touch in this track: the durable job engine, event replay,
checkpoints, structured logs, and every safety boundary. **Remove only what is
proven non-load-bearing** — categories 1 and 2 below. **Categories 3–5 are
protected** and are not removed yet.

## Classification

| # | Category | Components (with pointers) | Verdict |
|---|----------|----------------------------|---------|
| **1** | **Display-only** | Role/agent labels and the delegation framing in the cards/console — `DelegationResultCard`, `CoderProgressCard`, `JobCard`, `HubConsoleTab` subagent/source lines. | **Already de-emphasized** in PR #758 via `lib/role-display.ts`. Whatever remains collapses cleanly with the wrapper; nothing runtime depends on it. |
| **2** | **Prompt / brief ceremony** | The Planner pre-pass (`app/src/lib/planner-agent.ts`, `lib/planner-core.ts`, `PLANNER_SYSTEM_PROMPT`, `runPlanner`/`formatPlannerBrief`); the delegation brief (`lib/delegation-brief.ts`, `buildCoderDelegationBrief`); the inline sequential handler's always-delegate-then-handoff default (`app/src/lib/coder-delegation-handler.ts:435–504`). | **Primary cut target.** This is the small-model crutch and the lossy-intent handoff. Removing it lets the lead agent run the task directly (interactive) or via the existing background-main-chat entry (detached). |
| **3** | **Event-shape compatibility** | `subagent.*` / `task_graph.*` event types (`lib/runtime-contract.ts:348+`), the v1↔v2 downgrade (`cli/v1-downgrade.ts`), the strict protocol pins (`lib/protocol-schema.ts`) and their drift tests. | **PROTECTED — do not remove.** The web↔CLI/daemon relay and attach clients decode these. Shapes can be *retired* later only behind a versioned protocol change with the drift tests updated in lockstep. |
| **4** | **Runtime safety boundary** | Capability gating (`lib/capabilities.ts` `ROLE_CAPABILITIES`, `delegate_coder`/`delegate_explorer` grants :133, `roleCanUseTool`, read-only Explorer gate); Auditor SAFE/UNSAFE commit gate (`lib/auditor-agent.ts`); Protect Main; the `git checkout`/`switch` blocks; DO resume cap (`MAX_DO_RESTART_RESUMES`) and wall-clock alarm. | **PROTECTED — do not remove.** These are consent/correctness boundaries, not delegation ceremony; they survive the collapse, and a single-agent world still needs a safety gate. **Auditor reconciliation (2026-06-03):** the [scratchpad doc](Main%20as%20Scratchpad%20—%20Branch%20on%20Graduation.md)'s open-Q #2 concludes the model-Auditor should *unbundle*. No contradiction once you split **function vs implementation**: the safety *function* is protected (still needed here), but its *implementation* relocates — at auto-push it becomes a deterministic secret-scan + the existing PR reviewers + Protect Main, not a per-commit model-judge. So: protect the gate's *job*, don't protect the *model-Auditor as the mechanism*. Capability gating + Protect Main + the git blocks remain unconditionally protected. **Update (2026-06-06):** the mechanical/secrets half of the relocation now exists — `lib/secret-scan.ts` + the `PrePushGate` seam on `PushGit.push()`, wired into the web commit/push flow (see the scratchpad doc's open-Q #2). The model-Auditor is *not* removed; the deterministic scan is an additional pre-push backstop today ~~and the relocation target once auto-push lands~~. **Update (2026-06-08):** struck "relocation target" — nothing migrates. The scan covers a *narrower* path (the auto-push transport that structurally skips `prepare_commit`) for a *narrower* class (secrets, which a regex catches and a semantic judge might not bother to); it does **not** absorb the model-judge's XSS/auth/injection reasoning. The model-Auditor stays the per-commit gate in **every** mode, including Autonomous/Full-Auto, because its verdict's reader is the agent loop (UNSAFE → Coder revises), not a human — so the headless-can't-answer premise behind "relocate it" is void. Evidence: an Autonomous-mode session where the Auditor blocked three commits on a markdown-renderer change and the model shipped cleaner each time. See the [scratchpad doc](Main%20as%20Scratchpad%20—%20Branch%20on%20Graduation.md)'s open-Q #2 head + Remaining note (both reframed same day). |
| **5** | **Progress / liveness relevant** | Checkpoint cadence (`coder-agent.ts`), SSE heartbeat, the wall-clock alarm, orphan resume, and the run-events that feed progress UI (`CoderProgressCard` working memory). | **PROTECTED — do not remove.** This is how a detached run stays observable and recoverable. See the separate liveness note ([`Kernel Progress Liveness.md`](Kernel%20Progress%20Liveness.md)) — that work *adds* to this category, it does not subtract. |

## The engine (explicitly out of scope for removal)

`coder-job-do.ts`, `worker-coder-job.ts`, `useBackgroundCoderJob.ts`, the
`/api/jobs/*` endpoints, the checkpoint/snapshot/restore machinery, and
`chat-send-background.ts` stay. The kernel `lib/coder-agent.ts` stays — it is the
work engine, not the wrapper. The end state is the lead agent driving that engine
directly, not an Orchestrator briefing a separate Coder role.

## Sequencing (not a commitment until a ROADMAP entry exists)

1. **Cut category 2 first** behind a flag: stop forcing `delegate_coder` → brief →
   Planner for interactive edits; let the lead edit inline, and keep the
   background-main-chat entry for detached runs. Measure quality/latency vs. the
   delegated path before deleting code. **(LANDED 2026-06-03, default-off):** the
   `delegation-mode=inline` preference (`app/src/lib/delegation-mode-settings.ts`)
   routes the turn through `startBackgroundMainChatTurn` → `startMainChatJob` — the
   raw user turn on the durable engine, no Orchestrator/Planner/brief — selected at
   the single `resolveTurnEngineTrigger` seam in `useChat.sendMessage`. The delegated
   arc is untouched and still default. Both arcs emit measurement for the A/B gate.
   The chosen seam is the durable DO engine (not a foreground in-browser inline lane),
   so an inline turn currently inherits the detached/JobCard UX — same mechanism as
   background-mode, reframed as the collapse experiment.
2. Once interactive-inline is the default, **delete the Planner and brief
   ceremony** (category 2 proper).
3. Re-evaluate task-graph parallelism on its own merits — its *events* are
   category 3 (protected); its *Planner→graph wiring* is category 2.
4. Categories 3–5 remain untouched throughout.

## To verify before cutting category 2

- Does anything besides the interactive Orchestrator path consume
  `buildCoderDelegationBrief` output in a way that isn't ceremony? (Inference: no —
  the DO receives a pre-formatted `plannerBrief` string and never runs the Planner
  itself.)
- Does the CLI/daemon emit `subagent.*` for delegated coder runs that a remote
  attach client renders? If so, the collapse must keep emitting a compatible
  event shape (category 3) even when the lead runs inline.

## Step 2 cut plan (recon, 2026-06-03 — NOT YET CUT; gated on the step-1 A/B)

A trace of the actual blast radius shows the audit's one-line "delete the Planner
and brief ceremony" is really **three separately-gated cuts**, and a naive
"delete `planner-agent.ts` + `delegation-brief.ts`" would break two protected
surfaces (the inline path we just shipped, and a category-3 protocol enum). The
cuts, smallest-first:

### Cut 2a — the web foreground Planner pre-pass (the actual step-2 target)

- **Delete:** the Planner pre-pass block in `app/src/lib/coder-delegation-handler.ts`
  (the `if (harnessSettings.plannerRequired && taskList.length === 1)` arm — the
  `runPlanner` call, the `plannerBrief` thread into `runCoderAgent`, the
  `subagent.started/completed {agent:'planner'}` emission **on this path only**);
  `app/src/lib/planner-agent.ts` (web wrapper around `runPlannerCore`) once
  orphaned — confirm its only consumer is the handler before deleting (it
  re-exports `formatPlannerBrief` + planner types; re-point any stray importer at
  `lib/planner-core.ts`).
- **`plannerRequired`** (`app/src/types/index.ts:249`, `model-capabilities.ts`
  standard=false/heavy=true, the `harness-profiles.ts:165` malformed-call
  adaptation that escalates it) becomes dead for web once 2a lands — the
  adaptation branch and likely the field go too. CLI never reads it
  (`cli/harness-adaptation.ts:19`), so this is a web-only removal.
- **Tests touched (update/remove):** `planner-agent.test.ts`, the Planner sub-seam
  cases in `useAgentDelegation.test.ts`, `harness-profiles.test.ts` (the
  plannerRequired adaptation), `model-capabilities-resolve.test.ts`. Also drop the
  `plannerRan` field from `coder_delegation_measured` once the pre-pass is gone (it
  becomes constant-false).

### Cut 2b — the orchestrator-synthesized brief params (gated on retiring the foreground delegated path, NOT on 2a)

- The "brief ceremony" the model performs is synthesizing
  `intent/deliverable/knownContext/constraints/acceptanceCriteria` into the
  `delegate_coder` args (`lib/tool-registry.ts:218` schema + the
  `lib/orchestrator-prompt-builder.ts:196-210` guidance). Removing those params
  from the tool schema + prompt is only safe **once the foreground delegated path
  is fully retired** (i.e. inline is default *and* the Orchestrator→`delegate_coder`
  arc is removed) — until then the orchestrator still legitimately uses them.
- **DO NOT touch `buildCoderDelegationBrief`** (`lib/delegation-brief.ts` via
  `role-context.ts`). It is the kernel envelope→preamble expansion and is called by
  **both** `coder-agent.ts:326` (foreground) **and `coder-job-do.ts:663` — the
  inline engine path we just shipped.** It is not ceremony; it is how the
  single-agent loop frames its raw task. This corrects the audit's category-2 line
  that listed `delegation-brief.ts` for removal: the *shared expansion stays*; only
  the *orchestrator-side synthesis + the params that invite it* are ceremony.

### Cut 2c — the CLI Planner + `planner-core.ts` + task-graph wiring (this is STEP 3, not step 2)

- `cli/delegation-entry.ts` wires the Planner into the CLI's **task-graph**
  pipeline (`runPlannerCore`, `planToTaskGraph`, `runDelegatedHeadless`), and
  `lib/planner-core.ts` is its shared kernel. Per sequencing item 3, task-graph
  parallelism is re-evaluated on its own merits — so the CLI Planner and
  `planner-core.ts` are **out of scope for step 2** and stay until step 3.

### Protected — do not touch in any step-2 cut

- **`'planner'` is a category-3 protocol agent type** (`lib/protocol-schema.ts:325`,
  `lib/runtime-contract.ts:187,268`, pinned by `cli/tests/daemon-integration.test.mjs`).
  Step 2 **stops emitting** planner events but **keeps the enum value** — removing it
  is a versioned protocol change with the drift tests updated in lockstep, never a
  side effect of 2a.

**Net:** step 2 (when the A/B clears) = cut 2a only — a contained web-side removal.
2b waits on retiring the foreground delegated path; 2c is step 3. The "before
deleting" gate from sequencing item 1 still governs even 2a: no data yet (inline is
default-off as of the step-1 merge), so this plan is staged, not executed.
