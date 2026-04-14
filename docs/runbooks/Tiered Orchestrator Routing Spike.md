# Tiered Orchestrator Routing Spike

Status: Draft spike, added 2026-04-14
Origin: [External Resource Review — Harness Engineering and Ralph Loop](../decisions/External%20Resource%20Review%20%E2%80%94%20Harness%20Engineering%20and%20Ralph%20Loop.md), r/ollama CPU SLM agent post (2026-04)

## Why This Exists

Every Orchestrator turn today goes through the full chat-locked frontier model, even when the user's intent is trivially resolvable. A sample of real traffic shows a long tail of turns that are effectively one of:

- "what branch am I on"
- "show diff"
- "open `app/src/lib/orchestrator.ts`"
- "run the tests"
- "what did the last commit do"
- "list files in `lib/`"
- single-word acknowledgements that trigger another orchestrator call

On mobile networks these turns feel slow — not because the work is hard, but because the round trip is large. On cost, they're the worst ratio of value to tokens in the system: full system prompt, full tool schema, full memory pack, to resolve something a 10-line regex could have handled.

The insight from the external SLM writeup is not about small models — it's about **not paying frontier-model cost for intents that don't need a frontier model**. Push can adopt the routing idea without changing its backend mix.

## Goal

Land a two-phase intent router in front of the Orchestrator that resolves a measurable fraction of turns without a frontier-model call, without regressing on either tool-use quality or the chat experience.

## Non-Goals

- Running any on-device or CPU-only inference. Push stays multi-backend with opt-in private connectors.
- Replacing the Orchestrator. The router sits in front of it, not instead of it.
- Auto-executing mutations. The rule layer only routes to read-only tools and to human-visible confirmations; anything that writes still goes through the Orchestrator and (where applicable) the Auditor.
- A full NLU stack. The router is deliberately cheap and dumb.

## Current Baseline

- `app/src/lib/orchestrator.ts` is the single entry point for chat-locked Orchestrator turns. Every user message currently constructs a full system prompt, tool schema, and memory pack, then makes a provider call.
- Tool dispatch is structured (`chat-tool-messages.ts`, multi-tool turns, structured error taxonomy) but every dispatch decision is made by the model.
- There is no layer that can short-circuit a turn based on pattern matching.

## Design

### Phase 1 — Rule Engine (<5 ms)

A pre-compiled set of intent rules that map user text to a direct tool invocation or a direct answer. Rules live in `lib/` so both web and CLI can share them.

Each rule has:

- a deterministic matcher (regex or normalized-string predicate)
- a bound action: either a single read-only tool call, a canned response template, or an "escalate" decision
- a side-effect scope: `read_only`, `display_only`, or `escalate`
- an optional confirmation requirement for anything that is not display-only

Sketch of rule shape:

```ts
type OrchestratorRule = {
  id: string;
  match: (normalized: string) => boolean;
  action:
    | { kind: "tool"; tool: string; args: Record<string, unknown> }
    | { kind: "answer"; render: (ctx: RuleContext) => string }
    | { kind: "escalate"; reason: string };
  scope: "read_only" | "display_only" | "escalate";
};
```

Candidate starter rules:

| Intent | Action |
|---|---|
| `what branch am i on` / `current branch` | `answer` from session state |
| `show diff` / `what changed` | `tool: sandbox_diff` (public name `diff`) |
| `open <path>` / `show <path>` | `tool: sandbox_read_file` |
| `list files in <path>` | `tool: sandbox_list_dir` (public name `ls`) |
| `run tests` (no qualifier) | `escalate` — too ambiguous, still cheap-to-frontier |
| single emoji / `ok` / `thanks` | `answer` with acknowledgement, no provider call |

Tool names here match the canonical names in `lib/tool-registry.ts`. Any rule action that dispatches a tool must use the registered name; the router is not the place to invent new tools.

Escalation is the default. If no rule fires confidently, the router falls through to Phase 2.

### Phase 2 — Cheap Classifier (optional, ~300-500 ms)

For turns that don't match a rule but still look like they might be a single-intent request, we can optionally call a small fast model (Haiku 4.5 or similar) with:

