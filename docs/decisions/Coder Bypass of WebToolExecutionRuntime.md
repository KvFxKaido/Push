# Coder Bypass of WebToolExecutionRuntime

Date: 2026-05-14
Status: Current
Companion to: [`phase-5-tool-runtime-brief.md`](./phase-5-tool-runtime-brief.md), [`push-runtime-v2.md`](./push-runtime-v2.md), [PR #546](https://github.com/KvFxKaido/Push/pull/546)
Code: [`lib/coder-agent-bindings.ts`](../../lib/coder-agent-bindings.ts), [`app/src/lib/web-tool-execution-runtime.ts`](../../app/src/lib/web-tool-execution-runtime.ts)

## Why this exists

PR #546 promoted the role-capability check into the dispatch kernel as part of the OpenCode silent-failure audit (#3). Every web/CLI tool path routes through one of two seams that now enforce `enforceRoleCapability` unconditionally:

- **Web orchestrator / Explorer / deep-reviewer:** `WebToolExecutionRuntime.execute`
- **CLI engine + daemon (Coder, Explorer, Reviewer):** `cli/tools.ts:executeToolCall`

The **web Coder path** doesn't go through either. `buildCoderToolExec` in `lib/coder-agent-bindings.ts` dispatches directly to `executeSandboxToolCall` / `executeWebSearch` from the services bag. PR #546 closed the role-check loophole by inlining `enforceRoleCapability('coder', ...)` at the top of the closure, but the broader question — *why does Coder bypass the runtime at all?* — was punted to this doc.

This doc captures the answer: **the bypass is intentional** because Coder's autonomy contract conflicts with the runtime's interactive pipeline. The inline `enforceRoleCapability` is an explicit two-site invariant — accepted with drift-test mitigation, not framed as the cleanest possible shape. **One caveat to flag up front:** the bypass leaves a real Protect Main gap on the Coder path that this doc identifies but does not fix; see [Open work](#open-work) for the proposed shape.

## What the runtime does that Coder doesn't want

`WebToolExecutionRuntime.execute` runs every call through a pipeline:

1. Role capability check (`enforceRoleCapability`)
2. Pre-hooks (`ToolHookRegistry`) — arbitrary tool-arg rewrites, decision gates
3. Approval gates (`ApprovalGateRegistry`) — interactive "ask user" prompts for destructive ops
4. Protect Main — blocks commit/push tools when on the default branch
5. `localDaemonBinding` routing — forks to the `pushd` daemon for `local-pc` sessions
6. Per-source execution (sandbox / GitHub / web-search / artifacts / ask-user)
7. Post-hooks (`ToolHookRegistry`) — result rewrites, structured-error injection

Items 1–7 are tuned for the **orchestrator chat path**: a human is in the loop, the UI can prompt, and approval interruptions are part of the UX.

Coder runs **autonomously inside a delegation**:

- Triggered by a `delegate_coder` tool call from the orchestrator, not by direct user input.
- Runs to completion against an acceptance criteria budget; the orchestrator surfaces a summary at the end.
- Can run in the **background** (Durable Object surface, `app/src/worker/coder-job-do.ts`) where there is no UI to prompt.

The pipeline items conflict with that contract:

| Pipeline step | Why Coder bypasses |
|---|---|
| **Pre/post hooks** | Web hooks are policy-shaped (`ToolHookRegistry`). Coder uses its own `TurnPolicyRegistry` with phase-aware semantics (`createCoderPolicy()`) that the bindings invoke directly via `evaluateBeforeTool` / `evaluateAfterTool`. Routing through `ToolHookRegistry` would require translating Coder policies into hooks, or running both, or losing the phase-awareness. |
| **Approval gates** | Approval gates open `ask_user` flows. Coder is supposed to be autonomous — interrupting a delegation with a UI prompt defeats the purpose. The background DO surface has no UI at all; an approval gate would hang the job. |
| **Protect Main** | Coder is the role that creates commits and pushes. Blocking those tools at the runtime layer (the way `WebToolExecutionRuntime` does for the orchestrator path) would be a circular constraint — Coder is *how* a Protect-Main-respecting commit gets produced. **Known gap:** today the Coder path receives `branchContext.protectMain` only as `[WORKSPACE CONTEXT]` prompt text (see `lib/coder-agent.ts`, `lib/explorer-agent.ts`, `lib/deep-reviewer-agent.ts`); there is no code-level orchestrator-side refusal to delegate when on `main`, nor a Coder-side `sandbox_prepare_commit` / `sandbox_push` gate. Surface enforcement today is the orchestrator's runtime check on its own `sandbox_prepare_commit` / `sandbox_push` calls (`PROTECTED_MAIN_TOOLS` in `web-tool-execution-runtime.ts`), which Coder bypasses. Real enforcement for the Coder path needs a separate decision — see the "Open work" section below. |
| **`localDaemonBinding` routing** | Coder runs against a managed sandbox (cloud Cloudflare Sandbox or Modal). Local-PC daemon binding is a different transport entirely. |
| **Capability ledger** | Coder uses `CapabilityLedger` to track *declared-vs-used* capabilities for delegation audit — a contract the runtime doesn't have a slot for. |

The runtime's pipeline is correct for the orchestrator chat path because that's the contract it was built for. The runtime already supports conditional injection — `if (context.approvalGates)`, no-op hook registries, omitted `localDaemonBinding` — so "Coder uses the runtime with everything off" is *technically* available. The real blocker is item 2: Coder's `TurnPolicyRegistry` is phase-aware in ways `ToolHookRegistry` isn't, and there's no slot in the runtime for the `CapabilityLedger` either. Routing Coder through the runtime would mean:

- **Inherit items 2–7** — a behavior change that breaks autonomous delegation (interactive prompts inside background jobs, hooks that don't understand Coder phases).
- **Force-disable items 2–7** — pass `undefined` for everything except sandbox dispatch. The runtime collapses to a switch over `call.source`, which is what the bindings layer already is. Coder's policy + ledger machinery still has to live on Coder's side because the runtime has no slot for them, so the "unification" doesn't actually consolidate anything.

## What the bypass keeps

The web Coder path inside `buildCoderToolExec` runs its own pipeline shaped for delegation semantics:

1. Source filter (`call.source !== 'sandbox' && call.source !== 'web-search'` → `denied`)
2. **Role capability check** (`enforceRoleCapability('coder', ...)`) — landed in PR #546
3. `policy.evaluateBeforeTool` — phase-aware turn-policy gates from `TurnPolicyRegistry`
4. `capabilityLedger.isToolAllowed` — declared-vs-used budget check
5. Per-source execution via `executeSandboxToolCall` / `executeWebSearch` from the services bag
6. Sandbox health probe on `SANDBOX_UNREACHABLE`
7. `policy.evaluateAfterTool` — phase-aware result hooks
8. OTel span attributes (`push.agent.role: 'coder'` + correlation tags) via the tracing services adapter

Items 2, 3, 4, 6, 7 are Coder-specific concerns the orchestrator pipeline doesn't model. Item 2 is the kernel invariant; the rest are autonomy-shaped.

## The DO surface keeps the same shape

`app/src/worker/coder-job-do.ts` (background Coder jobs) consumes `buildCoderToolExec` from `lib/coder-agent-bindings.ts` and supplies its own services bag (`buildCoderJobServices` in `coder-job-services.ts`). The DO bypasses the runtime *more strongly* than Web — it has no `WebToolExecutionRuntime` at all, no `ToolHookRegistry`, no `ApprovalGateRegistry`, and no chat-side UI.

Today, Web and DO share `buildCoderToolExec` because they call the same `lib/` function — not because the bindings layer is inherently more portable than a runtime. But that shared call site is what lets the inline `enforceRoleCapability` check cover both surfaces from one place. Unifying Web's Coder path through `WebToolExecutionRuntime` would split that: Web Coder would route through the runtime, DO Coder wouldn't, and the kernel invariant would need to live in both the runtime *and* the bindings layer. Keeping both surfaces on the bindings layer is what keeps the invariant single-sourced. **This is contingent, not architectural** — if the DO grows enough infrastructure to host its own runtime (see revisit trigger #3 below), the symmetry argument flips.

## The hard rule

**Coder does not go through `WebToolExecutionRuntime`. Capability enforcement is inlined at the top of `buildCoderToolExec` and runs on both Web and DO surfaces. The runtime's interactive-pipeline features (approval gates, pre/post hooks, `localDaemonBinding` routing) are deliberately not available to autonomous delegations.**

*Caveat on Protect Main:* it was grouped with the runtime's interactive features in earlier drafts, but unlike approval gates or `localDaemonBinding`, Protect Main is a correctness invariant the user expects globally — not an interactive affordance. The Coder path's lack of Protect Main is a gap to close, not a feature of the bypass. See [Open work](#open-work).

If a future feature needs Coder to integrate with one of those pipeline items, the right move is to extend the bindings layer with a parallel adapter (matching what the DO surface does), **not** to fold Coder into the runtime.

## Trade-offs and revisit triggers

What we gave up by keeping the bypass:

- Two seams to maintain (`WebToolExecutionRuntime` for non-Coder web, bindings for Coder + DO). Both currently call `enforceRoleCapability`, so the kernel invariant doesn't drift; routine drift detection happens in `cli/tests/role-required-drift.test.mjs` for production CLI surfaces and via TypeScript's required-field enforcement on `ToolExecutionContext`.
- Web Coder won't pick up new orchestrator-pipeline features automatically. Anyone adding a new hook/gate to `WebToolExecutionRuntime` has to think about whether it should also apply to Coder (which usually means: no, Coder is autonomous; or yes, build a Coder-shaped equivalent in the policy registry).

Revisit if any of these become true:

1. **Coder needs interactive approval.** If a future Coder run must pause for user approval mid-delegation (e.g. for explicitly opt-in dangerous operations), the bindings layer would need an approval seam. At that point, sharing the runtime's `approvalCallback` plumbing may be cheaper than reinventing it — but the decision should be driven by the new feature, not by code-shape symmetry.
2. **The kernel invariant gains a third call site.** If a new tool-execution surface (e.g. a server-side auditor that's neither orchestrator nor Coder) appears, this doc should be revisited to confirm whether the bindings layer is the right home for cross-surface invariants or whether `WebToolExecutionRuntime`'s scope should expand.
3. **The DO surface gains a runtime.** If background Coder jobs grow enough infrastructure that a `DOToolExecutionRuntime` makes sense, Web routing through `WebToolExecutionRuntime` becomes symmetric with DO, and the bypass becomes the odd one out. Until then, both surfaces sharing the same bindings layer is the simplest shape.

Of these, **trigger #3 is the most plausible near-term shift.** Background Coder is already non-trivial infrastructure (DO + services bag + job state machine), and a `DOToolExecutionRuntime` is a credible refactor target. This doc captures the right shape *for the current state of the DO surface* and explicitly opts into being revisited — it should not be cited as permanent doctrine.

## Open work

- **Protect Main for the Coder path** (correctness gap, not nice-to-have). The bypass means Protect Main — which today refuses `sandbox_prepare_commit` / `sandbox_push` from the orchestrator path via `PROTECTED_MAIN_TOOLS` in `web-tool-execution-runtime.ts` — doesn't gate the Coder path. A user with Protect Main on can produce a commit-to-`main` via `delegate_coder` that they would not have been allowed to produce directly. Coder sees the flag as `[WORKSPACE CONTEXT]` prompt text (`lib/coder-agent.ts`, `lib/explorer-agent.ts`, `lib/deep-reviewer-agent.ts`), which a cooperating model honors but a non-cooperating model can ignore. Per the "Behavior lives in code, not prompts" convention, this belongs in code. Two reasonable fix shapes:
  1. **Orchestrator-side refusal.** Block `delegate_coder` (and the task-graph `plan_tasks` equivalent) when `branchContext.protectMain && activeBranch === defaultBranch`. Cheap, but loses the "Coder is *how* you produce a commit" affordance — the user would need to switch branches before delegating at all.
  2. **Coder-side enforcement.** Mirror `PROTECTED_MAIN_TOOLS` inside `buildCoderToolExec` so commit/push tools deny when on `main` even though the runtime is bypassed. The role gate already runs at the same seam in `buildCoderToolExec`; Protect Main slots in alongside it. Preserves the "delegate, then commit on a feature branch" UX.

  Option 2 is the right shape — the orchestrator can still hand the task off, and Coder denies the commit at the bottom of the stack the same way the runtime denies it for non-Coder paths. Tracking as a follow-up; not landing in the same change as this doc because it's a code change, not a decision.

## Related work

- **PR #546** — kernel role-capability check, with `enforceRoleCapability` inlined into `buildCoderToolExec`. Closed the silent-skip loophole; this doc explains why the inline check is the correct level of integration rather than full runtime unification.
- **`phase-5-tool-runtime-brief.md`** — the original Web tool-runtime extraction. The brief covered orchestrator, Explorer, and deep-reviewer paths; Coder was left out by design because the bindings layer already existed.
- **`push-runtime-v2.md`** — ongoing runtime design space. If a v2 runtime contract emerges that's surface-agnostic enough to host both interactive and autonomous flows, this decision may flip.
