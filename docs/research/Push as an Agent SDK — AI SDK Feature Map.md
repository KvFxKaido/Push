# Push as an Agent SDK — AI SDK Feature Map

Status: Reference (research snapshot, 2026-06-26)
Source: Vercel **AI SDK 7** (`@aisdk`) feature announcements + Push's `lib/`
runtime contracts. API names verified against the AI SDK docs / Vercel
changelog (vercel/ai `content/docs`, `vercel.com/blog/ai-sdk-7`,
`vercel.com/changelog/program-agent-harnesses-with-ai-sdk`).

## Why this doc exists

Push isn't *using* an agent SDK — it's *being* one. The cross-surface runtime
in root `lib/` (provider seam, tool protocol, agent loop, approval gates,
durable runs, telemetry) is already the surface a published SDK would expose,
just without the front door. This doc takes the AI SDK's recent public surface
— the thing people reach for when they want "an agent framework" — and maps it
onto the primitives Push already ships, so we can see three things at once:

1. **What Push already has** (usually deeper, because Push is a *governed*
   runtime, not a library).
2. **The genuine gaps** worth borrowing as concepts.
3. **The missing facade** — Push has the engine and no labeled dashboard. If
   we're building an SDK, the highest-leverage move is naming the surface, not
   adding capabilities.

This is a *concept* map, not a dependency proposal. Per
[`CLAUDE.md`](../../CLAUDE.md) ("Capability sourcing: fold in, don't outsource"),
adopting `@ai-sdk` as a dependency would invert Push's thesis — the provider
seam (`lib/provider-contract.ts`, the Anthropic-conceptual neutral hub) is
exactly the layer the AI SDK would replace, and it's load-bearing. The value
here is *vocabulary*, not packages.

## The map

Each row is a feature from the AI SDK announcements, paired with the Push
primitive that already covers it (or the gap if none does).