- only the skill name list
- no tool schemas, no memory pack, no transcript
- instruction to output a single JSON object: `{ "skill": string | null, "confidence": "high" | "low" }`

If the classifier returns a high-confidence skill, we dispatch through the same rule-engine action path. Otherwise we fall through to the full Orchestrator.

**Timeout policy.** The ~300–500 ms range is a best-case estimate and does not hold on slow networks or during provider backpressure. Phase 2 therefore runs under a hard deadline (v1 target: 400 ms from dispatch to response). If the classifier has not returned by the deadline, we abandon its result, emit a `router.phase2_timeout` trace event, and escalate to the full Orchestrator as if Phase 2 had never fired. A classifier call that misses the deadline is strictly worse than no classifier call — it burns tokens and latency to produce nothing useful — so the deadline must be enforced rather than hoped for. If the timeout fires on more than a small single-digit percentage of runs, Phase 2 should be disabled by feature gate until the latency floor improves.

Phase 2 is strictly optional for v1. The rule engine alone should cover the obvious wins. Phase 2 is listed here so the design isn't a dead end if we want to grow the cheap path later.

### Phase 3 — Full Orchestrator (unchanged)

Anything that escalates hits the existing Orchestrator path with no behavioral changes. This is the safety valve: if the router is wrong, the user never sees degraded capability, only slightly more latency than a pure-Orchestrator turn.

## Integration Points

- `app/src/lib/orchestrator.ts` gains a pre-dispatch hook that consults the router.
- Router lives in `lib/orchestrator-router.ts` (new) so `cli/` can adopt it without a second implementation.
- Router decisions are emitted as structured trace events (`router.hit`, `router.escalate`) alongside the existing run-event vocabulary, so we can measure hit rate without instrumenting the UI.
- The rule set is a plain module, not data-driven config. It needs to be reviewable in PRs.

## Safety and UX Rules

- **No silent mutations.** Any rule whose action would modify the sandbox, commit, push, or hit GitHub MUST escalate. The router is read-only plus display-only.
- **Visible short-circuit.** When the router answers a turn, the UI labels it (small marker, e.g. "resolved locally") so the user can tell they didn't get a model answer. This matters for trust.
- **Override escape hatch.** A leading `??` (or equivalent prefix) on the user message forces escalation to the full Orchestrator regardless of rule hits. This is the release valve when a rule is wrong.
- **Branch-scope awareness.** Rule actions must honor the chat's locked branch/repo/session state the same way Orchestrator tool calls do.
- **No rule may answer a question about project state it hasn't actually read.** `answer` rules only compose from session capability blocks that are already in memory.

## Acceptance Criteria

1. Router module lands in `lib/` with unit tests covering every starter rule (positive match, negative match, escalation fallback).
2. `orchestrator.ts` consults the router before building the full prompt; integration test exercises at least three starter intents end-to-end through the router path.
3. Trace events `router.hit` and `router.escalate` are emitted through the shared run-event vocabulary and validated by the CLI protocol schema harness.
4. A short follow-up doc captures observed hit-rate, latency delta, and any rules that fired incorrectly during dogfood.
5. The `??` override path is wired and tested.

## Open Questions

- Do we want the router to run on the CLI transcript-first REPL path from day one, or only the web app first? Startup cost matters less for `push` but product focus this cycle is transcript-first muscle memory, so a CLI adoption pass might be worth folding in.
- Should rule hits still write to the typed context-memory store? Probably yes for `tool` actions (they're real tool calls), probably no for `answer` actions (they're not new information).
- How do we want to handle the Orchestrator provider/model lock when a turn is resolved entirely by the router? The lock is established "on first send" today — a router-only first turn shouldn't accidentally defer the lock and let it get re-bound later.
- Phase 2 classifier cost: is a Haiku-class call cheap enough end-to-end that it's actually a win over just going straight to the locked model? Worth measuring before committing to Phase 2.

## Success Metric (v1)

The spike is a success if, across a week of dogfood usage, the router resolves at least 15% of Orchestrator turns without a frontier-model call and the median latency of those turns drops below 200 ms, with zero unresolved incident reports of "the router answered wrong and I didn't notice."
