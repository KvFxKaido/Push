# Web and CLI Runtime Contract

Status: Current, added 2026-04-05
Origin: [Web–CLI Parity Plan](../runbooks/Web-CLI%20Parity%20Plan.md), [Architecture](../architecture.md), [Context Memory and Retrieval Architecture](Context%20Memory%20and%20Retrieval%20Architecture.md)

## Why This Exists

Push now has enough sophisticated runtime behavior that context switching between the web app and CLI creates real cognitive cost.

Some of that divergence is necessary:

- mobile-first UX
- browser lifecycle constraints
- Cloudflare Worker and Modal boundaries
- terminal-native attach and daemon flows

Some of it is not necessary:

- different mental models for delegation
- different meanings for run phases or memory
- app-only orchestration semantics that the CLI does not even conceptually share

That second category is where the architecture starts to feel expensive.

This doc defines the intended rule:

**Push web and Push CLI should be two shells over one agent runtime contract.**

Short version:

- unify the brain
- do not force the same shell

## Decision

Use the same agent-runtime semantics across web and CLI wherever those semantics define how Push thinks, plans, delegates, verifies, remembers, and explains work.

Allow divergence where the behavior is purely about transport, UX shell, platform limits, or execution substrate.

This is deliberately **not** a full feature-parity goal.

It is a **same mental model** goal.

## What Must Be Shared

These areas should converge as much as possible, because drift here changes how Push behaves as an agent rather than how it is surfaced.

### 1. Agent semantics

- role meanings: Orchestrator, Explorer, Coder, Reviewer, Auditor
- delegation envelopes and completion outcomes
- verification and evidence semantics
- approval and safety semantics at the contract level

If a role or delegation concept means one thing on web and another in CLI, the system is paying unnecessary cognitive tax.

### 2. Tool protocol

- model-facing tool-call format
- parsing, repair, and malformed-call handling
- structured error taxonomy
- shared rules for read vs mutate semantics where possible

This is already partly converged through `lib/tool-protocol.ts` and `lib/error-types.ts`.

### 3. Edit safety and workspace reasoning

- hashline edit semantics
- file-awareness and mutation invalidation rules
- workspace-state postconditions that the agent can rely on

This is already partly converged through `lib/hashline.ts` and `lib/working-memory.ts`.

### 4. Working memory and context policy

- Coder working-memory shape and formatting
- context-budget heuristics
- context compaction policy shape
- what counts as live context versus carried-forward state

### 5. Delegation and orchestration semantics

- task-graph rules
- dependency handling
- cancellation behavior
- per-node status model
- graph-level result formatting

If task graphs remain web-only, that should be an intentional product choice, not an architectural accident.

### 6. Typed artifact memory

- memory record model
- retrieval query shape
- scoring and freshness rules
- invalidation behavior
- prompt packing semantics

This is now important enough that treating it as app-only would create a second-class runtime on CLI.

### 7. Run phases and event vocabulary

- major loop phases
- delegation lifecycle events
- task-graph event names
- approval-required / cancellation / completion semantics

Different shells can render events differently, but they should be speaking the same runtime language.

## What May Diverge

These differences are acceptable because they are shell or platform concerns rather than agent-runtime semantics.

### 1. UI shell

- mobile chat/workspace UX
- terminal REPL
- TUI panes, widgets, shortcuts, attach flows

### 2. Execution transport

- browser + Worker + Modal boundaries on web
- local process execution, Docker sandbox, or daemon transport in CLI

### 3. Auth and connector plumbing

- browser session/auth behavior
- local CLI config and key management
- platform-specific connector constraints

### 4. Background execution strategy

- browser/PWA suspend behavior
- daemon-attached local sessions
- future native-app background execution

Background execution is not the current reason for the CLI to exist. PWA background work remains explicitly deferred.

### 5. Approval UX

- modal or sheet on web
- terminal prompt, slash command, or trust-prefix workflow in CLI

### 6. Sandbox substrate

- Modal sandbox on web
- local Docker or direct host execution in CLI

The important thing is consistent semantics around what is allowed, not identical infrastructure.

## Current State

### Already shared in root `lib/`

These are examples of the right direction:

- `lib/hashline.ts`
- `lib/tool-protocol.ts`
- `lib/error-types.ts`
- `lib/context-budget.ts`
- `lib/reasoning-tokens.ts`
- `lib/diff-utils.ts`
- `lib/working-memory.ts`

These are brain-level modules that already serve both shells well.

### Still app-local but strong candidates for shared runtime extraction

If CLI remains a first-class shell, these should likely move into root `lib/` or equivalent shared-runtime homes:

- `app/src/lib/task-graph.ts`
- `app/src/lib/context-memory.ts`
- `app/src/lib/context-memory-store.ts`
- `app/src/lib/context-memory-retrieval.ts`
- `app/src/lib/context-memory-invalidation.ts`
- `app/src/lib/context-memory-packing.ts`
- `app/src/lib/role-context.ts`
- the pure event/phase vocabulary around `app/src/lib/run-engine.ts`

These modules mostly define agent behavior, not app UI behavior.

### Likely to remain shell-local

- `app/src/hooks/useChat.ts`
- `app/src/hooks/useAgentDelegation.ts`
- `app/src/hooks/chat-send.ts`
- `cli/engine.ts`
- `cli/pushd.ts`
- terminal UI modules under `cli/`

These coordinate a shell around the runtime contract. They should consume shared semantics, not become shared themselves.

## Decision Filter

When deciding whether a new capability belongs in shared runtime code or shell-local code, use this test:

### Put it in shared runtime code if it changes:

- how the agent reasons
- how the agent delegates
- what memory means
- what verification means
- what run phases and events mean
- what safety or approval contracts mean

### Keep it shell-local if it changes:

- how the user sees the system
- how input/output is transported
- how a shell starts, attaches, resumes, or renders
- which platform-specific APIs are involved

Another way to say this:

- if it changes the agent's mental model, share it
- if it changes the shell's delivery model, keep it local

## Near-Term Implications

### 1. CLI north star

The CLI should be justified as a terminal-native Push shell, not as a hidden infrastructure answer for current PWA background execution.

That means:

- transcript-first local agent workflows
- headless one-shot runs
- attach/resume via daemon
- local repo work that feels faster and more direct than web on desktop

### 2. Next convergence tranche

If reducing web/CLI context-switch cost becomes a priority, the highest-leverage shared-runtime extraction is:

1. task graph executor
2. typed context-memory stack
3. role/delegation context packing
4. shared run-event vocabulary and phase helpers

### 3. Avoid parity theater

Do not force:

- identical UI features
- identical approval UX
- identical transports
- identical shell affordances

The goal is not "same screens everywhere."

The goal is "same agent, different shell."

## Success Criteria

This decision is working if:

- moving between web and CLI does not require re-learning how Push thinks
- runtime innovations are evaluated first as shared-contract candidates
- platform-specific code gets thinner at the semantic layer
- CLI and web can diverge in UX without feeling like different products

## Short Version

Push should minimize differences in runtime semantics and allow differences in shell behavior.

The architecture target is:

**same brain, different shells**