| AI SDK feature | Push equivalent | State |
|---|---|---|
| **`reasoning: 'high'`** — one standard reasoning knob across providers | `lib/reasoning-models.ts`, `lib/reasoning-tokens.ts`, normalized through `lib/provider-contract.ts` | ✅ Have it. Provider-neutral by design — the neutral hub *is* the normalization layer. |
| **`ToolLoopAgent` + `toolApproval`** — agent loop with automatic or human-in-the-loop tool approval (per-tool values like `'user-approval'`, plus a policy path via `@ai-sdk/policy-opa` / Open Policy Agent) | The round loop (`cli/engine.ts`, `app/src/hooks/chat-*`) + `lib/approval-gates.ts` (`supervised` / `autonomous` / `full-auto`) + the Auditor gate + per-turn side-effect budget | ✅ Have it. Both ship a policy-style approval engine now — Push's edge is *integration*: approval is wired to the capability ledger and the fail-closed **delivery** gates (Gate-at-Push, Protect Main), not a standalone policy module. |
| **Typed private tool context** — tools get context the model never sees | `lib/role-context.ts`, `lib/tool-execution-runtime.ts`, `ToolHookContext` (`lib/tool-hooks.ts`) | ✅ Have it. Context is threaded through the execution runtime, not the prompt. |
| **`runtimeContext` + `prepareStep`** — typed state shared across steps/approvals/telemetry | `lib/working-memory.ts`, `lib/context-memory*` (store/retrieval/packing/invalidation), `lib/correlation-context.ts`, `lib/delegation-brief.ts` | ✅ Have it, **scattered**. The state exists and is typed; it just isn't presented as one `runtimeContext` object. (See gap #2.) |
| **`uploadFile` → provider file references** — upload once, reuse the reference across multi-step calls | Partial: `lib/artifacts/`, `lib/scratchpad-tools.ts` | ⚠️ **Gap.** Push re-sends file content per call. Provider-side file handles would cut tokens on multi-step coder runs. (See gap #1.) |
| **`uploadSkill`** — upload skills, attach to provider-managed agent runs | Workspace skills: `.push/skills/*.md`, `.claude/commands/**/*.md` (CLI auto-load) | ◐ Have the *concept*, client-side. Push skills are loaded into the prompt locally; not registered as provider-managed assets. Fine for now — keeps skills inspectable and surface-portable. |
| **MCP apps** — model-visible tools + app-only tools + resources + sandboxed UI | MCP is **CLI-scoped by decision** ([`CLAUDE.md`](../../CLAUDE.md) "MCP, when it lands, is CLI-scoped"); sandboxed UI = `lib/artifacts/` | ✅ Deliberately bounded. The "app-only tools + sandboxed UI" idea maps to artifacts; the ungoverned-reach part is intentionally *not* on the web surface. |
| **Host-executed tools in a restricted sandbox** — `experimental_sandbox.readTextFile(path)` | `lib/sandbox-provider.ts`, `lib/sandbox-policy.ts`, `sandbox_exec`, capability gating (`lib/capabilities.ts`) | ✅ Have it, **deeper**. Two backends (CF/Modal) behind one `SandboxProvider`; git policy + remote-mutation blocks layered on top. |
| **`HarnessAgent`** — run established harnesses (Claude Code, etc.) through one agent interface | `lib/run-host-adoption.ts`, `lib/run-adoption-loop.ts` | ◐ Inverse framing. Push *is* the harness (the CLI/daemon is the lead with more reach); adoption lets a run survive host loss. AI SDK wraps foreign harnesses; Push runs its own. Worth noting the symmetry but not chasing it. |
| **Terminal UI for agents** — run an agent in a TUI in a few lines | The Push TUI (`cli/`, `docs/cli/design/`) | ✅ Core surface, not an add-on. |
| **`WorkflowAgent`** — durable agents that survive restarts, deploys, interruptions, delayed approvals | `lib/run-checkpoint.ts`, `lib/run-host-adoption.ts` (Adopt-on-Silence), `app/src/worker/coder-job-do.ts` resume path, `docs/decisions/Durable Runs — Adopt-on-Silence.md`, `Checkpoint Recovery on Sandbox Loss.md` | ✅ Have it, **deeper**. Durability is checkpoint + DO-driven adoption with a watchdog, not just retry. |
| **`registerTelemetry(new OpenTelemetry())`** — pluggable telemetry provider | `lib/prompt-cost-telemetry.ts`, `lib/loop-metrics.ts`, `lib/correlation-context.ts`, symmetric structured logs (`console.log`/`console.error` JSON lines) | ◐ Have the *data*, no **OTel exporter**. Push emits structured logs and cost telemetry but doesn't speak OpenTelemetry. (See gap #3.) |
| **Lifecycle callbacks** — `onStart` / `onLanguageModelCall` / `onStepFinish` / `onFinish` | `lib/run-events.ts` + `RunEvent` types in `lib/runtime-contract.ts` (`assistant.turn_start`, `tool.execution_start`, `subagent.started`, `job.started`, …) | ✅ Have it, as an **event stream** rather than callbacks. Push's `RunEvent` taxonomy is richer (per-tool, per-subagent, task-graph) but isn't exposed as a named callback contract. (See gap #2.) |

## Where Push is already ahead

The AI SDK is a *library* — it hands you primitives and trusts the caller.
Push is a *governed runtime*, and the governance is the moat the AI SDK
structurally can't have:

- **Capability ledger** (`lib/capabilities.ts`) — tools declare capabilities,
  roles grant them, runtime tracks declared-vs-used for audit and approval UI.
  AI SDK 7 has a policy engine (OPA) for *whether* a call is allowed, but no
  capability model tying approvals to roles and a declared-vs-used audit trail.
- **Gate-at-Push** + **Auditor gate** + **Protect Main** — delivery is gated on
  the cumulative push diff, fail-closed. No SDK ships a release gate.
- **Per-turn side-effect budget** — read-only calls parallel (cap 6), mutations
  batched (cap 8), at most one trailing side-effect. Ordering violations
  rejected with structured errors.
- **Untrusted-content handling** (`lib/untrusted-content.ts`) — external content
  (PR bodies, CI logs, comments) is treated as untrusted by contract.
- **Role model** — five locked internal roles with provider routing/lock
  inheritance, rendered phase-first via `lib/role-display.ts`.

These aren't features to add; they're the reason Push is a product and the AI
SDK is a dependency. Any "Push SDK" surface should *lead* with governance, not
bury it.

## Genuine gaps worth borrowing (as concepts)

Ranked by leverage.

### 1. Provider file references (`uploadFile` shape) — token savings
Push re-sends file content on every multi-step model call. A provider-side file
handle (Anthropic Files API / equivalent) reused across a coder run would cut
input tokens materially on long edit loops. To order-of-magnitude it: a long
coder run that re-reads a ~200-line file (~2K tokens) each turn over ~50 turns
re-sends on the order of 100K tokens that a content-hash-keyed reference would
send once — and that's one file, before counting the larger context a real edit
loop carries. This is a real efficiency win, not just ergonomics. Scope: a
`lib/` file-reference cache keyed by content hash, threaded through the coder
kernel. Smallest concrete adoption.

### 2. A named, typed SDK facade — the missing front door
**This is the highest-leverage item and the reason the branch is called
`custom-sdk-docs`.** Push has every primitive the AI SDK packages as one `Agent`
object, but they're spread across ~15 `lib/` modules with no `lib/index.ts`.
The AI SDK's actual product is *the assembly* — `new ToolLoopAgent({ model,
tools, toolApproval, runtimeContext, prepareStep })` — not any single
capability. Push should sketch the equivalent facade:

```ts
// lib/index.ts (proposed public surface — names illustrative)
export { createRun } from './run-engine-contract.js'      // the loop
export { defineTool, type ToolHookContext } from './tool-hooks.js'
export { approvalGates, type ApprovalMode } from './approval-gates.js'
export { capabilities, type Capability } from './capabilities.js'
export { runtimeContext } from './working-memory.js'       // the shared state
export { onRunEvent, type RunEvent } from './run-events.js' // the callbacks
export { providers } from './provider-contract.js'         // the neutral hub
```

The value isn't new code — it's giving the existing runtime a *labeled* surface
so "what is Push's agent API?" has a one-import answer. This also forces the
`runtimeContext` consolidation (gap from the map): today the shared typed state
is real but spread across `working-memory` / `context-memory*` /
`correlation-context`; a facade pressures it into one object.

### 3. OpenTelemetry exporter — cheap ops win

> **Resolved by posture, not code (2026-07-23).** #1190 closed as not-planned:
> the visibility goal this gap ranked on is met Cloudflare-natively for the
> sole deployment that exists (Workers Observability over the structured logs,
> Logpush→R2 traces #1577, cost/cache capture #951 + AI Gateway inspection,
> `/api/_stats` via Analytics Engine). What remained was portability to
> arbitrary OTel backends — a maintenance contract for external users Push
> doesn't have. Accepted residue and the reopen trigger live in #1190's
> closing comment.

Push has the telemetry *data* (`prompt-cost-telemetry.ts`, `loop-metrics.ts`,
structured logs) but no OTel exporter. A thin `registerTelemetry`-shaped adapter
that maps existing `RunEvent`s + cost telemetry to OTel spans would let users
point Push at their existing observability stack with zero new instrumentation.
Maps cleanly onto the symmetric-structured-log discipline already in
[`CLAUDE.md`](../../CLAUDE.md).

### 4. Named lifecycle-callback contract
Push's `RunEvent` stream is richer than the AI SDK's four callbacks, but it's an
internal taxonomy, not a public contract. If the facade (#2) ships, expose the
event stream as the `onStepFinish`/`onFinish`-equivalent so external consumers
have a stable hook surface. (Drift-detector test in the same PR, per the New
Feature Checklist.)

## What *not* to adopt

- **The `@ai-sdk` dependency itself.** It would replace `provider-contract.ts`,
  the load-bearing neutral hub. Fold-in, don't outsource.
- **Provider-managed skills** (`uploadSkill`). Push skills as local markdown
  (`.push/skills`, `.claude/commands`) stay inspectable, diffable, and portable
  across surfaces. Provider-managed skills trade that for a vendor lifecycle
  Push doesn't control.
- **`HarnessAgent` as a goal.** Push is the harness. Wrapping foreign harnesses
  is the opposite of the "single conversational lead" thesis. Adoption
  (`run-host-adoption.ts`) already covers the durability win that motivates it.

## Bottom line

Push has ~11 of 13 AI SDK capabilities already, several of them deeper because
they're governed rather than libraried. The two real gaps are **provider file
references** (token efficiency, small) and the **named SDK facade** (no new
capability, high leverage — it's the difference between owning an SDK and owning
a pile of modules that happen to be one). If we're embracing "I'm building my
own SDK," the facade in gap #2 is the thing to build; everything else is already
yours.

## Counter-read (second opinion, 2026-06-26)

A reviewing pass from the provider-contract / conformance work. Agreement on the
diagnosis — Push *is* the governed runtime, and "engine with no labeled
dashboard" is the right insight. The divergence is on **emphasis and
sequencing**, kept as a counter-section rather than a rewrite: the map above is a
sound snapshot; this is where a second set of hands would weight it differently.

1. **The facade (gap #2) is oversold as strategy — its real payload is
   internal.** A `lib/index.ts` public surface only earns its keep with *external
   consumers* building agents on Push. For a single-operator product ("a repo you
   run by chatting"), "what is Push's agent API?" is low-urgency — you know the
   modules. What the facade genuinely buys is *forcing the `runtimeContext`
   consolidation* (the "✅ have it, scattered" row), which is a real smell worth
   fixing on its own. Reframe: **the consolidation is the win; the facade is just
   the pressure.** Shipping a facade as "we're an SDK now" without a consumer is
   tidiness in a strategy costume — and it implicitly signs a maintenance contract
   for external callers.

2. **Gap #1's token estimate assumes static re-reads; a coder loop edits files.**
   A content-hash-keyed file handle only caches files that *don't change*
   across turns. The high-churn files in an edit loop are the edit *targets* —
   cache miss every turn. The win is real but it's for the *context* files
   (read, not modified), not the headline "200-line file × 50 turns." Two omissions
   compound it: (a) provider file APIs have **no clean neutral shape** (Anthropic
   Files beta, Gemini, OpenAI all differ) — direct tension with the
   Anthropic-conceptual neutral hub this doc otherwise venerates; (b) that makes
   it a *new per-provider capability dimension*, i.e. exactly what the #1169
   conformance harness now exists to pin. The gap and the harness reinforce each
   other; the doc doesn't connect them.

3. **For a visibility-first operator, OTel (gap #3) outranks the facade.** It's
   cheap, unambiguous, maps onto the symmetric-structured-log discipline already
   in `CLAUDE.md`, and points Push at any observability stack. That's more aligned
   with how this product is actually run than a public API for hypothetical
   external callers. On personal-fit grounds the ranking flips: **OTel +
   consolidation before the facade.**

4. **The unasked fork: should Push be an SDK at all?** The doc opens with "if
   we're embracing 'I'm building my own SDK'" and then maps features without
   interrogating it. Product-vs-library pull opposite ways — the product thesis
   says polish the single conversational lead; the SDK thesis says expose the
   primitives for others to assemble. Best read: "I'm building my own SDK" is
   shorthand for "I want my runtime *coherent and observable*" — which is the
   consolidation + OTel, not a published package. Name the fork before anyone
   ships `lib/index.ts`.

Minor: the "11 of 13" box-score is generous (counting "HarnessAgent — inverse
framing" and "MCP apps — deliberately bounded" as ✅ is *we chose differently*,
not *we have it*). The "governance divergence" framing is stronger than the count.

**Revised "what I'd build first":** the `runtimeContext` consolidation (real
smell, the facade's actual payload) and the OTel exporter (cheap, fits how the
product is run). Hold the public facade until a concrete external consumer
justifies the maintenance contract.

## Pointers

- [`CLAUDE.md`](../../CLAUDE.md) — fold-in-vs-outsource, capability sourcing, governance
- [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — canonical runtime/role/tool-protocol contract
- [`docs/decisions/Provider Contract — Anthropic-Conceptual Neutral Hub.md`](../decisions/<Provider Contract — Anthropic-Conceptual Neutral Hub.md>)
- [`docs/decisions/Durable Runs — Adopt-on-Silence.md`](../decisions/<Durable Runs — Adopt-on-Silence.md>)
- Shared runtime index: root `lib/` (see CLAUDE.md "Shared runtime in root `lib/`")
