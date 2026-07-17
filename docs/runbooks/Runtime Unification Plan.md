# Runtime Unification Plan

Status: **Current** — complete through Phase 4 (2026-07-17)

## Goal

Finish the remaining high-value runtime convergence without turning the web,
CLI, daemon, and a future native shell into identical applications. Shared
`lib/` code owns deterministic agent behavior; each shell keeps transport,
credentials, persistence, presentation, and native execution local.

This plan extends §15 of
[`Agent Runtime Decisions.md`](../decisions/Agent%20Runtime%20Decisions.md). The
four phases are complete: the shared Coder hosts now use one policy, transport
families, capability resolver, execution ledger, intervention contract,
malformed-call reducer, and post-compaction goal anchor while shell-local
storage and transport boundaries remain explicit.

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

At the start of this plan, web resolved a full `PushCapabilityProfile` while
CLI separately applied curated native-tool allowlists. Phase 3 replaced that
split with one shared decision algorithm. Metadata sources still differ by
design: web supplies live/cached catalog evidence; CLI supplies its curated
fallback.

### 4. Secondary convergence (complete)

- Shared malformed-tool metric records/reducers while preserving shell-local
  storage scope.
- Closed the CLI user-goal-anchor parity gap with the user-owned goal file.
- Finished the execution half of the shared tool ledger so policy, recovery,
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
request serialization, and SSE pumping. The traced fetch, error-prefix
normalization, and response-body validation common to all three families live
in one `provider-stream-fetch` helper — transport plumbing only, so it cannot
drift into the mega-adapter this plan rules out. OpenRouter remains outside that builder: its session trace,
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

1. [x] Move the pure profile decision into `lib/capability-profile.ts`.
2. [x] Inject dynamic web metadata or the CLI/native curated fallback through
   the same synchronous lookup contract.
3. [x] Keep credential discovery and catalog caching surface-local.
4. [x] Pin profile coherence and source-specific fallbacks with shared, web,
   and CLI tests.

The shared resolver owns provider eligibility, tool/streaming coherence,
structured-output mode, content/reasoning block routing, multimodal fallback,
and context tiers. `app/src/lib/model-catalog.ts` remains the web metadata and
cache adapter; `cli/native-tool-gate.ts` projects curated catalogs into the same
raw evidence shape. An explicit `false` is distinct from missing evidence, so
the web-only Cloudflare cold-cache name fallback does not accidentally enable a
provider absent from the CLI catalog. Zen Go catalog/transport metadata moved to
`lib/zen-go.ts` because both routing and profile resolution consume it.

### Phase 4 — ledger completion and secondary convergence

1. [x] Turn the grouping snapshot into a run-scoped execution ledger. The
   shared Coder kernel records every classified emitted call's accepted/rejected decision,
   then updates accepted entries through start, completion, denial, structured
   failure, or thrown execution with duration, retryability, target, and
   postcondition evidence. Web inline, CLI lead, daemon delegation, and Worker
   background/adoption hosts inherit it from the kernel.
2. [x] Make ledger snapshots the input to loop evaluation and post-Coder
   auditing. Loop policy no longer reconstructs the executable batch from
   detector arrays in the shared kernel; the Auditor receives a compact
   transcript-independent record of accepted, rejected, completed, and failed
   calls. Multi-task Coder arcs merge their per-task ledgers without merging
   shell state.
3. [x] Route the remaining recovery, loop, and Auditor decisions through the
   shared runtime-intervention contract. Reasoning-channel call recovery and
   graded loop handling emit typed steers/blocks; incomplete evaluations steer
   at the delivery gate; unsafe or unavailable pre-push audits block there and
   preserve retryability through the git result.
4. [x] Share the malformed-tool metric record/reducer while preserving web
   process storage and CLI per-session storage. The reducer owns provider,
   model, reason, and tool dimensions; each shell owns lifecycle and exposure.
5. [x] Close CLI goal-anchor parity. The first successful lead compaction
   atomically seeds `.push/goal.md` without overwriting user edits, and every
   later compacted turn loads that file (or derives a fallback) and places the
   canonical `[USER_GOAL]` block immediately before the current task.

Acceptance:

- the shared execution ledger is returned with every normal and guarded Coder
  termination and is detached from retained turn snapshots;
- rejected calls never acquire an execution state, while all executed calls
  finish as completed or failed;
- loop and Auditor consumers use runtime records rather than transcript claims;
- intervention reason codes remain stable across web, CLI, daemon, and Worker
  hosts without adding a hook framework;
- user-owned goal files and shell-local metric scopes do not cross runtime
  boundaries;
- focused shared, web, CLI, Auditor-gate, reducer, and goal-anchor tests pass.

## Non-goals

- No generic hook or plugin framework.
- No shared UI, storage backend, credential loader, or transport lifecycle.
- No removal of real provider quirks to satisfy a uniform abstraction.
- No reopening already-converged tool parsing/grouping without a concrete
  forcing function.
- No new tool or agent capability as part of this refactor.
