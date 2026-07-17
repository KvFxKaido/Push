# Runtime Unification Plan

Status: **Current** — Phase 2 complete (2026-07-17)

## Goal

Finish the remaining high-value runtime convergence without turning the web,
CLI, daemon, and a future native shell into identical applications. Shared
`lib/` code owns deterministic agent behavior; each shell keeps transport,
credentials, persistence, presentation, and native execution local.

This plan extends §15 of
[`Agent Runtime Decisions.md`](../decisions/Agent%20Runtime%20Decisions.md). The
steer/block contract and initial tool-ledger snapshot have landed, but several
runtime decisions are still implemented or bypassed per surface.

## Current Findings

### 1. Coder policy and interventions

At the start of this plan, the web inline lane ran the Coder turn policy while
the CLI lead and daemon Coder paths passed no-op policy callbacks into the
shared Coder kernel. The Worker background host also supplied a permissive
policy adapter, and `cli/turn-policy.ts` was a standalone, test-only port rather
than the production policy source. Phase 1 replaced those splits: web inline,
CLI lead, daemon task-graph/direct delegation, Worker background jobs, and
Worker run adoption now use the same stateful policy factory.

Target boundary:

- shared `lib/`: pure Coder policy state machine, intent classification,
  steer/block directives, and stable reason codes;
- shell adapters: message IDs/timestamps, structured logs, approvals, tool
  execution, and UI events;
- shared kernel: consumes the policy result but does not import web or CLI
  message types.

### 2. Provider transport families

The app has provider-specific stream modules that repeat request construction,
headers/tracing, error parsing, response-body validation, and SSE pumping.
Converge these by wire family (`openai-compat`, `openai-responses`, `anthropic`,
`gemini`) while keeping provider-specific body overrides and model-dependent
routing explicit. The Anthropic `pause_turn` continuation loop should have one
shared implementation.

### 3. Capability resolution

Web resolves a full `PushCapabilityProfile`; CLI separately applies curated
native-tool allowlists. The metadata sources may differ, but the decision
algorithm should be shared and accept a surface-provided metadata lookup.

### 4. Smaller follow-ups

- Share malformed-tool metric records/reducers while preserving shell-local
  storage scope.
- Close or explicitly preserve the CLI user-goal-anchor parity gap.
- Finish the execution half of the shared tool ledger so policy, recovery,
  budgets, loops, and Auditor context query recorded outcomes rather than local
  arrays or transcript text.

## Phases

### Phase 1 — shared Coder policy

1. [x] Extract the surface-neutral Coder policy engine and turn-intent
   classifier into `lib/`.
2. [x] Delete the web-only registry and `ChatMessage` adapter after moving its
   only production caller to the shared factory.
3. [x] Wire the web inline lane and CLI lead to the same policy instance
   contract.
4. [x] Remove the standalone CLI policy implementation and move its tests to
   the shared contract.
5. [x] Wire daemon Coder delegations through the shared direct-kernel adapter
   and replace the Worker background policy no-op with the shared factory.

Acceptance:

- web, CLI lead, daemon delegations, and Worker background/adoption runs
  evaluate the same after-model policy rules;
- all Coder hosts enforce verification-phase mutation denial and after-tool
  mutation failure/backpressure rules using their own tool names;
- conversational turns do not trigger task-only drift or fake-completion
  rules;
- policy outputs carry shared steer/block metadata without changing agent
  capability;
- each shell emits the same structured policy events with a runtime-host field;
- focused web, CLI, and shared-kernel tests pass.

Review-pinned behavior:

- task-shaped turns keep the strict short-response grounding guard on every
  host; only explicitly conversational web, CLI, background, or adopted lead
  turns use `claims_only`, which permits ordinary direct answers but still
  challenges explicit completion claims;
- a trailing announced action is evaluated before generic completion
  grounding so the next round can force the promised tool call;
- native tool-call presence bypasses text-only after-model policy for that
  round, because the structured call is already concrete action even when its
  prose preface sounds like an unfulfilled announcement;
- only successful repo-level verification tools or commands reset mutation
  backpressure; a file-scoped `lsp_diagnostics` result does not;
- CLI policy events use stderr because stdout is reserved for user and JSONL
  output, while web and Worker hosts use their local structured-log sink;
- Worker adoption builds one services/policy instance per adoption attempt;
  a relaunched attempt intentionally receives fresh policy state.

### Phase 2 — provider-family adapters

Create small transport-family builders and migrate the copy-shaped providers
incrementally. Do not create one provider mega-adapter.

1. [x] Extract the OpenAI Responses client family and migrate direct OpenAI,
   xAI, Sakana, and Fireworks while keeping endpoint, credential lookup, and
   provider identity explicit in their leaf modules.
2. [x] Extract the copy-shaped OpenAI Chat Completions family for Z.ai, Nvidia
   NIM, Hugging Face, and Cloudflare Workers AI without folding
   provider-specific request fields into opaque generic hooks.
3. [x] Converge direct Anthropic and DeepSeek's Anthropic-compatible transport,
   extract the cross-shell `pause_turn` continuation state machine separately,
   and share the defensive no-pause completion policy with Zen/background
   routes.
4. [x] Audit Gemini request/stream mechanics and preserve the current boundary:
   direct web and CLI already share `toGeminiGenerateContent` and
   `geminiEventStream`; Vertex is no longer a provider surface, and its former
   OpenAI-compatible wire is not interchangeable with direct Gemini.

The OpenAI Responses slice owns prompt composition, neutral-message conversion,
request serialization, traced fetch, error parsing, response-body validation,
and SSE pumping. OpenRouter remains outside that builder: its session trace,
provider routing controls, and dual Chat/Responses paths are real product
behavior rather than copy-shaped transport boilerplate.

The Chat Completions slice uses declarative credential and error-prefix modes.
Kimi remains separate for its model-specific fixed sampling, Ollama remains
separate for reasoning effort and native tool-history replay, and OpenRouter
remains separate for routing/trace metadata and its dual wire modes.

The Anthropic slice keeps web transport construction in a small family adapter
while moving replay ordering, the three-continuation cap, empty-block handling,
and terminal synthesis into shared `lib/` code used by web and CLI. DeepSeek,
Zen Go, and background Zen routes cannot legitimately continue `pause_turn`, so
they share the complementary drain-and-guarantee-done policy instead.

The Gemini audit deliberately produced no new family adapter. Direct Google is
the only native Gemini provider leaf; both shells already converge at the
serializer and native SSE pump. Reintroducing Vertex into that adapter would
erase a real wire-family boundary rather than remove duplication.

### Phase 3 — capability resolver

Move the pure profile decision into `lib/`; inject dynamic web metadata or the
CLI/native curated fallback. Keep credential discovery and catalog caching
surface-local.

### Phase 4 — ledger completion and secondary convergence

Record tool execution start/completion/failure in the shared ledger, route the
remaining recovery/loop/Auditor decisions through runtime interventions, then
converge metric reducers and resolve goal-anchor parity.

## Non-goals

- No generic hook or plugin framework.
- No shared UI, storage backend, credential loader, or transport lifecycle.
- No removal of real provider quirks to satisfy a uniform abstraction.
- No reopening already-converged tool parsing/grouping without a concrete
  forcing function.
- No new tool or agent capability as part of this refactor.
